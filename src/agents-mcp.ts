/**
 * Cross-agent MCP import: scan the well-known config files of other desktop
 * agents (Claude Code, Cursor, Codex, Cline, Roo Code, Continue, Windsurf),
 * normalize their server definitions onto the dsh mcp-client spec, and hand
 * them to the same add-server pipeline (patch-layer write + HMR hot apply).
 *
 * Only reads the config files; nothing here writes anything outside the dsh
 * patch layer selected at import time.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** A server definition as found in one external agent config. */
export interface ExtServerRaw {
  name: string
  type?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
}

/** One scanned source (one config file). */
export interface ImportSource {
  /** Stable agent id (claude-code, cursor, codex, ...). */
  agent: string
  /** Human label. */
  label: string
  path: string
  exists: boolean
  servers: ExtServerRaw[]
  /** Parse problem, when the file exists but could not be read. */
  error?: string
}

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/u

/** Normalize a raw server name onto the dsh serverName pattern, or null. */
export function normalizeServerName(raw: string): string | null {
  const ascii = raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '')
  if (ascii.length === 0) return null
  if (ascii.length > 32) return ascii.slice(0, 32).replace(/-+$/u, '')
  return ascii
}

function readJsonConfig(path: string): { mcpServers?: Record<string, unknown> } | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    if (typeof parsed.mcpServers === 'object' && parsed.mcpServers !== null && !Array.isArray(parsed.mcpServers)) {
      return parsed as { mcpServers?: Record<string, unknown> }
    }
    return null
  } catch {
    return null
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const item of value) if (typeof item === 'string') out.push(item)
  return out.length > 0 ? out : undefined
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') out[key] = item
    else if (typeof item === 'number' || typeof item === 'boolean') out[key] = String(item)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Normalize one raw definition; null when it is not a usable server. */
function toServer(record: unknown, fallbackName: string): ExtServerRaw | null {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return null
  const r = record as Record<string, unknown>
  const name = fallbackName
  const command = asString(r.command)
  const url = asString(r.url)
  if (command === undefined && url === undefined) return null
  const type = asString(r.type)
  const transport = type !== undefined && type !== 'stdio' && type !== 'streamable-http'
    ? undefined
    : type ?? (url !== undefined ? 'streamable-http' : 'stdio')
  return {
    name,
    ...(transport !== undefined ? { type: transport } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(asStringArray(r.args) !== undefined ? { args: asStringArray(r.args) } : {}),
    ...(asStringRecord(r.env) !== undefined ? { env: asStringRecord(r.env) } : {}),
    ...(asString(r.cwd) !== undefined ? { cwd: asString(r.cwd) } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(asStringRecord(r.headers) !== undefined ? { headers: asStringRecord(r.headers) } : {}),
  }
}

function serversOf(config: { mcpServers?: Record<string, unknown> } | null): ExtServerRaw[] {
  if (config === null) return []
  const out: ExtServerRaw[] = []
  for (const [name, definition] of Object.entries(config.mcpServers ?? {})) {
    const server = toServer(definition, name)
    if (server !== null) out.push(server)
  }
  return out
}

/** Minimal TOML parser for the Codex mcp config subset: section headers,
 * strings, numbers, booleans, inline arrays and inline tables. */
function parseCodexToml(text: string): Array<{ section: string; key: string; value: unknown }> {
  const out: Array<{ section: string; key: string; value: unknown }> = []
  let section = ''
  let at = 0
  const lines = text.split(/\r?\n/u)
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const header = /^\[([^\]]+)\]$/u.exec(line)
    if (header !== null) {
      section = (header[1] ?? '').trim()
      continue
    }
    const eq = indexOfUnquoted(line, '=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    const valueText = line.slice(eq + 1).trim()
    const value = parseTomlValue(valueText)
    if (value.parsed) out.push({ section, key, value: value.value })
  }
  return out
}

function indexOfUnquoted(text: string, needle: string): number {
  let quote: string | null = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== null) {
      if (ch === quote && text[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === needle) return i
  }
  return -1
}

/** Parse one TOML value: string, number, boolean, inline array, inline table. */
function parseTomlValue(text: string): { parsed: boolean; value: unknown } {
  if (text.startsWith('"') || text.startsWith("'")) {
    const quote = text[0]!
    const end = text.indexOf(quote, 1)
    if (end <= 0) return { parsed: false, value: undefined }
    return { parsed: true, value: text.slice(1, end) }
  }
  if (text.startsWith('[')) {
    const inner = text.slice(1, text.lastIndexOf(']') === -1 ? undefined : text.lastIndexOf(']')).trim()
    if (inner === '') return { parsed: true, value: [] }
    const items: unknown[] = []
    let current = ''
    let depth = 0
    let quote: string | null = null
    for (let i = 0; i < inner.length; i += 1) {
      const ch = inner[i]
      if (quote !== null) {
        current += ch
        if (ch === quote) quote = null
        continue
      }
      if (ch === '"' || ch === "'") { quote = ch; current += ch; continue }
      if (ch === '{' || ch === '[') depth += 1
      if (ch === '}' || ch === ']') depth -= 1
      if (ch === ',' && depth === 0) {
        const value = parseTomlValue(current.trim())
        if (value.parsed) items.push(value.value)
        current = ''
        continue
      }
      current += ch
    }
    const last = parseTomlValue(current.trim())
    if (last.parsed && current.trim() !== '') items.push(last.value)
    return { parsed: true, value: items }
  }
  if (text.startsWith('{')) {
    const inner = text.slice(1, text.lastIndexOf('}') === -1 ? undefined : text.lastIndexOf('}')).trim()
    const out: Record<string, unknown> = {}
    if (inner === '') return { parsed: true, value: out }
    let current = ''
    let depth = 0
    let quote: string | null = null
    for (let i = 0; i < inner.length; i += 1) {
      const ch = inner[i]
      if (quote !== null) {
        current += ch
        if (ch === quote) quote = null
        continue
      }
      if (ch === '"' || ch === "'") { quote = ch; current += ch; continue }
      if (ch === '{' || ch === '[') depth += 1
      if (ch === '}' || ch === ']') depth -= 1
      if (ch === ',' && depth === 0) {
        const eq = indexOfUnquoted(current, '=')
        if (eq > 0) {
          const value = parseTomlValue(current.slice(eq + 1).trim())
          if (value.parsed) out[current.slice(0, eq).trim()] = value.value
        }
        current = ''
        continue
      }
      current += ch
    }
    const eq = indexOfUnquoted(current, '=')
    if (eq > 0) {
      const value = parseTomlValue(current.slice(eq + 1).trim())
      if (value.parsed) out[current.slice(0, eq).trim()] = value.value
    }
    return { parsed: true, value: out }
  }
  if (/^-?\d+(?:\.\d+)?$/u.test(text)) return { parsed: true, value: Number(text) }
  if (text === 'true' || text === 'false') return { parsed: true, value: text === 'true' }
  return { parsed: false, value: undefined }
}

/** Codex: `~/.codex/config.toml` — `[mcp_servers.NAME]` sections. */
function codexServers(path: string): ExtServerRaw[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const grouped = new Map<string, Record<string, unknown>>()
  for (const entry of parseCodexToml(text)) {
    if (!entry.section.startsWith('mcp_servers.')) continue
    const name = entry.section.slice('mcp_servers.'.length)
    if (name === '') continue
    if (!grouped.has(name)) grouped.set(name, {})
    grouped.get(name)![entry.key] = entry.value
  }
  const out: ExtServerRaw[] = []
  for (const [name, record] of grouped) {
    const server = toServer(record, name)
    if (server !== null) out.push(server)
  }
  return out
}

function scanOne(agent: string, label: string, path: string, parse: (path: string) => ExtServerRaw[]): ImportSource {
  let exists = false
  try {
    exists = readFileSync(path, 'utf8').length >= 0
  } catch {
    exists = false
  }
  return {
    agent,
    label,
    path,
    exists,
    servers: exists ? parse(path) : [],
  }
}

const HOME = (): string => process.env.DSH_TE_AGENT_HOME ?? homedir()

/** Scan every known source; nonexistent files yield empty sources. */
export function scanAgentMcpSources(): ImportSource[] {
  const home = HOME()
  const sources: Array<{ agent: string; label: string; path: string; parse: (path: string) => ExtServerRaw[] }> = [
    { agent: 'claude-code', label: 'Claude Code (全局配置)', path: join(home, '.claude.json'), parse: p => serversOf(readJsonConfig(p)) },
    { agent: 'claude-code', label: 'Claude Code (~/.claude/mcp.json)', path: join(home, '.claude', 'mcp.json'), parse: p => serversOf(readJsonConfig(p)) },
    { agent: 'cursor', label: 'Cursor', path: join(home, '.cursor', 'mcp.json'), parse: p => serversOf(readJsonConfig(p)) },
    { agent: 'codex', label: 'Codex', path: join(home, '.codex', 'config.toml'), parse: codexServers },
    { agent: 'cline', label: 'Cline', path: join(home, '.cline', 'mcp_settings.json'), parse: p => serversOf(readJsonConfig(p)) },
    { agent: 'roo', label: 'Roo Code', path: join(home, '.roo', 'mcp.json'), parse: p => serversOf(readJsonConfig(p)) },
    { agent: 'continue', label: 'Continue', path: join(home, '.continue', 'mcp.json'), parse: p => serversOf(readJsonConfig(p)) },
    { agent: 'windsurf', label: 'Windsurf', path: join(home, '.codeium', 'windsurf', 'mcp_config.json'), parse: p => serversOf(readJsonConfig(p)) },
  ]
  return sources.map(source => scanOne(source.agent, source.label, source.path, source.parse))
}
