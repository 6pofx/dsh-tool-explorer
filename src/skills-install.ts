/**
 * GitHub skill installation (M3): fetch a repo tarball (through the regional
 * github proxy when direct access fails), discover SKILL.md candidates,
 * install them into a user root, maintain the shared `.skill-lock.json` v3
 * in the exact Skills CLI shape — including the byte-compatible
 * `skillFolderHash` (sorted-relative-path + content sha256, skipping
 * .git/node_modules; verified against 5 locally installed skills).
 */

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import * as tar from 'tar'
import { readSkillFile, readSkillLock, userSkillRoots, writeSkillLock, type LockEntry, type SkillsHost } from './skills.js'

/** Default github prefix proxy (dshmarket's verified china-region route). */
export const DEFAULT_GITHUB_PROXY = 'https://gh-proxy.com'

/** URL parse result. */
export interface GitHubTarget {
  owner: string
  repo: string
  /** Optional pinned commit/ref for tarball downloads. */
  branch?: string
  /** Repo-internal path to the skill directory (optional). */
  path?: string
}

/** Parse a GitHub input into a target; null for anything non-github. */
export function parseGitHubInput(input: string): GitHubTarget | null {
  let text = input.trim()
  if (text === '') return null
  // Strip leading protocol forms.
  if (/^https?:\/\/(?:www\.)?github\.com\//i.test(text)) text = text.replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
  else if (/^git@github\.com:/i.test(text)) text = text.replace(/^git@github\.com:/i, '')
  else if (/^github:/i.test(text)) text = text.slice('github:'.length)
  // owner/repo[/tree/[branch/][path]] or owner/repo[/path][#branch] or owner/repo.git
  text = text.replace(/^\/+/u, '').replace(/\.git$/i, '')
  const at = text.indexOf('#')
  let branch: string | undefined
  if (at !== -1) {
    branch = text.slice(at + 1).trim() || undefined
    text = text.slice(0, at)
  }
  const segments = text.split('/').filter(segment => segment !== '')
  if (segments.length < 2) return null
  const [owner, repo, ...rest] = segments
  if (owner === undefined || repo === undefined) return null
  if (!/^[A-Za-z0-9_.-]+$/u.test(owner) || !/^[A-Za-z0-9_.-]+$/u.test(repo)) return null
  let path: string | undefined
  if (rest.length > 0) {
    const afterTree = rest[0] === 'tree' ? rest.slice(1) : rest
    if (afterTree.length > 0) {
      // `tree/<branch>/<path>`: the first segment may be the branch.
      if (rest[0] === 'tree' && afterTree.length >= 2) {
        if (branch === undefined) branch = afterTree[0]
        path = afterTree.slice(1).join('/')
      } else {
        // owner/repo/<path> — ambiguous; take the whole remainder as path.
        path = afterTree.join('/')
      }
    }
  }
  return { owner, repo, branch, path: path !== undefined && path !== '' ? path : undefined }
}

/** A discovered install candidate inside one repo tarball. */
export interface InstallCandidate {
  /** Repo-internal directory containing SKILL.md ('' = repo root). */
  skillPath: string
  /** Skill name from frontmatter (may differ from the directory name). */
  name: string
  description: string
  whenToUse?: string
  disabled: boolean
  /** Body preview (first 300 chars). */
  bodyPreview: string
}

/** Resolve download URL: direct, or prefix-proxied (github.com-family only). */
export function throughProxy(proxy: string | null, url: string): string {
  if (proxy === null || proxy === '') return url
  return `${proxy.replace(/\/+$/u, '')}/${url}`
}

function downloadUrlFor(target: GitHubTarget): string {
  if (target.branch !== undefined && target.branch !== '') {
    return `https://codeload.github.com/${target.owner}/${target.repo}/tar.gz/refs/heads/${encodeURIComponent(target.branch)}`
  }
  return `https://codeload.github.com/${target.owner}/${target.repo}/tar.gz/HEAD`
}

/** Download the repo tarball; throws with the error text on failure. */
export async function fetchRepoTarball(host: SkillsHost, target: GitHubTarget, signal?: AbortSignal): Promise<Buffer> {
  const url = throughProxy(githubProxyOf(host), downloadUrlFor(target))
  const fetchImpl = (host as { fetchImpl?: typeof fetch }).fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(url, { signal: signal ?? AbortSignal.timeout(120_000), redirect: 'follow' })
  } catch (error) {
    throw new Error(`download failed (${url.slice(0, 80)}…): ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status} (${url.slice(0, 90)}…)`)
  return Buffer.from(await response.arrayBuffer())
}

/** Extract a tarball buffer into a fresh temp dir; returns the extraction root. */
export async function extractTarball(buffer: Buffer): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-te-install-'))
  writeFileSync(join(dir, 'repo.tar.gz'), buffer)
  await tar.x({ file: join(dir, 'repo.tar.gz'), cwd: dir, strip: 1 })
  rmSync(join(dir, 'repo.tar.gz'), { force: true })
  return dir
}

/** All directories exactly one level deeper than `base` (after strip). */
function childDirs(base: string): string[] {
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map(entry => entry.name)
  } catch {
    return []
  }
}

function candidateAt(dir: string, skillPath: string, rawName: string): InstallCandidate | null {
  const file = join(dir, skillPath === '' ? 'SKILL.md' : join(skillPath, 'SKILL.md'))
  if (!existsSync(file)) return null
  const parsed = readSkillFile(file)
  if (parsed === null) return null
  const fm = parsed.frontmatter
  const name = typeof fm.name === 'string' && fm.name !== '' ? fm.name : rawName
  const description = typeof fm.description === 'string' ? fm.description : ''
  return {
    skillPath,
    name,
    description,
    whenToUse: typeof fm.whenToUse === 'string' ? fm.whenToUse : undefined,
    disabled: fm['disable-model-invocation'] === true && fm['user-invocable'] === false,
    bodyPreview: parsed.body.slice(0, 300),
  }
}

/** Discover SKILL.md candidates inside an extracted repo root. */
export function discoverCandidates(root: string, requestedPath?: string): InstallCandidate[] {
  const out: InstallCandidate[] = []
  if (requestedPath !== undefined && requestedPath !== '') {
    const candidate = candidateAt(root, requestedPath, requestedPath.split('/').pop() ?? '')
    if (candidate !== null) out.push(candidate)
    return out
  }
  const rootCandidate = candidateAt(root, '', root.split(/[\\/]/u).pop() ?? 'repo')
  if (rootCandidate !== null) out.push(rootCandidate)
  // `<repo>/skills/<name>/SKILL.md` convention, then any one-level child.
  for (const dirName of ['skills']) {
    for (const child of childDirs(join(root, dirName))) {
      const candidate = candidateAt(root, `${dirName}/${child}`, child)
      if (candidate !== null) out.push(candidate)
    }
  }
  for (const child of childDirs(root)) {
    if (out.some(item => item.skillPath === child)) continue
    const candidate = candidateAt(root, child, child)
    if (candidate !== null) out.push(candidate)
  }
  const seen = new Set<string>()
  return out.filter(candidate => {
    if (seen.has(candidate.name)) return false
    seen.add(candidate.name)
    return true
  })
}

/**
 * The Skills CLI's exact `skillFolderHash`: collect every file recursively
 * (skipping .git/node_modules), sort by POSIX-relative path with
 * localeCompare, then sha256(relativePath ++ content) sequentially.
 * Verified byte-compatible against 5 locally installed locked skills.
 */
export async function computeSkillFolderHash(skillDir: string): Promise<string> {
  const files: Array<{ relativePath: string; content: Buffer }> = []
  const collect = (base: string, current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue
        collect(base, full)
      } else if (entry.isFile()) {
        files.push({
          relativePath: relative(base, full).split('\\').join('/'),
          content: readFileSync(full),
        })
      }
    }
  }
  collect(skillDir, skillDir)
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file.relativePath)
    hash.update(file.content)
  }
  return hash.digest('hex')
}

/** One preview result (candidates for a repo URL). */
export interface InstallPreview {
  target: GitHubTarget
  sourceUrl: string
  candidates: InstallCandidate[]
}

/** Download + discover candidates for one GitHub input. */
export async function previewInstall(host: SkillsHost, input: string): Promise<InstallPreview> {
  const target = parseGitHubInput(input)
  if (target === null) throw new Error('invalid GitHub URL — expected https://github.com/owner/repo[/path] owner/repo[/path] or owner/repo#branch')
  const buffer = await fetchRepoTarball(host, target)
  const root = await extractTarball(buffer)
  const candidates = discoverCandidates(root, target.path)
  rmSync(root, { recursive: true, force: true })
  return {
    target,
    sourceUrl: `https://github.com/${target.owner}/${target.repo}.git`,
    candidates,
  }
}

/** Resolve the proxy: plugin setting → env → default china route. */
export function githubProxyOf(host: SkillsHost): string | null {
  const fromHost = (host as { githubProxy?: string | null }).githubProxy
  if (fromHost === null) return null
  if (typeof fromHost === 'string' && fromHost !== '') return fromHost
  return process.env.DSH_TE_GITHUB_PROXY ?? process.env.DSHM_GITHUB_PROXY ?? DEFAULT_GITHUB_PROXY
}

/** Install one candidate; returns the lock entry written. */
export async function installCandidate(
  host: SkillsHost,
  preview: InstallPreview,
  candidate: InstallCandidate,
  rootLabel: '~/.agents/skills' | '~/.dsh/skills',
  signal?: AbortSignal,
): Promise<{ ok: true; name: string; lock: LockEntry } | { ok: false; error: string }> {
  const target = preview.target
  const root = userSkillRoots(host).find(item => item.label === rootLabel)
  if (root === undefined) return { ok: false, error: 'unknown skill root' }
  const name = candidate.name
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) {
    return { ok: false, error: `skill name "${name}" is not kebab-case; the filesystem provider would reject it` }
  }
  const dest = join(root.path, name)
  if (existsSync(dest)) {
    return { ok: false, error: `a skill named "${name}" already exists in ${rootLabel}` }
  }
  const buffer = await fetchRepoTarball(host, target, signal)
  const extracted = await extractTarball(buffer)
  const sourceDir = candidate.skillPath === '' ? extracted : join(extracted, candidate.skillPath)
  if (!existsSync(join(sourceDir, 'SKILL.md'))) {
    rmSync(extracted, { recursive: true, force: true })
    return { ok: false, error: `SKILL.md not found at repo path "${candidate.skillPath}"` }
  }
  // Verify the installed name matches the frontmatter (rename safety).
  const parsed = readSkillFile(join(sourceDir, 'SKILL.md'))
  if (parsed === null || parsed.frontmatter.name !== name) {
    rmSync(extracted, { recursive: true, force: true })
    return { ok: false, error: 'frontmatter name changed between preview and install; retry' }
  }
  const lock = readSkillLock(host) ?? {}
  mkdirSync(dest, { recursive: true })
  cpSync(sourceDir, dest, { recursive: true })
  rmSync(extracted, { recursive: true, force: true })
  const skillFolderHash = await computeSkillFolderHash(dest)
  const now = new Date().toISOString()
  lock[name] = {
    source: `${target.owner}/${target.repo}`,
    sourceType: 'github',
    sourceUrl: preview.sourceUrl,
    skillPath: candidate.skillPath === '' ? 'SKILL.md' : `${candidate.skillPath}/SKILL.md`,
    skillFolderHash,
    installedAt: now,
    updatedAt: now,
  }
  writeSkillLock(host, lock)
  return { ok: true, name, lock: lock[name]! }
}

/** Check one managed skill for updates (tarball hash comparison). */
export async function checkSkillUpdate(host: SkillsHost, name: string): Promise<{ ok: true; updateAvailable: boolean; currentHash?: string; targetHash?: string } | { ok: false; error: string }> {
  const lock = (readSkillLock(host) ?? {})[name]
  if (lock === undefined) return { ok: false, error: `skill "${name}" is not lockfile-managed` }
  const localDir = skillsRootFor(host, name)
  if (localDir === null) return { ok: false, error: `skill "${name}" not found on disk` }
  const target = parseGitHubInput(lock.sourceUrl ?? `${lock.source ?? ''}`)
  if (target === null) return { ok: false, error: 'lockfile source could not be parsed as GitHub' }
  const buffer = await fetchRepoTarball(host, target)
  const extracted = await extractTarball(buffer)
  const skillPath = typeof lock.skillPath === 'string' ? lock.skillPath.replace(/\/SKILL\.md$/u, '') : ''
  const remoteDir = skillPath === '' ? extracted : join(extracted, skillPath)
  if (!existsSync(join(remoteDir, 'SKILL.md'))) {
    rmSync(extracted, { recursive: true, force: true })
    return { ok: false, error: `SKILL.md not found at repo path "${skillPath}"` }
  }
  const targetHash = await computeSkillFolderHash(remoteDir)
  const currentHash = await computeSkillFolderHash(localDir)
  rmSync(extracted, { recursive: true, force: true })
  return { ok: true, updateAvailable: currentHash !== targetHash, currentHash, targetHash }
}

/** Resolve the local directory of a managed skill. */
function skillsRootFor(host: SkillsHost, name: string): string | null {
  for (const root of userSkillRoots(host)) {
    const dir = join(root.path, name)
    if (existsSync(join(dir, 'SKILL.md')) || existsSync(join(root.path, `${name}.md`))) return dir
  }
  return null
}

/** Update one managed skill from its lockfile source; backup + rollback. */
export async function updateSkillFromSource(host: SkillsHost, name: string): Promise<{ ok: true; name: string; updated: boolean } | { ok: false; error: string }> {
  const lock = (readSkillLock(host) ?? {})[name]
  if (lock === undefined) return { ok: false, error: `skill "${name}" is not lockfile-managed` }
  const localDir = skillsRootFor(host, name)
  if (localDir === null) return { ok: false, error: `skill "${name}" not found on disk` }
  const parent = localDir.replace(/[\\/][^\\/]+$/u, '')
  const target = parseGitHubInput(lock.sourceUrl ?? `${lock.source ?? ''}`)
  if (target === null) return { ok: false, error: 'lockfile source could not be parsed as GitHub' }
  const buffer = await fetchRepoTarball(host, target)
  const extracted = await extractTarball(buffer)
  const skillPath = typeof lock.skillPath === 'string' ? lock.skillPath.replace(/\/SKILL\.md$/u, '') : ''
  const remoteDir = skillPath === '' ? extracted : join(extracted, skillPath)
  if (!existsSync(join(remoteDir, 'SKILL.md'))) {
    rmSync(extracted, { recursive: true, force: true })
    return { ok: false, error: `SKILL.md not found at repo path "${skillPath}"` }
  }
  const localHash = await computeSkillFolderHash(localDir)
  const remoteHash = await computeSkillFolderHash(remoteDir)
  if (localHash === remoteHash) {
    rmSync(extracted, { recursive: true, force: true })
    return { ok: true, name, updated: false }
  }
  const backup = `${parent}/.${name}.bak`
  await fsRmBackup(backup)
  if (existsSync(backup)) rmSync(backup, { recursive: true, force: true })
  if (existsSync(localDir)) {
    cpSync(localDir, backup, { recursive: true })
    rmSync(localDir, { recursive: true, force: true })
  }
  try {
    cpSync(remoteDir, localDir, { recursive: true })
  } catch (error) {
    // Roll back.
    rmSync(localDir, { recursive: true, force: true })
    if (existsSync(backup)) cpSync(backup, localDir, { recursive: true })
    rmSync(extracted, { recursive: true, force: true })
    return { ok: false, error: `update failed and was rolled back: ${error instanceof Error ? error.message : String(error)}` }
  }
  rmSync(extracted, { recursive: true, force: true })
  rmSync(backup, { recursive: true, force: true })
  const all = readSkillLock(host) ?? {}
  if (all[name] !== undefined) all[name] = { ...all[name], updatedAt: new Date().toISOString(), skillFolderHash: remoteHash }
  writeSkillLock(host, all)
  return { ok: true, name, updated: true }
}

async function fsRmBackup(path: string): Promise<void> {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // best effort
  }
}

/** Uninstall a lockfile-managed skill: directory + lock entry. */
export function uninstallSkill(host: SkillsHost, name: string): { ok: true } | { ok: false; error: string } {
  const lock = readSkillLock(host) ?? {}
  if (lock[name] === undefined) return { ok: false, error: `skill "${name}" is not lockfile-managed` }
  const localDir = skillsRootFor(host, name)
  if (localDir !== null) rmSync(localDir, { recursive: true, force: true })
  delete lock[name]
  writeSkillLock(host, lock)
  return { ok: true }
}
