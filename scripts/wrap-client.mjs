/**
 * Wrap the tsdown CJS chunk into the __ModuleLoader__ lazy-CJS factory the
 * client module system serves:
 *
 *   window.__ModuleLoader__.load({ id: "dsh-tool-explorer", factory: (require) => { ... } });
 *
 * The factory's `require` resolves the external module table (react, the
 * injected dsh-client packages, ...). The rolldown output already carries its
 * own `module`/`exports` prologue, so no extra state is needed inside.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const bundlePath = fileURLToPath(new URL('../client/client.js', import.meta.url))
const mapPath = fileURLToPath(new URL('../client/client.js.map', import.meta.url))

let code = readFileSync(bundlePath, 'utf8')
// The tsdown chunk ends with a sourcemap comment; reattach it outside the
// factory so the map still matches the wrapped file with a stable offset.
code = code.replace(/\n?\/\/# sourceMappingURL=.*$/, '')

const wrapped = `window.__ModuleLoader__.load({
	id: "dsh-tool-explorer",
	factory: (require) => {
var module = { exports: {} };
var exports = module.exports;
${code}
return module.exports;

	}
});

//# sourceMappingURL=client.js.map
`

writeFileSync(bundlePath, wrapped)
// Read back the map size for a sanity check log; the map is emitted by tsdown.
const mapBytes = readFileSync(mapPath, 'utf8').length
console.log(`wrap-client: client/client.js wrapped (${code.length} -> ${wrapped.length} bytes, map ${mapBytes} bytes)`)
