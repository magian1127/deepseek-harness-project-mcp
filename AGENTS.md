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
10. **回收只清 `servers`，不 `agents.delete(key)`**——被回收的会话还活着，下次发消息要重挂。
    回收走 `fiber.dispose()` 而非杀进程（`mcp-client` 会自动重连，杀进程会被重新拉起）。
11. **`agent/pre-step` 监听器必须 `return next()`**（waterfall，本插件不拥有该决策；不调用会
    否决整条链含内置行为）。监听器内任何异常都必须吞掉并记日志，绝不打断用户的消息。
12. **`Config` 在 profile 无 schemastery 时必须是 `undefined`，绝不能是 `null`**——宿主设置页
    的 `'toJSON' in Config` 遇 `null` 抛错并带崩整页。连接上限默认 **8**。
13. 不主动 `git commit` / `git push`；用户明确批准后，提交标题以中文开头。

## 源码地图摘要

| 模块 | 职责 |
| --- | --- |
| `src/index.ts` | 插件入口 `apply`：装配命令、订阅 `agent/created` / `agent/disposed`、挂载与卸载、写信任存储。**唯一做会话数据 I/O 与 Cordis 交互的模块** |
| `src/config-guard.ts` | 挂载前的 Config 自校验（非法配置拦在 `ctx.plugin()` 之前）与只记类型名的 `errorName` |
| `src/types.ts` | 宿主服务的最小鸭子类型（不 import `@deepseek-ai/*`） |
| `src/profile-modules.ts` | 从当前 profile 解析并预载 DSH 运行时模块 |
| `src/discovery.ts` | 项目根发现（向上找 `.git`）、`.mcp.json` 读取与解析 |
| `src/translate.ts` | 条目 → `McpClientConfig`、`serverName` 规范化、`${VAR}` 展开 |
| `src/trust.ts` | 信任存储、规范化指纹、批准/撤销 |
| `src/global-rows.ts` | 从 Loader 树收集全局 `mcp-client` 行的 `serverName` |
| `src/session.ts` | `planSessionMount`：会话 → 挂载决策（纯函数，零 I/O） |
| `src/session-tag.ts` | `withSessionTag`：给 stdio config 追加 `--project-mcp-session <SessionId>` 会话标记（纯函数，返回新对象） |
| `src/reclaim.ts` | `selectReclaimTargets` / `normalizeConnectionLimit`：连接回收决策与上限归一（纯函数，零 I/O） |
| `src/commands.ts` | `/mcp-project` 命令族（依赖经 `CommandDeps` 注入） |
| `src/notice.ts` | `renderNotice`：会话提示文本（只在需用户行动时非空） |

依赖方向单向无环：

```
index.ts ──> session.ts ──> discovery.ts, translate.ts, trust.ts, global-rows.ts
   │                              │
   ├──> commands.ts, notice.ts    └──> types.ts
   ├──> config-guard.ts ──> types.ts
   ├──> session-tag.ts ──> types.ts
   ├──> reclaim.ts
   └──> profile-modules.ts
```

`session.ts` / `translate.ts` / `discovery.ts` / `trust.ts` / `global-rows.ts` /
`config-guard.ts` / `session-tag.ts` / `reclaim.ts` 各自只承担一件事、互不依赖，全部通过
注入 I/O（或干脆无 I/O）保持可彻底单测。

**"唯一做 I/O"的准确范围**：`index.ts` 是唯一做**会话数据** I/O（`.mcp.json` 与信任
存储的读写）与 Cordis 交互的模块。`profile-modules.ts` 是**显式例外**——它做真实 I/O
（`readFileSync` 读 `package.json`、`createRequire`、动态 `import`），但那是 profile
模块解析，与会话数据无关，且刻意独立成模块以便隔离"从 profile 载入 DSH 运行时模块"
这一副作用。不要把会话数据 I/O 搬出 `index.ts`，也不要把 profile 解析搬进来。

## 本地验证命令

```powershell
npm install
npm run typecheck                        # tsc -p tsconfig.json --noEmit
npm test                                 # 222 个用例，14 个测试文件
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
- `/mcp-project` 与提示段在真实 GUI 会话中的实际渲染；
- **`agent/pre-step` 是否对每个会话都触发**——重挂完全依赖它（监听器注册在宿主 ctx 上，
  靠 `scopeTarget` 对未打 scope 标签的 ctx 放行来接收全部 agent 的事件，
  `packages/core/scope/src/index.ts:170-185`）。**该事件不触发则被回收的会话无法重挂**；
- **回收是否真的释放子进程**：测试只证明 `fiber.dispose()` 被调用，真实释放取决于
  `mcp-client` 在 dispose 时杀掉子进程并清掉重连定时器（`connection.ts:388-394`）；
- **`Config` 的插件页表单**：测试 profile 无 schemastery，只覆盖降级为 `undefined` 的路径。

Host 半边没有热通道：新构建进入长跑进程需要使用者重启一次 DSH，代理不得自行重启。
详见 [`docs/development.md#8-验证分层与未验证项`](docs/development.md#8-验证分层与未验证项)。
