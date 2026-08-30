# dsh-tool-explorer

Management console for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh): a Web settings page where you **browse, install, update, edit and toggle skills**, and **add, edit, test and monitor MCP servers**.

> Milestone M0: the plugin skeleton is installed and its settings page is live. Skills (M2/M3) and MCP (M1) modules land next — see [docs/requirements.md](docs/requirements.md).

## Install

```bash
dsh plugin --profile web add dsh-tool-explorer
```

The bundle is appended to your profile's layer stack automatically ([`dsh plugin`](https://github.com/deepseek-ai/deepseek-harness) reconciles it). Restart `dsh web` once — host plugins load at boot. Then open **Settings → Tool Explorer**.

## Development

```bash
pnpm install
pnpm run typecheck   # tsc for host + client sources
pnpm run build       # tsc host -> lib/, tsdown client -> client/client.js, wrap + verify
```

Local install (rebuild + reinstall without publishing):

```bash
pnpm pack
dsh plugin --profile web add file:G:/dsh-tool-explorer/dsh-tool-explorer-0.1.0.tgz
```

## Layout

| Path | Purpose |
|---|---|
| `src/index.ts` | Host plugin entry (Cordis `name`/`apply`) |
| `src/routes.ts` | HTTP routes served under `/dsh-tool-explorer/api/*` |
| `src/settings.ts` | Settings namespace registered on `ctx.settings` |
| `src/http.ts` | Route helpers (JSON, same-origin, body cap) |
| `src/client/` | Browser half — settings section page (built by tsdown) |
| `scripts/` | Client bundle wrapper + structural verification |

## License

MIT
