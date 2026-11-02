/** Lifetime of the native speech worker process, its stdio frame channel and its automatic restarts. */
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { decodeInputFrame, encodeAudio, encodeEnroll, encodeEnrollRestore, encodeResetStream, encodeVoiceParams, FrameDecoder,
  type EnrollmentState, type InputFrame, type VoiceParams } from './protocol.ts'
import type { InputConfig, SpeechInputState, SpeechProcessState } from './types.ts'

/** Worker launch settings resolved from a plugin configuration. */
export interface SpeechWorkerLaunch {
  /** Worker executable (`dsh-mic-asr-worker`). */
  readonly workerPath: string
  readonly input: InputConfig
  /** Directory for crash backtraces and the last minute of uplink audio; empty disables the files. */
  readonly crashDir: string
  readonly startupTimeoutMs: number
  readonly graceMs: number
  readonly maxLogBytes: number
  /** Automatic restarts after unexpected exits allowed within restartWindowMs. */
  readonly maxRestarts: number
  readonly restartWindowMs: number
  /** Voice parameters sent after every start; read at that moment. */
  readonly voiceParams: () => VoiceParams
}

/** Largest uplink audio item, one second of 16 kHz 16-bit samples. */
const MAX_AUDIO_BYTES = 32_000

/** A browser item that feeds speech input. */
export type SpeechUplinkItem =
  /** 16 kHz mono 16-bit little-endian microphone samples, base64. */
  | { readonly type: 'audio'; readonly samples: string }
  /** Begin or end one live enrollment recording, or clear the enrollment. */
  | { readonly type: 'enroll'; readonly action: 'begin' | 'end' | 'reset' }

/** Delay before restarting a worker that exited unexpectedly. */
const RESTART_DELAY_MS = 2_000

const EMPTY_ENROLLMENT: EnrollmentState = { recording: false, enrolled: false, denoiseAtEnroll: false, segmentsOk: 0, embeddings: [], durations: [], pairScores: [] }

/**
 * Command-line options of speech input passed to `dsh-mic-asr-worker serve`.
 * @param input - speech input settings.
 * @returns `--name=value` arguments; none when the ASR library is empty.
 */
export function inputArguments(input: InputConfig): string[] {
  return input.asrLibrary === '' ? [] : [
    `--asr-library=${input.asrLibrary}`,
    `--denoise-library=${input.denoiseLibrary}`,
    `--asr-model-dir=${input.asrModelDir}`,
    `--vad-model-dir=${input.vadModelDir}`,
    `--speaker-model-dir=${input.speakerModelDir}`,
  ]
}

type Routed<F> = { readonly input: InputFrame } | { readonly extra: F }

/**
 * One worker process at a time; start() after an exit launches a fresh process, and an unexpected exit restarts it
 * within the configured budget. Subclasses add frame types through decodeExtra and receive.
 */
export class SpeechWorker<F = never> {
  private handle: SubprocessHandle | undefined
  private decoder: FrameDecoder<Routed<F>>
  private readonly frameListeners = new Set<(frame: InputFrame | F) => void>()
  private readonly stateListeners = new Set<() => void>()
  private processState: SpeechProcessState = { phase: 'starting' }
  private inputState: SpeechInputState
  private readonly restartTimes: number[] = []
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  /** Latest enrollment reported by the worker. */
  enrollment: EnrollmentState = EMPTY_ENROLLMENT

  /**
   * @param ctx - context providing subprocesses and the logger.
   * @param launch - launch, restart and parameter settings.
   * @param label - name used in logs and failure texts.
   */
  constructor(protected readonly ctx: Context, private readonly launch: SpeechWorkerLaunch, protected readonly label: string) {
    this.inputState = launch.input.asrLibrary === '' ? { phase: 'disabled' } : { phase: 'starting' }
    this.decoder = this.newDecoder()
  }

  /**
   * Read the process lifetime.
   * @returns the latest published process state.
   */
  get process(): SpeechProcessState { return this.processState }

  /**
   * Read speech input readiness.
   * @returns the latest published input state.
   */
  get input(): SpeechInputState { return this.inputState }

  /**
   * Count recent automatic restarts.
   * @returns unexpected exits restarted within the restart window.
   */
  get restartsInWindow(): number { return this.restartTimes.length }

  /**
   * Tell whether frames can be written.
   * @returns whether the process accepts frames (starting or running).
   */
  get alive(): boolean { return this.processState.phase === 'starting' || this.processState.phase === 'running' }

  /**
   * Observe state changes.
   * @param listener - invalidation callback.
   * @returns disposer.
   */
  onState(listener: () => void): () => void {
    this.stateListeners.add(listener)
    return () => { this.stateListeners.delete(listener) }
  }

  /**
   * Observe frames.
   * @param listener - called for log, voice event, voice statistics and enrollment status frames, and the subclass frames it emits.
   * @returns disposer.
   */
  onFrame(listener: (frame: InputFrame | F) => void): () => void {
    this.frameListeners.add(listener)
    return () => { this.frameListeners.delete(listener) }
  }

  /** @returns arguments beyond speech input. */
  protected extraArguments(): string[] { return [] }

  /**
   * Decode a frame type outside speech input.
   * @param _type - frame type code.
   * @param _payload - frame payload.
   * @returns the frame, or undefined when the type is not the subclass's.
   */
  protected decodeExtra(_type: number, _payload: Buffer): F | undefined { return undefined }

  /** @param _frame - a frame decoded by decodeExtra. */
  protected receive(_frame: F): void {}

  /** @returns whether input readiness completes startup; subclasses that report their own readiness return false. */
  protected startsOnInputReady(): boolean { return true }

  /** @param _reason - failure text of an unexpected exit; pending requests fail with it. */
  protected exited(_reason: string): void {}

  /** @param frame - forwarded to frame listeners. */
  protected emit(frame: InputFrame | F): void {
    for (const listener of this.frameListeners) listener(frame)
  }

  /** @param state - new process state, published to state listeners. */
  protected publishProcess(state: SpeechProcessState): void {
    this.processState = state
    if (state.phase === 'exited' && this.inputState.phase !== 'disabled') this.inputState = { phase: 'failed', error: state.error }
    this.notify()
  }

  /** Tell state listeners about a change. */
  protected notify(): void {
    for (const listener of this.stateListeners) listener()
  }

  private newDecoder(): FrameDecoder<Routed<F>> {
    return new FrameDecoder<Routed<F>>((type, payload) => {
      const extra = this.decodeExtra(type, payload)
      if (extra !== undefined) return { extra }
      const input = decodeInputFrame(type, payload)
      return input === undefined ? undefined : { input }
    })
  }

  /** Spawn the worker and send the current voice parameters. */
  start(): void {
    clearTimeout(this.restartTimer)
    this.restartTimer = undefined
    this.decoder = this.newDecoder()
    // A new process starts unenrolled; its owner restores the saved enrollment once input is ready.
    this.enrollment = EMPTY_ENROLLMENT
    this.processState = { phase: 'starting' }
    if (this.inputState.phase !== 'disabled') this.inputState = { phase: 'starting' }
    const handle = this.ctx.subprocess.spawn({
      argv: [this.launch.workerPath, 'serve', ...inputArguments(this.launch.input), ...this.extraArguments(),
        ...this.launch.crashDir === '' ? [] : [`--crash-dir=${this.launch.crashDir}`]],
      cwd: this.launch.workerPath.slice(0, this.launch.workerPath.lastIndexOf('/')) || '/',
      graceMs: this.launch.graceMs,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: this.launch.maxLogBytes } },
    })
    this.handle = handle
    const startup = setTimeout(() => {
      if (this.processState.phase === 'starting') this.fail(`${this.label} worker did not report readiness within ${String(this.launch.startupTimeoutMs)} ms`)
    }, this.launch.startupTimeoutMs)
    handle.stdout?.on('data', (chunk: Buffer) => {
      if (this.handle !== handle) return
      let frames: Routed<F>[]
      try { frames = this.decoder.push(chunk) } catch (error) {
        this.fail(error instanceof Error ? error.message : String(error))
        return
      }
      for (const frame of frames) {
        if ('extra' in frame) this.receive(frame.extra)
        else this.dispatch(frame.input)
      }
    })
    handle.stdin?.on('error', (error: Error) => { this.ctx.logger.warn(`${this.label} worker stdin failed`, error) })
    void handle.done.then((outcome) => {
      clearTimeout(startup)
      if (this.handle !== handle) return
      const stderr = handle.collected.stderr?.readFrom(0).text.trim() ?? ''
      const reason = `${this.label} worker exited (code ${String(outcome.exitCode)}, signal ${String(outcome.signal)})${stderr === '' ? '' : `: ${stderr}`}`
      if (this.processState.phase !== 'stopped') {
        this.publishProcess({ phase: 'exited', error: reason })
        this.scheduleRestart()
      }
      this.exited(reason)
    })
    void handle.done.finally(() => { clearTimeout(startup) })
    this.write(encodeVoiceParams(this.launch.voiceParams()))
  }

  private scheduleRestart(): void {
    if (this.restartTimer !== undefined) return
    const now = Date.now()
    while (this.restartTimes.length > 0 && now - (this.restartTimes[0] as number) > this.launch.restartWindowMs) this.restartTimes.shift()
    if (this.restartTimes.length >= this.launch.maxRestarts) return
    this.restartTimes.push(now)
    this.ctx.logger.warn(`${this.label}: restarting the worker (${String(this.restartTimes.length)}/${String(this.launch.maxRestarts)} within the window)`)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      if (this.processState.phase === 'exited') this.start()
    }, RESTART_DELAY_MS)
  }

  private fail(message: string): void {
    this.publishProcess({ phase: 'exited', error: message })
    this.handle?.terminate()
  }

  private dispatch(frame: InputFrame): void {
    switch (frame.type) {
      case 'log':
        if (frame.level >= 2) this.ctx.logger.error(`${this.label} worker: ${frame.text}`)
        else if (frame.level === 1) this.ctx.logger.warn(`${this.label} worker: ${frame.text}`)
        else this.ctx.logger.info(`${this.label} worker: ${frame.text}`)
        this.emit(frame)
        return
      case 'input-ready':
        if (this.inputState.phase === 'disabled') return
        this.inputState = frame.ok ? { phase: 'ready', hasDenoiser: frame.hasDenoiser } : { phase: 'failed', error: frame.error }
        if (this.startsOnInputReady() && this.processState.phase === 'starting') this.processState = { phase: 'running' }
        this.notify()
        return
      case 'enroll-status':
        this.enrollment = frame.state
        this.emit(frame)
        return
      case 'voice-event':
      case 'voice-stats':
        this.emit(frame)
        return
    }
  }

  /**
   * Write one frame.
   * @param bytes - encoded frame.
   */
  protected write(bytes: Buffer): void {
    const stdin = this.handle?.stdin
    if (stdin === undefined || stdin.destroyed || !this.alive) throw new Error(`${this.label} worker is not running`)
    stdin.write(bytes)
  }

  /**
   * Apply one browser item; items arriving before input is ready, or after the process ended, are dropped.
   * @param item - audio or an enrollment action.
   * @throws {Error} for audio that is not whole 16-bit samples or exceeds one second.
   */
  uplink(item: SpeechUplinkItem): void {
    const ready = this.inputState.phase === 'ready' && this.alive
    switch (item.type) {
      case 'audio': {
        const samples = Buffer.from(item.samples, 'base64')
        if (samples.length % 2 !== 0 || samples.length > MAX_AUDIO_BYTES) throw new Error(`${this.label} audio items carry at most one second of 16-bit samples`)
        if (ready) this.audio(samples)
        return
      }
      case 'enroll':
        if (ready) this.enroll(item.action)
        return
    }
  }

  /**
   * Send microphone audio.
   * @param samples - 16 kHz mono 16-bit little-endian microphone bytes.
   */
  audio(samples: Buffer): void { this.write(encodeAudio(samples)) }

  /**
   * Send voice-processing parameters.
   * @param params - parameters applied in order with audio.
   */
  voiceParams(params: VoiceParams): void { this.write(encodeVoiceParams(params)) }

  /**
   * Drive speaker enrollment.
   * @param action - begin or end one live recording, or clear the enrollment.
   */
  enroll(action: 'begin' | 'end' | 'reset'): void { this.write(encodeEnroll(action)) }

  /**
   * Install a saved enrollment.
   * @param state - saved enrollment.
   */
  restoreEnrollment(state: EnrollmentState): void { this.write(encodeEnrollRestore(state)) }

  /** End any open segment and reset recognition for a new microphone stream. */
  resetStream(): void { this.write(encodeResetStream()) }

  /** Cancel a pending restart, close stdin, then terminate after the grace period. @returns after the process exits. */
  async stop(): Promise<void> {
    clearTimeout(this.restartTimer)
    this.restartTimer = undefined
    const handle = this.handle
    if (handle === undefined) return
    this.publishProcess({ phase: 'stopped' })
    handle.stdin?.end()
    const exited = await handle.waitForExit(AbortSignal.timeout(this.launch.graceMs)).catch(() => false)
    if (!exited) {
      handle.terminate()
      await handle.waitForExit()
    }
  }
}
