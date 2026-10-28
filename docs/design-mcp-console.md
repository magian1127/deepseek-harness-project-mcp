# 设计：项目级 MCP 控制台化（输入区按钮 + 弹层 + 全异步拉起）

> 状态：**切片 1+2 已实施**（Host 状态中心与桥接、Client 按钮与弹层、信任 v2 per-server 哈希、
> 命令族与系统提示注入删除；`npm test` 252/252，真机闭环已验：`start` → v2 记录 → 本会话
> `mounted` → MCP 连接可用）。**待办**：Client 半边首次供应需一次 `dsh web` 重启（宿主
> `clientModules` 的进程级负缓存）；重启后的按钮渲染与弹层交互仍需肉眼验收（§9）。
> 用户可见语义的权威位置仍是 [`behavior.md`](behavior.md)；本文只写"为什么这样设计"。
> 关联缺陷背景：[`design-http-serve.md` §4.3](design-http-serve.md)（Windows `DETACHED_PROCESS`
> 让 PowerShell 静默空转，会话创建白等 120 秒）。

## 1 背景

当前实现把三件性质不同的事压在会话创建路径上：

1. **安全批准**：`.mcp.json` 未批准时注入一段系统提示词，等用户跑 `/mcp-project trust`；
2. **服务拉起**：HTTP 条目的 `serve` 在 `agent/created`（serial、被 await）里等健康检查就绪，
   默认上限 120 秒——会话创建因此可被卡满两分钟；
3. **诊断**：全部由 `/mcp-project` 命令承载。

三个载体（系统提示词、阻塞等待、斜杠命令）都不是用户自然会发现的地方。2026-10-18 的真机
缺陷（`serve.command: pwsh` 在 Windows 上静默空转、新会话卡 120 秒、服务没起来、日志无声）
暴露的正是这个组合：等待发生在用户看不见原因的地方，而唯一的诊断入口是一条要记住拼写的命令。

用户提出的目标（原话归纳）：

- 会话创建**永不**因 MCP 阻塞；检测、拉起、连接全部异步；
- 输入区一个按钮实时显示"N 个服务没启动 / 检测中"，点开弹层手动启动；
- **手动启动过一次即视为授权**，命令模式整体去掉；
- 未批准时**不往系统提示词里写任何内容**。

## 2 目标与非目标

### 目标

| # | 目标 | 验收口径 |
| --- | --- | --- |
| G1 | 会话创建路径零 MCP 等待 | `agent/created` 监听器同步返回；读盘有 1 MiB 上限且只读一次 |
| G2 | MCP 状态在 UI 可见、可操作 | 输入区按钮 + 弹层；状态变化秒级反映，无需重开会话 |
| G3 | 授权零摩擦且仍是用户动作 | 弹层点"启动"即授权该服务器当前配置；无斜杠命令、无系统提示词 |
| G4 | 不污染模型上下文 | 未批准/未启动时系统提示词与收件箱均无相关内容 |
| G5 | 保留既有安全属性 | 仓库内无可写入的批准通道；未授权不 spawn、不连接；展开后的 env 永不入日志 |

### 非目标

- 不做跨工作区的全局 MCP 管理页（profile 全局行仍归 profile 管，本插件只看项目 `.mcp.json`）；
- 不做服务生命周期管理（不 kill、不监控、不重启；沿用 `serve` 的既有决策）;
- 不解决 `mcp-client` 对 streamable-http 不重连的问题（另案；本设计用"状态可见 + 可重试"缓解）；
- 不为无 Web UI 的环境（headless / SDK）提供替代批准入口——那里只剩 Host 日志（见 §6）。

## 3 用户可见行为

### 3.1 按钮（`conversation.input.left`）

注册 id `project-mcp`，渲染为**图标 + 状态文字**（数量并入文字；完整文案进 tooltip 与弹层）。
按工作区计划（plan）存在与否与需动作数取态：

| 情形 | 按钮 | tooltip |
| --- | --- | --- |
| 工作区无可用 `.mcp.json` 计划 | **不渲染** | — |
| 计划检测中（会话刚创建 / 文件刚变化） | 图标 + 转圈 + 「检测中」 | "正在检测项目 MCP" |
| 需动作数 N > 0（未授权 + 已授权未连接 + 失败） | 图标 + 「N 个未启动」 | "N 个服务没启动，点击处理" |
| 需动作数 = 0 且计划非空 | 图标 + 「MCP 就绪」 | "项目 MCP 已就绪（M 个）" |

按钮**每会话**渲染（slot scope 为 session），但状态来自**工作区级**计划 + **会话级**挂载状态
的合成（§4.1）。无 Session 的 inert 态不渲染（slot 自身只在有 Session 时渲染）。

### 3.2 弹层（按钮上方锚定面板）

点按钮打开；fixed 锚定在按钮上方，Escape / 点外 / 窗口缩放关闭，动作后保持打开看状态更新。
每个服务器一行：

| 列 | 内容 |
| --- | --- |
| 名称 | 规范名；被规范化重命名的附原名 |
| 传输 | stdio / streamable-http |
| 状态 | 未授权 / 未启动 / 启动中 / 已连接 / 失败 / 已跳过 |
| 说明 | 跳过原因、失败原因（错误类型名）、serve 等待进度——**不含任何配置值与 env 值** |
| 动作 | `[启动]`（未授权或未连接时）／`[重试]`（失败时）／`[撤销授权]`（已授权时） |

"启动"= 授权（写 per-server 记录）+ 异步挂载/拉起；"撤销授权"= 删除记录 + 从**所有**已挂载
该服务器的活会话卸载。弹层底部一行小字给出 `.mcp.json` 路径与"内容变化需重新启动"的提示。

### 3.3 授权语义（per-server + configHash）

- 授权记录键：`projectRoot` → `serverName` → `configHash`（该服务器条目规范化后的 JSON 的
  sha256，**不含**展开后的 env 值——哈希输入是 `.mcp.json` 里的字面量）。
- 点一次"启动"= 授权**该服务器的当前配置**。`.mcp.json` 改动后：同名服务器哈希变化 → 回到
  "未授权"；新增服务器 → 新的未授权项；未变化的服务器授权保留。**git-pull 保护因此保留**，
  且比旧的文件级指纹更精确（改 A 不再连累 B）。
- 信任文件升级到 `version: 2`。**不做 v1 → v2 迁移**（v1 只存文件指纹、不存内容，展开不出
  per-server 哈希）：升级后每个项目需点一次"启动"。v1 文件按"失败关闭"读为未授权，随后被 v2
  整体重写（沿用既有的原子写 + `0600`）。
- 批准通道只有 UI 的用户动作；仓库内依旧没有任何可写入批准的文件或命令。

### 3.4 移除项

- `/mcp-project` 命令族整体删除（含 `trust` / `untrust`）；
- 系统提示词注入（`notice.ts` 与 `injectNotice`）整体删除；
- 会话创建时对 `serve` 的等待删除（§4.2）。

## 4 架构

```
Host（index.ts 装配）
  ├─ plan registry      工作区级：.mcp.json 发现/解析/翻译 + 跳过原因；fs.watch 防抖刷新
  ├─ auth store         ~/.dsh/project-mcp-trust.json v2（per-server configHash）
  ├─ session registry   会话级：每服务器 mount/serve 状态机 + fiber 记账
  ├─ status service     @Remote：follow(sessionId, signal) 流 / start / revoke / retry
  └─ agent/created      同步：登记 + 对已授权服务器 fire-and-forget 挂载；**不 await 任何 I/O 结果**
Client（client.js，plain JS）
  ├─ conversation.input.left  按钮 + 内联锚定弹层（sessionId 由注册项 inject 注入）
  └─ fetch('/project-mcp/…')  status 轮询（1.5s）+ start/revoke（同源 fetch，无 nonce）
```

### 4.1 Host 状态中心

- **plan registry**（工作区级，键 = projectRoot）：会话创建与文件 watch 事件（防抖 300ms）时
  重算。读盘沿用 1 MiB 上限与"向上找 `.git`"的发现规则。plan 是纯函数产物
  （复用 `session.ts` / `translate.ts` / `discovery.ts`），可单测。
- **session registry**（会话级，键 = sessionId）：每服务器一个状态机：
  `unauthorized → starting → connected | failed`，外加 `skipped`（带原因）与 `revoked`。
  serve 的 inflight 去重表（按 url）保留，改由后台任务持有。
- 状态是**活状态**（不写会话日志、不做 sessionProjections）：practices 要求会话日志是唯一
  事实源、插件自有数据不进 session events；本状态既非模型可见也非 durable，用 Remote 流推送
  即可，避免为 UI 状态发明新事件类型。

### 4.2 会话创建契约（G1）

`agent/created` 监听器内只做：取/建 plan（命中 registry 缓存时零读盘）、登记 session registry、
对**已授权**服务器发起 fire-and-forget 挂载（挂载本身不 await 连接，红线 5 不变），然后**同步
返回**。未授权服务器不做任何 I/O。serve 的健康检查与 spawn 全部发生在后台任务里，就绪后再挂
对应条目；期间按钮显示"启动中"。

代价（用户已接受）：首轮消息可能看不到这些工具。按钮的"启动中/已连接"是用户侧的补偿信号。

### 4.3 Client↔Host 通道

- Host 服务方法标 `@Remote`（`@deepseek-ai/dsh-typert-protocol` 导出；`commands`、
  `workspaceController` 等宿主服务同机制）：
  - `@Remote({mode:'stream'}) follow(sessionId, signal)`：状态快照流；
  - `@Remote start(sessionId, serverName)` / `revoke(...)` / `retry(...)`。
- 插件红线 1 禁止把 `@deepseek-ai/*` 写进依赖：沿用 `profile-modules.ts` 的
  `createRequire(profile/package.json).resolve + 动态 import` 在 apply 时解析该包。
  **解析失败即降级**：插件保持 Host-only 行为（挂载/授权语义不变，只是没有按钮），记一条
  warn。**不**提供无认证 HTTP 路由兜底——那会让本机任意进程触发 `.mcp.json` 里的命令。
- 解析可行性是实现的**第一个验证点**（spike）：profile 的 node_modules 能否解析到
  typert-protocol。不可行则回到评审，改选通道（不自行发明）。
- **路由准入**（2026-10-28 修订）：`/project-mcp/status` / `start` / `revoke` 的全部请求先过
  同源三重围栏（`src/same-origin.ts` 的 `requestAllowed`：peer 回环 + `Host` 白名单 +
  `sec-fetch-site`/`Origin`），拒则 `403 {ok:false, reason}`。这**不是**匿名面：围栏沿用宿主对
  插件自注册路由既有的信任模型（loopback Host 即过），跨站请求与 DNS rebinding 都在它之外。
  它与「工具调试」Tab 是**同一套**准入，**不是** boot 级 nonce：nonce 依赖 `webServer.tapIndex`
  把 `<meta>` 注入页面，而桌面版（Electron）的页面文档由 shell 的 `serveWebDocument()` 直读
  打包 dist、不经 Host 的 `renderIndex()`，`tapIndex` 在那里**永不执行**——桌面版会因此每个
  请求 403、按钮静默消失（Web 版正常）。判据与教训见 [`behavior.md` §7A.5](behavior.md)。

### 4.4 Client 半边

- plain-JS client 模块（`dsh.client`），注册进 `conversation.input.left`（id `project-mcp`）；
  弹层由按钮组件**内联渲染**（fixed 锚定按钮上方），不再使用 `shell.overlay`（root 作用域
  拿不到会话；跨组件共享开关状态曾导致弹层无法关闭）。
- 会话 id 由注册项 `inject: sessionId => ({ sessionId })` 注入（slot standardProps 无
  `sessionId`）；状态经同源 fetch 轮询 `/project-mcp/status`（1.5s），**最小切片**渲染。
  运行时权威描述见 [`behavior.md`](behavior.md) §7（本文件的 `@Remote follow` 设想未采用，
  实现走 `webServer` 前缀路由 + 轮询）。
- 文案走 `ctx.locale.register`（zh + en）；样式只用 `--dsw-alias-*` 主题令牌；控件自写
  （不 import 宿主 UI 包，practices 明令禁止）。
- 弹层的打开态是 Client 本地状态；Host 不持 UI 状态。

### 4.5 与既有模块的关系

| 模块 | 处置 |
| --- | --- |
| `commands.ts` / `notice.ts` | **删除** |
| `trust.ts` | 重写为 v2（per-server configHash）；v1 读为未授权 |
| `session.ts` | 保留 plan 纯函数；删除"待批准提示"计划分支 |
| `serve.ts` | 保留；`ensureServeReady` 的调用点从创建路径移到后台任务 |
| `index.ts` | 装配状态中心、Remote 服务、watcher；`agent/created` 改同步；**`inject` 声明改为
  `['loader']`**（命令与系统提示注入删除后不再需要；随之"缺 `commands` 的 profile 保持未激活"
  这条旧行为作废，父工作区 `AGENTS.md` 第 71 行与本项目文档需同步） |
| 新增 `status.ts` | 状态机与计数口径（纯函数，可单测） |
| 新增 `remote.ts` | Remote 服务装配与 typert 解析/降级 |
| 新增 `client.js` + locale 资源 + 图标 | Client 半边 |

### 4.6 新构建进入长跑进程（免重启，已实测）

2026-10-18 以带标签的 apply 日志实测：在官方插件页**删除→安装**本包（`link:` 安装），长跑
`dsh web` 进程载入磁盘上的当前构建（新标记出现在宿主日志）；随后换入无标记构建，标记不再
出现（证明第二次载入的也是磁盘当前构建）。**不需要重启，也不需要本插件自带换血机制。**

| 通道 | 结论 |
| --- | --- |
| 官方插件页删除→安装（或 `plugin_manager` remove/install） | ✅ 免重启载入新构建（实测） |
| `set_plugin` 停用→启用往返 | 只修结构；`Entry.update()` 复用旧 `moduleNamespace`，**不**载入新构建 |
| 重启 `dsh web` | 可行但没必要 |
| 自带 zh_pro 式 dispose 逐出 + `watchConfig` watcher | **不做**（YAGNI）：删除→安装已够用；若将来需要"不丢挂载的自动换血"再单独立项 |

两个注意点：

- 换血**不会**把项目级 MCP 重新挂进活会话（挂载只发生在会话创建或批准时）。验收新构建的
  行为必须开新会话；
- 判据只用可见行为（技能 §2.4）：`fiberPhase`、诊断计数、版本号都不可信。

## 5 状态机与计数口径

```
skipped(原因) ────────────────────────────────┐
unauthorized ──start──> starting ──ok──> connected
     ^                     │  ^               │
     │revoke               │  └──retry────────┤fail
     └─────────────────────┴── failed <───────┘
```

- 状态闭集：`unauthorized` / `starting` / `mounted` / `not-mounted` / `failed` / `skipped`。
- **需动作数 N** = `unauthorized` + `failed` + `not-mounted`。`starting` 不计入（显示为转圈）。
- `not-mounted`：计划是 mount、授权也在，但**本会话**没有登记项（插件换血、或批准发生在会话
  创建之后）。旧设计把它折进 `starting` 会永远转圈；独立成态后它上徽标、弹层里点"启动"即
  补挂——顺带让"换血后活会话拿不到工具"从"必须重开会话"变成"点一下"。
- `starting` 只是瞬态：挂载 fiber 拒绝即转 `failed`；serve 超时不转 failed，条目保持
  `mounted`/`starting` 并由 `mcp-client` 自连（与现状语义一致，只是从"日志里一条 warn"变成
  按钮上的一个数）。

## 6 失败模式与诊断归属

| 失败 | 用户在哪看见 |
| --- | --- |
| `.mcp.json` 无法解析 / 超 1 MiB | 弹层顶部一行原因 |
| 服务器被跳过（传输不支持 / 变量缺失 / 撞名 / 重名） | 弹层该行"已跳过 + 原因" |
| spawn 失败 / serve 超时 / 连接失败 | 弹层该行状态 + 错误类型名 |
| typert 解析失败（无按钮） | Host 日志 warn（无 UI 可言） |
| headless / SDK profile | Host 日志 warn；无批准入口（非目标，已声明） |

所有诊断**只含**服务器名、字段名、错误类型名；不含 `.mcp.json` 内容、不含展开后的 env 值
（红线 3 延伸到 UI）。

## 7 安全对照

| 既有属性 | 本设计如何保持 |
| --- | --- |
| 仓库无法自我批准 | 批准只由 UI 用户动作写 `~/.dsh`（0600）；仓库内无通道 |
| 未批准不 spawn、不连接 | 后台任务只对已授权条目动作 |
| env 值不入日志/错误/会话 | 诊断口径不变；UI 同口径 |
| 指纹绑定防 git-pull | 升级为 per-server configHash，语义更强 |
| 挂载不 await 连接、失败不抛 | 红线 4/5 原样保留 |
| 控制台路由的准入 | 全部 `/project-mcp/*` 请求（按钮的 status/start/revoke + 调试台）过同源三重围栏：peer 回环 + `Host` 白名单 + `sec-fetch-site`/`Origin`；**不用 nonce**（桌面版 `tapIndex` 永不执行）。`start`/`revoke` 会写信任记录并 spawn 进程，因此围栏不设例外 |

## 8 测试策略

- **纯函数层**（主力）：`status.ts` 状态机与计数、`trust.ts` v2 读写与 v1 失败关闭、plan 合成、
  configHash 稳定性（键序无关）。每条分支配变异测试（本仓库既有做法）。
- **Host 装配层**：假 ctx + 假 agent 的集成测试（沿用 `serve-mount.test.mts` 手法）：断言
  `agent/created` **同步返回**（回归 G1：把挂载改成 await 就变红）、断言系统提示词装配里
  **没有**本插件贡献（回归 G4）、断言 Remote 服务的 start 会写授权并触发挂载。
- **Client 半边**：本环境无浏览器控制，只做安装级验证（bundle 装入、slot 注册出现、无
  console 报错）；真机验收清单见 §9，需用户配合。
- 端到端：用真实 MudMCP 的 `.mcp.json` 走"未授权 → 点启动 → 已连接 → 改文件 → 重新需动作"
  全链路（真机）。

## 9 上线与验收

1. **bootstrap 一次**：Client 半边**首次供应**需要一次进程重启——`clientModules` 对"非 client
   包"有进程级负缓存（本包在加 `dsh.client` 之前就被扫描过；技能 `dsh-hot-reload` §3 明记，
   2026-10-18 以 `/plugins/events` 的 graph 帧实测复核：帧内无本包条目）。重启之后：Host 半边
   免重启换血（官方删除→安装，§4.6 实测），Client 半边自动 HMR（无需刷新页面）。重启之前不得
   把旧进程的行为当成新构建的行为。
2. 真机清单：按钮三态切换；弹层启动/撤销/重试；改 `.mcp.json` 后徽标变化；新会话创建耗时
   不受 serve 影响（对照计时）；未批准时系统提示词无残留（导出提示词核对）；卸载插件后
   slot 与 Remote 面干净消失。
3. 文档同步：`behavior.md`（用户可见语义重写）、`troubleshooting.md`（命令入口改为弹层）、
   双语 README、`AGENTS.md`（文档职责表与红线清单核对）、本文件状态转"已实施"；并修正"Host
   半边没有热通道"的既有表述（本仓库 `AGENTS.md` 末段、`development.md`、`troubleshooting.md`
   快速分流第 3 条、双语 README 安装节）为 §4.6 的实际语义。

## 10 风险与未验证项

| 项 | 说明 |
| --- | --- |
| typert 包能否从 profile 解析 | 实现第一验证点；不可行则回评审换通道 |
| `conversation.input.left` 的空间 | compact controls；若图标+徽标仍显挤，退到 `conversation.composer.dock`（用户已备选） |
| 首轮无工具 | 已接受的代价；按钮状态是补偿信号 |
| `mcp-client` 不重连 | 另案；本设计以"可见 + 可重试"缓解 |
| Client 半边的真机表现 | 无浏览器控制，安装级验证 + 用户真机清单 |
| v1 批准作废 | 已决策：不迁移，重新点一次 |
| bootstrap 重启 | 逐出钩子的首次载入无法免重启（进程内无人清本包缓存）；一次性、由用户执行 |
| watcher `fires == skipped` | 初始扫描判定写错会让自建 watcher 永不触发；但 §4.6 的 dispose 路仍可能已让新构建生效——判据只用可见行为，不得据此改代码 |
| 诊断字段假信号 | `version` / `buildId` / `reload.count` 均不作换血判据（本机快照已见 `version=null` 而功能为新） |
