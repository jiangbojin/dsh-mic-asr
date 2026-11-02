import { describe, expect, it } from 'vitest'
import { decodeInputFrame, encodeEnroll, encodeEnrollRestore, encodeFrame, encodeResetStream, encodeVoiceParams, FrameDecoder, InputFrameType,
  MAX_PAYLOAD_BYTES } from '../src/protocol.ts'

describe('frame decoder', () => {
  it('rejects oversized and unknown frames', () => {
    const header = Buffer.alloc(6)
    header.writeUInt32LE(MAX_PAYLOAD_BYTES + 1, 0)
    expect(() => new FrameDecoder(decodeInputFrame).push(header)).toThrow(/exceeds the limit/)
    expect(() => new FrameDecoder(decodeInputFrame).push(encodeFrame(999, Buffer.alloc(0)))).toThrow(/Unknown/)
  })
})

describe('voice frames', () => {
  it('encodes voice parameters in the worker field order', () => {
    const frame = encodeVoiceParams({ vadThreshold: 0.5, vadMinSpeechMs: 100, vadMinSilenceMs: 200, asrChunkMs: 480, asrPrerollMs: 200,
      vadBarge: true, speakerThreshold: 0.25, verifyMs: 3000, denoise: false })
    const payload = frame.subarray(6)
    expect(frame.readUInt16LE(4)).toBe(InputFrameType.voiceParams)
    expect([payload.readFloatLE(0), payload.readInt32LE(4), payload.readInt32LE(8), payload.readInt32LE(12), payload.readInt32LE(16),
      payload.readUInt8(20), payload.readFloatLE(21), payload.readInt32LE(25), payload.readUInt8(29)]).toEqual([0.5, 100, 200, 480, 200, 1, 0.25, 3000, 0])
  })

  it('encodes a saved enrollment and an enrollment action', () => {
    const payload = encodeEnrollRestore({ recording: false, enrolled: true, denoiseAtEnroll: true, segmentsOk: 2,
      embeddings: [[1, 2], [3, 4]], durations: [5.5, 6], pairScores: [] }).subarray(6)
    expect([payload.readUInt8(0), payload.readUInt32LE(1), payload.readUInt32LE(5), payload.readFloatLE(9), payload.readFloatLE(21),
      payload.readUInt32LE(25), payload.readDoubleLE(29), payload.readDoubleLE(37)]).toEqual([1, 2, 2, 1, 4, 2, 5.5, 6])
    expect([...encodeEnroll('end').subarray(6)]).toEqual([2])
    expect(encodeResetStream().readUInt16LE(4)).toBe(InputFrameType.resetStream)
  })

  it('decodes voice events and enrollment status split across chunks', () => {
    const final = Buffer.alloc(9 + 17)
    final.writeUInt8(5, 0)
    final.writeBigUInt64LE(4n, 1)
    final.writeUInt8(1, 9)
    final.writeBigInt64LE(10n, 10)
    final.writeBigInt64LE(20n, 18)
    const status = Buffer.alloc(25 + 8 + 8)
    status.writeUInt8(1, 1)
    status.writeUInt32LE(3, 3)
    status.writeUInt32LE(1, 7)
    status.writeUInt32LE(1, 11)
    status.writeFloatLE(0.5, 15)
    status.writeUInt32LE(1, 19)
    status.writeDoubleLE(3.5, 23)
    status.writeUInt32LE(0, 31)
    status.writeUInt16LE(8, 35)
    const bytes = Buffer.concat([
      encodeFrame(InputFrameType.voiceEvent, Buffer.concat([final, Buffer.from('你好')])),
      encodeFrame(InputFrameType.enrollStatus, Buffer.concat([status.subarray(0, 37), Buffer.from('enrolled'), Buffer.from('声纹已注册')])),
    ])
    const decoder = new FrameDecoder(decodeInputFrame)
    expect(decoder.push(bytes.subarray(0, 10))).toEqual([])
    const frames = decoder.push(bytes.subarray(10))
    expect(frames[0]).toEqual({ type: 'voice-event', event: { kind: 'final', segment: 4n, accepted: true, speechEndNs: 10n, finalNs: 20n, text: '你好' } })
    expect(frames[1]).toEqual({ type: 'enroll-status', event: 'enrolled', message: '声纹已注册', state: {
      recording: false, enrolled: true, denoiseAtEnroll: false, segmentsOk: 3, embeddings: [[0.5]], durations: [3.5], pairScores: [] } })
  })
})
