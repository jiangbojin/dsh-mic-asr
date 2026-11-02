import { describe, expect, it } from 'vitest'
import { StreamChannel } from '../src/channel.ts'
import { DictationStream } from '../src/dictation.ts'
import type { MicAsrDownFrame } from '../src/types.ts'

function stream(): { sent: MicAsrDownFrame[]; dictation: DictationStream } {
  const sent: MicAsrDownFrame[] = []
  return { sent, dictation: new DictationStream((frame) => { sent.push(frame) }) }
}

describe('DictationStream', () => {
  it('marks accepted finals for insertion with the latest speaker score and the end-to-final time', () => {
    const { sent, dictation } = stream()
    dictation.workerFrame({ type: 'voice-event', event: { kind: 'speech-start', segment: 2n, bargeEnabled: true, onsetNs: 0n, confirmNs: 0n } })
    dictation.workerFrame({ type: 'voice-event', event: { kind: 'partial', segment: 2n, text: '你' } })
    dictation.workerFrame({ type: 'voice-event', event: { kind: 'score', segment: 2n, stage: 0, score: 0.8, accepted: true, decisive: true, audioSeconds: 3 } })
    dictation.workerFrame({ type: 'voice-event', event: { kind: 'final', segment: 2n, accepted: true, speechEndNs: 1_000_000n, finalNs: 351_000_000n, text: ' 你好 ' } })
    expect(sent).toEqual([
      { type: 'speech', phase: 'start', segment: 2 },
      { type: 'partial', segment: 2, text: '你' },
      { type: 'score', segment: 2, score: 0.8, accepted: true, decisive: true },
      { type: 'final', segment: 2, text: '你好', reason: 'insert', score: 0.8, endToFinalMs: 350 },
    ])
  })

  it('withholds rejected and empty finals and reports levels and errors', () => {
    const { sent, dictation } = stream()
    dictation.workerFrame({ type: 'voice-event', event: { kind: 'final', segment: 1n, accepted: false, speechEndNs: 0n, finalNs: 0n, text: '别人' } })
    dictation.workerFrame({ type: 'voice-event', event: { kind: 'final', segment: 3n, accepted: true, speechEndNs: 0n, finalNs: 0n, text: '  ' } })
    dictation.workerFrame({ type: 'voice-stats', rawDbfs: -30, outDbfs: -35, inSegment: false, segmentSeconds: 0, frames: 0n, droppedSamples: 0n })
    dictation.workerFrame({ type: 'voice-event', event: { kind: 'error', segment: 4n, text: 'asr failed' } })
    expect(sent).toEqual([
      { type: 'final', segment: 1, text: '别人', reason: 'not-verified', score: null, endToFinalMs: null },
      { type: 'final', segment: 3, text: '', reason: 'empty', score: null, endToFinalMs: null },
      { type: 'level', rawDbfs: -30, outDbfs: -35, inSegment: false },
      { type: 'speech-error', message: 'asr failed' },
    ])
  })
})

describe('DictationStream enrollment', () => {
  it('reports enrollment steps without embeddings', () => {
    const { sent, dictation } = stream()
    dictation.workerFrame({ type: 'enroll-status', event: 'enrolled', message: '声纹已注册', state: {
      recording: false, enrolled: true, denoiseAtEnroll: true, segmentsOk: 3, embeddings: [[0.1]], durations: [3], pairScores: [0.9] } })
    expect(sent).toEqual([{ type: 'enroll', event: 'enrolled', message: '声纹已注册',
      enrollment: { enrolled: true, recording: false, segmentsOk: 3, pairScores: [0.9] } }])
  })
})

describe('StreamChannel', () => {
  it('yields queued items, then fails once the queue overflows', async () => {
    const channel = new StreamChannel<number>(2, 'too slow')
    channel.push(1)
    channel.push(2)
    channel.push(3)
    const seen: number[] = []
    await expect((async () => { for await (const item of channel.drain(new AbortController().signal)) seen.push(item) })()).rejects.toThrow('too slow')
    expect(seen).toEqual([1, 2])
  })

  it('ends on abort after the queued items', async () => {
    const channel = new StreamChannel<number>(8, 'too slow')
    const abort = new AbortController()
    channel.push(1)
    const seen: number[] = []
    const done = (async () => { for await (const item of channel.drain(abort.signal)) seen.push(item) })()
    await new Promise(resolve => setTimeout(resolve, 0))
    abort.abort()
    await done
    expect(seen).toEqual([1])
  })
})
