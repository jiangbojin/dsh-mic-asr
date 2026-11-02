/** Microphone capture at 16 kHz through an AudioWorklet, delivered as 20 ms blocks of 16-bit samples. */

const PROCESSOR = 'mic-asr-capture'
const BLOCK = 320

// Collects 20 ms of the context's 16 kHz input and posts each block as 16-bit little-endian samples.
const WORKLET_SOURCE = `
class MicAsrCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.block = new Int16Array(${BLOCK})
    this.size = 0
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0]
    if (!input) return true
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]))
      this.block[this.size++] = s < 0 ? s * 32768 : s * 32767
      if (this.size === ${BLOCK}) {
        this.port.postMessage(this.block.buffer, [this.block.buffer])
        this.block = new Int16Array(${BLOCK})
        this.size = 0
      }
    }
    return true
  }
}
registerProcessor('${PROCESSOR}', MicAsrCapture)
`

function base64(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i] as number)
  return btoa(text)
}

/** One microphone stream; create from a user gesture. */
export class Capture {
  private context: AudioContext | undefined
  private stream: MediaStream | undefined

  /**
   * @param deliver - receives each 20 ms block as base64 16-bit little-endian samples.
   * @param deviceId - microphone id; empty for the system default.
   */
  constructor(private readonly deliver: (samples: string) => void, private readonly deviceId: string) {}

  /** Request the microphone and start delivering blocks. */
  async start(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      // Browser 3A (echo cancellation, noise suppression, gain control) stays off: the Host denoises with its own model.
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        ...this.deviceId === '' ? {} : { deviceId: { exact: this.deviceId } } },
    })
    this.stream = stream
    const context = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' })
    this.context = context
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }))
    try { await context.audioWorklet.addModule(url) } finally { URL.revokeObjectURL(url) }
    const node = new AudioWorkletNode(context, PROCESSOR, { numberOfOutputs: 0 })
    node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => { this.deliver(base64(new Uint8Array(event.data))) }
    context.createMediaStreamSource(stream).connect(node)
    await context.resume()
  }

  /** Stop the microphone and release the AudioContext. */
  async stop(): Promise<void> {
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = undefined
    await this.context?.close()
    this.context = undefined
  }
}
