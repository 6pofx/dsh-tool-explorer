# dsh-tool-explorer

Management console for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh): a Web settings page where you can **browse, install, update, edit and toggle skills**, and **add, edit, enable/disable, test and monitor MCP servers**.

## Features

**Skills**
- Full catalog across every provider (project/user/bundled/plugin) merged with the shared `.skill-lock.json`
- Search, detail preview, online create/edit (kebab-case validation, frontmatter form, Markdown body)
- Enable/disable via the frontmatter dual switches
- Install from GitHub: URL parsing (`owner/repo`, tree paths, `#branch`), candidate preview, install into `~/.agents/skills` or `~/.dsh/skills`, update check/apply (backup + rollback), uninstall
- `skillFolderHash` is byte-compatible with the Skills CLI (`npx skills`)

**MCP**
- Server list with live state (fiber phase), tool inventory and per-server tool counts
- Add/edit/delete servers (stdio + streamable-http) and **enable/disable** toggles — all through the profile patch layer (HMR hot-applies, no restart)
- Cross-agent import: scan `~/.claude.json`, `~/.cursor/mcp.json`, `~/.codex/config.toml` (TOML), `~/.cline/mcp_settings.json`, `~/.roo/mcp.json`, `~/.continue/mcp.json`, `~/.codeium/windsurf/mcp_config.json` and import in one click
- Test connection with an independent SDK probe (never disturbs running instances)
- Write fencing (expected-hash) against concurrent hand edits

## Install

```bash
dsh plugin --profile web add dsh-tool-explorer
```

`dsh plugin` reconciles the bundle automatically. Restart `dsh web` once (host plugins load at boot), then open **Settings → Skills 和 MCP**.

## Local development

```bash
pnpm install
pnpm run typecheck   # tsc for host + client sources
pnpm run build       # tsc host -> lib/, tsdown client -> client/client.js (wrapped + verified)
pnpm test:self       # 80+ assertions: mock host CRUD, cross-agent import, git install, real stdio probe
```

Local install loop:

```bash
pnpm pack
dsh plugin --profile web remove dsh-tool-explorer
dsh plugin --profile web add file:G:/dsh-tool-explorer/dsh-tool-explorer-0.3.0.tgz
```

> Adding a runtime dependency (e.g. `tar`) requires a **re-pack + reinstall** — copying `lib/` alone is not enough.

## Layout

| Path | Purpose |
|---|---|
| `src/index.ts` | Host entry; plain host object built from injected services (never mutate the Cordis scope proxy) |
| `src/routes.ts` | HTTP routes under `/dsh-tool-explorer/api/*` (same-origin enforced on writes) |
| `src/mcp.ts` | MCP manager: patch-layer CRUD, enable/disable, state derivation, SDK probe |
| `src/skills.ts` | Skills catalog (registry × lock file × disk), edit/toggle, frontmatter parsing (full YAML) |
| `src/skills-install.ts` | GitHub install ecosystem: tarball fetch (regional proxy), candidate discovery, lock v3, CLI-compatible folder hash |
| `src/agents-mcp.ts` | Cross-agent MCP import (JSON + Codex TOML subset parser) |
| `src/patch-text.ts` | Patch-layer dialect: parse (`!!js` tolerant), surgical row edits, `[]` placeholder handling, atomic writes |
| `scripts/` | Client bundle wrapper/check, self-test, and **local dsh-mcp-client patches** (see below) |

## Local dsh-mcp-client patches

Two idempotent patches fix upstream dsh-mcp-client gaps until the official package gains config support (reported upstream via GitHub Discussion; re-run after any mcp-client update — dshmarket upgrades restore the official files):

```bash
# 1) silence stdio server stderr (banners/JSON logs were flooding `dsh web` output)
node scripts/patch-mcp-client-stderr.mjs
# 2) bound the startup wait (a hanging/unreachable server blocked the ready line)
node scripts/patch-mcp-client-async.mjs
```

Backups are written as `index.js.*.bak` next to the patched file.

## License

MIT
