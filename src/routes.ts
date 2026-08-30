/**
 * HTTP routes bridging the browser UI to the host. This layer only parses
 * requests and serializes responses — feature logic lives in modules
 * (skills.ts, mcp.ts) added in later milestones.
 *
 * Security: every mutating endpoint accepts only same-origin POSTs.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson } from './http.js'
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
  fiber?: unknown
  options?: {
    id?: string
    name?: string
    config?: unknown
    disabled?: boolean
  }
}

/** The host services this plugin's routes consume. */
export interface ToolExplorerHost {
  webServer: WebServerService
  loader: { entries(): Iterable<LoaderEntry> }
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

/**
 * Register the plugin's HTTP routes.
 * @param host - Acquired webServer + loader services.
 * @param settings - Live settings getter (see installToolExplorerSettings).
 * @returns Disposer removing every registered route.
 */
export function mountRoutes(host: ToolExplorerHost, settings: () => ToolExplorerSettings): () => void {
  const disposers: Array<() => void> = []

  disposers.push(host.webServer.register({
    kind: 'exact',
    path: '/dsh-tool-explorer/api/status',
    handler: (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      const entries = [...host.loader.entries()]
      sendJson(response, 200, {
        ok: true,
        name: 'dsh-tool-explorer',
        version: toolExplorerVersion(),
        profile: argvProfile(),
        loaderEntries: entries.length,
        selfEntry: entries.some(entry => entry.options?.id === 'dsh-tool-explorer' || entry.options?.name === 'dsh-tool-explorer'),
        features: {
          skills: false, // lands with the skills milestone (M2/M3)
          mcp: false, // lands with the mcp milestone (M1)
        },
        config: settings(),
      })
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
