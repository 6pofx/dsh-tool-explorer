/**
 * The plugin's own settings namespace: preferences shared by every feature
 * module (skill install target, MCP config layer, preview limits).
 *
 * DSH 0.1.5 removed the module-level `settingsNamespace` /
 * `installSettingsSection` helpers (importing them made this plugin fail to
 * load with `SyntaxError: The requested module '@deepseek-ai/dsh-settings' does
 * not provide an export named 'installSettingsSection'`). The same capability is
 * now an instance method on the `ctx.settings` provider
 * ({@link SettingsProvider.installSection}), so this module imports TYPES ONLY
 * and reaches the provider through `ctx.inject(['settings'])`.
 *
 * Degradation contract, unchanged from the pre-0.1.5 wiring: a host with no
 * settings service — or one whose provider predates `installSection` — simply
 * keeps the composed entry config as-is, and the returned getter always returns
 * a valid resolved value.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsProvider } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

/** Namespace the settings document files this plugin's section under. */
export const TOOL_EXPLORER_SETTINGS_NS = 'dsh-tool-explorer'

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
 * overrides the moment they are committed (the provider re-points the source
 * through `setSource`), so feature modules read fresh values without
 * subscribing themselves.
 *
 * @param ctx - the plugin's own context; it owns the registration (the
 *   provider drops the namespace when this fiber unloads).
 * @param entry - the composition entry config, used as the provider's base
 *   layer and as the fallback value when no provider is attached.
 * @returns a thunk over the currently authoritative settings value.
 */
export function installToolExplorerSettings(
  ctx: Context,
  entry: ToolExplorerSettings,
): () => ToolExplorerSettings {
  let source = (): ToolExplorerSettings => entry
  ctx.inject(['settings'], (settingsCtx: Context) => {
    // `settings` is typed by @deepseek-ai/dsh-settings' module augmentation, but
    // a host that predates the provider API has neither the method nor the same
    // service shape — feature-detect rather than assume.
    const provider = settingsCtx.settings as SettingsProvider | undefined
    if (provider === undefined || typeof provider.installSection !== 'function') return
    provider.installSection(ctx, TOOL_EXPLORER_SETTINGS_NS, ToolExplorerSettingsSchema, entry, {
      setSource: (current) => {
        source = current as () => ToolExplorerSettings
      },
      onChange: () => undefined,
    })
  })
  return () => source()
}
