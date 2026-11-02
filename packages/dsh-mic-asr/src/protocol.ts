/** Speech-input frames of the native worker's binary stdio protocol; mirrors `native/src/protocol.h`. */

/** Largest payload either side accepts. */
export const MAX_PAYLOAD_BYTES = 1 << 20

/** Frame type codes of speech input. */
export const InputFrameType = {
  audio: 5,
  voiceParams: 6,
  enroll: 7,
  enrollRestore: 8,
  resetStream: 9,
  log: 105,
  inputReady: 106,
  voiceEvent: 107,
  enrollStatus: 108,
  voiceStats: 109,
} as const

/** VoiceEventKind values of voice event frames. */
export const VoiceEventKind = { speechStart: 1, speechEnd: 2, partial: 3, score: 4, final: 5, error: 6 } as const

/** Voice-processing parameters; mirrors the worker's VoiceParams. */
export interface VoiceParams {
  /** VAD speech probability threshold in [0, 1]. */
  readonly vadThreshold: number
  /** Speech needed to open a segment. */
  readonly vadMinSpeechMs: number
  /** Silence that ends a segment; shorter pauses keep it open. */
  readonly vadMinSilenceMs: number
  /** Recognizer chunk length, 160 or 480. */
  readonly asrChunkMs: number
  /** Audio before the VAD start also sent to the recognizer. */
  readonly asrPrerollMs: number
  /** Voice activity alone counts as accepted speech; no speaker verification. */
  readonly vadBarge: boolean
  /** Speaker verification threshold in [-1, 1]. */
  readonly speakerThreshold: number
  /** Speech used for early speaker verification. */
  readonly verifyMs: number
  /** Denoise before VAD and recognition. */
  readonly denoise: boolean
}

/** Speaker enrollment as the worker reports and restores it. */
export interface EnrollmentState {
  readonly recording: boolean
  readonly enrolled: boolean
  readonly denoiseAtEnroll: boolean
  readonly segmentsOk: number
  readonly embeddings: readonly (readonly number[])[]
  readonly durations: readonly number[]
  readonly pairScores: readonly number[]
}

/** A decoded speech-input frame of the worker. */
export type InputFrame =
  | { readonly type: 'log'; readonly level: number; readonly text: string }
  | { readonly type: 'input-ready'; readonly ok: boolean; readonly hasDenoiser: boolean; readonly error: string }
  | { readonly type: 'voice-event'; readonly event: VoiceEvent }
  | { readonly type: 'enroll-status'; readonly event: string; readonly message: string; readonly state: EnrollmentState }
  | { readonly type: 'voice-stats'; readonly rawDbfs: number; readonly outDbfs: number; readonly inSegment: boolean; readonly segmentSeconds: number; readonly frames: bigint; readonly droppedSamples: bigint }

/** A decoded voice event of one VAD segment. */
export type VoiceEvent =
  | { readonly kind: 'speech-start'; readonly segment: bigint; readonly bargeEnabled: boolean; readonly onsetNs: bigint; readonly confirmNs: bigint }
  | { readonly kind: 'speech-end'; readonly segment: bigint; readonly durationSeconds: number; readonly speechEndNs: bigint }
  | { readonly kind: 'partial'; readonly segment: bigint; readonly text: string }
  | { readonly kind: 'score'; readonly segment: bigint; readonly stage: number; readonly score: number; readonly accepted: boolean; readonly decisive: boolean; readonly audioSeconds: number }
  | { readonly kind: 'final'; readonly segment: bigint; readonly accepted: boolean; readonly speechEndNs: bigint; readonly finalNs: bigint; readonly text: string }
  | { readonly kind: 'error'; readonly segment: bigint; readonly text: string }

/**
 * Prefix a payload with the frame header.
 * @param type - frame type code.
 * @param payload - frame payload.
 * @returns one frame.
 */
export function encodeFrame(type: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(6)
  header.writeUInt32LE(payload.length, 0)
  header.writeUInt16LE(type, 4)
  return Buffer.concat([header, payload])
}

/**
 * Encode 16 kHz mono uplink samples.
 * @param samples - 16-bit little-endian PCM bytes.
 * @returns one frame.
 */
export function encodeAudio(samples: Buffer): Buffer {
  return encodeFrame(InputFrameType.audio, samples)
}

/**
 * Encode voice-processing parameters.
 * @param params - complete parameter set.
 * @returns one frame.
 */
export function encodeVoiceParams(params: VoiceParams): Buffer {
  const payload = Buffer.alloc(30)
  payload.writeFloatLE(params.vadThreshold, 0)
  payload.writeInt32LE(params.vadMinSpeechMs, 4)
  payload.writeInt32LE(params.vadMinSilenceMs, 8)
  payload.writeInt32LE(params.asrChunkMs, 12)
  payload.writeInt32LE(params.asrPrerollMs, 16)
  payload.writeUInt8(params.vadBarge ? 1 : 0, 20)
  payload.writeFloatLE(params.speakerThreshold, 21)
  payload.writeInt32LE(params.verifyMs, 25)
  payload.writeUInt8(params.denoise ? 1 : 0, 29)
  return encodeFrame(InputFrameType.voiceParams, payload)
}

/**
 * Encode an enrollment action.
 * @param action - begin or end one live recording, or clear the enrollment.
 * @returns one frame.
 */
export function encodeEnroll(action: 'begin' | 'end' | 'reset'): Buffer {
  return encodeFrame(InputFrameType.enroll, Buffer.from([action === 'begin' ? 1 : action === 'end' ? 2 : 3]))
}

/**
 * Encode a saved enrollment.
 * @param state - embeddings, durations and the denoise setting at enrollment.
 * @returns one frame.
 */
export function encodeEnrollRestore(state: EnrollmentState): Buffer {
  const dim = state.embeddings[0]?.length ?? 0
  const payload = Buffer.alloc(9 + state.embeddings.length * dim * 4 + 4 + state.durations.length * 8)
  let at = payload.writeUInt8(state.denoiseAtEnroll ? 1 : 0, 0)
  at = payload.writeUInt32LE(state.embeddings.length, at)
  at = payload.writeUInt32LE(dim, at)
  for (const embedding of state.embeddings) for (const value of embedding) at = payload.writeFloatLE(value, at)
  at = payload.writeUInt32LE(state.durations.length, at)
  for (const value of state.durations) at = payload.writeDoubleLE(value, at)
  return encodeFrame(InputFrameType.enrollRestore, payload)
}

/**
 * Encode a stream reset.
 * @returns a frame that ends any open segment and resets recognition for a new audio stream.
 */
export function encodeResetStream(): Buffer {
  return encodeFrame(InputFrameType.resetStream, Buffer.alloc(0))
}

function decodeVoiceEvent(payload: Buffer): VoiceEvent {
  const kind = payload.readUInt8(0)
  const segment = payload.readBigUInt64LE(1)
  const rest = payload.subarray(9)
  switch (kind) {
    case VoiceEventKind.speechStart:
      return { kind: 'speech-start', segment, bargeEnabled: rest.readUInt8(0) === 1, onsetNs: rest.readBigInt64LE(1), confirmNs: rest.readBigInt64LE(9) }
    case VoiceEventKind.speechEnd:
      return { kind: 'speech-end', segment, durationSeconds: rest.readDoubleLE(0), speechEndNs: rest.readBigInt64LE(8) }
    case VoiceEventKind.partial:
      return { kind: 'partial', segment, text: rest.toString('utf8') }
    case VoiceEventKind.score:
      return { kind: 'score', segment, stage: rest.readUInt8(0), score: rest.readFloatLE(1), accepted: rest.readUInt8(5) === 1,
        decisive: rest.readUInt8(6) === 1, audioSeconds: rest.readDoubleLE(7) }
    case VoiceEventKind.final:
      return { kind: 'final', segment, accepted: rest.readUInt8(0) === 1, speechEndNs: rest.readBigInt64LE(1), finalNs: rest.readBigInt64LE(9),
        text: rest.subarray(17).toString('utf8') }
    case VoiceEventKind.error:
      return { kind: 'error', segment, text: rest.toString('utf8') }
    default:
      throw new Error(`Unknown voice event kind ${String(kind)}`)
  }
}

function decodeEnrollStatus(payload: Buffer): InputFrame {
  let at = 0
  const recording = payload.readUInt8(at++) === 1
  const enrolled = payload.readUInt8(at++) === 1
  const denoiseAtEnroll = payload.readUInt8(at++) === 1
  const segmentsOk = payload.readUInt32LE(at); at += 4
  const count = payload.readUInt32LE(at); at += 4
  const dim = payload.readUInt32LE(at); at += 4
  const embeddings: number[][] = []
  for (let i = 0; i < count; i++) {
    const embedding: number[] = []
    for (let j = 0; j < dim; j++) { embedding.push(payload.readFloatLE(at)); at += 4 }
    embeddings.push(embedding)
  }
  const readDoubles = (): number[] => {
    const count = payload.readUInt32LE(at)
    at += 4
    const values: number[] = []
    for (let i = 0; i < count; i++) { values.push(payload.readDoubleLE(at)); at += 8 }
    return values
  }
  const durations = readDoubles()
  const pairScores = readDoubles()
  const eventBytes = payload.readUInt16LE(at); at += 2
  const event = payload.subarray(at, at + eventBytes).toString('utf8')
  const message = payload.subarray(at + eventBytes).toString('utf8')
  return { type: 'enroll-status', event, message, state: { recording, enrolled, denoiseAtEnroll, segmentsOk, embeddings, durations, pairScores } }
}

/**
 * Decode a speech-input frame.
 * @param type - frame type code.
 * @param payload - frame payload.
 * @returns the frame, or undefined for a type outside speech input.
 */
export function decodeInputFrame(type: number, payload: Buffer): InputFrame | undefined {
  switch (type) {
    case InputFrameType.log:
      return { type: 'log', level: payload.readUInt8(0), text: payload.subarray(1).toString('utf8') }
    case InputFrameType.inputReady:
      return { type: 'input-ready', ok: payload.readUInt8(0) === 1, hasDenoiser: payload.readUInt8(1) === 1, error: payload.subarray(2).toString('utf8') }
    case InputFrameType.voiceEvent:
      return { type: 'voice-event', event: decodeVoiceEvent(payload) }
    case InputFrameType.enrollStatus:
      return decodeEnrollStatus(payload)
    case InputFrameType.voiceStats:
      return { type: 'voice-stats', rawDbfs: payload.readFloatLE(0), outDbfs: payload.readFloatLE(4), inSegment: payload.readUInt8(8) === 1,
        segmentSeconds: payload.readFloatLE(9), frames: payload.readBigUInt64LE(13), droppedSamples: payload.readBigUInt64LE(21) }
    default:
      return undefined
  }
}

/** Incremental decoder for the worker's stdout byte stream. */
export class FrameDecoder<F> {
  private buffered: Buffer = Buffer.alloc(0)

  /** @param decode - decodes one frame; undefined marks an unknown type, which fails the stream. */
  constructor(private readonly decode: (type: number, payload: Buffer) => F | undefined) {}

  /**
   * Append bytes and decode every complete frame.
   * @param chunk - stdout bytes.
   * @returns complete frames in order; malformed and unknown frames throw.
   */
  push(chunk: Buffer): F[] {
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk])
    const frames: F[] = []
    while (this.buffered.length >= 6) {
      const size = this.buffered.readUInt32LE(0)
      if (size > MAX_PAYLOAD_BYTES) throw new Error(`Speech worker frame of ${String(size)} bytes exceeds the limit`)
      if (this.buffered.length < 6 + size) break
      const type = this.buffered.readUInt16LE(4)
      const frame = this.decode(type, this.buffered.subarray(6, 6 + size))
      if (frame === undefined) throw new Error(`Unknown speech worker frame type ${String(type)}`)
      frames.push(frame)
      this.buffered = this.buffered.subarray(6 + size)
    }
    return frames
  }
}
