# AGENTS.md

本仓库是 DeepSeek Harness 的独立插件：让项目根目录的 `.mcp.json` 决定该项目下的会话启用
哪些 MCP 服务器，且未启用的服务器**完全不建立连接、不启动子进程**。

用户说明见 [`README.md`](README.md) / [`README.en.md`](README.en.md)，用户可见语义见
[`docs/behavior.md`](docs/behavior.md)，设计依据见 [`docs/design.md`](docs/design.md)。

## 文档职责

同一事实只保留一个权威位置，其他文档只做摘要并链接：

| 文档 | 唯一职责 |
| --- | --- |
| [`README.md`](README.md) / [`README.en.md`](README.en.md) | 面向用户：功能、环境要求、安装、`.mcp.json` 格式、批准流程、卸载、数据边界与已知限制 |
| [`docs/behavior.md`](docs/behavior.md) | 用户可见行为：字段语义、传输矩阵、命名规范化、信任模型与指纹、命令输出、失败模式、与全局行的关系 |
| [`docs/design.md`](docs/design.md) | 设计依据：目标、非目标、架构、取舍与风险 |
| [`docs/development.md`](docs/development.md) | 源码地图、依赖策略、peer 解析契约、构建与测试、验证分层、实现层局限 |
| [`docs/troubleshooting.md`](docs/troubleshooting.md) | 按症状诊断、运行时观察目标、未验证项 |

修改用户可见行为时同步双语 README 与 [`docs/behavior.md`](docs/behavior.md)；修改实现规则时
更新 [`docs/development.md`](docs/development.md)。

## 红线（不可破坏）

1. **不得**把 `@deepseek-ai/*` 写入 `dependencies` / `peerDependencies`——一律经
   `src/profile-modules.ts` 运行时从 profile 解析，或使用 `src/types.ts` 的鸭子类型。
2. **不得**在文档、源码、配置中写入本机绝对路径（盘符、用户名、具体安装目录）。本地文件
   用项目相对路径或 `${DSH_HOME:-~/.dsh}` 形式。
3. **展开后的环境变量值永不进入**日志、错误消息、会话记录或任何持久化产物；诊断只记
   **变量名**与服务器名，绝不回显 `.mcp.json` 内容。
4. 会话创建路径上的任何函数**都不抛异常**（抛异常会中断会话创建）；失败一律降级并记日志。
5. 挂载必须**不 await 连接**且设 `failOnStartupError: false`：会话秒开优先于工具必定就位。
6. 挂载与提示段的 disposer 必须**双份登记**：注册落在 `agent.ctx`，disposer 同时按
   **`agent.id`（会话 id）**键控地留在插件自己的 `ctx.effect` 里（`agent.ctx` 上的注册有
   两个 owner）。**不得**按 agent 对象引用记账：同一 sessionId 可能被 `agent/created`
   报告两次且传的是不同对象，按引用记账会让幂等失效、重复挂载并多 spawn 一个子进程。
7. `ctx.get('loader')` 必须传 **Loader 本体**而非 `loader.root`；传 root 会让全局名单静默
   变成空集、撞名守卫完全失效。
8. 信任键（`projectRoot` + `fingerprint`）必须与 `isApproved` 的查询键逐字一致；批准时复用
   计划携带的值，不自行推导。
9. 相对导入一律写 `.js` 扩展名（即使源文件是 `.ts`）；`lib/` 与 `.tsbuild/` 不得手改。
10. 不主动 `git commit` / `git push`；用户明确批准后，提交标题以中文开头。
11. `serve` 是**本插件自己的**元数据，不在 `mcp-client` 的 Config schema 里，必须在
   `validateMountConfig` / `withSessionTag` / `ctx.plugin()` **之前**剥离（`splitServe`）。
   带着它进 `ctx.plugin()` 一旦触发校验失败，schemastery 的 union 错误会把**整个 config**
   （含展开后的 `serve.env` 凭据）写进 Cordis 自己的日志——红线 3 的隐蔽通道。
12. `spawnDetached` 的五个要素缺一不可：`detached`（**按平台与命令**取值，见
   `spawnOptionsFor`：POSIX 恒为 `true`；Windows 上对 PowerShell 为 `false`、其余为 `true`）、
   `stdio: 'ignore'`、
   `windowsHide: true`、`child.on('error', …)`、`unref()`。**`'error'` 监听器不是防御性
   代码**：Node 对它没有默认处理器，无监听器时一个写错的 `serve.command`（ENOENT）会以
   未捕获异常**带崩宿主进程**（已实测）。启动后不 kill、不 await、不监听 exit——生命周期
   归服务自己。**Windows 上不得写 `detached: true`**：Node 在 Windows 把它实现成
   `DETACHED_PROCESS`（子进程没有控制台），而 PowerShell 在那种情形下**立刻以退出码 0 结束、
   一行都不执行**（已实测），于是 `serve.command: pwsh` 静默空转、插件白等满
   `readyTimeoutMs`（默认 120 秒），而会话创建正卡在这段等待上。**Windows + 其他命令又必须 `detached: true`**：
   不 detached 的子进程挂在宿主控制台上，控制台拆除时被 `CTRL_CLOSE_EVENT` 带走（已实测），
   服务会随 DSH 一起消失；而 Node 无法表达两全的 `CREATE_NO_WINDOW`，因此只能按命令分流。
13. 健康检查 URL 只允许 `http://` / `https://`；`fetch` 还支持 `file:` / `data:`，放行它们
   等于让不受信的 `.mcp.json` 指挥本插件读本机文件。

## 源码地图摘要

| 模块 | 职责 |
| --- | --- |
| `src/index.ts` | 插件入口 `apply`：装配命令、订阅 `agent/created` / `agent/disposed`、挂载与卸载、写信任存储。**唯一做会话数据 I/O 与 Cordis 交互的模块** |
| `src/config-guard.ts` | 挂载前的 Config 自校验（非法配置拦在 `ctx.plugin()` 之前）与只记类型名的 `errorName` |
| `src/types.ts` | 宿主服务的最小鸭子类型（不 import `@deepseek-ai/*`） |
| `src/profile-modules.ts` | 从当前 profile 解析并预载 DSH 运行时模块 |
| `src/discovery.ts` | 项目根发现（向上找 `.git`）、`.mcp.json` 读取与解析 |
| `src/values.ts` | `${VAR}` 展开与不受信 JSON 的形状守卫（`translate.ts` 与 `serve.ts` 共用） |
| `src/translate.ts` | 条目 → `McpClientConfig`、`serverName` 规范化、解析 `serve` 字段 |
| `src/health.ts` | `checkHealth` / `waitReady` / `isHttpUrl`：就绪探测与轮询（I/O 全部注入） |
| `src/serve.ts` | `planServeStart`（`serve` → 启动计划）、`deriveHealthUrl`、`splitServe`（剥离 `serve`）、`ensureServeReady`（编排 + 并发去重）、`spawnDetached`（脱离进程启动，**真实进程 I/O**） |
| `src/trust.ts` | 信任存储、规范化指纹、批准/撤销 |
| `src/global-rows.ts` | 从 Loader 树收集全局 `mcp-client` 行的 `serverName` |
| `src/session.ts` | `planSessionMount`：会话 → 挂载决策（纯函数，零 I/O） |
| `src/session-tag.ts` | `withSessionTag`：给 stdio config 追加 `--project-mcp-session <SessionId>` 会话标记（纯函数，返回新对象） |
| `src/console-view.ts` | `composeConsoleView`：计划 + 挂载记账 + serve 进行中表 → 控制台视图（纯函数，需动作数口径在此钉死） |
| `src/same-origin.ts` | `requestAllowed`：两座 HTTP 桥**共用**的同源三重围栏（peer 回环 + `Host` 白名单 + `sec-fetch-site`/`Origin`），拒绝理由 `loopback-only` / `same-origin-only`（纯函数，零 I/O） |
| `src/console-bridge.ts` | `installConsoleBridge`：`webServer` 前缀路由（status / start / revoke）。准入调 `same-origin.ts` 的 `requestAllowed`（同源三重围栏），**不用 nonce、不注册 `tapIndex`**（**真实 HTTP I/O**） |
| `src/debug-view.ts` | 工具调试台的纯函数投影：MCP 名解析、分组、关键词过滤、schema → 表单、表单 → 参数（**零 I/O**） |
| `src/debug-executor.ts` | `DebugExecutor`：`callId` 序列 + 取消表 + 结果块投影（`.value` 优先、图片 4 MiB 截断） |
| `src/debug-bridge.ts` | `installDebugBridge`：`webServer` 前缀路由（tools / call / cancel / prompt-sections / skills / skill）。准入与 `console-bridge` **共用** `same-origin.ts` 的同源三重围栏（peer 回环 + `Host` 白名单 + `sec-fetch-site`/`Origin`），两座桥都**刻意不用 nonce**；技能按**会话作用域**列举（`session` 解析成 agent 当 `scope`，否则 preset 的 `customSkillDirs` 技能看不到）（**真实 HTTP I/O**） |
| `client.js` | Client 半边（plain-JS bundle）：输入区按钮 + 内联锚定弹层（点外部/Esc 关闭）；`conversation.view` 的「工具调试」Tab（工具树 / 调用 / 结果 / 技能 / 提示词面）；会话 id 经注册项 `inject` 注入（不做任何会话数据折叠） |

依赖方向单向无环：

```
index.ts ──> session.ts ──> discovery.ts, translate.ts, trust.ts, global-rows.ts
   │                              │
   │                              ├──> serve.ts ──> health.ts, values.ts, config-guard.ts
   │                              └──> values.ts, types.ts
   ├──> console-view.ts, console-bridge.ts ──> same-origin.ts
   ├──> debug-bridge.ts ──> debug-executor.ts, debug-view.ts, same-origin.ts
   ├──> config-guard.ts ──> types.ts
   ├──> session-tag.ts ──> types.ts
   ├──> serve.ts（ensureServeReady / spawnDetached / spawnOptionsFor / splitServe）
   └──> profile-modules.ts
```

调试台是**通用**调试面：它读宿主全局 `tools` 服务，与项目级 MCP 无语义关系，只是搭在本插件
已装配的 webServer 通道上。schema → 表单的规则**只**在 `debug-view.ts` 实现一次，`client.js`
只渲染 Host 投影好的 `fields`——两处实现分叉会让"表单字段与真实 schema 不符"，而那正是调试台
最不该骗人的地方。`tools` 服务缺席时不装配调试路由。

`session.ts` / `translate.ts` / `discovery.ts` / `trust.ts` / `global-rows.ts` /
`config-guard.ts` / `session-tag.ts` / `values.ts` / `health.ts` / `serve.ts` / `same-origin.ts`
各自只承担一件事、互不依赖（除上面标出的单向依赖），全部通过注入 I/O（或干脆无 I/O）保持可彻底单测。

**"唯一做 I/O"的准确范围**：`index.ts` 是唯一做**会话数据** I/O（`.mcp.json` 与信任
存储的读写）与 Cordis 交互的模块。两个**显式例外**：`profile-modules.ts` 做真实 I/O
（`readFileSync` 读 `package.json`、`createRequire`、动态 `import`），但那是 profile
模块解析，与会话数据无关，且刻意独立成模块以便隔离"从 profile 载入 DSH 运行时模块"
这一副作用；`serve.ts` 的 `spawnDetached` 启动一个外部进程，同样不属于会话数据，且与
"怎么启动服务"的全部知识同处一室才不会被误改。不要把会话数据 I/O 搬出 `index.ts`，
也不要把 profile 解析或进程启动搬进来。

## 本地验证命令

```powershell
npm install
npm run typecheck                        # tsc -p tsconfig.json --noEmit
npm test                                 # 298 个用例，20 个测试文件
npm pack --dry-run                       # 核对 tarball 内容（files 字段）
(Get-Content AGENTS.md).Count            # 必须 ≤ 200
```

改动 `package.json` 的 `files` 字段后**必须**重跑 `npm pack --dry-run`，确认 tarball 不含
`.superpowers/`、`src/tests`、`docs/plans/` 与 `package-lock.json`（`tsconfig.json` 与
`tsconfig.tests.json` 在 `files` 里，**应当**在 tarball 里）。

单独跑一个测试文件：

```powershell
npm run build && node --test ".tsbuild/tests/session.test.mjs"
```

`tsconfig.tests.json` 开了 `noCheck`：构建 exit 0 **不代表**测试能加载，模块解析错误只在
运行期暴露。变异测试时注意 `noEmitOnError` 会让编译失败静默跑旧产物。

## 未验证项

以下需要真实 DSH profile 与会话，**尚未验证**；不要把它们当成已确认行为：

- `agent/created` 在 `clear` / `compact` source 下的幂等性；
- 非阻塞挂载下 fiber 在 agent dispose 时的清理时机；
- 从 `agent.ctx` 遍历 Loader 树能否拿到完整条目集；
- 首条消息是否真的赶不上工具注册；
- 控制台按钮与弹层在真实 GUI 会话中的实际渲染（本环境无浏览器控制，只做安装级验证）。

Host 半边换血：**官方插件页删除 → 安装**即可让新构建进入长跑进程（2026-10-18 以带标记的
apply 日志实测），不需要重启；`set_plugin` 停用→启用只修结构、复用旧模块命名空间，**不**载入
新构建。Client 半边由宿主自动热更新，但**首次供应**需要一次重启（宿主模块表按进程缓存
"非 client 包"）。代理不得自行重启 DSH。
详见 [`docs/development.md#8-验证分层与未验证项`](docs/development.md#8-验证分层与未验证项)。
