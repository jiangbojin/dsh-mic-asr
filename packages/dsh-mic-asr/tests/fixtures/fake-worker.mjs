#!/usr/bin/env node
// Stand-in for dsh-mic-asr-worker speaking the stdio frame protocol. The --asr-library value selects the
// behavior: "ok" (input ready), "crash" (exit 3 before readiness), "crash-once" (crash unless the marker file
// named by --asr-model-dir exists, creating it first).
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const mode = option('asr-library') ?? 'ok'
if (mode === 'crash-once') {
  const marker = option('asr-model-dir') ?? ''
  const { existsSync, writeFileSync } = await import('node:fs')
  if (!existsSync(marker)) {
    writeFileSync(marker, '')
    process.exit(3)
  }
}
if (mode === 'crash') {
  process.stderr.write('fake worker crashed\n')
  process.exit(3)
}
const frame = (type, payload) => {
  const head = Buffer.alloc(6)
  head.writeUInt32LE(payload.length, 0)
  head.writeUInt16LE(type, 4)
  process.stdout.write(Buffer.concat([head, payload]))
}
frame(106, Buffer.from([1, 1]))
let heard = false
let buffered = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  buffered = Buffer.concat([buffered, chunk])
  while (buffered.length >= 6) {
    const size = buffered.readUInt32LE(0)
    if (buffered.length < 6 + size) break
    const type = buffered.readUInt16LE(4)
    const payload = buffered.subarray(6, 6 + size)
    buffered = buffered.subarray(6 + size)
    if (type === 5 && !heard) {
      // The first audio frame yields one recognized, speaker-accepted sentence: segment 1, "你好".
      heard = true
      const start = Buffer.alloc(9 + 17)
      start.writeUInt8(1, 0)
      start.writeBigUInt64LE(1n, 1)
      start.writeUInt8(1, 9)
      frame(107, start)
      const final = Buffer.alloc(9 + 17)
      final.writeUInt8(5, 0)
      final.writeBigUInt64LE(1n, 1)
      final.writeUInt8(1, 9)
      frame(107, Buffer.concat([final, Buffer.from('你好')]))
    } else if (type === 7) {
      // recording | enrolled | denoise | segments_ok | count | dim | durations | pair scores | event bytes
      const status = Buffer.alloc(25)
      status.writeUInt8(1, 0)
      status.writeUInt16LE(Buffer.byteLength('recording'), 23)
      frame(108, Buffer.concat([status, Buffer.from('recording'), Buffer.from('第 1 段录音中')]))
    }
  }
})
process.stdin.on('end', () => { process.exit(0) })
