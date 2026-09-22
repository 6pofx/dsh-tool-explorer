/**
 * The plugin's own settings namespace: preferences shared by every feature
 * module (skill install target, MCP config layer, preview limits).
 *
 * CROSS-VERSION CONTRACT. The settings API moved twice around this plugin:
 * `0.1.0-rc.7 … 0.1.4` exposed module-level `settingsNamespace()` +
 * `installSettingsSection()`, and `0.1.5` replaced them with the provider method
 * `SettingsProvider.installSection()`. Importing either helper makes the plugin
 * fail to load on the other release — the 0.1.5 removal of those exports is
 * exactly what disabled this plugin
 * (`SyntaxError: … does not provide an export named 'installSettingsSection'`).
 *
 * So this module imports TYPES ONLY and registers through the part of the
 * surface that did NOT move: `ctx.settings.register(ns, schema, { base })`,
 * which takes identical arguments and returns an identical `scope.get()` in both
 * lines. The composition entry rides as the `base` layer, so a host whose
 * provider predates `register` (or has no settings service at all) keeps the
 * entry config unchanged — the same degradation the old helper provided.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsProvider, SettingsScope } from '@deepseek-ai/dsh-settings'
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
 * Read one resolved settings value, falling back to the composition entry when
 * the scope is no longer readable.
 *
 * A registered scope is torn down with its fiber; a request that arrives after
 * that must not fail, and a provider that detaches mid-session must degrade to
 * the entry config instead of throwing on every route — the fallback the
 * removed `installSettingsSection` helper used to install.
 *
 * @param scope - the scope the provider resolved for this namespace.
 * @param entry - the composition entry config used as the fallback value.
 * @returns the resolved settings, or the entry config.
 */
function readScope(scope: SettingsScope<ToolExplorerSettings>, entry: ToolExplorerSettings): ToolExplorerSettings {
  try {
    return scope.get()
  } catch {
    return entry
  }
}

/**
 * Wire the namespace and hand back a live getter. The getter reflects user
 * overrides the moment they are committed (the provider re-resolves the
 * namespace), so feature modules read fresh values without subscribing.
 *
 * @param ctx - the plugin's own context; it owns the registration (the provider
 *   drops the namespace when this fiber unloads).
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
    // an older or partial host may expose no service, or one without the
    // namespace registry — feature-detect rather than assume.
    const provider = settingsCtx.settings as SettingsProvider | undefined
    if (provider === undefined || typeof provider.register !== 'function') return
    const scope = provider.register(TOOL_EXPLORER_SETTINGS_NS, ToolExplorerSettingsSchema, { base: entry })
    source = () => readScope(scope, entry)
  })
  return () => source()
}
