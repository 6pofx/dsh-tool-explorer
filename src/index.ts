/**
 * dsh-tool-explorer host entry: mounts the management console's HTTP routes
 * once the profile composes the webServer service.
 *
 * Milestone M0: skeleton only — status route, settings namespace, and the
 * browser section registration. Skills (M2/M3) and MCP (M1) modules plug in
 * here as they land.
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  installToolExplorerSettings,
  TOOL_EXPLORER_SETTINGS_DEFAULTS,
  type ToolExplorerSettings,
} from './settings.js'
import { argvProfile, mountRoutes, type ToolExplorerHost } from './routes.js'

export const name = 'dsh-tool-explorer'

/** Optional cordis.yml configuration overrides for the settings defaults. */
export type Config = Partial<Pick<ToolExplorerSettings, 'defaultSkillRoot' | 'mcpConfigTarget' | 'previewContentLimit'>>

export function apply(ctx: Context, config?: Config): void {
  const entry: ToolExplorerSettings = {
    defaultSkillRoot: config?.defaultSkillRoot ?? TOOL_EXPLORER_SETTINGS_DEFAULTS.defaultSkillRoot,
    mcpConfigTarget: config?.mcpConfigTarget ?? TOOL_EXPLORER_SETTINGS_DEFAULTS.mcpConfigTarget,
    previewContentLimit: config?.previewContentLimit ?? TOOL_EXPLORER_SETTINGS_DEFAULTS.previewContentLimit,
  }
  const getSettings = installToolExplorerSettings(ctx, entry)

  ctx.inject(['webServer', 'loader', 'tools', 'skills'], (hostCtx: Context) => {
    // The scoped ctx is an active fiber PROXY: setting undeclared properties
    // on it throws. Read the injected services out into a plain host object
    // instead — the shape the feature modules consume.
    const scoped = hostCtx as unknown as ToolExplorerHost
    const host: ToolExplorerHost = {
      webServer: scoped.webServer,
      loader: scoped.loader,
      tools: scoped.tools,
      skills: scoped.skills,
      // Optional agent inventory, resolved LAZILY per request (never during
      // apply): a synchronous ctx.get('agents') at boot can wait for a
      // service that is still mounting and hang the whole dsh startup
      // (observed: no console output for 40+ minutes until rollback).
      agentsLookup: () => {
        try {
          return ctx.get('agents') as ReturnType<NonNullable<ToolExplorerHost['agentsLookup']>> | undefined
        } catch {
          return undefined
        }
      },
      profileName: argvProfile(),
    }
    ctx.effect(() => mountRoutes(host, getSettings), 'dsh-tool-explorer: http routes')
  })
}
