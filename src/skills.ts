/**
 * Skills management: catalog view (registry × lock file × disk scan),
 * online edit/create, and enable/disable via the frontmatter dual switches
 * (the platform's documented mechanism — D6). Only user-root skills are
 * editable; everything else is presented read-only.
 *
 * Writes are atomic (temp + rename) and land within watched roots, so the
 * filesystem provider's own watcher refreshes the catalog without any
 * manual invalidation.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dump, load } from 'js-yaml'

/** The exact grammar the filesystem provider enforces (mirrors dsh-skill). */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

export function isSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name)
}

/** Registry-view subset this module consumes. */
export interface SkillSummaryLike {
  name: string
  description: string
  whenToUse?: string
  invocation: { modelInvocable: boolean; userInvocable: boolean }
  source: string
  provider: string
  resourceBase?: { kind: string; path?: string; url?: string; description?: string }
}

export interface SkillDefinitionLike extends SkillSummaryLike {
  content: string
  path?: string
  metadata?: Readonly<Record<string, unknown>>
}

/** The host skills service (structural subset of the SkillRegistry). */
export interface SkillsService {
  list(options?: { scope?: unknown; cwd?: string }): Promise<SkillSummaryLike[]>
  get(name: string, options?: { scope?: unknown; cwd?: string }): Promise<SkillDefinitionLike | undefined>
}

/** Optional host agent inventory (dsh-agent), read ONLY at request time. */
export interface AgentsLike {
  list(): Array<{ id?: unknown; status?: unknown } | null>
  get?(id: unknown): unknown
}

export interface SkillsHost {
  dshHome?: string
  agentsHome?: string
  /**
   * Optional lazy agent lookup. MUST be a function called at request time —
   * a synchronous ctx.get('agents') during apply() can wait for a service
   * that is still mounting and hang the entire dsh boot.
   */
  agentsLookup?: () => AgentsLike | undefined
  skills: SkillsService
}

/**
 * The skills registry is scope-layered: Web mounts the filesystem provider
 * inside each session's agent preset, so the user-root catalog is only
 * visible from an agent's scope. Resolve one live agent as the viewing scope
 * (mirrors what dsh-tool-skill passes on every read).
 */
export function agentScopeOf(host: SkillsHost): unknown | undefined {
  let agents: AgentsLike | undefined
  try {
    agents = host.agentsLookup?.()
  } catch {
    return undefined
  }
  if (agents === undefined) return undefined
  try {
    for (const entry of agents.list() ?? []) {
      if (entry === null || typeof entry !== 'object') continue
      // Any live agent entry is a valid viewing scope — we only READ the
      // registry, so an idle (not currently running) agent is fine. The
      // running gate was borrowed from dshmarket's mutation guard and
      // produced the misleading host-only view while the page was open
      // without an active turn.
      if (typeof entry.id !== 'string' || entry.id === '') continue
      const scope = agents.get?.(entry.id)
      if (scope !== undefined) return scope
    }
  } catch {
    return undefined
  }
  return undefined
}

/** One entry of the shared `.skill-lock.json` (Skills CLI ecosystem). */
export interface LockEntry {
  source?: string
  sourceType?: string
  sourceUrl?: string
  skillPath?: string
  skillFolderHash?: string
  installedAt?: string
  updatedAt?: string
}

export function agentsHomeOf(host: SkillsHost): string {
  return host.agentsHome ?? process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents')
}

/** The user skill roots this manager may write to. */
export function userSkillRoots(host: SkillsHost): { source: 'user-agents' | 'user-dsh'; path: string; label: string }[] {
  return [
    { source: 'user-agents', path: join(agentsHomeOf(host), 'skills'), label: '~/.agents/skills' },
    { source: 'user-dsh', path: join(dshHomeOf(host), 'skills'), label: '~/.dsh/skills' },
  ]
}

function dshHomeOf(host: SkillsHost): string {
  return host.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Read the shared lock file; null when absent. */
export function readSkillLock(host: SkillsHost): Record<string, LockEntry> | null {
  try {
    const parsed = JSON.parse(readFileSync(join(agentsHomeOf(host), '.skill-lock.json'), 'utf8')) as {
      version?: number
      skills?: Record<string, LockEntry>
    }
    return typeof parsed.skills === 'object' && parsed.skills !== null ? parsed.skills : null
  } catch {
    return null
  }
}

/** Write the shared lock file, preserving top-level keys (version, dismissed, ...). */
export function writeSkillLock(host: SkillsHost, skills: Record<string, LockEntry>): void {
  const path = join(agentsHomeOf(host), '.skill-lock.json')
  let existing: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    existing = parsed
  } catch {
    existing = {}
  }
  const next = { ...existing, skills, version: typeof existing.version === 'number' ? existing.version : 3 }
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

/**
 * Scan one user root for skills: directory bundles `<name>/SKILL.md` and
 * flat `<name>.md` files (one level deep, mirroring discovery).
 */
function scanRoot(path: string): Map<string, string> {
  const out = new Map<string, string>()
  if (!existsSync(path)) return out
  let entries: string[]
  try {
    entries = readdirNames(path)
  } catch {
    return out
  }
  for (const name of entries) {
    if (name === '.disabled' || name.startsWith('.')) continue
    const dirPath = join(path, name)
    const skillMd = join(dirPath, 'SKILL.md')
    if (existsSync(skillMd)) {
      out.set(name, skillMd)
      continue
    }
    const flat = join(path, `${name}.md`)
    if (existsSync(flat)) out.set(name, flat)
  }
  return out
}

function readdirNames(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true }).map(entry => entry.name)
  } catch {
    return []
  }
}

/** One skill in the list view. */
export interface SkillListView {
  name: string
  description: string
  whenToUse?: string
  source: string
  provider: string
  modelInvocable: boolean
  userInvocable: boolean
  disabled: boolean
  /** Whether the skill lives in a user root this plugin may edit. */
  editable: boolean
  /** Installed through the Skills CLI lock file. */
  managed: boolean
  lock?: LockEntry
  /** Disk path of SKILL.md (user-root skills; resolved from the registry when available). */
  path?: string
  /** A user-root skill the registry did not surface (shadowed or invalid). */
  hiddenInCatalog: boolean
}

/** Build the merged catalog view (cached; see invalidateSkillCache). */
export async function listSkills(host: SkillsHost): Promise<{ skills: SkillListView[]; complete: boolean; viewScope: 'agent' | 'host' }> {
  const key = `${agentsHomeOf(host)}\u0000${dshHomeOf(host)}`
  const cached = skillListCache.get(key)
  if (cached !== undefined && Date.now() - cached.at < SKILL_LIST_TTL_MS) {
    return cached.value
  }
  const value = await collectSkills(host)
  skillListCache.set(key, { at: Date.now(), value })
  return value
}

/** Invalidate the cached catalog after any mutation (edit/install/toggle/...). */
export function invalidateSkillCache(): void {
  skillListCache.clear()
}

const SKILL_LIST_TTL_MS = 15_000
const skillListCache = new Map<string, { at: number; value: { skills: SkillListView[]; complete: boolean; viewScope: 'agent' | 'host' } }>()

async function collectSkills(host: SkillsHost): Promise<{ skills: SkillListView[]; complete: boolean; viewScope: 'agent' | 'host' }> {
  const lock = readSkillLock(host) ?? {}
  const disk = new Map<string, { source: string; path: string }>()
  for (const root of userSkillRoots(host)) {
    for (const [name, path] of scanRoot(root.path)) {
      if (!disk.has(name)) disk.set(name, { source: root.source, path })
    }
  }
  let summaries: SkillSummaryLike[] = []
  let complete = true
  const scope = agentScopeOf(host)
  const lookup = scope === undefined ? {} : { scope }
  try {
    summaries = await host.skills.list(lookup)
  } catch {
    complete = false
  }
  const byName = new Map(summaries.map(summary => [summary.name, summary]))
  const views: SkillListView[] = []
  const seen = new Set<string>()

  for (const summary of summaries) {
    seen.add(summary.name)
    const diskEntry = disk.get(summary.name)
    const source = summary.source === 'user-agents' || summary.source === 'user-dsh'
      ? summary.source
      : summary.source
    views.push({
      name: summary.name,
      description: summary.description,
      whenToUse: summary.whenToUse,
      source,
      provider: summary.provider,
      modelInvocable: summary.invocation.modelInvocable,
      userInvocable: summary.invocation.userInvocable,
      disabled: !summary.invocation.modelInvocable && !summary.invocation.userInvocable,
      editable: summary.source === 'user-agents' || summary.source === 'user-dsh',
      managed: lock[summary.name] !== undefined,
      lock: lock[summary.name],
      path: diskEntry?.path,
      hiddenInCatalog: false,
    })
  }
  // User-root skills the registry did not surface (shadowed by a nearer
  // provider, or invalid frontmatter) — still worth showing as managed state.
  // Read the real description off disk so a hidden row is never a mystery.
  for (const [name, entry] of disk) {
    if (seen.has(name)) continue
    const parsed = readSkillFile(entry.path)
    views.push({
      name,
      description: parsed?.frontmatter?.description ?? '(无简介 / no description)',
      source: entry.source,
      provider: 'filesystem',
      modelInvocable: true,
      userInvocable: true,
      disabled: false,
      editable: entry.source === 'user-agents' || entry.source === 'user-dsh',
      managed: lock[name] !== undefined,
      lock: lock[name],
      path: entry.path,
      hiddenInCatalog: true,
    })
  }
  const skills = views.sort((a, b) => a.name.localeCompare(b.name))
  return { skills, complete, viewScope: scope === undefined ? 'host' : 'agent' }
}

/** Parsed frontmatter of a skill file. */
export interface SkillFrontmatter {
  name: string
  description: string
  whenToUse?: string
  disableModelInvocation?: boolean
  userInvocable?: boolean
  [key: string]: unknown
}

export interface ParsedSkillFile {
  frontmatter: SkillFrontmatter
  body: string
}

/** Read and parse one SKILL.md file (frontmatter + body). */
export function readSkillFile(path: string): ParsedSkillFile | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  // A UTF-8 BOM (Windows editors) or CRLF line endings (common on Windows,
  // Git autocrlf) must not hide the frontmatter; tolerate both.
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (match === null) {
    return { frontmatter: {} as SkillFrontmatter, body: text.trim() }
  }
  let frontmatter: Record<string, unknown>
  try {
    // Full YAML schema: skill frontmatter routinely uses folded/block
    // scalars and anchors the SKILL.md format allows; JSON_SCHEMA would
    // reject them and the description would come back empty.
    const parsed = load(match[1] ?? '')
    frontmatter = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  } catch {
    return null
  }
  return {
    frontmatter: frontmatter as SkillFrontmatter,
    body: text.slice(match[0].length).trim(),
  }
}

/** Serialize frontmatter + body into the canonical SKILL.md text. */
export function serializeSkillFile(frontmatter: SkillFrontmatter, body: string): string {
  const keys = ['name', 'description', 'whenToUse', 'disable-model-invocation', 'user-invocable']
  const record: Record<string, unknown> = {}
  for (const key of keys) {
    if (key === 'name' || key === 'description' || key === 'whenToUse'
      || key === 'disable-model-invocation' || key === 'user-invocable') {
      const value = frontmatter[key]
      if (value !== undefined) record[key] = value
      else if (key === 'name' || key === 'description') return `invalid frontmatter: missing ${key}`
    }
  }
  // Preserve any extra keys (metadata etc.) the editor did not touch.
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!keys.includes(key)) record[key] = value
  }
  const head = dump(record, { indent: 2, lineWidth: -1, noRefs: true, flowLevel: 4 }).trimEnd()
  return `---\n${head}\n---\n${body.startsWith('\n') ? body.slice(1) : body}\n`
}

/** Validate an editing patch; returns a normalized skill write. */
export interface SkillWrite {
  name: string
  description: string
  whenToUse?: string
  disableModelInvocation?: boolean
  userInvocable?: boolean
  body: string
}

export function validateSkillWrite(input: unknown): { ok: true; write: SkillWrite } | { ok: false; errors: string[] } {
  if (typeof input !== 'object' || input === null) return { ok: false, errors: ['invalid payload'] }
  const record = input as Record<string, unknown>
  const errors: string[] = []
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (!isSkillName(name)) errors.push('name must be kebab-case (lowercase letters, digits, single hyphens)')
  const description = typeof record.description === 'string' ? record.description.trim() : ''
  if (description === '') errors.push('description is required')
  const whenToUse = record.whenToUse === undefined ? undefined
    : typeof record.whenToUse === 'string' ? record.whenToUse.trim() : null
  if (whenToUse === null) errors.push('whenToUse must be a string when provided')
  const modelInvocable = record.modelInvocable === undefined ? true : record.modelInvocable === true
  const userInvocable = record.userInvocable === undefined ? true : record.userInvocable === true
  const body = typeof record.body === 'string' ? record.body : ''
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    write: {
      name,
      description,
      ...(whenToUse !== null && whenToUse !== undefined && whenToUse !== '' ? { whenToUse } : {}),
      disableModelInvocation: modelInvocable ? undefined : true,
      userInvocable: userInvocable ? undefined : false,
      body,
    },
  }
}

function toFrontmatter(write: SkillWrite): SkillFrontmatter {
  return {
    name: write.name,
    description: write.description,
    ...(write.whenToUse !== undefined ? { whenToUse: write.whenToUse } : {}),
    ...(write.disableModelInvocation !== undefined ? { 'disable-model-invocation': write.disableModelInvocation } : {}),
    ...(write.userInvocable !== undefined ? { userInvocable: write.userInvocable } : {}),
  }
}

/** Atomic write of a skill file (temp + rename). */
function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}

/** True when a path lives under one of the user skill roots. */
function userRootOf(host: SkillsHost, path: string): { source: string; root: string } | null {
  for (const root of userSkillRoots(host)) {
    const normalized = root.path.replace(/[\\/]+$/u, '')
    if (path === normalized || path.startsWith(`${normalized}/`) || path.startsWith(`${normalized}\\`)) {
      return { source: root.source, root: normalized }
    }
  }
  return null
}

/** Create a new skill in a user root. */
export function createSkill(
  host: SkillsHost,
  input: unknown,
): { ok: true; name: string; path: string } | { ok: false; errors: string[] } {
  const validated = validateSkillWrite(input)
  if (!validated.ok) return { ok: false, errors: validated.errors }
  const record = input as Record<string, unknown>
  const rootLabel = record.root === '~/.dsh/skills' ? '~/.dsh/skills' : '~/.agents/skills'
  const root = userSkillRoots(host).find(item => item.label === rootLabel)
  if (root === undefined) return { ok: false, errors: ['unknown skill root'] }
  if (existsSync(join(root.path, validated.write.name))) {
    return { ok: false, errors: [`a skill named "${validated.write.name}" already exists in ${rootLabel}`] }
  }
  const dir = join(root.path, validated.write.name)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'SKILL.md')
  atomicWrite(path, serializeSkillFile(toFrontmatter(validated.write), validated.write.body))
  return { ok: true, name: validated.write.name, path }
}

/** Update an existing skill (name rename renames the directory + lock key). */
export function updateSkill(
  host: SkillsHost,
  currentName: string,
  input: unknown,
): { ok: true; name: string } | { ok: false; errors: string[] } {
  const validated = validateSkillWrite(input)
  if (!validated.ok) return { ok: false, errors: validated.errors }
  const lock = readSkillLock(host) ?? {}
  // Resolve the current file path: registry path first, then disk scan.
  let path = diskPathFor(host, currentName)
  const userRoot = path !== null ? userRootOf(host, path) : null
  if (path === null || userRoot === null) {
    return { ok: false, errors: [`skill "${currentName}" is not editable (only ~/.agents/skills and ~/.dsh/skills skills can be edited)`] }
  }
  let dir = dirNameOf(path)
  const newDir = join(userRoot.root, validated.write.name)
  const newPath = join(newDir, 'SKILL.md')
  if (validated.write.name !== currentName && existsSync(newDir)) {
    return { ok: false, errors: [`a skill named "${validated.write.name}" already exists`] }
  }
  const text = serializeSkillFile(toFrontmatter(validated.write), validated.write.body)
  if (validated.write.name !== currentName) {
    mkdirSync(newDir, { recursive: true })
    atomicWrite(newPath, text)
    // Remove the old directory only if it is the one we manage (safe: it
    // contains only this skill's files at user root).
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // leftover files are harmless; the new copy is authoritative
    }
    if (lock[currentName] !== undefined) {
      lock[validated.write.name] = lock[currentName]
      delete lock[currentName]
      writeSkillLock(host, lock)
    }
    path = newPath
  } else {
    atomicWrite(path, text)
  }
  if (lock[currentName] !== undefined) return { ok: true, name: validated.write.name }
  return { ok: true, name: validated.write.name }
}

/** Enable/disable via the frontmatter dual switches (D6). */
export function setSkillEnabled(host: SkillsHost, name: string, enabled: boolean): { ok: true } | { ok: false; error: string } {
  const path = diskPathFor(host, name)
  if (path === null || userRootOf(host, path) === null) {
    return { ok: false, error: `skill "${name}" is not editable (only user-root skills can be toggled)` }
  }
  const parsed = readSkillFile(path)
  if (parsed === null) return { ok: false, error: `could not parse ${path}` }
  const frontmatter = parsed.frontmatter
  if (enabled) {
    delete frontmatter['disable-model-invocation']
    delete frontmatter['user-invocable']
  } else {
    frontmatter['disable-model-invocation'] = true
    frontmatter['user-invocable'] = false
  }
  atomicWrite(path, serializeSkillFile(frontmatter, parsed.body))
  return { ok: true }
}

/** Resolve the SKILL.md path for a name (registry → disk scan). */
function diskPathFor(host: SkillsHost, name: string): string | null {
  for (const root of userSkillRoots(host)) {
    for (const [diskName, path] of scanRoot(root.path)) {
      if (diskName === name) return path
    }
  }
  return null
}

function dirNameOf(path: string): string {
  return path.replace(/[\\/]SKILL\.md$/u, '').replace(/\.md$/u, '')
}
