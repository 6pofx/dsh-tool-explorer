# GitHub Issue 成稿（浏览器粘贴提交）

提交地址：https://github.com/deepseek-ai/deepseek-harness/issues/new

推荐在 **New issue → Bug report** 或直接空白 issue 中粘贴以下英文正文（中文摘要附在末尾，可一并保留）。

---

## Title

**dsh-mcp-client: startup wait is unbounded — a down/hanging MCP server suppresses the "dsh web: http://…" ready line**

## Body (English, paste this)

### Summary

With `dsh web`, the process and web UI work fine, but the console never prints:

```
dsh web: http://127.0.0.1:3080
dsh web: opening the default browser; pass --no-open to disable
```

and the default browser is never opened (`--no-open` was NOT passed). The server itself is healthy: the browser UI is fully usable.

### Environment

- DSH `0.1.5-rc.2` (global npm install, Windows 11, Node 22); earlier reports on `0.1.1-rc.2`
- `@deepseek-ai/dsh-mcp-client` `0.1.5-rc.2` (unchanged in this release)
- Reproduction with a `streamable-http` server whose endpoint is **down** (e.g. an IDE-published MCP endpoint `http://127.0.0.1:64342/stream` after the IDE is closed), or a stdio server that never answers `initialize`

### Root cause (code-level)

- `dsh-mcp-client`'s `apply` is `async` and awaits the initial connection at the end:
  `const outcome = await connection.ready;` (lib/index.js, `apply`).
- `loader.await()` (cordis-plugin-loader) waits for **every** loader entry to settle; the web app prints its ready line only after it (dsh-web-app `lib/index.js`, `if (config.printUrl || handoffBrowser)` with `loader.await().then(...)`).
- For a `streamable-http` endpoint that refuses/hangs, `connection.ready` never settles, so that entry never settles → `loader.await()` never resolves → the URL line and browser handoff never print. The UI still works because the server itself is fine; only the readiness announcement is gated.
- The MCP SDK does not expose a connection timeout (README "Known Limitations" already notes the 60 s init default; in practice a refused/hanging HTTP endpoint can hang much longer or indefinitely).

### Steps to reproduce

1. Add to the profile patch (or `--patch` overlay):
   ```yaml
   - insert:
       - id: mcp-hang
         name: '@deepseek-ai/dsh-mcp-client'
         config:
           serverName: hang
           transport: streamable-http
           url: http://127.0.0.1:59999/mcp   # nothing listens here
   ```
2. Run `dsh web` (no `--no-open`).
3. Observe: no `dsh web: http://…` line is ever printed; visiting the UI works; a management view of the server shows it as `active` with 0 tools.
4. Expected: the ready line prints within a bounded time and the browser opens; the hanging server either reports failure (configurable `failOnStartupError`) or keeps retrying in the background.

### Requested behavior

Add a configurable startup/readiness timeout to the mcp-client entry, e.g.:

- `startupTimeoutMs` (or `readyTimeoutMs`), default something bounded like `3000`–`10000`.

Semantics we ask for: when the initial connection/tool sync does not settle within the timeout, `apply` completes anyway (the plugin activates without tools), while the underlying connection may keep progressing in the background — tools register when they arrive (the existing generation-replacement/re-sync path already supports this), and the reconnect supervisor stays unchanged. `failOnStartupError: true` should still throw when a failure is measurable within the window.

### Related: `stderr` is not configurable for stdio servers

All stdio servers inherit their stderr into the dsh process console (SDK default `inherit`), so server banners and JSON logs (e.g. FastMCP banners, pino lines) flood `dsh web` output. A `stderr: 'ignore' | 'inherit' | 'pipe'` config field (per entry) would let users silence them.

### Note (reference implementation)

In the meantime we bound the wait locally by racing `connection.ready` against a timeout in the installed package; tools still register when the connection eventually succeeds, and `connectGeneration` never rejects, so the losing promise cannot surface as an unhandled rejection. Re-verified against 0.1.5-rc.2 with an isolated `dsh web` whose profile contains a stdio server that prints to stderr and never answers `initialize`: the `dsh web: http://…` line prints in ~19 s (the rest of the boot), the console shows none of that server's stderr, and the server keeps retrying in the background. Happy to upstream the approach if it fits.

---

## 中文摘要（可选附上）

`dsh-mcp-client` 的启动等待没有上限：`apply` 末尾 `await connection.ready`，而 `dsh web` 的两行就绪输出（地址行 + 自动开浏览器）依赖 `loader.await()` 等待所有 entry 完成。只要有一个服务器连接挂起/不可达（实测：streamable-http 指向已关闭的 IDE 端点；或 stdio initialize 挂起），地址行就永不打印——进程与页面均正常，仅就绪公告被卡。建议增加可配置的启动超时（如 `startupTimeoutMs`，默认 3–10s），超时后 `apply` 照常完成、连接转后台（工具到达时注册，重连语义不变），`failOnStartupError` 保留窗口内失败检测；顺带建议为 stdio 增加 `stderr` 配置项以静音服务器日志刷屏。
