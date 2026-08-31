/**
 * Recoverable skill trash (M5): deleting a user-root skill moves its
 * directory (or flat file) into `<dshHome>/skills-trash` and records a
 * manifest entry; restore puts it back — including its lockfile entry —
 * while purge / empty removes it permanently.
 *
 * Mirrors the recoverable-trash pattern of dsh-skill-hub (`.trash/` rename
 * + restore + clear), but keeps the trash OUTSIDE every skill root so the
 * filesystem provider's watchers never observe it, and snapshots the lock
 * entry so restore is byte-compatible with the Skills CLI lock state.
 *
 * All writes are atomic (temp + rename) like every other write in this
 * plugin; moves fall back to copy+delete when rename crosses volumes.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  diskPathFor, dshHomeOf, isSkillName, readSkillLock, userRootOf, userSkillRoots, writeSkillLock,
  type LockEntry, type SkillsHost,
} from './skills.js'

/** One recoverable-trash entry. */
export interface TrashItem {
  /** Unique trash id (`<name>-<stamp>`) — also the trash directory name. */
  id: string
  /** Kebab-case skill name (directory / flat-file name). */
  name: string
  /** Source bucket the skill lived in ('user-agents' | 'user-dsh'). */
  source: string
  /** Label of the original root, e.g. '~/.agents/skills'. */
  rootLabel: string
  /** Absolute original path of the moved entry (dir bundle or flat file). */
  originalPath: string
  /** 'bundle' = `<name>/SKILL.md` directory, 'file' = flat `<name>.md`. */
  kind: 'bundle' | 'file'
  /** Lockfile snapshot kept for restore; null when the skill was not managed. */
  lock: LockEntry | null
  deletedAt: string
}

export interface TrashManifest {
  version: 1
  items: TrashItem[]
}

/** One trash entry as the browser sees it. */
export interface TrashItemView {
  id: string
  name: string
  rootLabel: string
  kind: 'bundle' | 'file'
  managed: boolean
  deletedAt: string
  /** Whether the trash copy is still on disk (purge-safe listing). */
  exists: boolean
}

const emptyManifest = (): TrashManifest => ({ version: 1, items: [] })

/** The trash root: `<dshHome>/skills-trash` (never inside a skill root). */
export function trashRootOf(host: SkillsHost): string {
  return join(dshHomeOf(host), 'skills-trash')
}

/** Read the trash manifest; an absent or corrupt file reads as empty. */
export function readTrashManifest(host: SkillsHost): TrashManifest {
  try {
    const parsed = JSON.parse(readFileSync(join(trashRootOf(host), 'manifest.json'), 'utf8')) as Partial<TrashManifest>
    if (parsed.version === 1 && Array.isArray(parsed.items)) return parsed as TrashManifest
  } catch {
    // absent or corrupt — treat as empty
  }
  return emptyManifest()
}

/** Write the trash manifest atomically (temp + rename). */
export function writeTrashManifest(host: SkillsHost, manifest: TrashManifest): void {
  const path = join(trashRootOf(host), 'manifest.json')
  mkdirSync(trashRootOf(host), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

/** Number of recoverable-trash items (surfaces in the skills list payload). */
export function trashCountOf(host: SkillsHost): number {
  return readTrashManifest(host).items.length
}

/** The trash directory for one item id. */
function trashDirFor(host: SkillsHost, id: string): string {
  return join(trashRootOf(host), id)
}

/** Move a directory or file; rename first, copy+delete on EXDEV (cross-volume). */
function moveEntry(source: string, destination: string): void {
  try {
    renameSync(source, destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    mkdirSync(destination.replace(/[\\/][^\\/]+$/u, ''), { recursive: true })
    cpSync(source, destination, { recursive: true })
    rmSync(source, { recursive: true, force: true })
  }
}

/** Build a unique trash id (`<name>-<stamp>`), never colliding on disk. */
function nextTrashId(host: SkillsHost, name: string): string {
  const stamp = new Date().toISOString().replace(/[-:T.]/gu, '').slice(0, 15)
  let id = `${name}-${stamp}`
  let n = 0
  while (existsSync(trashDirFor(host, id))) {
    n += 1
    id = `${name}-${stamp}-${n}`
  }
  return id
}

/**
 * Delete a user-root skill into the recoverable trash. The lockfile entry
 * (if any) is snapshotted into the manifest and removed from the lock so the
 * catalog state matches the disk state; restore returns both.
 */
export function trashSkill(host: SkillsHost, name: string): { ok: true; id: string } | { ok: false; error: string } {
  if (!isSkillName(name)) return { ok: false, error: 'invalid skill name' }
  const path = diskPathFor(host, name)
  if (path === null) return { ok: false, error: `skill "${name}" not found on disk` }
  const userRoot = userRootOf(host, path)
  if (userRoot === null) {
    return { ok: false, error: `skill "${name}" is not deletable (only ~/.agents/skills and ~/.dsh/skills skills can be deleted)` }
  }
  const kind: 'bundle' | 'file' = path.replace(/\\/gu, '/').endsWith('/SKILL.md') ? 'bundle' : 'file'
  const originalPath = kind === 'bundle' ? path.slice(0, path.length - 'SKILL.md'.length - 1) : path
  if (!existsSync(originalPath)) return { ok: false, error: `skill "${name}" is not deletable (${originalPath} missing)` }

  const id = nextTrashId(host, name)
  const lock = readSkillLock(host) ?? {}
  const snapshot = lock[name] ?? null
  if (snapshot !== null) {
    delete lock[name]
    writeSkillLock(host, lock)
  }

  mkdirSync(trashRootOf(host), { recursive: true })
  const dest = trashDirFor(host, id)
  if (kind === 'bundle') {
    moveEntry(originalPath, dest)
  } else {
    mkdirSync(dest, { recursive: true })
    moveEntry(originalPath, join(dest, `${name}.md`))
  }

  const manifest = readTrashManifest(host)
  manifest.items.push({
    id,
    name,
    source: userRoot.source,
    rootLabel: userSkillRoots(host).find(item => item.path === userRoot.root)?.label ?? userRoot.root,
    originalPath,
    kind,
    lock: snapshot,
    deletedAt: new Date().toISOString(),
  })
  writeTrashManifest(host, manifest)
  return { ok: true, id }
}

/** The browser-facing trash listing (manifest order, newest first). */
export function listTrash(host: SkillsHost): { items: TrashItemView[] } {
  const root = trashRootOf(host)
  const items = readTrashManifest(host).items
    .slice()
    .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
    .map(item => ({
      id: item.id,
      name: item.name,
      rootLabel: item.rootLabel,
      kind: item.kind,
      managed: item.lock !== null,
      deletedAt: item.deletedAt,
      exists: existsSync(join(root, item.id)),
    }))
  return { items }
}

function findItem(host: SkillsHost, id: string): TrashItem | null {
  return readTrashManifest(host).items.find(item => item.id === id) ?? null
}

/** Write the manifest without one item. */
function dropItem(host: SkillsHost, id: string): void {
  const manifest = readTrashManifest(host)
  manifest.items = manifest.items.filter(item => item.id !== id)
  writeTrashManifest(host, manifest)
}

/**
 * Restore one trashed skill to its original root — directory or flat file —
 * and re-add its lockfile snapshot so lock state is byte-identical to the
 * pre-delete state. Refuses when the original path is occupied again.
 */
export function restoreTrashItem(host: SkillsHost, id: string): { ok: true; name: string } | { ok: false; error: string } {
  const item = findItem(host, id)
  if (item === null) return { ok: false, error: `trash item "${id}" not found` }
  if (existsSync(item.originalPath)) {
    return { ok: false, error: `cannot restore "${item.name}": ${item.originalPath} already exists` }
  }
  const source = trashDirFor(host, item.id)
  if (!existsSync(source)) return { ok: false, error: `cannot restore "${item.name}": trash copy is missing` }
  mkdirSync(item.originalPath.replace(/[\\/][^\\/]+$/u, ''), { recursive: true })
  if (item.kind === 'bundle') {
    moveEntry(source, item.originalPath)
  } else {
    moveEntry(join(source, `${item.name}.md`), item.originalPath)
    try {
      rmSync(source, { recursive: true, force: true })
    } catch {
      // leftover trash dir is harmless; the file copy is authoritative
    }
  }
  if (item.lock !== null) {
    const lock = readSkillLock(host) ?? {}
    lock[item.name] = item.lock
    writeSkillLock(host, lock)
  }
  dropItem(host, id)
  return { ok: true, name: item.name }
}

/** Permanently delete one trashed skill (no recovery after this). */
export function purgeTrashItem(host: SkillsHost, id: string): { ok: true; name: string } | { ok: false; error: string } {
  const item = findItem(host, id)
  if (item === null) return { ok: false, error: `trash item "${id}" not found` }
  try {
    rmSync(trashDirFor(host, item.id), { recursive: true, force: true })
  } catch {
    // best effort; the manifest entry is authoritative
  }
  dropItem(host, id)
  return { ok: true, name: item.name }
}

/** Permanently delete every trashed skill. */
export function emptyTrash(host: SkillsHost): { ok: true; purged: number } {
  const manifest = readTrashManifest(host)
  const count = manifest.items.length
  for (const item of manifest.items) {
    try {
      rmSync(trashDirFor(host, item.id), { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
  writeTrashManifest(host, emptyManifest())
  return { ok: true, purged: count }
}