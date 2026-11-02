/** Host bundle (with the typert Remote artifacts) and browser bundle (module-loader factory with CSS modules). */
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown'
import { transform } from 'lightningcss'
import type { UserConfig } from 'tsdown'

/** Modules the dsh client provides through its module table. */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

const CSS_PREFIX = '\0dsh-mic-asr-css:'
// tsdown rejects module ids ending in `.css` without its own CSS pipeline, so the virtual id gets a JS suffix.
const CSS_SUFFIX = '.mjs'

/** Compile `*.module.css` into a class map whose stylesheet is injected when the bundle runs. */
const cssModules = {
  name: 'dsh-mic-asr-css-modules',
  resolveId(source: string, importer: string | undefined) {
    if (!source.endsWith('.module.css') || importer === undefined) return null
    return `${CSS_PREFIX}${resolve(dirname(importer), source)}${CSS_SUFFIX}`
  },
  async load(id: string) {
    if (!id.startsWith(CSS_PREFIX)) return null
    const file = id.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
    const { code, exports } = transform({ filename: file, code: await readFile(file), cssModules: true, minify: true })
    const classes = Object.fromEntries(Object.entries(exports ?? {}).map(([name, entry]) => [name, entry.name]))
    return [
      `const style = document.createElement('style')`,
      `style.dataset.dshMicAsr = ${JSON.stringify(file.slice(file.lastIndexOf('/') + 1))}`,
      `style.textContent = ${JSON.stringify(code.toString())}`,
      `document.head.appendChild(style)`,
      `export default ${JSON.stringify(classes)}`,
    ].join('\n')
  },
}

const host: UserConfig = {
  name: 'dsh-mic-asr',
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  plugins: [typertPlugin({ mode: 'package', faces: ['host'] })],
}

const client: UserConfig = {
  name: 'dsh-mic-asr/client',
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: false,
  minify: true,
  clean: false,
  external: CLIENT_EXTERNALS,
  noExternal: (id: string) => CLIENT_EXTERNALS.includes(id) ? undefined : true,
  plugins: [cssModules],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-mic-asr", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [host, client]
