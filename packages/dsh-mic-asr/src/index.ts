/** dsh-mic-asr: microphone dictation for the dsh Web composer, with a speech-input worker and one browser stream per Host. */
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-subprocess'
// Type-only: the Loader's `loader/volatile-update` event.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { Remote, TypertRemoteService, type RemoteStream } from '@deepseek-ai/dsh-typert-protocol'
import { StreamChannel } from './channel.ts'
import { voiceParamsOf, voiceSchema, workerLimitFields, type VoiceFields, type WorkerLimits } from './config.ts'
import { DictationStream } from './dictation.ts'
import { EnrollmentFile, enrollmentSummary, syncEnrollment } from './enrollment.ts'
import { RuntimeInstaller, type RuntimeLayout } from './runtime.ts'
import type { MicAsrDownFrame, MicAsrRuntimeState, MicAsrStatus, MicAsrUpFrame } from './types.ts'
import { SpeechWorker } from './worker.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Microphone dictation controller. */
    micAsr: MicAsrController
  }
}

/** Optional overrides of the runtime files; an empty field uses the downloaded runtime. */
export interface PathOverrides {
  /** Worker executable. */
  workerPath: string
  /** Speech library (recognition, VAD, speaker verification). */
  asrLibrary: string
  /** Denoise library. */
  denoiseLibrary: string
  /** Recognition model directory. */
  asrModelDir: string
  /** VAD model directory. */
  vadModelDir: string
  /** Speaker model directory. */
  speakerModelDir: string
}

/** Runtime archive source. */
export interface RuntimeConfig {
  /** Download URL of the runtime archive. */
  url: string
  /** SHA-256 of the runtime archive. */
  sha256: string
}

/** Plugin configuration. */
export interface Config extends WorkerLimits {
  /** Data directory for the runtime, `speaker.json` and crash reports; empty uses `$DSH_HOME/dsh-mic-asr`. */
  dataRoot: string
  /** Runtime archive downloaded on first use; changes need a restart. */
  runtime: RuntimeConfig
  /** Runtime file overrides; changes need a restart. */
  paths: PathOverrides
  /** Voice processing; fields apply at the next segment. */
  voice: VoiceFields
}

/** Release asset of the runtime this version is built and tested with. */
const RUNTIME_URL = 'https://github.com/jiangbojin/dsh-mic-asr/releases/download/runtime-v1/dsh-mic-asr-runtime-v1-linux-x64.tar.gz'
const RUNTIME_SHA256 = '70cebf2623afcb69e02f725764f1dd8132af185c4ecbf9d2b0159631422036f5'

const optionalPath = z.string().default('')

interface ActiveStream {
  readonly dictation: DictationStream
  readonly replace: () => void
  /** Send the current readiness again. */
  readonly refresh: () => void
}

function defaultDataRoot(): string {
  const configured = process.env['DSH_HOME']?.trim()
  return join(configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh'), 'dsh-mic-asr')
}

/** Owns the runtime, the speech-input worker and the single active dictation stream. */
export default class MicAsrController extends TypertRemoteService {
  static inject = ['subprocess', 'typert']
  static Config = z.object({
    dataRoot: optionalPath.description('Data directory for the runtime, speaker enrollment and crash reports; empty uses $DSH_HOME/dsh-mic-asr'),
    runtime: z.object({
      url: z.string().default(RUNTIME_URL).description('Download URL of the runtime archive'),
      sha256: z.string().pattern(/^[0-9a-fA-F]{64}$/).default(RUNTIME_SHA256).description('SHA-256 of the runtime archive'),
    }),
    paths: z.object({
      workerPath: optionalPath.description('Worker executable; empty uses the runtime'),
      asrLibrary: optionalPath.description('Speech library; empty uses the runtime'),
      denoiseLibrary: optionalPath.description('Denoise library; empty uses the runtime'),
      asrModelDir: optionalPath.description('Recognition model directory; empty uses the runtime'),
      vadModelDir: optionalPath.description('VAD model directory; empty uses the runtime'),
      speakerModelDir: optionalPath.description('Speaker model directory; empty uses the runtime'),
    }),
    voice: voiceSchema,
    maxRestarts: workerLimitFields.maxRestarts,
    restartWindowMs: workerLimitFields.restartWindowMs,
    startupTimeoutMs: workerLimitFields.startupTimeoutMs,
    graceMs: workerLimitFields.graceMs,
    maxLogBytes: workerLimitFields.maxLogBytes,
    maxQueuedFrames: workerLimitFields.maxQueuedFrames,
  })

  private readonly dataRoot: string
  private readonly enrollment: EnrollmentFile
  private worker: SpeechWorker | undefined
  private runtime: MicAsrRuntimeState = { phase: 'checking' }
  private active: ActiveStream | undefined

  /**
   * @param ctx - Host context providing subprocesses and the Remote registry.
   * @param config - validated configuration; voice fields are volatile.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'micAsr', { namespace: 'micAsr' })
    this.dataRoot = config.dataRoot === '' ? defaultDataRoot() : config.dataRoot
    const overrides = Object.values(config.paths).filter(path => path !== '')
    for (const path of [...overrides, this.dataRoot]) {
      if (!isAbsolute(path)) throw new Error(`dsh-mic-asr paths must be absolute: ${path}`)
    }
    this.enrollment = new EnrollmentFile(this.dataRoot, ctx.logger, 'dsh-mic-asr')
    ctx.effect(() => {
      const abort = new AbortController()
      void this.prepare(abort.signal)
      return async () => {
        abort.abort()
        this.active?.replace()
        await this.worker?.stop()
      }
    }, 'dsh-mic-asr.worker')
    ctx.effect(() => ctx.on('loader/volatile-update', () => {
      if (this.worker?.alive === true) this.worker.voiceParams(voiceParamsOf(this.config.voice))
    }), 'dsh-mic-asr.volatile-update')
  }

  private setRuntime(state: MicAsrRuntimeState): void {
    this.runtime = state
    this.active?.refresh()
  }

  // Resolve the files (downloading the runtime unless every path is overridden), then start the worker.
  private async prepare(signal: AbortSignal): Promise<void> {
    const paths = this.config.paths
    let layout: RuntimeLayout
    try {
      let runtime: RuntimeLayout | undefined
      if (Object.values(paths).some(path => path === '')) {
        const installer = new RuntimeInstaller(this.ctx, { ...this.config.runtime, root: join(this.dataRoot, 'runtime') }, (state) => { this.setRuntime(state) })
        runtime = await installer.ensure(signal)
      }
      const pick = (override: string, fallback: string | undefined): string => override !== '' ? override : fallback as string
      layout = {
        workerPath: pick(paths.workerPath, runtime?.workerPath), asrLibrary: pick(paths.asrLibrary, runtime?.asrLibrary),
        denoiseLibrary: pick(paths.denoiseLibrary, runtime?.denoiseLibrary), asrModelDir: pick(paths.asrModelDir, runtime?.asrModelDir),
        vadModelDir: pick(paths.vadModelDir, runtime?.vadModelDir), speakerModelDir: pick(paths.speakerModelDir, runtime?.speakerModelDir),
      }
      for (const path of Object.values(layout)) {
        if (!existsSync(path)) throw new Error(`dsh-mic-asr path does not exist: ${path}`)
      }
    } catch (error) {
      if (signal.aborted) return
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger.error(`dsh-mic-asr: ${message}`)
      this.setRuntime({ phase: 'failed', error: message })
      return
    }
    if (signal.aborted) return
    await mkdir(join(this.dataRoot, 'crashes'), { recursive: true, mode: 0o700 }).catch((error: unknown) => {
      this.ctx.logger.warn('dsh-mic-asr: cannot create the crash directory', error)
    })
    const { workerPath, ...input } = layout
    const worker = new SpeechWorker(this.ctx, {
      workerPath, input, crashDir: join(this.dataRoot, 'crashes'), startupTimeoutMs: this.config.startupTimeoutMs,
      graceMs: this.config.graceMs, maxLogBytes: this.config.maxLogBytes, maxRestarts: this.config.maxRestarts,
      restartWindowMs: this.config.restartWindowMs, voiceParams: () => voiceParamsOf(this.config.voice),
    }, 'dsh-mic-asr')
    this.attach(worker)
    this.worker = worker
    this.runtime = { phase: 'ready' }
    worker.start()
    this.active?.refresh()
  }

  private attach(worker: SpeechWorker): void {
    let processPhase = worker.process.phase
    let inputPhase = worker.input.phase
    worker.onState(() => {
      const process = worker.process
      if (process.phase !== processPhase) {
        processPhase = process.phase
        if (process.phase === 'exited') this.ctx.logger.error(`dsh-mic-asr: ${process.error}`)
        if (process.phase === 'running' && this.active !== undefined) worker.resetStream()
      }
      const current = worker.input
      if (current.phase !== inputPhase) {
        inputPhase = current.phase
        if (current.phase === 'failed') this.ctx.logger.error(`dsh-mic-asr input: ${current.error}`)
        // Another plugin may enroll or clear the speaker in the shared file, so it is re-read here and per stream.
        if (current.phase === 'ready') void syncEnrollment(this.enrollment, worker)
      }
      this.active?.refresh()
    })
    worker.onFrame((frame) => {
      if (frame.type === 'enroll-status') {
        void this.enrollment.save(frame.event, frame.state)
        this.active?.refresh()
      }
      this.active?.dictation.workerFrame(frame)
    })
  }

  private snapshot(): MicAsrStatus {
    const worker = this.worker
    if (worker === undefined) {
      return { runtime: this.runtime, process: { phase: 'starting' }, input: { phase: 'starting' },
        enrollment: { enrolled: false, recording: false, segmentsOk: 0, pairScores: [] } }
    }
    return { runtime: this.runtime, process: worker.process, input: worker.input, enrollment: enrollmentSummary(worker.enrollment) }
  }

  /**
   * Read runtime, worker, input and enrollment readiness.
   * @returns the current status.
   */
  @Remote
  status(): MicAsrStatus {
    return this.snapshot()
  }

  /**
   * Open the dictation stream, replacing any other open stream.
   * @param signal - stream cancellation.
   * @returns readiness, then voice activity, partial and final texts, speaker scores, enrollment steps and input levels until the stream ends or is replaced.
   */
  @Remote({ mode: 'stream' })
  connect(signal: AbortSignal): RemoteStream<MicAsrDownFrame, MicAsrUpFrame> {
    return this.open(signal)
  }

  private async *open(signal: AbortSignal): AsyncGenerator<MicAsrDownFrame> {
    const invocation = this.ctx.invocation
    if (invocation === undefined) throw new Error('micAsr.connect ran outside a Remote call')
    const channel = new StreamChannel<MicAsrDownFrame>(this.config.maxQueuedFrames, 'dsh-mic-asr stream fell behind its downlink limit')
    const stream: ActiveStream = {
      dictation: new DictationStream((frame) => { channel.push(frame) }),
      replace: () => { channel.push({ type: 'replaced' }); channel.end() },
      refresh: () => { channel.push({ type: 'state', ...this.snapshot() }) },
    }
    this.active?.replace()
    this.active = stream
    stream.refresh()
    if (this.worker?.alive === true) this.worker.resetStream()
    if (this.worker !== undefined) void syncEnrollment(this.enrollment, this.worker)
    const uplink = (async () => {
      for await (const frame of invocation.uplink<MicAsrUpFrame>()) {
        if (this.active !== stream) return
        this.worker?.uplink(frame)
      }
    })()
    void uplink.catch((error: unknown) => { channel.fail(error instanceof Error ? error : new Error(String(error))) })
    try {
      yield * channel.drain(signal)
    } finally {
      if (this.active === stream) {
        this.active = undefined
        if (this.worker?.alive === true) this.worker.resetStream()
      }
    }
  }
}
