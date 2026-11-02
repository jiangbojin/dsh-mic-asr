// The typert generator recognizes @Remote only when @deepseek-ai/dsh-typert-protocol is a project of the
// workspace it analyzes, and it reads that project's exports as sources. This copies the installed
// package's declarations into packages/.typert/ with exports pointing at them, so generation works
// against the published protocol package.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'packages', 'dsh-mic-asr', 'package.json'))
const source = dirname(require.resolve('@deepseek-ai/dsh-typert-protocol/package.json'))
const target = join(root, 'packages', '.typert', 'dsh-typert-protocol')
const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
cpSync(join(source, 'lib', 'types'), join(target, 'decl'), { recursive: true, filter: file => !/\.js(\.map)?$/.test(file) })
const exportsField = {}
for (const [subpath, value] of Object.entries(manifest.exports ?? {})) {
  const types = typeof value === 'object' && value !== null ? value.types : undefined
  if (typeof types === 'string' && types.startsWith('./lib/types/')) exportsField[subpath] = { types: types.replace('./lib/types/', './decl/') }
}
// The analyzer treats the copy as a contributor and checks its artifact exports; nothing is emitted into it.
exportsField['./typert'] = { types: './lib/typert.host.d.ts', default: './lib/typert.host.js' }
const files = ['lib/typert.host.js', 'lib/typert.host.d.ts']
writeFileSync(join(target, 'package.json'), `${JSON.stringify({ name: manifest.name, version: manifest.version, types: './decl/index.d.ts', exports: exportsField, files }, null, 2)}\n`)
writeFileSync(join(target, 'tsconfig.json'), `${JSON.stringify({ compilerOptions: { composite: true, skipLibCheck: true, noEmit: true }, include: ['decl'] }, null, 2)}\n`)
