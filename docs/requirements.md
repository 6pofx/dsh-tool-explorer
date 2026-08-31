# dsh-tool-explorer 需求分析文档

> 版本：v0.1（需求分析阶段）
> 目标：为 DeepSeek Harness (DSH) 开发一个管理 **Skills** 与 **MCP** 的插件
> 状态：待评审

---

## 1. 背景与定位

DSH 是一个 Cordis 插件架构的 Agent Harness。当前生态中：

- **Skills**：已有完整的加载机制（`ctx.skills` 注册表 + 文件系统 provider + `/` 斜杠触发），但**没有任何管理界面**——不能浏览/安装/更新/编辑/启停技能。
- **MCP**：已有连接机制（每服务器一个 `@deepseek-ai/dsh-mcp-client` 插件实例，工具注册为 `mcp__<server>__<tool>`，配置热生效），但**没有任何管理界面**——不能增删改配置、看状态、看工具清单、测连接。
- **插件生态**：已有 `dshmarket`（市场）、`dsh-better-sidebar`、`dsh-theme-endfield` 等社区插件，证明"带 Web UI 的外部插件"模式可行（dshmarket 是功能最全的参照物）。

**产品定位**：`dsh-tool-explorer` —— 一个 DSH 插件，在 Web 设置页中提供一个统一的"技能与 MCP 控制台"，覆盖两个领域的**管理面**（浏览、安装、更新、删除、编辑、启停、状态查看），不重复已有的**使用面**（斜杠调用技能、模型调用 MCP 工具）。

**目标用户**：DSH 用户（公开发布，拟纳入 dshmarket 生态），文案中英双语。

**范围外（v1 明确不做）**：

- skills.sh 远程目录搜索（v1.1 再接入；v1 仅支持 GitHub URL/仓库安装）
- MCP 服务器"一键重启 / 临时禁用"（用户未选择）
- CLI 子命令（用户选择"Web 设置页为主"）
- MCP Resources / Prompts 桥接（上游 dsh-mcp-client 就不支持）
- 插件内置技能（runtime 技能）的启停——其注册方不在本插件管辖内，仅展示

---

## 2. 已核实的平台事实（设计依据）

### 2.1 插件结构（外部插件模板，经 dshmarket/dsh-go-usage/dsh-better-sidebar 交叉验证）

```jsonc
{
  "name": "dsh-tool-explorer",
  "main": "lib/index.js",                  // host 半部：Cordis 插件 { name, inject, apply }
  "exports": {
    "./client": "./lib/client.js"          // client 半部：lazy-CJS factory bundle
    // ".", "./types", "./remote" 按需
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },  // 入口 patch，insert 本插件条目
    "client": { "platform": "web", "inject": [...] }  // client 外部包声明
  },
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.1", "react": "^18.x" }
}
```

- 安装 = `dsh plugin --profile web add <pkg>`（写 deps + append bundles）。
- **host 半部改动需重启，纯 client 改动可 HMR**。
- client bundle 受 **bundle-purity gate** 限制：只可 require 壳种子 externals（react/react-dom/jsx-runtime + inject 声明的包）；`tsdown.client.ts` 预设未随包发布，需按 dshmarket/better-sidebar 的自建 tsdown 配置复现。
- 通信三板斧：① 同源 `fetch` 到主机路由（`webServer.register({kind, path, handler})`，dshmarket 用此）；② `ctx.settingsScope` 设置 RPC；③ Typert Remote（需进入 api-remotes 装配，外部插件有额外成本）。**本插件采用 ① + ②**。

### 2.2 Skills 事实

| 项 | 事实 |
|---|---|
| 注册表 | `ctx.skills`（provider 架构，`skills/change` 事件；本地 provider watcher 自动失效） |
| 扫描根（rank 小者优先） | 项目 `.dsh/skills`(100) → 项目 `.agents/skills`(200) → runtime 注册(250) → `customSkillDirs`(300) → `~/.dsh/skills`(400) → `~/.agents/skills`(500) → bundled(600) |
| 技能形态 | `<name>/SKILL.md` 或 `<name>.md`，一层目录（嵌套 `**/SKILL.md` 不扫描） |
| frontmatter | 必填 `name`（kebab：`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`）、`description`；可选 `whenToUse`、`disable-model-invocation`、`user-invocable`、`metadata`（其余键忽略；旧 camelCase 键直接使整个文件失效） |
| 安装协议 | 生态标准 = **Skills CLI**（`npx skills`，vercel-labs/skills），锁文件 `~/.agents/.skill-lock.json` v3 |
| 锁文件 | `{version:3, skills:{<name>:{source, sourceType:'github', sourceUrl, skillPath, skillFolderHash, installedAt, updatedAt}}, dismissed, lastSelectedAgents}`；`skillFolderHash` = 技能目录内容 sha256 |
| 禁用机制 | **平台无原生禁用**；可用 frontmatter 双开关（`disable-model-invocation: true` + `user-invocable: false`）从模型目录与 `/` 菜单排除，但仍在注册表中；或用目录移出扫描根 |
| 已装技能 | 本机 11 个目录，其中 9 个在锁内（harmonyos-arkts、officecli 系其它途径安装）；DSH 本身**不读**锁文件 |

### 2.3 MCP 事实

| 项 | 事实 |
|---|---|
| 权威配置 | profile 级 `<profile>/cordis.patch.yml`（及 home 级 `$DSH_HOME/cordis.patch.yml`），每服务器一条目：`{id, name:'@deepseek-ai/dsh-mcp-client', config:{serverName, transport('stdio'\|'streamable-http'), command/args/env/cwd 或 url/headers, toolCallTimeoutMs, failOnStartupError, reconnect.*}, disabled?}` |
| 热生效 | **改写补丁文件 → 已有 HMR 管线（watchUserPatches）自动热应用**：config 变更触发断开+重连，删除/禁用卸载并注销工具，无需重启 |
| 覆盖语义 | patch 条目中 `config` 是**整体替换**（须重述未变字段）；`disabled: true` 停用；`insert` 新增 |
| 状态 | mcp-client 不暴露服务/事件；可经 `ctx.loader.entries()`（fiber 阶段）+ `ctx.tools.schemas()`（`mcp__<server>__*` 前缀计数）推导 |
| 测试连接 | 无现成 API；可用其依赖 `@modelcontextprotocol/sdk` 的 Client 直接做 initialize + tools/list 探测 |
| 约束 | `serverName` 全局唯一（`[A-Za-z0-9_-]{1,32}`），重复实例加载即报错 |
| 现状 | 本机未配置任何 MCP 服务器 |

---

## 3. 用户需求（已与用户确认）

1. 形态：**Web 设置页为主**（新增 Settings 页面）。
2. Skills：浏览/搜索已装技能、从 GitHub 安装、在线编辑/新建、启停切换。
3. MCP：服务器增删改配置、连接状态与工具清单、测试连接。
4. 受众：公开发布，中英双语。
5. 技能安装来源：**GitHub 优先，skills.sh 搜索后置**。
6. 技能安装目标：**默认 `~/.agents/skills`，安装时可选**（`~/.dsh/skills`）。

---

## 4. 功能需求

### 4.1 Skills 模块

**FR-S1 浏览与搜索**

- 列出全部已发现技能（跨所有 provider）：名称、描述、来源（`user-agents`/`user-dsh`/`project-dsh`/`project-agents`/`custom`/`runtime`/`bundled` 及对应路径）、调用策略（模型/用户）、是否被本插件管理（在锁文件中）、状态（正常/已禁用/来源缺失）。
- 支持按名称/描述全字段搜索；按来源、状态筛选。
- 展示冲突信息：同名技能被更高优先级层遮蔽时，标记"被遮蔽"并显示胜出者。
- 刷新按钮（重读注册表）+ 注册表变更自动刷新（订阅 `skills/change`）。

**FR-S2 详情与预览**

- 点击技能展开：frontmatter 结构化展示（name/description/whenToUse/metadata/策略开关）、正文预览（markdown 渲染，超长折叠）、资源基路径（resourceBase）、锁文件来源信息（repo/路径/hash/安装时间）。
- 缓存：预览有限制（如 20KB 截断 + 提示）。

**FR-S3 从 GitHub 安装**

- 输入支持：
  - `https://github.com/<owner>/<repo>`（自动探测仓库内技能：根或 `skills/<name>/SKILL.md` 约定位置；多候选时列出选择）
  - `https://github.com/<owner>/<repo>/tree/<branch>/<path>`（精确指向）
  - `owner/repo[/path][#branch]` 简写
- 流程：解析默认分支（GitHub API，未认证）→ 下载 codeload tarball → 定位目标技能目录（含 `SKILL.md`）→ 解析 frontmatter 校验 `name`（kebab）与 `description` → **安装前展示预览**（来源、目标名、frontmatter、正文前 N 行）→ 确认后写入目标根（默认 `~/.agents/skills/<name>/`，可切换为 `~/.dsh/skills/`）→ 计算 `skillFolderHash` → 更新 `~/.agents/.skill-lock.json`（v3 全字段，保留顶层 `dismissed`/`lastSelectedAgents` 等既有键，有并发写时读-改-写加锁）。
- 只允许 `github.com` 域（SSRF 防护）；非法/不存在的仓库、无 SKILL.md、名字非法 → 明确错误。
- 安装后无需手动刷新：本地 provider watcher 自动失效（`fs/observed` 或 chokidar 路径）。

**FR-S4 更新**

- 对锁文件中的 GitHub 技能：`check` = 按锁内 `sourceUrl`+`skillPath` 重新拉取，与 `skillFolderHash` 对比；有差异标记"可更新"，展示变更摘要（文件级，mtime/size 或 hash）。
- `update` = 替换目标目录内容 + 重算 hash + 更新 `updatedAt`。
- 更新前备份：旧目录改为 `<name>.bak-<ts>`（保留一份），成功后删除；失败回滚。

**FR-S5 卸载**

- 删除目标根下的技能目录 + 锁文件条目；确认对话框说明"删除的是 `<path>`"。
- bundle 内附带 `references/scripts/assets` 等子目录一并删除。
- 已禁用（FR-S6）的技能同样可卸载。

**FR-S6 启停切换**

- 语义：**禁用 = 写入双开关 frontmatter**（`disable-model-invocation: true` + `user-invocable: false`），**启用 = 移除这两个键**。效果：从模型目录与 `/` 斜杠菜单消失，技能文件与锁文件保持不变，其他工具仍可见。
- 适用对象：本插件管理的技能 + 任意 `user-agents`/`user-dsh` 根下的技能；project/runtime/bundled 来源给出"不支持/不支持修改"说明（runtime/bundled 仅展示）。
- 禁用状态以 frontmatter 反推 + 在插件自有状态（settings namespace）中留档"由本插件操作"。
- 编辑/安装等所有写操作使用原子写（临时文件 + rename），失败不破坏原文件。

**FR-S7 在线编辑/新建**

- 新建：目标根（默认 `~/.agents/skills`，可切换）→ 表单生成 frontmatter（name 实时 kebab 校验、description、whenToUse、两个策略开关）+ Markdown 正文编辑；保存原子写入 `<name>/SKILL.md`。
- 编辑：选中已安装技能（user 根）→ 结构化 frontmatter 表单 + Markdown 正文（带行号、字数统计），保存原子写回；实时校验 `name` 变更合法且不与已有技能冲突（kebab 校验 + 目录一致性：frontmatter name 与目录名无需一致，但改名应提示"目录名不变，目录以 name 展示"）。
- 校验失败（缺失字段/非法值/camelCase 旧键）保存前拦截并提示（对应 provider 的 fail-closed 行为）。
- 本模块不追踪 body 版本（平台无 body revision 协议）。

### 4.2 MCP 模块

**FR-M1 服务器列表**

- 列出所有 MCP 条目：来源文件（`<profile>/cordis.patch.yml` 或 `$DSH_HOME/cordis.patch.yml`）、id、serverName、transport、命令/URL（摘要）、启用/禁用、**运行状态**（`active`/`disabled`/`error`/`missing`——由 `ctx.loader.entries()` 的 fiber 阶段推导）、**工具数**（`ctx.tools.schemas()` 按 `mcp__<serverName>__` 前缀统计）。
- 状态刷新：切换页面/手动刷新时重新推导（mcp-client 无事件，接受"点查"式刷新；文档注明局限）。

**FR-M2 添加/编辑/删除**

- Add 表单：serverName（唯一性校验，[A-Za-z0-9_-]{1,32}）、transport 二选一；
  - stdio：command（必填）、args（逐项编辑）、cwd、env（键值对，支持 `!!js process.env.X` 引用语法提示，如 README 示例）、可展开高级选项（toolCallTimeoutMs、failOnStartupError、reconnect 三参）。
  - streamable-http：url、headers（键值对，secret 性质字段标注）。
- 保存 = 原子改写 `<profile>/cordis.patch.yml`：
  - 新增：`- insert: [{ id: 'mcp-<serverName>', name: '@deepseek-ai/dsh-mcp-client', config: {...} }]`
  - 修改：`- id: 'mcp-<serverName>', config: {...（全量）}`（整体替换语义，必须重述全部字段）
  - 删除：移除该条目所有相关行（insert/override/disabled）
  - **保留文件中与本插件无关的所有行**（用户手写条目、其他插件条目），失败不写入。
- 写入触发既有 HMR → 热生效（编辑/删除即时断开重连/卸载），UI 中显示"已热生效"或"等待生效（若 watcher 未就绪则提示重启）"。
- 冲突保护：保存前重读文件，若文件已变（用户手改）则提示并让用户选择覆盖/取消（expectedRevision 风格栅栏，与 settings 写入哲学一致）。
- 目标文件选择：默认当前 profile 的 `cordis.patch.yml`；高级选项可写 `$DSH_HOME/cordis.patch.yml`（全局生效）。
- 管理范围：**列出并管理所有 `@deepseek-ai/dsh-mcp-client` 条目**（包括用户手写的），以 id 精确操作——不区分"我管理的/你手写的"，避免出现两套真相；手写 id 结构不匹配时（非 `mcp-<serverName>`）仅展示、删除/修改仍需二次确认。

**FR-M3 工具清单**

- 每服务器展开：该服务器暴露的工具（`ctx.tools.schemas()` 过滤），展示 public 名（`mcp__<serverName>__<raw>`）、raw 名、描述、参数个数与参数名摘要；支持搜索。
- 服务器未连接（工具数为 0 且 fiber active）时显示"无工具/连接异常，可测试连接"。

**FR-M4 测试连接**

- 对任意服务器（含未保存的表单草稿）执行探测：使用 `@modelcontextprotocol/sdk` 直接建立 stdio / streamable-http 连接 → initialize + `tools/list`，超时 15s。
- 结果：`ok`（延迟 ms、工具数、工具名列表）/ `fail`（错误摘要：spawn 失败、超时、协议错误、认证失败区分显示）。
- 探测进程独立于运行时实例，**不改变现有连接**（失败不触发重连风暴）。
- serverName 冲突提示：若探测 serverName 与现有实例重复，线上报错与测试连接结果在添加流程中双重校验。

### 4.3 共同

**FR-C1 UI 布局**

- Settings 新增一个独立页面（`settings.section` 插槽，仿 dshmarket）：标题"Tool Explorer"，页内 Tab：`Skills` | `MCP`。
- 每页顶部状态条（技能总数/已禁用数；MCP 启用数/异常数），操作按钮（刷新；技能页有"从 GitHub 安装"主按钮，MCP 页有"添加服务器"主按钮）。
- 所有危险操作（卸载/删除/覆盖保存）二次确认；所有远程操作（安装/测试/更新）带进行中状态；错误可展开详情并可直接复制。
- 中英双语：client 内置字符串表，按平台 locale（`ctx.locale`，若可用）或自动探测选择；host 侧日志英文为主（与 DSH 日志惯例一致）。

**FR-C2 Host 侧服务（插件内部 API 设计）**

- `tools` 路由（同源 fetch 前缀，如 `/dsh-tool-explorer/*`），dshmarket 同款模式，避免 Typert/装配约束：
  - `GET /api/skills` — 全量技能视图（合并 `ctx.skills.list()` + 锁文件 + 文件系统元信息 + 遮蔽分析）
  - `POST /api/skills/install` — 安装（含 dry-run 预览：`{dryRun:true}` 返回解析结果不落盘）
  - `POST /api/skills/update` / `DELETE /api/skills/:name`
  - `GET /api/skills/:name/view` — 详情+正文（编辑器用）
  - `PUT /api/skills/:name` / `POST /api/skills` — 编辑/新建
  - `POST /api/skills/:name/toggle` — 启停
  - `GET /api/mcp` — 服务器列表+状态+工具清单
  - `POST /api/mcp/test` — 测试连接（body 为完整 spec，含草稿）
  - `POST /api/mcp` / `PUT /api/mcp/:id` / `DELETE /api/mcp/:id`
  - `POST /api/mcp/check` — 冲突/合法性预检（添加前校验 serverName 唯一、命令存在性提示）
- 文件操作：host 插件直接在 Node 进程内读写（非 agent 沙箱路径）；所有写走原子写；patch 文件读改写带 revision 栅栏。
- 依赖清单：`@modelcontextprotocol/sdk`（探测）、`yaml`（patch 读写）、`js-yaml` 可用亦可；tar 解包（codeload tarball）用轻量实现或 `tar` 包；GitHub API 走 `fetch`（Node 内置）。

**FR-C3 配置项（settings namespace `dsh-tool-explorer`）**

| 字段 | 默认 | 说明 |
|---|---|---|
| `defaultSkillRoot` | `~/.agents/skills` | 技能安装/新建默认目标（可选 `~/.dsh/skills`） |
| `mcpConfigTarget` | `profile` | MCP 配置默认写入 profile 还是 home 补丁层 |
| `previewContentLimit` | `20000` | 技能正文预览截断字节数 |

---

## 5. 非功能需求

- **安全**：GitHub 抓取仅允许 github.com（codeload/api 域名白名单）；MCP 配置本身就是命令执行型配置（沿用平台既有信任模型，UI 显著提示"点击保存即同意执行该命令"）；env/header 中的密钥字段在 UI 显示为 `●●●`、接口响应中脱敏（不回显，保存后仅显示"已配置"）。
- **可靠**：所有写操作原子化；patch 写入前备份原内容（同文件 `.bak`）；一次操作失败不留下半完成状态（先校验后落盘）。
- **兼容**：不使用本 DSH 版本中悬空的包（`dsh-client-ui-slots`、`dsh-client-web`）；client 构造遵守 bundle-purity；不读/写 DSH 内部未公开 API（工具计数走公开 `ctx.tools.schemas()`，状态走公开 `ctx.loader.entries()`）。
- **性能**：列表接口秒级；正文预览截断；skills/change 事件驱动的刷新做防抖；MCP 工具清单按需加载。
- **可维护**：host/client 分为独立子目录（`src/` + `client/`），类型共享 `shared/types.ts`；README 中英文 + 架构说明。

---

## 6. 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M0 骨架 | npm 包模板、patch 入口、host 插件空转、client 设置页空壳（含双语框架）、本地安装到 web profile 验证 | `dsh web` 重启后设置页出现"Tool Explorer"空页 |
| M1 MCP 管理 | 列表/状态/工具清单 → 增删改（patch 原子写）→ 测试连接 | 添加一个 test server 秒级热生效；工具出现在模型目录 |
| M2 技能浏览+编辑 | 全量列表/搜索/详情/遮蔽分析 → 编辑/新建（表单+校验）→ 启停切换 | 手工编辑的技能秒级（watcher）出现在系统目录 |
| M3 技能安装生态 | GitHub 安装（tarball/预览/多候选）/更新/卸载 + 锁文件 v3 读写 | `npx skills check` 能识别本插件安装的技能（hash 兼容验证） |
| M4 打磨发布 | 完整双语、错误态、文档、npm 发布 + dshmarket 上架、升级说明（host 改动需重启的发布提示） | 市场可安装；README 双语 |
| M5 来源分级浏览+独立调用+回收站 | 按来源分级浏览（来源→provider 树+筛选）→ 独立模型/用户调用开关 → 删除进可恢复回收站（还原/永久删除/清空） | 分组树正确合并 registry；模型/用户可独立开合且 watcher 即时生效；删除→回收站→还原字节级恢复（含锁条目） |

---

## 7. 风险与开放问题

1. **`skillFolderHash` 算法精确性**：需与 skills CLI 的目录 sha256 定义完全一致，否则 `npx skills check/update` 可能误判。实现阶段用 CLI 本地验证（安装一个技能后 CLI 不报"new version"）。
2. **锁文件并发**：用户可能同时用 `npx skills` 与本插件写 `.skill-lock.json`；v1 采用读-改-写 + 时间戳检测（若读后文件变更则重读），文档注明不支持双写同时。
3. **patch 写入与 HMR**：原子 rename 触发一次 `change` 事件，应无重复刷新；但在无 HMR 的部署形态（如 headless/tui profile）下不会热生效——插件仅把 patch 写入 profile 目录，UI 显示当前 profile 是否挂载 hmr（可从 loader 查询），未挂载时提示重启。
4. **bundle 构建自建 tsdown 配置**：外部插件无法复用未发布的 `tsdown.client.ts` 预设；M0 阶段必须按 dshmarket 方式自建并验证 purity gate，这是最大的工程不确定性，故排在 M0 验收。
5. **client 侧 UI 与 `@deepseek-ai/cordis` 版本耦合**：peer 依赖 cordis ^4.0.1，DSH 更新主版本时插件需跟进。
6. **多 profile**：MCP patch 目标默认当前运行 profile；插件不枚举其他 profile（超出 v1）。
7. **启用/禁用语义跨工具**：双开关 frontmatter 是 DSH 方言，其他 agent（如 Codex）不识别——文档中明确说明该开关仅影响 DSH。

---

## 8. 决策记录（已确认 2026-XX-XX）

| # | 决策 | 结论 |
|---|---|---|
| D1 | 插件形态 | Web 设置页为主，无 CLI；公开双语发布 |
| D2 | 技能范围 | 浏览/搜索、GitHub 安装、在线编辑/新建、启停，全选 |
| D3 | MCP 范围 | 增删改配置、状态+工具清单、测试连接；不做重启/临时禁用 |
| D4 | 技能来源 | GitHub 安装优先，skills.sh 搜索后置 v1.1 |
| D5 | 技能安装目标 | 默认 `~/.agents/skills`，安装时可选 `~/.dsh/skills` |
| D6 | 禁用机制 | **frontmatter 双开关**（`disable-model-invocation: true` + `user-invocable: false` 写入；启用则移除） |
| D7 | MCP 写入位置 | 默认当前 profile 的 `cordis.patch.yml`；home 全局仅高级选项 |
| D8 | 里程碑顺序 | M1 先做 MCP，再 skills |
| D9 | 插件通信 | `webServer` 路由 + 同源 fetch（仿 dshmarket），settings namespace 存偏好 |
| D10 | 跨 agent MCP 导入 | 扫描本机其他 agent 配置（Claude Code `~/.claude.json`、Cursor `~/.cursor/mcp.json`、Codex `~/.codex/config.toml`、Cline/Roo/Continue/Windsurf），规范化后经标准添加管线导入（已实现于 M1.1） |
| D11 | 表单形态 | 内联面板（非弹窗）——像素色全部继承设置页主题，修复黑底黑字问题 |

### 里程碑状态

| 里程碑 | 状态 |
|---|---|
| M0 骨架 | ✅ 完成（设置页可见、构建管线、bundle 加载） |
| M1 MCP 管理 | ✅ 完成 + 1.1 增强：**修复 host 挂在 Cordis Proxy 上的赋值 bug**（表现为全路由静默 404）、**prefix 路由不带尾斜杠**（webserver 匹配语义为 `prefix + '/'`）；表单改内联面板；**跨 agent MCP 导入（D10）已实现**（JSON + Codex TOML 子集解析、名称规范化、冲突跳过）；真实 boot 端到端验证：添加→HMR 热生效（active / 1 tool）→删除→patch 恢复 `[]` |
| M2 技能浏览/编辑/启停 | ✅ 完成：目录视图（registry × 锁文件 × 磁盘扫描合并、来源/可编辑/managed/隐藏标记）、搜索、详情与正文预览、**新建/编辑（内联表单，kebab 校验、frontmatter 序列化、改名=目录改名+锁文件 key 迁移）**、**启停（frontmatter 双开关 D6）**；自测 54 项全绿；真实环境验证：12 技能正确合并（含 bundled 只读、非锁文件安装区分）、7 个 MCP 服务器状态/工具数全部正确 |
| M3 技能安装生态 | ✅ 完成：GitHub URL 解析（owner/repo、tree 路径、#branch、非 github 拒绝）、**codeload tarball 下载（默认经 gh-proxy 代理，实测 HEAD 直通）**、多候选发现（根/`skills/*`/一级子目录/指定路径）、安装预览→安装（`.skill-lock.json` v3 全字段写入）、**`skillFolderHash` 与 Skills CLI 字节级兼容**（算法取自 skills@1.5.23 源码、5 个本机已装技能 MATCH 验证 + 自测独立实现对比）、检查更新（hash 对比）、更新（备份+替换+时间戳）、卸载（目录+锁条目）；自测 75 项全绿；真实端到端：预览 16 个候选 → 安装 algorithmic-art（watcher 即时出现在会话技能目录）→ 卸载（即时消失）。v0.4.1 增强：**多候选批量/全选安装**（同一仓库单次 tarball 下载，逐技能独立处理冲突；部分成功返回 installed/skipped，全部失败保持 409；单选接口向后兼容） |
| M4 打磨发布 | 未开始（双语完善、npm 发布、dshmarket 上架、文档） |
| M5 来源分级浏览+独立调用+回收站 | ✅ 完成：**按来源分级浏览**（来源→provider 可折叠树，含已加载/禁用计数；来源/状态筛选、平铺视图开关）、**独立模型/用户调用开关**（`POST /api/skills/:name/invocation`，只写对应 frontmatter 键，模型与用户轴互不影响）、**可恢复回收站**（`<dshHome>/skills-trash` + manifest v1；删除=移入回收站并快照锁条目，还原=原路径+锁条目字节级恢复，永久删除/清空；EXDEV 跨卷回退复制；参考 dsh-skill-hub 的 `.trash/` 模式，但放在技能根之外避免 watcher 干扰）；自测 116 项全绿（含 30 项 M5 新增） |

> 待定：包名是否可用（`dsh-tool-explorer` 或 scoped `@<user>/dsh-tool-explorer`，M0 落定时用 npm 查重）。

---

## 9. 下一步（M0 开始的建议动作）

1. 确认包名可用性（npm registry 查重），初始化 Monorepo 单包仓库。
2. 按 dshmarket/better-sidebar 复现 client bundle 构建（tsdown 自建配置），跑通 purity gate —— 风险最高的一步先做。
3. 搭 host 侧插件骨架 + settings 页面空壳，本机 profile 安装验证。
4. 然后进入 M1（MCP 管理）实现。
