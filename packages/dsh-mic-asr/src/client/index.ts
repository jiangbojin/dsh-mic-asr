/** Browser entry for the micCapture service, the mic-asr Remote and the composer-toolbar microphone. */
import type { Context } from '@deepseek-ai/cordis'
import micAsrRemote from 'dsh-mic-asr/remote'
import { mountMicAsr } from './mount.ts'

export { inject } from './mount.ts'
export type { Capture } from './capture.ts'
export type { AudioDevice, MicrophoneSnapshot, MicrophoneStore } from './microphones.ts'
export type { MicCaptureService } from './service.ts'

/**
 * Activate the dictation control.
 * @param ctx - Client runtime.
 * @returns complete UI and Remote disposer.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await mountMicAsr(ctx, micAsrRemote)
}
