/**
 * Local patch: silence stdio MCP server stderr (startup banners, JSON logs)
 * that @deepseek-ai/dsh-mcp-client currently lets inherit into the dsh
 * process console.
 *
 * WHY: dsh-mcp-client 0.1.1-rc.2 has no `stderr` config field, so the SDK
 * default (`inherit`) applies and every stdio server's stderr — FastMCP
 * banners, pino JSON lines, Python tracebacks — floods `dsh web`'s output.
 * This patch adds `stderr: "ignore"` to the transport construction.
 *
 * IDEMPOTENT: re-run after any mcp-client update (dshmarket upgrades restore
 * the official file). Backs up the original as index.js.bak on first patch.
 * Remove the patch when the official package gains a stderr option.
 *
 * Usage:  node scripts/patch-mcp-client-stderr.mjs [--target <path>]
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
  // Per-profile node_modules (non-hoisted layouts) first, then the hoisted
  // profile root (nodeLinker: hoisted).
  for (const profile of ['web']) {
    out.push(join(profileDir, profile, 'node_modules', '@deepseek-ai', 'dsh-mcp-client', 'lib', 'index.js'))
  }
  out.push(join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-mcp-client', 'lib', 'index.js'))
  return out
}

const needle = 'env: buildChildEnv(config.env),'
const replacement = `env: buildChildEnv(config.env),
			stderr: "ignore",`

let patched = false
for (const target of candidates()) {
  if (!existsSync(target)) continue
  const source = readFileSync(target, 'utf8')
  if (source.includes('stderr: "ignore"')) {
    console.log(`already patched: ${target}`)
    patched = true
    continue
  }
  if (!source.includes(needle)) {
    console.log(`pattern not found (unexpected mcp-client layout?): ${target}`)
    continue
  }
  const bak = `${target}.bak`
  if (!existsSync(bak)) copyFileSync(target, bak)
  writeFileSync(target, source.replace(needle, replacement), 'utf8')
  console.log(`patched: ${target} (backup: ${bak})`)
  patched = true
}

if (!patched) {
  console.error('no mcp-client installation found to patch (profiles/web searched; pass --target <path>)')
  process.exit(1)
}
