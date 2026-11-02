/** Per-stream translation of worker voice frames into dictation items. */
import { enrollmentSummary } from './enrollment.ts'
import type { InputFrame, VoiceEvent } from './protocol.ts'
import type { MicAsrDownFrame } from './types.ts'

/** Browser item reporting input levels or an enrollment step. */
export type InputStatusItem = Extract<MicAsrDownFrame, { type: 'level' | 'enroll' }>

/**
 * Translate a statistics or enrollment frame into its browser item.
 * @param frame - any worker frame.
 * @returns the item, or undefined for other frames.
 */
export function inputStatusItem(frame: InputFrame): InputStatusItem | undefined {
  switch (frame.type) {
    case 'voice-stats':
      return { type: 'level', rawDbfs: frame.rawDbfs, outDbfs: frame.outDbfs, inSegment: frame.inSegment }
    case 'enroll-status':
      return { type: 'enroll', event: frame.event, message: frame.message, enrollment: enrollmentSummary(frame.state) }
    default:
      return undefined
  }
}

/** One dictation stream; the controller forwards worker frames to it. */
export class DictationStream {
  /** Latest speaker score per open segment. */
  private readonly scores = new Map<bigint, number>()

  /** @param send - downlink of the stream. */
  constructor(private readonly send: (frame: MicAsrDownFrame) => void) {}

  /**
   * Translate one worker frame.
   * @param frame - any worker frame; voice events, statistics and enrollment status become dictation items.
   */
  workerFrame(frame: InputFrame): void {
    if (frame.type === 'voice-event') {
      this.voiceEvent(frame.event)
      return
    }
    const item = inputStatusItem(frame)
    if (item !== undefined) this.send(item)
  }

  private voiceEvent(event: VoiceEvent): void {
    const segment = Number(event.segment)
    switch (event.kind) {
      case 'speech-start':
        this.send({ type: 'speech', phase: 'start', segment })
        return
      case 'speech-end':
        this.send({ type: 'speech', phase: 'end', segment })
        return
      case 'partial':
        this.send({ type: 'partial', segment, text: event.text })
        return
      case 'score':
        this.scores.set(event.segment, event.score)
        this.send({ type: 'score', segment, score: event.score, accepted: event.accepted, decisive: event.decisive })
        return
      case 'final': {
        const text = event.text.trim()
        const score = this.scores.get(event.segment) ?? null
        this.scores.delete(event.segment)
        const endToFinalMs = event.speechEndNs > 0n && event.finalNs > 0n ? Number(event.finalNs - event.speechEndNs) / 1e6 : null
        this.send({ type: 'final', segment, text, reason: text === '' ? 'empty' : event.accepted ? 'insert' : 'not-verified', score, endToFinalMs })
        return
      }
      case 'error':
        this.send({ type: 'speech-error', message: event.text })
        return
    }
  }
}
