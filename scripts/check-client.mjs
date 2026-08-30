/**
 * Verify the wrapped client bundle structurally before it is packed:
 * the loader wrapper parses, `apply`/`inject`/`name` are exported, and the
 * factory requires nothing outside the shell-seed external set.
 *
 * Runs after wrap-client.mjs (build) and before pack/install.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const bundlePath = fileURLToPath(new URL('../client/client.js', import.meta.url))
const code = readFileSync(bundlePath, 'utf8').replace(/\n?\/\/# sourceMappingURL=.*$/, '')

/** The shell-seed externals the factory is allowed to require. */
const ALLOWED = new Set([
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  '@deepseek-ai/dsh-client-ui-primitives',
])

let loaded = null
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(descriptor) {
        loaded = descriptor
      },
    },
  },
  console,
}
vm.createContext(sandbox)
vm.runInContext(code, sandbox)

if (loaded === null) throw new Error('check-client: bundle did not call window.__ModuleLoader__.load()')
if (loaded.id !== 'dsh-tool-explorer') throw new Error(`check-client: unexpected bundle id ${loaded.id}`)
if (typeof loaded.factory !== 'function') throw new Error('check-client: factory is not a function')

const seen = new Set()
const require_ = id => {
  seen.add(id)
  if (!ALLOWED.has(id)) throw new Error(`check-client: factory requires disallowed module ${id}`)
  if (id === 'react') return { createElement: () => null }
  return {}
}
const module_ = { exports: {} }
const exports_ = loaded.factory.call(undefined, require_, module_, module_.exports)
const result = exports_ && typeof exports_ === 'object' ? exports_ : module_.exports

if (result.name !== 'dsh-tool-explorer') throw new Error(`check-client: missing/incorrect name export`)
if (!Array.isArray(result.inject)) throw new Error('check-client: missing inject export')
const expectedServices = ['slots', 'locale']
for (const service of expectedServices) {
  if (!result.inject.includes(service)) throw new Error(`check-client: inject missing service ${service}`)
}
if (typeof result.apply !== 'function') throw new Error('check-client: missing apply export')

console.log(`check-client: ok — exports ${Object.keys(result).join(', ')}, requires ${[...seen].join(', ') || '(none)'}`)
