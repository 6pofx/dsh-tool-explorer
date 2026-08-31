English | [中文](README.zh.md)

# dsh-tool-explorer

[![npm version](https://img.shields.io/npm/v/dsh-tool-explorer)](https://www.npmjs.com/package/dsh-tool-explorer)
[![npm downloads](https://img.shields.io/npm/dw/dsh-tool-explorer)](https://www.npmjs.com/package/dsh-tool-explorer)
[![license](https://img.shields.io/npm/l/dsh-tool-explorer)](LICENSE)

Management console for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh): a Web settings page where you can **browse, install, update, edit and toggle skills**, and **add, edit, enable/disable, test and monitor MCP servers**.

## Features

**Skills**
- Full catalog across every provider (project/user/bundled/plugin) merged with the shared `.skill-lock.json`
- **Hierarchical browse by source**: collapsible source tree (project-dsh → project-agents → custom → user-dsh → user-agents → runtime → bundled), each source subdivided by provider, with loaded/disabled counts; source + state filters and flat view
- Search, detail preview, online create/edit (kebab-case validation, frontmatter form, Markdown body)
- **Independent model / user invocation switches** — turn off the model call for a skill alone (`disable-model-invocation`) while keeping the `/` menu, or vice versa; both off = fully disabled
- **Recoverable trash**: deleting a user-root skill moves it to `<dshHome>/skills-trash` (lock entry snapshotted); restore puts it back byte-identically, or purge / empty for permanent removal
- Install from GitHub: URL parsing (`owner/repo`, tree paths, `#branch`), candidate preview, install into `~/.agents/skills` or `~/.dsh/skills`, update check/apply (backup + rollback), uninstall
- `skillFolderHash` is byte-compatible with the Skills CLI (`npx skills`)

**MCP**
- Server list with live state (fiber phase), tool inventory and per-server tool counts
- Add/edit/delete servers (stdio + streamable-http) and **enable/disable** toggles — all through the profile patch layer (HMR hot-applies, no restart)
- Cross-agent import: scan `~/.claude.json`, `~/.cursor/mcp.json`, `~/.codex/config.toml` (TOML), `~/.cline/mcp_settings.json`, `~/.roo/mcp.json`, `~/.continue/mcp.json`, `~/.codeium/windsurf/mcp_config.json` and import in one click
- Test connection with an independent SDK probe (never disturbs running instances)
- Write fencing (expected-hash) against concurrent hand edits

## Install

Published on [npm](https://www.npmjs.com/package/dsh-tool-explorer) (v0.3.0):

```bash
dsh plugin --profile web add dsh-tool-explorer
```

`dsh plugin` reconciles the bundle automatically. Restart `dsh web` once (host plugins load at boot), then open **Settings → Skills 和 MCP**.

## Local development

```bash
pnpm install
pnpm run typecheck   # tsc for host + client sources
pnpm run build       # tsc host -> lib/, tsdown client -> client/client.js (wrapped + verified)
pnpm test:self       # 116+ assertions: mock host CRUD, cross-agent import, git install, trash, real stdio probe
```

Local install loop:

```bash
pnpm pack
dsh plugin --profile web remove dsh-tool-explorer
dsh plugin --profile web add file:G:/dsh-tool-explorer/dsh-tool-explorer-0.4.0.tgz
```

> Adding a runtime dependency (e.g. `tar`) requires a **re-pack + reinstall** — copying `lib/` alone is not enough.

## Reference implementations

The M5 feature set (source-grouped browse, per-axis invocation, recoverable trash) was designed against the existing community plugins below — cloned under `.ref/` for reference:

- [cheshireez/dsh-skill-hub](https://github.com/cheshireez/dsh-skill-hub) — in-GUI skill hub on the official `ctx.skills` registry; its `.trash/` rename + restore + clear pattern inspired our recoverable trash
- [SeverusZh/dsh-skills-mcp-group-manager](https://github.com/SeverusZh/dsh-skills-mcp-group-manager) — group management and model-catalog filtering via a shadow skill provider
- [BAIKAI23333/dsh-skills-manager](https://github.com/BAIKAI23333/dsh-skills-manager) — settings-page skills manager
- [peiqi10086/dsh-skills-market](https://github.com/peiqi10086/dsh-skills-market) — sidebar skills panel (user/project/bundled) + SkillHub marketplace

Design notes: we keep the platform-documented frontmatter dual switches (`disable-model-invocation` / `user-invocable`) instead of skill-hub's `SKILL.md.disabled` rename, and keep the trash **outside** every skill root so provider watchers never observe it.

## Layout

| Path | Purpose |
|---|---|
| `src/index.ts` | Host entry; plain host object built from injected services (never mutate the Cordis scope proxy) |
| `src/routes.ts` | HTTP routes under `/dsh-tool-explorer/api/*` (same-origin enforced on writes) |
| `src/mcp.ts` | MCP manager: patch-layer CRUD, enable/disable, state derivation, SDK probe |
| `src/skills.ts` | Skills catalog (registry × lock file × disk), edit/toggle, per-axis model/user invocation, frontmatter parsing (full YAML) |
| `src/skills-trash.ts` | Recoverable trash: delete-to-trash, restore, purge, empty (`<dshHome>/skills-trash` + manifest) |
| `src/skills-install.ts` | GitHub install ecosystem: tarball fetch (regional proxy), candidate discovery, lock v3, CLI-compatible folder hash |
| `src/agents-mcp.ts` | Cross-agent MCP import (JSON + Codex TOML subset parser) |
| `src/patch-text.ts` | Patch-layer dialect: parse (`!!js` tolerant), surgical row edits, `[]` placeholder handling, atomic writes |
| `scripts/` | Client bundle wrapper/check, self-test, and **local dsh-mcp-client patches** (see below) |

## Local dsh-mcp-client patches

Two idempotent patches fix upstream dsh-mcp-client gaps until the official package gains config support ([reported upstream](https://github.com/deepseek-ai/deepseek-harness/discussions/5129); re-run after any mcp-client update — dshmarket upgrades restore the official files):

```bash
# 1) silence stdio server stderr (banners/JSON logs were flooding `dsh web` output)
node scripts/patch-mcp-client-stderr.mjs
# 2) bound the startup wait (a hanging/unreachable server blocked the ready line)
node scripts/patch-mcp-client-async.mjs
```

Backups are written as `index.js.*.bak` next to the patched file.

## Feedback

Issues, feature requests and upstream discussions:

- The two local patches above are reported upstream in [DeepSeek Harness Discussions #5129](https://github.com/deepseek-ai/deepseek-harness/discussions/5129) — follow it for the official fix.
- For anything else about this plugin, open an issue or discussion in this repository.

## License

MIT
