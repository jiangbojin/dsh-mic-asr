/** The binary runtime (worker, speech libraries and models): download, verification and unpacking. */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { InputConfig, MicAsrRuntimeState } from './types.ts'

/** Executable and speech-input files of an unpacked runtime. */
export interface RuntimeLayout extends InputConfig {
  readonly workerPath: string
}

/** Where the runtime comes from and where it is kept. */
export interface RuntimeSource {
  /** Download URL of the runtime archive (`.tar.gz`). */
  readonly url: string
  /** Lowercase hex SHA-256 of the archive. */
  readonly sha256: string
  /** Directory that holds unpacked runtimes, one subdirectory per archive digest. */
  readonly root: string
}

/** Marker file present only in a completely unpacked runtime. */
const COMPLETE_MARKER = 'SHA256SUMS'

/**
 * File layout of an unpacked runtime directory.
 * @param dir - runtime directory.
 * @returns the worker, libraries and model directories inside it.
 */
export function runtimeLayout(dir: string): RuntimeLayout {
  return {
    workerPath: join(dir, 'bin', 'dsh-mic-asr-worker'),
    asrLibrary: join(dir, 'lib', 'libbase_asr.so'),
    denoiseLibrary: join(dir, 'lib', 'libbase_denoise.so'),
    asrModelDir: join(dir, 'models', 'asr'),
    vadModelDir: join(dir, 'models', 'vad'),
    speakerModelDir: join(dir, 'models', 'speaker'),
  }
}

/**
 * Directory of the runtime unpacked from one archive.
 * @param source - archive source.
 * @returns the directory named after the archive digest.
 */
export function runtimeDir(source: RuntimeSource): string {
  return join(source.root, source.sha256.slice(0, 16))
}

/** Makes one runtime available, downloading it on first use. */
export class RuntimeInstaller {
  /**
   * @param ctx - context providing subprocesses for unpacking.
   * @param source - archive source.
   * @param report - receives each progress state.
   */
  constructor(private readonly ctx: Context, private readonly source: RuntimeSource, private readonly report: (state: MicAsrRuntimeState) => void) {}

  /**
   * Return the unpacked runtime, downloading, verifying and unpacking the archive when it is missing.
   * @param signal - cancels a download in progress.
   * @returns the runtime layout.
   * @throws {Error} when the download fails, the digest differs or unpacking fails.
   */
  async ensure(signal: AbortSignal): Promise<RuntimeLayout> {
    const dir = runtimeDir(this.source)
    if (existsSync(join(dir, COMPLETE_MARKER))) return runtimeLayout(dir)
    await mkdir(this.source.root, { recursive: true, mode: 0o700 })
    const archive = join(this.source.root, `.download-${String(process.pid)}.tar.gz`)
    const staging = join(this.source.root, `.unpack-${String(process.pid)}`)
    try {
      await this.download(archive, signal)
      this.report({ phase: 'unpacking' })
      await rm(staging, { recursive: true, force: true })
      await mkdir(staging, { recursive: true })
      await this.unpack(archive, staging)
      const [top] = await readdir(staging)
      if (top === undefined || !existsSync(join(staging, top, COMPLETE_MARKER))) throw new Error('the runtime archive has no runtime directory')
      await rm(dir, { recursive: true, force: true })
      await rename(join(staging, top), dir)
      return runtimeLayout(dir)
    } finally {
      await rm(archive, { force: true })
      await rm(staging, { recursive: true, force: true })
    }
  }

  private async download(file: string, signal: AbortSignal): Promise<void> {
    const response = await fetch(this.source.url, { signal, redirect: 'follow' })
    if (!response.ok || response.body === null) throw new Error(`runtime download failed: HTTP ${String(response.status)} from ${this.source.url}`)
    const length = Number(response.headers.get('content-length'))
    const totalBytes = Number.isFinite(length) && length > 0 ? length : null
    const hash = createHash('sha256')
    const out = createWriteStream(file, { mode: 0o600 })
    let receivedBytes = 0
    let reported = 0
    try {
      for await (const chunk of response.body) {
        hash.update(chunk)
        receivedBytes += chunk.byteLength
        if (!out.write(chunk)) await new Promise<void>((resolve) => { out.once('drain', resolve) })
        // About one report per megabyte keeps the browser stream light.
        if (receivedBytes - reported >= 1 << 20) {
          reported = receivedBytes
          this.report({ phase: 'downloading', receivedBytes, totalBytes })
        }
      }
    } finally {
      await new Promise<void>((resolve, reject) => { out.end((error?: Error | null) => { if (error) reject(error); else resolve() }) })
    }
    const digest = hash.digest('hex')
    if (digest !== this.source.sha256.toLowerCase()) throw new Error(`runtime archive digest ${digest} differs from the configured ${this.source.sha256}`)
  }

  private async unpack(archive: string, into: string): Promise<void> {
    const handle = this.ctx.subprocess.spawn({ argv: ['tar', '-xzf', archive, '-C', into], cwd: into, graceMs: 5_000, stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 16 * 1024 } } })
    const outcome = await handle.done
    if (outcome.exitCode !== 0) {
      const stderr = handle.collected.stderr?.readFrom(0).text.trim() ?? ''
      throw new Error(`unpacking the runtime failed (tar exit ${String(outcome.exitCode)})${stderr === '' ? '' : `: ${stderr}`}`)
    }
  }
}
