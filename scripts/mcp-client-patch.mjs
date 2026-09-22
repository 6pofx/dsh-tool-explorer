/**
 * Engine for the local `@deepseek-ai/dsh-mcp-client` patches.
 *
 * Both patches edit the same installed file — the package's `lib/index.js` — in
 * whichever profile the running `dsh` resolves it from, and both must be
 * re-runnable after an upstream package update restores the official bytes.
 * This module owns target discovery, the read/patch/write cycle, `--check`
 * reporting, and the CLI surface; the patch definitions live in
 * `mcp-client-patches.mjs`.
 *
 * Layout note: the DSH launcher links first-party packages into
 * `<dshHome>/profiles/node_modules/@deepseek-ai/*` (a hoisted view of the global
 * `@deepseek-ai/dsh` install), while per-profile installs keep them under
 * `<dshHome>/profiles/<profile>/node_modules/...`. Both are searched.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Package-relative path of the file both patches edit. */
const MCP_CLIENT_ENTRY = ['node_modules', '@deepseek-ai', 'dsh-mcp-client', 'lib', 'index.js']

/**
 * Parse the shared CLI surface.
 * @returns `{ target, profile, check }` — explicit target path (or undefined),
 *   the profile whose per-profile install is searched, and whether this run
 *   only reports status.
 */
export function parseArgs() {
  const args = process.argv.slice(2)
  const value = (flag) => {
    const index = args.indexOf(flag)
    return index === -1 ? undefined : args[index + 1]
  }
  return {
    target: value('--target'),
    profile: value('--profile') ?? 'web',
    check: args.includes('--check'),
  }
}

/**
 * Every location the mcp-client entry may live at, most specific first.
 * @param options - explicit target and profile name.
 * @returns absolute candidate paths (existence is the caller's check).
 */
export function candidates({ target, profile }) {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const profiles = join(dshHome, 'profiles')
  const out = []
  if (target !== undefined) out.push(target)
  // Per-profile install first (pnpm isolated layout), then the hoisted
  // profiles/node_modules view the launcher links first-party packages into.
  out.push(join(profiles, profile, ...MCP_CLIENT_ENTRY))
  out.push(join(profiles, ...MCP_CLIENT_ENTRY))
  return out
}

/**
 * Version of the package owning a patched entry, for diagnostics.
 * @param entryPath - absolute path of the patch target.
 * @returns the version string, or undefined when the manifest is unreadable.
 */
export function packageVersion(entryPath) {
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(dirname(entryPath)), 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/**
 * Apply one textual patch to one file, idempotently.
 *
 * Failure isolation is deliberate: a sandboxed or read-only install (EPERM) must
 * report as an outcome, not as an uncaught throw, so a run that patches one
 * location still reports the others accurately.
 *
 * @param target - absolute path of the file to patch.
 * @param patch - `marker` (idempotency sentinel), `needle`, `replacement`, and
 *   the backup suffix used on first write.
 * @param options - `check` reports the outcome without writing.
 * @returns `{ status, target, version?, detail? }` where status is one of
 *   `patched`, `would-patch`, `already`, `missing`, `nomatch`, `error`.
 */
export function patchFile(target, { marker, needle, replacement, backupSuffix }, { check = false } = {}) {
  if (!existsSync(target)) return { status: 'missing', target }
  const version = packageVersion(target)
  let source
  try {
    source = readFileSync(target, 'utf8')
  } catch (error) {
    return { status: 'error', target, version, detail: `cannot read: ${error.message}` }
  }
  if (source.includes(marker)) return { status: 'already', target, version }
  if (!source.includes(needle)) {
    return { status: 'nomatch', target, version, detail: 'the official layout changed — inspect the file and update this patch' }
  }
  if (check) return { status: 'would-patch', target, version }
  const backup = `${target}${backupSuffix}`
  try {
    if (!existsSync(backup)) copyFileSync(target, backup)
    writeFileSync(target, source.replace(needle, replacement), 'utf8')
  } catch (error) {
    return { status: 'error', target, version, detail: `cannot write: ${error.message}` }
  }
  return { status: 'patched', target, version, detail: backup }
}

/**
 * Run one or more patches across every candidate installation and print a
 * report.
 *
 * Exit codes: 0 = every found installation is patched (or was already);
 * 1 = no installation found; 2 = an installation exists but needs work
 * (unpatched in `--check` mode, unrecognized layout, or a failed write).
 *
 * @param patches - patch definitions (`id`, `label`, `marker`, `needle`,
 *   `replacement`, `backupSuffix`).
 * @param parsed - result of {@link parseArgs}.
 * @returns the process exit code.
 */
export function runPatches(patches, parsed = parseArgs()) {
  console.log(`${parsed.check ? 'checking' : 'applying'} local dsh-mcp-client patch${patches.length === 1 ? '' : 'es'}${parsed.check ? ' (no files are written)' : ''}`)
  let foundAny = false
  const problems = []
  const changed = []

  for (const patch of patches) {
    const results = candidates(parsed).map(target => patchFile(target, patch, { check: parsed.check }))
    const found = results.filter(result => result.status !== 'missing')
    console.log(`\n${patch.label}`)
    if (found.length === 0) {
      console.error('  no installation found (searched profiles/*/node_modules and profiles/node_modules; pass --target <path>)')
      continue
    }
    foundAny = true
    for (const result of found) {
      const at = `dsh-mcp-client${result.version === undefined ? '' : ` ${result.version}`}`
      if (result.status === 'already') console.log(`  already patched  ${at}  ${result.target}`)
      else if (result.status === 'patched') {
        console.log(`  patched          ${at}  ${result.target}\n                   backup: ${result.detail}`)
        changed.push(result.target)
      } else if (result.status === 'would-patch') {
        console.error(`  NOT PATCHED      ${at}  ${result.target}`)
        problems.push(`${patch.id} @ ${result.target}`)
      } else {
        console.error(`  NOT APPLIED      ${at}  ${result.target}\n                   ${result.detail}`)
        problems.push(`${patch.id} @ ${result.target}`)
      }
    }
  }

  console.log('')
  if (!foundAny) {
    console.error('no @deepseek-ai/dsh-mcp-client installation found to patch.')
    return 1
  }
  if (problems.length > 0) {
    if (parsed.check) console.error(`${problems.length} pending patch application(s) — run again without --check to apply them.`)
    else console.error(`${problems.length} patch application(s) failed — write access to those paths is required (or pass --target <path>).`)
    return 2
  }
  if (changed.length > 0) console.log('Patched files take effect on the next dsh start (a module already imported keeps its current code).')
  else console.log(parsed.check ? 'All patches are in place.' : 'Nothing to do — all patches are already in place.')
  return 0
}
