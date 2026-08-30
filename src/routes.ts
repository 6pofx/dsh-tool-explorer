/**
 * HTTP routes bridging the browser UI to the host. This layer only parses
 * requests, validates input, calls the feature modules (mcp.ts; skills.ts
 * lands in a later milestone), and serializes responses.
 *
 * Security: every mutating endpoint accepts only same-origin POSTs; MCP
 * server configs are command-executing by nature, and the UI states that
 * caveat before a write.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readJsonBody, sameOrigin, sendJson } from './http.js'
import {
  addServer, listServers, patchFilesView, patchHash, removeServer,
  serverDetail, testConnection, updateServer, validateSpec,
  type McpHost, type McpServerSpec, type PatchLayer, type WriteOptions,
} from './mcp.js'
import type { ToolExplorerSettings } from './settings.js'

/** Structural subset of the dsh webServer service. */
export interface WebServerService {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Structural subset of a Cordis loader entry (plugin-inventory shape). */
export interface LoaderEntry {
  fiber?: { state?: number } | undefined
  disabled?: boolean
  options?: {
    id?: string
    name?: string
    config?: unknown
    disabled?: boolean
  }
}

/** Structural subset of the dsh-tools registry this plugin reads. */
export interface ToolsService {
  schemas(scope?: unknown): Array<{ name: string; description?: string; parameters?: Record<string, unknown> }>
}

/** The host services this plugin's routes consume. */
export interface ToolExplorerHost extends McpHost {
  webServer: WebServerService
  loader: { entries(): Iterable<LoaderEntry> }
  tools: ToolsService
}

/**
 * The plugin's own version, read once from its installed package.json. The
 * UI shows it in the page heading so a user's screenshot carries it: most
 * bug reports arrive as a photo of the screen.
 */
let cachedVersion: string | null = null
export function toolExplorerVersion(): string {
  if (cachedVersion !== null) return cachedVersion
  try {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version?: string }
    cachedVersion = manifest.version ?? 'unknown'
  } catch {
    cachedVersion = 'unknown'
  }
  return cachedVersion
}

/** The profile this host process actually booted (`--profile <name>`). */
export function argvProfile(): string {
  const argv = process.argv
  const flag = argv.indexOf('--profile')
  if (flag !== -1 && flag + 1 < argv.length && !argv[flag + 1]!.startsWith('-')) return argv[flag + 1]!
  return 'web'
}

function requireSameOrigin(request: IncomingMessage, response: ServerResponse): boolean {
  if (!sameOrigin(request)) {
    sendJson(response, 403, { error: 'untrusted origin' })
    return false
  }
  return true
}

function requireMethod(request: IncomingMessage, response: ServerResponse, methods: string[]): boolean {
  if (!methods.includes(request.method ?? '')) {
    response.writeHead(405, { allow: methods.join(', ') })
    response.end()
    return false
  }
  return true
}

/** Parse write options out of a request body. */
function writeOptionsFrom(body: Record<string, unknown>): WriteOptions {
  const layer = body.layer === 'home' ? ('home' as PatchLayer) : ('profile' as PatchLayer)
  const expectedHash = typeof body.expectedHash === 'string' || body.expectedHash === null
    ? body.expectedHash
    : undefined
  return { layer, expectedHash }
}

/** Decode a route path parameter. */
function param(request: IncomingMessage, prefix: string): string {
  const path = request.url ?? ''
  const at = path.indexOf(prefix)
  if (at === -1) return ''
  const raw = path.slice(at + prefix.length).split('?')[0] ?? ''
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/**
 * Register the plugin's HTTP routes.
 * @param host - Acquired webServer + loader + tools services.
 * @param settings - Live settings getter (see installToolExplorerSettings).
 * @returns Disposer removing every registered route.
 */
export function mountRoutes(host: ToolExplorerHost, settings: () => ToolExplorerSettings): () => void {
  const disposers: Array<() => void> = []

  disposers.push(host.webServer.register({
    kind: 'exact',
    path: '/dsh-tool-explorer/api/status',
    handler: (request, response) => {
      if (!requireMethod(request, response, ['GET'])) return
      const entries = [...host.loader.entries()]
      sendJson(response, 200, {
        ok: true,
        name: 'dsh-tool-explorer',
        version: toolExplorerVersion(),
        profile: host.profileName,
        loaderEntries: entries.length,
        selfEntry: entries.some(entry => entry.options?.id === 'dsh-tool-explorer' || entry.options?.name === 'dsh-tool-explorer'),
        features: {
          mcp: true,
        },
        config: settings(),
      })
    },
  }))

  // --- MCP ---

  disposers.push(host.webServer.register({
    kind: 'exact',
    path: '/dsh-tool-explorer/api/mcp',
    handler: async (request, response) => {
      if (!requireMethod(request, response, ['GET', 'POST'])) return
      if (request.method === 'POST') {
        if (!requireSameOrigin(request, response)) return
        await handleAddServer(host, request, response)
        return
      }
      sendJson(response, 200, mcpListPayload(host))
    },
  }))

  disposers.push(host.webServer.register({
    kind: 'exact',
    path: '/dsh-tool-explorer/api/mcp/test',
    handler: (request, response) => {
      if (!requireMethod(request, response, ['POST'])) return
      if (!requireSameOrigin(request, response)) return
      void handleTestServer(request, response)
    },
  }))

  disposers.push(host.webServer.register({
    kind: 'prefix',
    path: '/dsh-tool-explorer/api/mcp/',
    handler: async (request, response) => {
      const id = param(request, '/dsh-tool-explorer/api/mcp/')
      if (id === '' || id === 'test') {
        // `test` is an exact route above; never treat it as a server id.
        sendJson(response, 404, { error: 'not found' })
        return
      }
      if (request.method === 'GET') {
        handleServerDetail(host, request, response, id)
        return
      }
      if (request.method === 'PUT') {
        if (!requireSameOrigin(request, response)) return
        await handleUpdateServer(host, request, response, id)
        return
      }
      if (request.method === 'DELETE') {
        if (!requireSameOrigin(request, response)) return
        handleRemoveServer(host, request, response, id)
        return
      }
      response.writeHead(405, { allow: 'GET, PUT, DELETE' })
      response.end()
    },
  }))

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // teardown must not be blocked by one failing route disposer
      }
    }
  }
}

function mcpListPayload(host: ToolExplorerHost): Record<string, unknown> {
  const files = patchFilesView(host)
  return {
    servers: listServers(host),
    files: {
      profile: { path: files.profile, hash: patchHash(files.profile) },
      home: { path: files.home, hash: patchHash(files.home) },
    },
  }
}

async function handleAddServer(host: ToolExplorerHost, request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const body = (await readJsonBody(request)) as Record<string, unknown>
    const validated = validateSpec(body.spec)
    if (!validated.ok) {
      sendJson(response, 400, { error: validated.errors.join('; ') })
      return
    }
    const result = addServer(host, validated.spec, writeOptionsFrom(body))
    if (!result.ok) {
      sendJson(response, 409, { error: result.error })
      return
    }
    sendJson(response, 200, { ok: true, id: result.id, ...mcpListPayload(host) })
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
  }
}

async function handleUpdateServer(host: ToolExplorerHost, request: IncomingMessage, response: ServerResponse, id: string): Promise<void> {
  try {
    const body = (await readJsonBody(request)) as Record<string, unknown>
    const validated = validateSpec(body.spec)
    if (!validated.ok) {
      sendJson(response, 400, { error: validated.errors.join('; ') })
      return
    }
    const result = updateServer(host, id, validated.spec, writeOptionsFrom(body))
    if (!result.ok) {
      sendJson(response, 409, { error: result.error })
      return
    }
    sendJson(response, 200, { ok: true, ...mcpListPayload(host) })
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
  }
}

function handleRemoveServer(host: ToolExplorerHost, request: IncomingMessage, response: ServerResponse, id: string): void {
  const query = new URL(request.url ?? '', 'http://localhost').searchParams
  const result = removeServer(host, id, {
    layer: query.get('layer') === 'home' ? 'home' : 'profile',
    expectedHash: query.get('expectedHash') ?? undefined,
  })
  if (!result.ok) {
    sendJson(response, 409, { error: result.error })
    return
  }
  sendJson(response, 200, { ok: true, ...mcpListPayload(host) })
}

function handleServerDetail(host: ToolExplorerHost, request: IncomingMessage, response: ServerResponse, id: string): void {
  const detail = serverDetail(host, id)
  if (detail === null) {
    sendJson(response, 404, { error: `server "${id}" not found` })
    return
  }
  sendJson(response, 200, { ok: true, server: detail.view, tools: detail.tools })
}

async function handleTestServer(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const body = (await readJsonBody(request)) as Record<string, unknown>
    const validated = validateSpec(body.spec)
    if (!validated.ok) {
      sendJson(response, 400, { error: validated.errors.join('; ') })
      return
    }
    const result = await testConnection(validated.spec as McpServerSpec)
    sendJson(response, 200, result)
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}
