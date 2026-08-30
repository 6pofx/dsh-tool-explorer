/**
 * The plugin's own settings namespace: preferences shared by every feature
 * module (skill install target, MCP config layer, preview limits).
 *
 * Registered through `installSettingsSection` so a host with no settings
 * service (every dsh before 0.1.0-rc.7) simply keeps the composed entry
 * config as-is; the returned getter always returns a valid resolved value.
 */

import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

/** Namespace the browser side keys its configuration card to. */
export const TOOL_EXPLORER_SETTINGS_NS = settingsNamespace('dsh-tool-explorer')

/** Which skills root new installs and edits target by default. */
export type SkillRoot = '~/.agents/skills' | '~/.dsh/skills'

/** Which patch layer MCP server configuration is written to. */
export type McpConfigTarget = 'profile' | 'home'

/** The plugin settings a user may edit at runtime. */
export interface ToolExplorerSettings {
  /** Default root for installing and creating skills. */
  defaultSkillRoot: string
  /** Default target layer for MCP server configuration writes. */
  mcpConfigTarget: McpConfigTarget
  /** Preview truncation limit for skill content, in bytes. */
  previewContentLimit: number
}

/** Schema used both for the settings document and the entry config. */
export const ToolExplorerSettingsSchema = z.object({
  defaultSkillRoot: z.string().default('~/.agents/skills'),
  mcpConfigTarget: z.union([z.const('profile'), z.const('home')]).default('profile'),
  previewContentLimit: z.number().min(1024).max(1_000_000).default(20000),
})

/** Resolved defaults for a composition that declares nothing. */
export const TOOL_EXPLORER_SETTINGS_DEFAULTS: ToolExplorerSettings = {
  defaultSkillRoot: '~/.agents/skills',
  mcpConfigTarget: 'profile',
  previewContentLimit: 20000,
}

/**
 * Wire the namespace and hand back a live getter. The getter reflects user
 * overrides the moment they are committed (the settings service watches the
 * scope and re-points the source), so feature modules read fresh values
 * without subscribing themselves.
 */
export function installToolExplorerSettings(
  ctx: Context,
  entry: ToolExplorerSettings,
): () => ToolExplorerSettings {
  let source = (): ToolExplorerSettings => entry
  installSettingsSection(ctx, TOOL_EXPLORER_SETTINGS_NS, ToolExplorerSettingsSchema, entry, {
    setSource: (current) => {
      source = current as () => ToolExplorerSettings
    },
    onChange: () => undefined,
  })
  return () => source()
}
