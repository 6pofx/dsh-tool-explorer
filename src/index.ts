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
import { mountRoutes, type ToolExplorerHost } from './routes.js'

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

  ctx.inject(['webServer', 'loader'], (hostCtx: Context) => {
    const host = hostCtx as unknown as ToolExplorerHost
    ctx.effect(() => mountRoutes(host, getSettings), 'dsh-tool-explorer: http routes')
  })
}
