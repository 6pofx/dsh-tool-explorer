# dsh-tool-explorer

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) 管理控制台：在 Web 设置页中**浏览、安装、更新、编辑与启停技能**，并**添加、编辑、测试与监控 MCP 服务器**。

> 当前里程碑 M0：插件骨架已就绪、设置页可见。技能（M2/M3）与 MCP（M1）模块随后落地 —— 详见 [docs/requirements.md](docs/requirements.md)。

## 安装

```bash
dsh plugin --profile web add dsh-tool-explorer
```

`dsh plugin` 会自动把插件追加到 profile 的 layer stack（bundles）。请重启一次 `dsh web`（host 插件在启动时加载），然后打开 **设置 → 工具探索**。

## 本地开发

```bash
pnpm install
pnpm run typecheck   # host + client 源码类型检查
pnpm run build       # tsc 编译 host 到 lib/，tsdown 打包 client 到 client/client.js，并做结构与加载校验
```

本地安装（无需发布即可重装调试）：

```bash
pnpm pack
dsh plugin --profile web add file:G:/dsh-tool-explorer/dsh-tool-explorer-0.1.0.tgz
```

## 目录结构

| 路径 | 用途 |
|---|---|
| `src/index.ts` | host 插件入口（Cordis `name`/`apply`） |
| `src/routes.ts` | 挂载在 `/dsh-tool-explorer/api/*` 下的 HTTP 路由 |
| `src/settings.ts` | 在 `ctx.settings` 注册的配置 namespace |
| `src/http.ts` | 路由助手（JSON、同源校验、体积上限） |
| `src/client/` | 浏览器半部 —— 设置页（由 tsdown 构建） |
| `scripts/` | client bundle 包装与结构性校验 |

## 许可证

MIT
