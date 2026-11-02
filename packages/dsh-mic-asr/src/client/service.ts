/** The micCapture browser service: the microphone choice and capture shared by the voice plugins of a window. */
import { Capture } from './capture.ts'
import type { MicrophoneStore } from './microphones.ts'

/** Microphone access shared by the voice plugins of this window. */
export interface MicCaptureService {
  /** Microphone choice of this browser. */
  readonly microphones: MicrophoneStore
  /**
   * Prepare a capture of the chosen microphone; call its start() from a user gesture.
   * @param deliver - receives each 20 ms block as base64 16-bit little-endian samples.
   * @returns the capture, not yet started.
   */
  open(deliver: (samples: string) => void): Capture
}

/**
 * Build the service over one microphone store.
 * @param microphones - the window's microphone choice.
 * @returns the service.
 */
export function micCaptureService(microphones: MicrophoneStore): MicCaptureService {
  return { microphones, open: deliver => new Capture(deliver, microphones.getSnapshot().microphone) }
}
