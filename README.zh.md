[English](README.md) | 中文

# dsh-tool-explorer

[![npm version](https://img.shields.io/npm/v/dsh-tool-explorer)](https://www.npmjs.com/package/dsh-tool-explorer)
[![npm downloads](https://img.shields.io/npm/dw/dsh-tool-explorer)](https://www.npmjs.com/package/dsh-tool-explorer)
[![license](https://img.shields.io/npm/l/dsh-tool-explorer)](LICENSE)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) 管理控制台：在 Web 设置页中**浏览、安装、更新、编辑与启停技能**，并**添加、编辑、启用/禁用、测试与监控 MCP 服务器**。

## 功能

**技能**
- 全量目录（项目/用户/内置/插件各来源）与共享 `.skill-lock.json` 合并展示
- **按来源分级浏览**：可折叠来源树（项目 .dsh → 项目 .agents → 自定义 → `~/.dsh/skills` → `~/.agents/skills` → 插件 → 内置），来源下再按 provider 分组，附已加载/禁用计数；支持来源、状态筛选与平铺视图
- 搜索、详情预览、在线新建/编辑（kebab-case 校验、frontmatter 表单、Markdown 正文）
- **独立模型 / 用户调用开关**：可只关模型调用（`disable-model-invocation`，保留 `/` 菜单），也可只关用户调用；双关 = 完整禁用
- **可恢复回收站**：删除用户根技能 → 移入 `<dshHome>/skills-trash`（锁文件条目快照存档）；还原可字节级恢复（含锁条目），永久删除/清空则彻底移除
- GitHub 安装：URL 解析（`owner/repo`、tree 路径、`#branch`）、候选预览、安装到 `~/.agents/skills` 或 `~/.dsh/skills`、检查更新/应用（备份+回滚）、卸载
- `skillFolderHash` 与 Skills CLI（`npx skills`）字节级兼容

**MCP**
- 服务器列表：实时状态（fiber 阶段）、工具清单、各服务器工具计数
- 添加/编辑/删除（stdio + streamable-http）与**启用/禁用**开关 —— 全部通过 profile patch 层写入（HMR 热生效，无需重启）
- 跨 agent 导入：扫描 `~/.claude.json`、`~/.cursor/mcp.json`、`~/.codex/config.toml`（TOML 子集）、`~/.cline/mcp_settings.json`、`~/.roo/mcp.json`、`~/.continue/mcp.json`、`~/.codeium/windsurf/mcp_config.json`，一键导入
- 测试连接：独立 SDK 探测（不干扰运行中实例）
- 写入栅栏（expected-hash）：与手改配置并发安全

## 安装

已发布到 [npm](https://www.npmjs.com/package/dsh-tool-explorer)（v0.3.0）：

```bash
dsh plugin --profile web add dsh-tool-explorer
```

`dsh plugin` 会自动 reconcile bundle。重启一次 `dsh web`（host 插件在启动时加载），打开 **设置 → Skills 和 MCP**。

## 本地开发

```bash
pnpm install
pnpm run typecheck   # host + client 源码类型检查
pnpm run build       # tsc host -> lib/，tsdown client -> client/client.js（含包装与校验）
pnpm test:self       # 116+ 断言：mock host CRUD、跨 agent 导入、GitHub 安装、回收站、真实 stdio 探测
```

本地安装循环：

```bash
pnpm pack
dsh plugin --profile web remove dsh-tool-explorer
dsh plugin --profile web add file:G:/dsh-tool-explorer/dsh-tool-explorer-0.4.0.tgz
```

> ⚠️ 新增运行时依赖（如 `tar`）必须**重新打包并重装** —— 只拷贝 `lib/` 不够。

## 参考实现

M5 功能集（来源分级浏览、独立调用开关、可恢复回收站）参考了以下社区插件（克隆在 `.ref/` 下备查）：

- [cheshireez/dsh-skill-hub](https://github.com/cheshireez/dsh-skill-hub) —— 基于官方 `ctx.skills` 注册表的 GUI 技能中枢；其 `.trash/` 重命名 + 还原 + 清空模式启发了本插件的可恢复回收站
- [SeverusZh/dsh-skills-mcp-group-manager](https://github.com/SeverusZh/dsh-skills-mcp-group-manager) —— 分组管理与"影子 provider 过滤模型技能目录"
- [BAIKAI23333/dsh-skills-manager](https://github.com/BAIKAI23333/dsh-skills-manager) —— 设置页技能管理器
- [peiqi10086/dsh-skills-market](https://github.com/peiqi10086/dsh-skills-market) —— 侧边栏技能面板（用户/项目/内置）+ SkillHub 商城

设计取舍：启停沿用平台文档化的 frontmatter 双开关（`disable-model-invocation` / `user-invocable`），而非 skill-hub 的 `SKILL.md.disabled` 重命名；回收站放在**技能根之外**，避免 provider watcher 观察到干扰。

## 目录结构

| 路径 | 用途 |
|---|---|
| `src/index.ts` | host 入口；从注入服务组装普通 host 对象（绝不修改 Cordis scope Proxy） |
| `src/routes.ts` | `/dsh-tool-explorer/api/*` 路由（写操作强制同源校验） |
| `src/mcp.ts` | MCP 管理：patch 层增删改、启停、状态推导、SDK 探测 |
| `src/skills.ts` | 技能目录（注册表 × 锁文件 × 磁盘）、编辑/启停、独立模型/用户调用开关、frontmatter 解析（完整 YAML） |
| `src/skills-trash.ts` | 可恢复回收站：删除入站、还原、永久删除、清空（`<dshHome>/skills-trash` + manifest） |
| `src/skills-install.ts` | GitHub 安装生态：tarball 下载（区域代理）、候选发现、锁文件 v3、CLI 兼容目录哈希 |
| `src/agents-mcp.ts` | 跨 agent MCP 导入（JSON + Codex TOML 子集解析） |
| `src/patch-text.ts` | patch 层方言：解析（`!!js` 容错）、行级手术编辑、`[]` 占位符处理、原子写 |
| `scripts/` | client bundle 包装/校验、自测、以及 **dsh-mcp-client 本地补丁**（见下） |

## dsh-mcp-client 本地补丁

两个幂等补丁修复上游 dsh-mcp-client 的缺口（[已上报官方讨论](https://github.com/deepseek-ai/deepseek-harness/discussions/5129)；每次 mcp-client 更新后需重跑——dshmarket 升级会还原官方文件）：

```bash
# 1) 静音 stdio 服务器 stderr（banner/JSON 日志曾刷爆 dsh web 输出）
node scripts/patch-mcp-client-stderr.mjs
# 2) 限制启动等待（挂起/不可达的服务器曾阻塞就绪提示行）
node scripts/patch-mcp-client-async.mjs
```

备份文件以 `index.js.*.bak` 形式保留在被修补文件旁。

## 反馈

问题、功能建议与官方沟通渠道：

- 上文两个本地补丁已上报官方：见 [DeepSeek Harness Discussions #5129](https://github.com/deepseek-ai/deepseek-harness/discussions/5129)——官方修复进展可以跟帖关注。
- 其他与本插件相关的问题，请在本仓库发起 issue 或 discussion。

## 许可证

MIT
