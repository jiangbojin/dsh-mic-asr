/** Browser side of the dictation stream: microphone, readiness, enrollment, live status and inserting recognized text into one composer. */
import type { RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import type { MicAsrDownFrame, MicAsrRuntimeState, MicAsrUpFrame, SpeechEnrollment } from '../types.ts'
import type { Capture } from './capture.ts'
import type { MicCaptureService } from './service.ts'

/** Dictation phase shown by the control. */
export type DictationPhase = 'off' | 'connecting' | 'preparing' | 'loading' | 'listening' | 'failed'

/** The latest outcome worth showing next to the control. */
export type DictationNotice =
  | { readonly kind: 'inserted'; readonly text: string }
  /** Speaker verification rejected the segment, or no speaker is enrolled. */
  | { readonly kind: 'not-verified'; readonly text: string; readonly enrolled: boolean }
  /** The composer refused the text, for example while a prompt is being admitted. */
  | { readonly kind: 'insert-failed'; readonly text: string }
  | { readonly kind: 'error'; readonly message: string }

/** One final text of the stream. */
export interface DictationFinal {
  readonly text: string
  readonly reason: 'insert' | 'not-verified' | 'empty'
  /** Speaker score of the segment; null when it was not scored. */
  readonly score: number | null
  /** From the end of speech to the final text; null when not timed. */
  readonly endToFinalMs: number | null
}

/** The latest speaker score of the segment being spoken. */
export interface DictationScore {
  readonly score: number
  readonly accepted: boolean
  /** The score decided acceptance; earlier scores are provisional. */
  readonly decisive: boolean
}

/** One input level report. */
export interface DictationLevel {
  /** Input level after denoise, dBFS. */
  readonly dbfs: number
  /** VAD was inside a speech segment. */
  readonly speaking: boolean
}

/** Immutable snapshot read by the control and the tuning page. */
export interface DictationState {
  readonly phase: DictationPhase
  /** Composer that receives the text; undefined while off. */
  readonly owner: object | undefined
  /** Partial text of the segment being spoken. */
  readonly partial: string | undefined
  /** VAD currently inside a speech segment. */
  readonly inSegment: boolean
  /** Input level after denoise, dBFS. */
  readonly levelDbfs: number | undefined
  /** Input level before denoise, dBFS. */
  readonly rawDbfs: number | undefined
  /** Recent level reports, oldest first, at most LEVEL_HISTORY (about ten per second). */
  readonly levels: readonly DictationLevel[]
  /** The microphone has delivered only near-digital silence for SILENT_MS. */
  readonly silent: boolean
  readonly enrollment: SpeechEnrollment
  /** Latest enrollment message from the Host. */
  readonly enrollMessage: string | undefined
  readonly score: DictationScore | undefined
  /** Finals of this stream, newest first, at most HISTORY_SIZE. */
  readonly finals: readonly DictationFinal[]
  readonly notice: DictationNotice | undefined
  /** Runtime download or unpacking progress while preparing. */
  readonly runtime: MicAsrRuntimeState | undefined
}

/** Opens the Host dictation stream. */
export type ConnectDictation = () => RemoteStreamHandle<MicAsrDownFrame, MicAsrUpFrame>

/** Inserts text at the composer's caret. @returns whether the composer accepted it. */
export type InsertText = (text: string) => boolean

const NO_ENROLLMENT: SpeechEnrollment = { enrolled: false, recording: false, segmentsOk: 0, pairScores: [] }
const OFF: DictationState = { phase: 'off', owner: undefined, partial: undefined, inSegment: false, levelDbfs: undefined, rawDbfs: undefined, levels: [], silent: false,
  enrollment: NO_ENROLLMENT, enrollMessage: undefined, score: undefined, finals: [], notice: undefined, runtime: undefined }
/** Finals kept for the tuning page. */
const HISTORY_SIZE = 20
/** Level reports kept for the live level line, about six seconds. */
const LEVEL_HISTORY = 60

/** Input before denoise below this level counts as silence; a working microphone in a quiet room stays above it. */
const SILENT_DBFS = -70
/** Silence this long marks the microphone as silent. */
const SILENT_MS = 3_000

/** One dictation at a time; starting it for another composer moves it there. */
export class DictationClient {
  private state: DictationState = OFF
  private readonly listeners = new Set<() => void>()
  private handle: RemoteStreamHandle<MicAsrDownFrame, MicAsrUpFrame> | undefined
  private capture: Capture | undefined
  private insert: InsertText | undefined
  private generation = 0
  /** Start of the current run of silent levels. */
  private quietSince: number | undefined

  /**
   * @param connect - opens the Host stream.
   * @param microphone - opens captures of the chosen microphone.
   */
  constructor(private readonly connect: ConnectDictation, private readonly microphone: MicCaptureService) {}

  /**
   * Read the dictation state.
   * @returns the current snapshot.
   */
  getSnapshot = (): DictationState => this.state

  /**
   * Observe changes.
   * @param listener - invalidation callback.
   * @returns disposer.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private update(patch: Partial<DictationState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  /**
   * Start dictating into a composer; call from a user gesture so the microphone can open.
   * @param owner - identity of the composer control.
   * @param insert - inserts recognized text into that composer.
   */
  async start(owner: object, insert: InsertText): Promise<void> {
    await this.stop()
    const generation = ++this.generation
    this.insert = insert
    this.quietSince = undefined
    this.update({ ...OFF, owner, phase: 'connecting' })
    const capture = this.microphone.open((samples) => { this.send({ type: 'audio', samples }) })
    this.capture = capture
    try {
      const handle = this.connect()
      this.handle = handle
      await capture.start()
      void this.microphone.microphones.refresh()
      for await (const frame of handle) {
        if (generation !== this.generation) return
        this.receive(frame)
      }
      if (generation === this.generation) this.update(OFF)
    } catch (error) {
      if (generation === this.generation) this.update({ phase: 'failed', partial: undefined, inSegment: false, notice: { kind: 'error', message: error instanceof Error ? error.message : String(error) } })
    } finally {
      if (generation === this.generation) await this.release()
    }
  }

  /**
   * Point the stream at the current insert callback of its owner; composers re-render with fresh actions.
   * @param owner - identity of the composer control.
   * @param insert - its current insert callback.
   */
  retarget(owner: object, insert: InsertText): void {
    if (this.state.owner === owner) this.insert = insert
  }

  private receive(frame: MicAsrDownFrame): void {
    switch (frame.type) {
      case 'state': {
        const enrollment = frame.enrollment
        const runtime = frame.runtime
        if (runtime.phase === 'failed') this.update({ phase: 'failed', enrollment, runtime, notice: { kind: 'error', message: runtime.error } })
        else if (runtime.phase !== 'ready') this.update({ phase: 'preparing', enrollment, runtime })
        else if (frame.process.phase === 'exited') this.update({ phase: 'failed', enrollment, notice: { kind: 'error', message: frame.process.error } })
        else if (frame.process.phase === 'stopped') this.update({ phase: 'failed', enrollment, notice: undefined })
        else if (frame.input.phase === 'failed') this.update({ phase: 'failed', enrollment, notice: { kind: 'error', message: frame.input.error } })
        else this.update({ phase: frame.input.phase === 'ready' ? 'listening' : 'loading', enrollment })
        return
      }
      case 'speech':
        this.update(frame.phase === 'start' ? { partial: '', inSegment: true, score: undefined } : { inSegment: false })
        return
      case 'partial':
        this.update({ partial: frame.text })
        return
      case 'final': {
        const finals = [{ text: frame.text, reason: frame.reason, score: frame.score, endToFinalMs: frame.endToFinalMs }, ...this.state.finals].slice(0, HISTORY_SIZE)
        if (frame.reason === 'empty') {
          this.update({ partial: undefined, finals })
          return
        }
        if (frame.reason === 'not-verified') {
          this.update({ partial: undefined, finals, notice: { kind: 'not-verified', text: frame.text, enrolled: this.state.enrollment.enrolled } })
          return
        }
        this.update({ partial: undefined, finals, notice: this.insert?.(frame.text) === true ? { kind: 'inserted', text: frame.text } : { kind: 'insert-failed', text: frame.text } })
        return
      }
      case 'score':
        this.update({ score: { score: frame.score, accepted: frame.accepted, decisive: frame.decisive } })
        return
      case 'enroll':
        this.update({ enrollment: frame.enrollment, enrollMessage: frame.message })
        return
      case 'level': {
        const now = performance.now()
        this.quietSince = frame.rawDbfs < SILENT_DBFS ? this.quietSince ?? now : undefined
        const levels = [...this.state.levels.slice(1 - LEVEL_HISTORY), { dbfs: frame.outDbfs, speaking: frame.inSegment }]
        this.update({ levelDbfs: Math.round(frame.outDbfs), rawDbfs: Math.round(frame.rawDbfs), inSegment: frame.inSegment, levels,
          silent: this.quietSince !== undefined && now - this.quietSince >= SILENT_MS })
        return
      }
      case 'speech-error':
        this.update({ notice: { kind: 'error', message: frame.message } })
        return
      case 'replaced':
        void this.stop()
        return
    }
  }

  private send(frame: MicAsrUpFrame): void {
    try { this.handle?.send(frame) } catch (error) {
      void error // the stream already terminated; its iteration reports the failure
    }
  }

  /**
   * Drive speaker enrollment on the open stream.
   * @param action - begin or end one recording, or clear the enrollment.
   */
  enroll(action: 'begin' | 'end' | 'reset'): void {
    this.send({ type: 'enroll', action })
  }

  /** Close the stream and the microphone. */
  async stop(): Promise<void> {
    this.generation++
    await this.release()
    if (this.state.phase !== 'off') this.update(OFF)
  }

  private async release(): Promise<void> {
    const handle = this.handle
    const capture = this.capture
    this.handle = undefined
    this.capture = undefined
    this.insert = undefined
    handle?.dispose()
    await capture?.stop()
  }
}
