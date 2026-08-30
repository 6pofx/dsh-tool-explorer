/**
 * Local patch: bound the mcp-client startup wait so an unreachable or
 * hanging MCP server can never block `dsh web` from finishing boot.
 *
 * WHY: dsh-mcp-client 0.1.1-rc.2 awaits `connection.ready` inside its
 * async apply() (lib/index.js), so a streamable-http server whose endpoint
 * is down (e.g. an IDE launched MCP endpoint with the IDE closed), or a
 * stdio server that hangs during initialize, keeps that entry pending
 * forever. `loader.await()` waits for every entry, which is what the web
 * app's "dsh web: http://..." line sits behind — the process stays usable
 * but the ready line (and browser handoff) never prints.
 *
 * This patch races `connection.ready` against a 3s timeout: apply()
 * completes either way, while the connection keeps working in the
 * background (tools register when they arrive; reconnection is
 * supervisor-owned, unchanged). `failOnStartupError` still throws when the
 * failure is measurable within the window.
 *
 * IDEMPOTENT: re-run after any mcp-client update (dshmarket upgrades
 * restore the official file). Backs up as index.js.async.bak on first
 * patch. Remove when the official package gains a startup timeout.
 *
 * Usage:  node scripts/patch-mcp-client-async.mjs [--target <path>]
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const targetArgIndex = args.indexOf('--target')
const explicitTarget = targetArgIndex !== -1 ? args[targetArgIndex + 1] : undefined

function candidates() {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const profileDir = join(dshHome, 'profiles')
  const out = []
  if (explicitTarget !== undefined) out.push(explicitTarget)
  for (const profile of ['web']) {
    out.push(join(profileDir, profile, 'node_modules', '@deepseek-ai', 'dsh-mcp-client', 'lib', 'index.js'))
  }
  out.push(join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-mcp-client', 'lib', 'index.js'))
  return out
}

const needle =
  '\tconst outcome = await connection.ready;\n' +
  '\tif (outcome.error !== void 0 && config.failOnStartupError) throw new Error(`mcp-client(${config.serverName}): initial connection or tool synchronization failed`, { cause: outcome.error });'
const replacement =
  '\t// Local patch (patch-mcp-client-async): bound the startup wait so a\n' +
  '\t// hanging/unreachable server cannot block dsh web from finishing boot.\n' +
  '\tconst outcome = await Promise.race([\n' +
  '\t\tconnection.ready,\n' +
  '\t\tnew Promise((resolve) => setTimeout(() => resolve(null), 3000))\n' +
  '\t]);\n' +
  '\tif (outcome !== null && outcome.error !== void 0 && config.failOnStartupError) throw new Error(`mcp-client(${config.serverName}): initial connection or tool synchronization failed`, { cause: outcome.error });'

let patched = false
for (const target of candidates()) {
  if (!existsSync(target)) continue
  const source = readFileSync(target, 'utf8')
  if (source.includes('patch-mcp-client-async')) {
    console.log(`already patched: ${target}`)
    patched = true
    continue
  }
  if (!source.includes(needle)) {
    console.log(`pattern not found (unexpected mcp-client layout?): ${target}`)
    continue
  }
  const bak = `${target}.async.bak`
  if (!existsSync(bak)) copyFileSync(target, bak)
  writeFileSync(target, source.replace(needle, replacement), 'utf8')
  console.log(`patched: ${target} (backup: ${bak})`)
  patched = true
}

if (!patched) {
  console.error('no mcp-client installation found to patch (profiles/web searched; pass --target <path>)')
  process.exit(1)
}
