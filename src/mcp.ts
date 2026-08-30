/**
 * MCP server management: read the configured servers (loader tree + user
 * patch layers), add/edit/remove them through the profile's cordis.patch.yml
 * (the official HMR-driven hot-apply path), and probe a server's health with
 * an independent SDK client that never disturbs running instances.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  appendRowBlock, atomicWrite, insertRowBlock, isJsExpr, overrideRowBlock,
  parsePatchText, readPatchOrNull, removeDisabledRowsForId, removeRowsForId, toggleRowBlock,
  type PatchEntry,
} from './patch-text.js'

/** The bundle name every MCP server instance is composed under. */
export const MCP_PLUGIN_NAME = '@deepseek-ai/dsh-mcp-client'

/** The id prefix this plugin writes for new servers. */
export const MCP_ID_PREFIX = 'mcp-'

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/u

/** Probe timeout shared by connect and tools/list. */
const TEST_TIMEOUT_MS = 15_000

/** One validated MCP server specification (plain JSON-safe data). */
export interface McpServerSpec {
  serverName: string
  transport: 'stdio' | 'streamable-http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  toolCallTimeoutMs?: number
  failOnStartupError?: boolean
  reconnect?: {
    enabled?: boolean
    initialDelayMs?: number
    maxDelayMs?: number
    maxAttempts?: number
  }
}

/** Which patch layer a write targets. */
export type PatchLayer = 'profile' | 'home'

/** Loader entry shape this module reads (structural subset). */
export interface LoaderEntryLike {
  options?: {
    id?: string
    name?: string
    config?: unknown
    disabled?: unknown
  }
  disabled?: boolean
  fiber?: { state?: number } | undefined
}

/** Tool schema shape this module reads (structural subset). */
export interface ToolSchemaLike {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

/** The host services the MCP manager consumes. */
export interface McpHost {
  loader: { entries(): Iterable<LoaderEntryLike> }
  tools: { schemas(scope?: unknown): ToolSchemaLike[] }
  profileName: string
  dshHome?: string
}

/** The resolved DeepSeek Harness home directory. */
export function dshHomeOf(host: McpHost): string {
  return host.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Profile directory for the booted profile. */
export function profileDirOf(host: McpHost): string {
  return join(dshHomeOf(host), 'profiles', host.profileName)
}

/**
 * Resolve the user patch layer the loader actually read: the include entry's
 * config lists the composed cordis.yml path, and the patch sits beside it.
 * Falls back to the conventional `<profile>/cordis.patch.yml`.
 */
export function profilePatchPathOf(host: McpHost): string {
  for (const entry of host.loader.entries()) {
    const cfg = entry.options?.config as { path?: unknown } | undefined
    if (entry.options?.name !== 'cordis:include' || cfg == null || typeof cfg.path !== 'string') continue
    if (!cfg.path.includes('cordis.yml')) continue
    let includePath = cfg.path
    if (includePath.startsWith('file://')) {
      try {
        includePath = fileURLToPath(includePath)
      } catch {
        // fileURLToPath rejects POSIX-style URLs on Windows; strip the scheme.
        includePath = includePath.replace(/^file:\/\//u, '')
      }
    }
    return includePath.replace(/cordis\.yml$/u, 'cordis.patch.yml')
  }
  return join(profileDirOf(host), 'cordis.patch.yml')
}

/** Both patch layers: the profile-owned one and the home-global one. */
export function patchPathsOf(host: McpHost): { profile: string; home: string } {
  return {
    profile: profilePatchPathOf(host),
    home: join(dshHomeOf(host), 'cordis.patch.yml'),
  }
}

/** Content hash of a patch file (for write fencing); null when absent. */
export function patchHash(path: string): string | null {
  const text = readPatchOrNull(path)
  if (text === null) return null
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/** MCP entries a patch file contributes (insert payloads only). */
function serverRowsFromPatch(path: string | null): Array<{ id: string; config: McpServerSpec; raw: PatchEntry }> {
  if (path === null) return []
  const text = readPatchOrNull(path)
  if (text === null) return []
  const rows = parsePatchText(text)
  if (rows === null) return []
  const out: Array<{ id: string; config: McpServerSpec; raw: PatchEntry }> = []
  const collect = (entries: unknown[]): void => {
    for (const value of entries) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      const entry = value as PatchEntry
      if (entry.name !== MCP_PLUGIN_NAME || typeof entry.id !== 'string') continue
      const config = asSpec(entry.config)
      if (config === null) continue
      out.push({ id: entry.id, config, raw: entry })
    }
  }
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue
    const insert = (row as Record<string, unknown>).insert
    if (Array.isArray(insert)) collect(insert)
  }
  return out
}

/** Coerce an unknown config value into a well-formed spec; null when not. */
function asSpec(value: unknown): McpServerSpec | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (isJsExpr(record.serverName)) return null
  if (typeof record.serverName !== 'string' || !SERVER_NAME_PATTERN.test(record.serverName)) return null
  const transport = record.transport
  if (transport !== 'stdio' && transport !== 'streamable-http') return null
  const spec: McpServerSpec = { serverName: record.serverName, transport }
  if (typeof record.command === 'string') spec.command = record.command
  if (Array.isArray(record.args) && record.args.every(arg => typeof arg === 'string')) {
    spec.args = record.args as string[]
  }
  if (typeof record.env === 'object' && record.env !== null && !Array.isArray(record.env)) {
    const env = record.env as Record<string, unknown>
    const clean: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) if (typeof value === 'string') clean[key] = value
    if (Object.keys(clean).length > 0) spec.env = clean
  }
  if (typeof record.cwd === 'string' && record.cwd !== '') spec.cwd = record.cwd
  if (typeof record.url === 'string') spec.url = record.url
  if (typeof record.headers === 'object' && record.headers !== null && !Array.isArray(record.headers)) {
    const headers = record.headers as Record<string, unknown>
    const clean: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) if (typeof value === 'string') clean[key] = value
    if (Object.keys(clean).length > 0) spec.headers = clean
  }
  if (typeof record.toolCallTimeoutMs === 'number' && Number.isFinite(record.toolCallTimeoutMs)) {
    spec.toolCallTimeoutMs = record.toolCallTimeoutMs
  }
  if (typeof record.failOnStartupError === 'boolean') spec.failOnStartupError = record.failOnStartupError
  if (typeof record.reconnect === 'object' && record.reconnect !== null && !Array.isArray(record.reconnect)) {
    const reconnect = record.reconnect as Record<string, unknown>
    const out: NonNullable<McpServerSpec['reconnect']> = {}
    if (typeof reconnect.enabled === 'boolean') out.enabled = reconnect.enabled
    if (typeof reconnect.initialDelayMs === 'number' && Number.isFinite(reconnect.initialDelayMs)) out.initialDelayMs = reconnect.initialDelayMs
    if (typeof reconnect.maxDelayMs === 'number' && Number.isFinite(reconnect.maxDelayMs)) out.maxDelayMs = reconnect.maxDelayMs
    if (typeof reconnect.maxAttempts === 'number' && Number.isFinite(reconnect.maxAttempts)) out.maxAttempts = reconnect.maxAttempts
    spec.reconnect = out
  }
  return spec
}

/** Human-readable one-line summary of a server (command or URL). */
export function specSummary(spec: McpServerSpec): string {
  if (spec.transport === 'stdio') {
    if (spec.command === undefined) return '(no command)'
    return [spec.command, spec.command.includes(' ') ? '' : spec.args?.join(' ') ?? ''].filter(Boolean).join(' ')
  }
  return spec.url ?? '(no url)'
}

/** Validate a user-supplied spec; returns a translated error list. */
export function validateSpec(spec: unknown): { ok: true; spec: McpServerSpec } | { ok: false; errors: string[] } {
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
    return { ok: false, errors: ['spec must be an object'] }
  }
  const record = spec as Record<string, unknown>
  const errors: string[] = []
  const serverName = typeof record.serverName === 'string' ? record.serverName.trim() : ''
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    errors.push('serverName must be 1-32 characters of [A-Za-z0-9_-]')
  }
  const transport = record.transport
  if (transport !== 'stdio' && transport !== 'streamable-http') {
    errors.push('transport must be "stdio" or "streamable-http"')
  }
  const command = typeof record.command === 'string' ? record.command : ''
  if (transport === 'stdio' && command.trim() === '') {
    errors.push('command is required for stdio servers')
  }
  const url = typeof record.url === 'string' ? record.url : ''
  if (transport === 'streamable-http') {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error()
    } catch {
      errors.push('a valid http(s) url is required for streamable-http servers')
    }
  }
  if (record.args !== undefined && (!Array.isArray(record.args) || !record.args.every(arg => typeof arg === 'string'))) {
    errors.push('args must be an array of strings')
  }
  if (record.env !== undefined && !isStringRecord(record.env)) {
    errors.push('env must be an object of string values')
  }
  if (record.headers !== undefined && !isStringRecord(record.headers)) {
    errors.push('headers must be an object of string values')
  }
  if (errors.length > 0) return { ok: false, errors }
  const normalized = asSpec({ serverName, transport: transport as 'stdio' | 'streamable-http', ...record })
  if (normalized === null) return { ok: false, errors: ['spec could not be normalized'] }
  return { ok: true, spec: normalized }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.values(value).every(item => typeof item === 'string')
}

/** Pick only the fields the mcp-client plugin tolerates, dropping unknown keys. */
export function sanitizeSpec(spec: McpServerSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {
    serverName: spec.serverName,
    transport: spec.transport,
  }
  if (spec.command !== undefined) out.command = spec.command
  if (spec.args !== undefined) out.args = spec.args
  if (spec.env !== undefined) out.env = spec.env
  if (spec.cwd !== undefined) out.cwd = spec.cwd
  if (spec.url !== undefined) out.url = spec.url
  if (spec.headers !== undefined) out.headers = spec.headers
  if (spec.toolCallTimeoutMs !== undefined) out.toolCallTimeoutMs = spec.toolCallTimeoutMs
  if (spec.failOnStartupError !== undefined) out.failOnStartupError = spec.failOnStartupError
  if (spec.reconnect !== undefined && Object.keys(spec.reconnect).length > 0) out.reconnect = spec.reconnect
  return out
}

/** Fiber state mirror (cross-package const enum, identical to plugin-inventory). */
const FIBER_PHASE: Record<number, string> = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: 'disposed',
  5: 'unloading',
}

/** All serverNames currently configured (loader + both patch layers). */
export function existingServerNames(host: McpHost): string[] {
  const names = new Set<string>()
  for (const entry of host.loader.entries()) {
    if (entry.options?.name !== MCP_PLUGIN_NAME) continue
    const config = asSpec(entry.options?.config)
    if (config !== null) names.add(config.serverName)
  }
  for (const path of Object.values(patchPathsOf(host))) {
    for (const row of serverRowsFromPatch(path)) names.add(row.config.serverName)
  }
  return [...names]
}

/** One server row in the list view. */
export interface McpServerView {
  id: string
  serverName: string
  transport: 'stdio' | 'streamable-http'
  summary: string
  enabled: boolean
  /** active | loading | failed | pending | unloading | disabled | missing */
  state: string
  toolCount: number
  patchLayer: PatchLayer | null
  config: McpServerSpec
}

/**
 * Build the merged server list: loader entries are the live ground truth
 * (resolve config overrides, fiber state, tool inventory); patch rows cover
 * servers that failed to mount (HMR lag, duplicate names, ...).
 */
export function listServers(host: McpHost): McpServerView[] {
  const views = new Map<string, McpServerView>()
  for (const entry of host.loader.entries()) {
    if (entry.options?.name !== MCP_PLUGIN_NAME || entry.options.id === undefined) continue
    const config = asSpec(entry.options.config)
    if (config === null) continue
    const enabled = entry.disabled === true || entry.options.disabled === true ? false : true
    const phase = entry.fiber?.state === undefined ? null : FIBER_PHASE[entry.fiber.state] ?? null
    const tools = host.tools.schemas().filter(tool => tool.name.startsWith(`mcp__${config.serverName}__`))
    views.set(entry.options.id, {
      id: entry.options.id,
      serverName: config.serverName,
      transport: config.transport,
      summary: specSummary(config),
      enabled,
      state: enabled ? (phase ?? 'missing') : 'disabled',
      toolCount: tools.length,
      patchLayer: null,
      config,
    })
  }
  for (const [layer, path] of Object.entries(patchPathsOf(host)) as Array<[PatchLayer, string]>) {
    for (const row of serverRowsFromPatch(path)) {
      if (!views.has(row.id)) {
        views.set(row.id, {
          id: row.id,
          serverName: row.config.serverName,
          transport: row.config.transport,
          summary: specSummary(row.config),
          enabled: true,
          state: 'missing',
          toolCount: 0,
          patchLayer: layer,
          config: row.config,
        })
      }
    }
  }
  const sorted = [...views.values()].sort((a, b) => a.serverName.localeCompare(b.serverName))
  return sorted
}

interface DetailedView extends McpServerView {
  tools: Array<{ name: string; description: string; paramCount: number }>
}

function toolsFor(host: McpHost, view: McpServerView): DetailedView['tools'] {
  return host.tools.schemas()
    .filter(tool => tool.name.startsWith(`mcp__${view.serverName}__`))
    .map(tool => {
      const properties = (tool.parameters as Record<string, unknown> | undefined)?.properties
      const params = typeof properties === 'object' && properties !== null ? properties : {}
      return {
        name: tool.name,
        description: tool.description ?? '',
        paramCount: Object.keys(params).length,
      }
    })
}

/** Write target resolution with fencing: expectedHash guards concurrent edits. */
export interface WriteOptions {
  layer?: PatchLayer
  expectedHash?: string | null
}

function writeTarget(host: McpHost, options: WriteOptions): { path: string; layer: PatchLayer } {
  const layer = options.layer ?? 'profile'
  return { path: patchPathsOf(host)[layer], layer }
}

function verifyFencing(path: string, expectedHash: string | null | undefined): string | null {
  const current = patchHash(path)
  if (expectedHash === undefined) return null
  if (current !== expectedHash) {
    return `the patch file changed since it was read (expected ${expectedHash ?? 'missing'}, found ${current ?? 'missing'}); reload and retry`
  }
  return null
}

/** Resolve the id for a new server: `mcp-<serverName>` (`#`-free, unique). */
function idForServer(host: McpHost, serverName: string): string {
  let id = `${MCP_ID_PREFIX}${serverName}`
  const existing = new Set<string>()
  for (const entry of host.loader.entries()) if (entry.options?.id !== undefined) existing.add(entry.options.id)
  for (const path of Object.values(patchPathsOf(host))) {
    for (const row of serverRowsFromPatch(path)) existing.add(row.id)
  }
  if (!existing.has(id)) return id
  let n = 2
  while (existing.has(`${id}-${n}`)) n += 1
  return `${id}-${n}`
}

/** Add a new server: append an insert row to the target patch layer. */
export function addServer(host: McpHost, spec: McpServerSpec, options: WriteOptions): { ok: true; id: string } | { ok: false; error: string } {
  const { path, layer } = writeTarget(host, options)
  const conflict = verifyFencing(path, options.expectedHash)
  if (conflict !== null) return { ok: false, error: conflict }
  if (existingServerNames(host).includes(spec.serverName)) {
    return { ok: false, error: `serverName "${spec.serverName}" is already in use; every live server needs a unique name` }
  }
  const id = idForServer(host, spec.serverName)
  const text = readPatchOrNull(path) ?? '[]\n'
  const appended = appendRowBlock(text, insertRowBlock(id, MCP_PLUGIN_NAME, sanitizeSpec(spec)))
  if (!appended.ok) return { ok: false, error: appended.reason }
  atomicWrite(path, appended.text)
  return { ok: true, id }
}

/** Edit a server: append an id-targeted override row (config is replaced wholesale). */
export function updateServer(host: McpHost, id: string, spec: McpServerSpec, options: WriteOptions): { ok: true } | { ok: false; error: string } {
  const { path } = writeTarget(host, options)
  const conflict = verifyFencing(path, options.expectedHash)
  if (conflict !== null) return { ok: false, error: conflict }
  const others = existingServerNames(host).filter(name => name !== spec.serverName)
  // The CURRENT name may swap to a new one; the old name then frees up.
  const current = findView(host, id)?.serverName
  if (others.includes(spec.serverName) && current !== spec.serverName) {
    return { ok: false, error: `serverName "${spec.serverName}" is already in use; every live server needs a unique name` }
  }
  const text = readPatchOrNull(path)
  if (text === null) return { ok: false, error: 'the target patch layer does not exist yet; add the server first' }
  const appended = appendRowBlock(text, overrideRowBlock(id, sanitizeSpec(spec)))
  if (!appended.ok) return { ok: false, error: appended.reason }
  atomicWrite(path, appended.text)
  return { ok: true }
}

/** Remove a server: drop every row (insert/override/disable) for its id. */
export function removeServer(host: McpHost, id: string, options: WriteOptions): { ok: true } | { ok: false; error: string } {
  const { path } = writeTarget(host, options)
  const conflict = verifyFencing(path, options.expectedHash)
  if (conflict !== null) return { ok: false, error: conflict }
  const text = readPatchOrNull(path)
  if (text === null) return { ok: false, error: 'the target patch layer has no content to remove from' }
  const next = removeRowsForId(text, id)
  if (next === text) {
    return { ok: false, error: `no rows for "${id}" were found in ${path}` }
  }
  atomicWrite(path, next)
  return { ok: true }
}

/** Find one server view by id (loader + patch rows). */
export function findView(host: McpHost, id: string): McpServerView | null {
  return listServers(host).find(view => view.id === id) ?? null
}

/**
 * Enable/disable a server by writing a `disabled: true|false` row into the
 * patch layer that owns the entry (profile when the row lives there, home
 * when it does — an override in a lower layer cannot reach a higher layer's
 * insert). A loader-only entry (no patch row) is toggled in the profile
 * layer, which discards its row's source metadata.
 */
export function setServerEnabled(host: McpHost, id: string, enabled: boolean, options: WriteOptions): { ok: true } | { ok: false; error: string } {
  const view = findView(host, id)
  if (view === null) return { ok: false, error: `server "${id}" not found` }
  const layer: PatchLayer = view.patchLayer === 'home' ? 'home' : 'profile'
  const { path } = writeTarget(host, { ...options, layer })
  const conflict = verifyFencing(path, options.expectedHash)
  if (conflict !== null) return { ok: false, error: conflict }
  const text = readPatchOrNull(path)
  if (text === null) return { ok: false, error: 'the target patch layer does not exist yet' }
  const cleaned = removeDisabledRowsForId(text, id)
  const appended = appendRowBlock(cleaned, toggleRowBlock(id, !enabled))
  if (!appended.ok) return { ok: false, error: appended.reason }
  atomicWrite(path, appended.text)
  return { ok: true }
}

/** One probe result. */
export interface ProbeResult {
  ok: boolean
  latencyMs: number
  toolCount: number
  tools: string[]
  error?: string
}

/** Build a probe-able transport from a spec (never touches the live tree). */
function transportFor(spec: McpServerSpec): StdioClientTransport | StreamableHTTPClientTransport {
  if (spec.transport === 'stdio') {
    const env = { ...getDefaultEnvironment(), ...(spec.env ?? {}) }
    return new StdioClientTransport({
      command: spec.command!,
      args: spec.args ?? [],
      env,
      cwd: spec.cwd,
      stderr: 'pipe',
    })
  }
  return new StreamableHTTPClientTransport(new URL(spec.url!), {
    requestInit: spec.headers !== undefined ? { headers: spec.headers } : undefined,
  })
}

/**
 * Probe one server with an independent SDK client: initialize + tools/list.
 * The probe shadows nothing — it closes every transport it opens and cannot
 * trigger the runtime reconnection machinery.
 */
export async function testConnection(spec: McpServerSpec): Promise<ProbeResult> {
  if (spec.transport === 'stdio' && (spec.command === undefined || spec.command === '')) {
    return { ok: false, latencyMs: 0, toolCount: 0, tools: [], error: 'command is required for stdio servers' }
  }
  if (spec.transport === 'streamable-http' && spec.url === undefined) {
    return { ok: false, latencyMs: 0, toolCount: 0, tools: [], error: 'url is required for streamable-http servers' }
  }
  const client = new Client({ name: 'dsh-tool-explorer', version: '0.1.0' })
  const transport = transportFor(spec)
  const started = Date.now()
  try {
    await client.connect(transport, { timeout: TEST_TIMEOUT_MS })
    const result = await client.listTools({}, { timeout: TEST_TIMEOUT_MS })
    const latencyMs = Date.now() - started
    return {
      ok: true,
      latencyMs,
      toolCount: result.tools.length,
      tools: result.tools.map(tool => tool.name),
    }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      toolCount: 0,
      tools: [],
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await client.close().catch(() => undefined)
  }
}

/** Re-exported for the routes (readable hash for responses). */
export function patchFilesView(host: McpHost): { profile: string; home: string } {
  const paths = patchPathsOf(host)
  return { profile: paths.profile, home: paths.home }
}

/** Short file label for the UI. */
export function patchLabel(host: McpHost, layer: PatchLayer): string {
  return patchPathsOf(host)[layer]
}

/** Tools one server exposes, for the expanded view. */
export function serverDetail(host: McpHost, id: string): { view: McpServerView; tools: Array<{ name: string; description: string; paramCount: number }> } | null {
  const view = listServers(host).find(entry => entry.id === id)
  if (view === undefined) return null
  return { view, tools: toolsFor(host, view) }
}
