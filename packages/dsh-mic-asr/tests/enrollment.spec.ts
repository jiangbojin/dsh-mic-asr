import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EnrollmentFile, parseEnrollment, syncEnrollment, type EnrollmentTarget } from '../src/enrollment.ts'
import type { EnrollmentState } from '../src/protocol.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('parseEnrollment', () => {
  it('accepts saved embeddings and durations', () => {
    expect(parseEnrollment({ denoiseAtEnroll: true, embeddings: [[0.1, 0.2]], durations: [3.2] })).toEqual({
      recording: false, enrolled: true, denoiseAtEnroll: true, segmentsOk: 1, embeddings: [[0.1, 0.2]], durations: [3.2], pairScores: [] })
  })

  it('rejects files that do not hold an enrollment', () => {
    expect(parseEnrollment(null)).toBeUndefined()
    expect(parseEnrollment({ denoiseAtEnroll: true, embeddings: [['x']], durations: [] })).toBeUndefined()
    expect(parseEnrollment({ denoiseAtEnroll: 'yes', embeddings: [], durations: [] })).toBeUndefined()
    expect(parseEnrollment({ denoiseAtEnroll: true, embeddings: [[Number.NaN]], durations: [] })).toBeUndefined()
  })
})

describe('EnrollmentFile', () => {
  it('writes an enrollment with mode 0600, keeps the replaced one, and moves it aside on reset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mic-asr-enroll-'))
    dirs.push(dir)
    const logger = { warn: vi.fn(), error: vi.fn() } as never
    const file = new EnrollmentFile(join(dir, 'data'), logger, 'test')
    const state = (value: number) => ({ recording: false, enrolled: true, denoiseAtEnroll: true, segmentsOk: 1, embeddings: [[value]], durations: [3], pairScores: [] })
    await expect(file.read()).resolves.toEqual({ kind: 'missing' })
    await file.save('enrolled', state(1))
    expect(statSync(join(dir, 'data', 'speaker.json')).mode & 0o777).toBe(0o600)
    await expect(file.read()).resolves.toMatchObject({ kind: 'saved', state: { embeddings: [[1]] } })
    await file.save('enrolled', state(2))
    expect(JSON.parse(readFileSync(join(dir, 'data', 'speaker.previous.json'), 'utf8'))).toMatchObject({ embeddings: [[1]] })
    await file.save('reset', state(2))
    await expect(file.read()).resolves.toEqual({ kind: 'missing' })
    expect(JSON.parse(readFileSync(join(dir, 'data', 'speaker.previous.json'), 'utf8'))).toMatchObject({ embeddings: [[2]] })
  })
})

describe('syncEnrollment', () => {
  const state = (value: number): EnrollmentState => ({ recording: false, enrolled: true, denoiseAtEnroll: true, segmentsOk: 3, embeddings: [[value]], durations: [3], pairScores: [] })
  function target(enrollment: EnrollmentState): EnrollmentTarget & { calls: string[] } {
    const calls: string[] = []
    return { calls, input: { phase: 'ready', hasDenoiser: true }, alive: true, enrollment,
      restoreEnrollment: (saved) => { calls.push(`restore ${String(saved.embeddings[0]?.[0])}`) }, enroll: (action) => { calls.push(action) } }
  }

  it('restores a changed file, resets only for a missing one, and leaves the worker alone for an unusable one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mic-asr-sync-'))
    dirs.push(dir)
    const file = new EnrollmentFile(dir, { warn: vi.fn(), error: vi.fn() } as never, 'test')
    const enrolled = target(state(1))
    await syncEnrollment(file, enrolled)
    expect(enrolled.calls).toEqual(['reset'])
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'speaker.json'), '{ not json')
    const kept = target(state(1))
    await syncEnrollment(file, kept)
    expect(kept.calls).toEqual([])
    await file.save('enrolled', state(2))
    const stale = target(state(1))
    await syncEnrollment(file, stale)
    expect(stale.calls).toEqual(['restore 2'])
  })
})
