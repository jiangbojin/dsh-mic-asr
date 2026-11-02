/** Configuration fields of speech input shared by the plugins that run the speech worker. */
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { VoiceParams } from './protocol.ts'

/** Voice-processing configuration fields; each applies at the next segment without restarting the worker. */
export interface VoiceFields {
  /** VAD speech probability threshold in [0, 1]. */
  vadThreshold: Volatile<number>
  /** Speech needed to open a segment. */
  vadMinSpeechMs: Volatile<number>
  /** Silence that ends a segment; shorter pauses keep it open. */
  vadMinSilenceMs: Volatile<number>
  /** Recognizer chunk length, 160 or 480. */
  asrChunkMs: Volatile<number>
  /** Audio before the VAD start also sent to the recognizer. */
  asrPrerollMs: Volatile<number>
  /** Voice activity alone counts as accepted speech; no speaker verification. */
  vadBarge: Volatile<boolean>
  /** Speaker verification threshold in [-1, 1]. */
  speakerThreshold: Volatile<number>
  /** Speech used for early speaker verification. */
  verifyMs: Volatile<number>
  /** Denoise before VAD and recognition. */
  denoise: Volatile<boolean>
}

/** Voice-processing fields; each applies at the next segment without restarting the worker. */
export const voiceSchema = z.object({
  vadThreshold: z.number().min(0).max(1).default(0.5).volatile().description('VAD speech probability threshold'),
  vadMinSpeechMs: z.natural().default(100).volatile().description('Speech needed to open a segment'),
  vadMinSilenceMs: z.natural().default(300).volatile().description('Mid-sentence pause: silence shorter than this keeps one speech segment open'),
  asrChunkMs: z.union([160, 480]).default(480).volatile().description('Recognizer chunk length'),
  asrPrerollMs: z.natural().default(200).volatile().description('Audio before the VAD start also sent to the recognizer'),
  vadBarge: z.boolean().default(false).volatile().description('Voice activity alone counts as accepted speech'),
  speakerThreshold: z.number().min(-1).max(1).default(0.5).volatile().description('Speaker verification threshold'),
  verifyMs: z.natural().min(100).default(3000).volatile().description('Speech used for early speaker verification'),
  denoise: z.boolean().default(true).volatile().description('Denoise before VAD and recognition'),
})

/** Worker process and stream limits of the plugins that run the speech worker. */
export interface WorkerLimits {
  /** Automatic restarts after unexpected worker exits allowed within restartWindowMs. */
  maxRestarts: number
  /** Window over which maxRestarts is counted. */
  restartWindowMs: number
  /** Worker readiness deadline, covering model loading. */
  startupTimeoutMs: number
  /** Grace period between closing the worker's stdin and terminating it. */
  graceMs: number
  /** Retained worker stderr bytes reported when it exits. */
  maxLogBytes: number
  /** Downlink items buffered for one stream before it fails. */
  maxQueuedFrames: number
}

/** Schema fields of {@link WorkerLimits}; each plugin schema names every field. */
export const workerLimitFields = {
  maxRestarts: z.natural().default(3).description('Automatic restarts after unexpected worker exits within restartWindowMs'),
  restartWindowMs: z.natural().min(1).default(600_000),
  startupTimeoutMs: z.natural().min(1).default(60_000),
  graceMs: z.natural().min(1).default(3_000),
  maxLogBytes: z.natural().min(1024).default(64 * 1024),
  maxQueuedFrames: z.natural().min(16).default(2_000),
}

/**
 * Read the current voice parameters.
 * @param voice - volatile voice fields.
 * @returns the parameter set sent to the worker.
 */
export function voiceParamsOf(voice: VoiceFields): VoiceParams {
  return { vadThreshold: voice.vadThreshold.get(), vadMinSpeechMs: voice.vadMinSpeechMs.get(), vadMinSilenceMs: voice.vadMinSilenceMs.get(),
    asrChunkMs: voice.asrChunkMs.get(), asrPrerollMs: voice.asrPrerollMs.get(), vadBarge: voice.vadBarge.get(),
    speakerThreshold: voice.speakerThreshold.get(), verifyMs: voice.verifyMs.get(), denoise: voice.denoise.get() }
}
