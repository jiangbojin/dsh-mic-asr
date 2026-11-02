/** The speaker enrollment file shared by the plugins that verify the speaker. */
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { EnrollmentState } from './protocol.ts'
import type { SpeechEnrollment, SpeechInputState } from './types.ts'

const ENROLLMENT_FILE = 'speaker.json'
const PREVIOUS_ENROLLMENT_FILE = 'speaker.previous.json'

/**
 * Validate a saved enrollment file.
 * @param value - parsed JSON.
 * @returns the enrollment, or undefined when the file does not hold one.
 */
export function parseEnrollment(value: unknown): EnrollmentState | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const embeddings = record['embeddings']
  const durations = record['durations']
  if (!Array.isArray(embeddings) || !Array.isArray(durations) || typeof record['denoiseAtEnroll'] !== 'boolean') return undefined
  const numbers = (list: unknown): list is number[] => Array.isArray(list) && list.every(item => typeof item === 'number' && Number.isFinite(item))
  if (!embeddings.every(numbers) || !numbers(durations)) return undefined
  return { recording: false, enrolled: true, denoiseAtEnroll: record['denoiseAtEnroll'], segmentsOk: embeddings.length,
    embeddings, durations, pairScores: [] }
}

/**
 * Browser view of an enrollment.
 * @param state - worker enrollment state.
 * @returns summary without embeddings.
 */
export function enrollmentSummary(state: EnrollmentState): SpeechEnrollment {
  return { enrolled: state.enrolled, recording: state.recording, segmentsOk: state.segmentsOk, pairScores: state.pairScores }
}

/**
 * Whether two enrollments hold the same embeddings.
 * @param a - one enrollment.
 * @param b - the other.
 * @returns true for equal embedding lists.
 */
export function sameEmbeddings(a: EnrollmentState, b: EnrollmentState): boolean {
  return JSON.stringify(a.embeddings) === JSON.stringify(b.embeddings)
}

/** Outcome of reading `speaker.json`. */
export type SavedEnrollment =
  | { readonly kind: 'saved'; readonly state: EnrollmentState }
  /** No file: nobody enrolled, or the enrollment was cleared. */
  | { readonly kind: 'missing' }
  /** A file that could not be read or does not hold an enrollment; a warning was logged. */
  | { readonly kind: 'unusable' }

function parseEnrollmentText(text: string): EnrollmentState | undefined {
  try { return parseEnrollment(JSON.parse(text)) } catch (error) {
    void error // malformed JSON is no enrollment
    return undefined
  }
}

/** `speaker.json` (mode 0600) in a data directory; a replaced or cleared enrollment stays in `speaker.previous.json`. */
export class EnrollmentFile {
  private readonly path: string
  private readonly previous: string
  private readonly staging: string

  /**
   * @param dataRoot - directory holding the files.
   * @param logger - receives read and write failures.
   * @param label - plugin name used in log texts.
   */
  constructor(private readonly dataRoot: string, private readonly logger: Context['logger'], private readonly label: string) {
    this.path = join(dataRoot, ENROLLMENT_FILE)
    this.previous = join(dataRoot, PREVIOUS_ENROLLMENT_FILE)
    this.staging = join(dataRoot, `${ENROLLMENT_FILE}.${String(process.pid)}.tmp`)
  }

  /**
   * Read `speaker.json`.
   * @returns the saved enrollment, a missing file, or an unusable one after a warning.
   */
  async read(): Promise<SavedEnrollment> {
    let text: string
    try { text = await readFile(this.path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
      this.logger.warn(`${this.label}: cannot read ${this.path}`, error)
      return { kind: 'unusable' }
    }
    const state = parseEnrollmentText(text)
    if (state !== undefined) return { kind: 'saved', state }
    this.logger.warn(`${this.label}: ignoring invalid speaker enrollment ${this.path}`)
    return { kind: 'unusable' }
  }

  /**
   * Apply a worker enrollment event to the files. A new enrollment replaces `speaker.json` atomically, so readers
   * never see the file missing while it is written.
   * @param event - `reset` moves the file aside; `enrolled` writes a new enrollment unless it equals the saved one.
   * @param state - the worker's enrollment after the event.
   */
  async save(event: string, state: EnrollmentState): Promise<void> {
    try {
      if (event === 'reset') {
        await rename(this.path, this.previous).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        })
      } else if (event === 'enrolled') {
        const saved = await this.read()
        // Restoring at startup reports the saved enrollment again; that must not replace the previous one.
        if (saved.kind === 'saved' && sameEmbeddings(saved.state, state)) return
        await mkdir(this.dataRoot, { recursive: true, mode: 0o700 })
        if (saved.kind === 'saved') await copyFile(this.path, this.previous)
        await writeFile(this.staging, `${JSON.stringify({ denoiseAtEnroll: state.denoiseAtEnroll, embeddings: state.embeddings, durations: state.durations })}\n`, { mode: 0o600 })
        await rename(this.staging, this.path)
      }
    } catch (error) {
      this.logger.error(`${this.label}: cannot update ${this.path}`, error)
    }
  }
}

/** The worker operations that enrollment syncing uses. */
export interface EnrollmentTarget {
  readonly input: SpeechInputState
  readonly alive: boolean
  readonly enrollment: EnrollmentState
  restoreEnrollment(state: EnrollmentState): void
  enroll(action: 'reset'): void
}

/**
 * Make a worker follow `speaker.json`, which another plugin sharing the data directory may have replaced or cleared.
 * An unusable file leaves the worker unchanged.
 * @param file - the shared enrollment file.
 * @param worker - a worker whose input is ready.
 */
export async function syncEnrollment(file: EnrollmentFile, worker: EnrollmentTarget): Promise<void> {
  const saved = await file.read()
  if (worker.input.phase !== 'ready' || !worker.alive) return
  if (saved.kind === 'saved' && !sameEmbeddings(saved.state, worker.enrollment)) worker.restoreEnrollment(saved.state)
  else if (saved.kind === 'missing' && worker.enrollment.enrolled) worker.enroll('reset')
}
