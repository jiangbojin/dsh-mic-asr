/** Wire and configuration types of the dsh-mic-asr Remote and its speech worker. */

/** Speech input libraries and models; paths are absolute. An empty asrLibrary disables input. */
export interface InputConfig {
  /** libbase_asr.so (ASR, VAD, speaker verification). */
  readonly asrLibrary: string
  /** libbase_denoise.so; empty disables denoise and therefore enrollment. */
  readonly denoiseLibrary: string
  /** ASR model directory. */
  readonly asrModelDir: string
  /** VAD model directory. */
  readonly vadModelDir: string
  /** Speaker verification model directory. */
  readonly speakerModelDir: string
}

/** Speech input readiness. */
export type SpeechInputState =
  | { readonly phase: 'disabled' }
  | { readonly phase: 'starting' }
  | { readonly phase: 'ready'; readonly hasDenoiser: boolean }
  | { readonly phase: 'failed'; readonly error: string }

/** Worker process lifetime; running starts at the frame that completes startup. */
export type SpeechProcessState =
  | { readonly phase: 'starting' }
  | { readonly phase: 'running' }
  | { readonly phase: 'exited'; readonly error: string }
  | { readonly phase: 'stopped' }

/** Speaker enrollment summary shown to the browser; embeddings stay on the Host. */
export interface SpeechEnrollment {
  readonly enrolled: boolean
  readonly recording: boolean
  /** Accepted recordings of the current round, out of three. */
  readonly segmentsOk: number
  /** Pairwise similarity of the three enrolled recordings. */
  readonly pairScores: readonly number[]
}

/** Availability of the binary runtime (worker, speech libraries and models). */
export type MicAsrRuntimeState =
  | { readonly phase: 'checking' }
  | { readonly phase: 'downloading'; readonly receivedBytes: number; readonly totalBytes: number | null }
  | { readonly phase: 'unpacking' }
  | { readonly phase: 'ready' }
  | { readonly phase: 'failed'; readonly error: string }

/** Readiness of the dictation worker. */
export interface MicAsrStatus {
  readonly runtime: MicAsrRuntimeState
  readonly process: SpeechProcessState
  readonly input: SpeechInputState
  readonly enrollment: SpeechEnrollment
}

/** Host-to-browser item of the dictation stream. */
export type MicAsrDownFrame =
  | ({ readonly type: 'state' } & MicAsrStatus)
  /** Voice activity of one segment. */
  | { readonly type: 'speech'; readonly phase: 'start' | 'end'; readonly segment: number }
  | { readonly type: 'partial'; readonly segment: number; readonly text: string }
  /**
   * Final text of a segment. reason insert tells the browser to insert the text into the composer;
   * not-verified marks a speaker that verification rejected, or any speaker while unenrolled; empty marks no text.
   */
  | { readonly type: 'final'; readonly segment: number; readonly text: string; readonly reason: 'insert' | 'not-verified' | 'empty'
    /** Latest speaker score of the segment; null when it was not scored (unenrolled, or too short). */
    readonly score: number | null
    /** From the end of speech to the final text; null when the worker did not time it. */
    readonly endToFinalMs: number | null }
  /** A speaker score of the segment being spoken; decisive marks the score that decided acceptance. */
  | { readonly type: 'score'; readonly segment: number; readonly score: number; readonly accepted: boolean; readonly decisive: boolean }
  /** An enrollment step or change, with the worker's message. */
  | { readonly type: 'enroll'; readonly event: string; readonly message: string; readonly enrollment: SpeechEnrollment }
  /** Input levels in dBFS before and after denoise, about ten times per second. */
  | { readonly type: 'level'; readonly rawDbfs: number; readonly outDbfs: number; readonly inSegment: boolean }
  /** A recognition error of one segment; the stream continues. */
  | { readonly type: 'speech-error'; readonly message: string }
  /** Another browser took over dictation; this stream ends. */
  | { readonly type: 'replaced' }

/** Browser-to-Host item of the dictation stream: 16 kHz mono 16-bit little-endian microphone samples in base64, or an enrollment action. */
export type MicAsrUpFrame =
  | { readonly type: 'audio'; readonly samples: string }
  | { readonly type: 'enroll'; readonly action: 'begin' | 'end' | 'reset' }
