import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InputFrame, VoiceParams } from '../src/protocol.ts'
import { inputArguments, SpeechWorker, type SpeechWorkerLaunch } from '../src/worker.ts'

// A stand-in for dsh-mic-asr-worker speaking the same stdio frames.
const fake = fileURLToPath(new URL('./fixtures/fake-worker.mjs', import.meta.url))
const roots: Context[] = []
const workers: SpeechWorker[] = []
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(workers.splice(0).map(worker => worker.stop()))
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const input = { asrLibrary: 'ok', denoiseLibrary: '/d', asrModelDir: '/a', vadModelDir: '/v', speakerModelDir: '/s' }
const params: VoiceParams = { vadThreshold: 0.5, vadMinSpeechMs: 100, vadMinSilenceMs: 300, asrChunkMs: 480, asrPrerollMs: 200, vadBarge: false,
  speakerThreshold: 0.5, verifyMs: 3000, denoise: true }

async function launch(overrides: Partial<SpeechWorkerLaunch> = {}): Promise<SpeechWorker> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(LocalSubprocess)
  const worker = new SpeechWorker(ctx, { workerPath: fake, input, crashDir: '', startupTimeoutMs: 10_000, graceMs: 2_000, maxLogBytes: 4096,
    maxRestarts: 0, restartWindowMs: 60_000, voiceParams: () => params, ...overrides }, 'dsh-mic-asr')
  workers.push(worker)
  worker.start()
  return worker
}

describe('SpeechWorker', () => {
  it('runs at input readiness without TTS, forwards voice events, starts a new process unenrolled, and stops on stdin close', async () => {
    const worker = await launch()
    const frames: InputFrame[] = []
    worker.onFrame((frame) => { frames.push(frame) })
    await vi.waitFor(() => { expect(worker.process).toEqual({ phase: 'running' }) })
    expect(worker.input).toEqual({ phase: 'ready', hasDenoiser: true })
    worker.audio(Buffer.alloc(640))
    await vi.waitFor(() => {
      expect(frames).toContainEqual({ type: 'voice-event', event: expect.objectContaining({ kind: 'final', accepted: true, text: '你好' }) })
    })
    worker.enroll('begin')
    await vi.waitFor(() => { expect(worker.enrollment.recording).toBe(true) })
    await worker.stop()
    worker.start()
    expect(worker.enrollment.recording).toBe(false)
    await vi.waitFor(() => { expect(worker.process).toEqual({ phase: 'running' }) })
    await worker.stop()
    expect(worker.process.phase).toBe('stopped')
    expect(() => { worker.resetStream() }).toThrow('dsh-mic-asr worker is not running')
  })

  it('restarts an unexpected exit within the budget', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mic-asr-restart-'))
    dirs.push(dir)
    const worker = await launch({ input: { ...input, asrLibrary: 'crash-once', asrModelDir: join(dir, 'marker') }, maxRestarts: 1 })
    await vi.waitFor(() => { expect(worker.process.phase).toBe('exited') })
    expect(worker.input.phase).toBe('failed')
    await vi.waitFor(() => { expect(worker.process).toEqual({ phase: 'running' }) }, { timeout: 5_000 })
    expect(worker.restartsInWindow).toBe(1)
  })

  it('stays exited once the restart budget is spent', async () => {
    const worker = await launch({ input: { ...input, asrLibrary: 'crash' } })
    await vi.waitFor(() => { expect(worker.process.phase).toBe('exited') })
    expect(worker.process).toMatchObject({ error: expect.stringContaining('fake worker crashed') })
    expect(worker.restartsInWindow).toBe(0)
  })
})

describe('inputArguments', () => {
  it('passes speech input options only with an ASR library', () => {
    expect(inputArguments({ ...input, asrLibrary: '' })).toEqual([])
    expect(inputArguments(input)).toContain('--asr-library=ok')
  })
})
