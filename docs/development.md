# 开发指南（development）

> 本文件是源码地图、依赖策略、构建与测试的**唯一权威位置**。
> 用户可见语义见 [`behavior.md`](behavior.md)；设计依据见 [`design.md`](design.md)；
> 按症状诊断见 [`troubleshooting.md`](troubleshooting.md)。

## 1. 仓库结构

| 路径 | 职责 |
| --- | --- |
| `src/*.ts` | 唯一手写实现源码 |
| `src/tests/*.test.mts` | `node:test` 测试源码 |
| `cordis.patch.yml` | 随包发布的持久 bundle patch（行 id `dsh-project-mcp`） |
| `lib/` | Host 构建产物（`tsc`），**不得手改** |
| `.tsbuild/` | 测试构建产物（`tsc`），**不得手改** |
| `docs/` | 按主题拆分的权威文档 |
| `temp/` | 临时产物，已 gitignore |

`lib/` 与 `.tsbuild/` 只能由构建命令生成。

## 2. 源码地图

| 模块 | 职责 | I/O |
| --- | --- | --- |
| `index.ts` | 插件入口 `apply`：装配命令、订阅 `agent/created` 与 `agent/disposed`、挂载与卸载、写信任存储、持有按 `url` 的进行中启动表 | **唯一做会话数据 I/O 与 Cordis 交互的模块**（`profile-modules.ts` / `serve.ts` 是显式例外，见下） |
| `config-guard.ts` | 挂载前的 Config 自校验（`validateMountConfig`）与只记类型名的 `errorName` | 纯函数 |
| `types.ts` | 宿主服务的最小鸭子类型（`HostContext` / `AgentContext` / `CommandsService` / `SystemPromptService` / `LoaderService` / `AgentShape` / `McpClientConfig` / `ServeMetadata`） | 无 |
| `profile-modules.ts` | 从当前 profile 的模块解析上下文解析并预载 DSH 运行时模块 | 模块解析 + 文件读 |
| `discovery.ts` | 项目根发现（向上找 `.git`）、`.mcp.json` 读取与解析 | 纯函数 + 注入 I/O |
| `values.ts` | `${VAR}` 展开与不受信 JSON 的形状守卫（`asStringArray` / `asStringRecord` / `expandRecord` / `expandList`） | 纯函数 |
| `translate.ts` | 条目 → `McpClientConfig`、`serverName` 规范化、解析 `serve` 字段 | 纯函数 |
| `health.ts` | `checkHealth` / `waitReady` / `isHttpUrl`：就绪探测与轮询（`fetch`、定时器、时钟全部注入） | 纯函数 + 注入 I/O |
| `serve.ts` | `planServeStart`（`serve` → 启动计划）、`deriveHealthUrl`、`splitServe`（剥离 `serve`）、`ensureServeReady`（编排 + 并发去重）、`spawnDetached`（脱离进程启动） | 纯函数 + 注入 I/O；`spawnDetached` 是**真实进程 I/O** |
| `trust.ts` | 信任存储读写、规范化指纹、批准/撤销、存储路径 | 纯函数 + 注入 I/O |
| `global-rows.ts` | 从 Loader 树收集全局 `mcp-client` 行的 `serverName` | 纯函数（只读遍历） |
| `session.ts` | `planSessionMount`：会话 → 挂载决策（纯函数，零 I/O） | 纯函数 |
| `session-tag.ts` | `withSessionTag`：给 stdio config 追加 `--project-mcp-session <SessionId>` 标记（返回新对象） | 纯函数 |
| `commands.ts` | `/mcp-project` 命令族（列表 / trust / untrust） | 无（依赖经 `CommandDeps` 注入） |
| `notice.ts` | `renderNotice`：会话提示文本 | 纯函数 |

**依赖方向**（单向，无环）：

```
index.ts ──> session.ts ──> discovery.ts, translate.ts, trust.ts, global-rows.ts
   │                              │
   │                              ├──> serve.ts ──> health.ts, values.ts, config-guard.ts
   │                              └──> values.ts, types.ts
   ├──> commands.ts, notice.ts
   ├──> config-guard.ts ──> types.ts
   ├──> session-tag.ts ──> types.ts
   ├──> serve.ts（ensureServeReady / spawnDetached / splitServe）
   └──> profile-modules.ts
```

**职责边界**：`session.ts` / `translate.ts` / `discovery.ts` / `trust.ts` / `global-rows.ts`
/ `session-tag.ts` / `values.ts` / `health.ts` / `serve.ts` 各自只承担一件事、互不依赖（除上面
标出的单向依赖），且全部通过注入 I/O（或干脆无 I/O）保持可彻底单测。`index.ts` 是唯一的装配层，
因此它的测试是"假 ctx + 真实 fs"的集成冒烟，而非穷尽单测。

**"唯一做 I/O"的准确范围**：`index.ts` 是唯一做**会话数据** I/O（`.mcp.json` 与信任存储
的读写）与 Cordis 交互的模块。上表把 `profile-modules.ts` 的 I/O 记为"模块解析 + 文件读"
——它**确实**做真实 I/O（`readFileSync` 读 `package.json`、`createRequire`、动态 `import`），
是这条不变量的**显式例外**：那是 profile 模块解析，与会话数据无关，且刻意独立成模块以便
隔离"从 profile 载入 DSH 运行时模块"这一副作用（模块顶层就会执行，见 §7.4 的 `DSH_HOME`
时序要求）。`serve.ts` 的 `spawnDetached` 是**第二个例外**：它启动一个外部进程，同样不属于
会话数据，且与"怎么启动服务"的全部知识同处一室才不会被误改——`index.ts` 只负责把它接进
`ServeIo`。因此不要把会话数据 I/O 搬出 `index.ts`，也不要把 profile 解析或进程启动搬进来。

## 3. 依赖策略：不把 `@deepseek-ai/*` 写进依赖

**这是本工作区的硬约定**，对齐 `deepseek-harness-hashline` 的 `src/profile-modules.ts`。

DSH 运行时模块（`@deepseek-ai/dsh-*`、`@deepseek-ai/schemastery`）**不写入本包
`dependencies` / `peerDependencies`**，而是运行时从当前 profile 的模块解析上下文加载：

1. 保证与主进程**同一模块实例**——`HarnessError`、schemastery 等类型的 `instanceof` 判定
   依赖同一性；
2. `link:` 与 `file:` 两种安装方式走同一条路径；
3. 避免 peer 声明被宿主 preflight 按 semver 拒绝（0.1.7-rc.1 起精确版本清单会被拒）。

`dependencies` 与 `peerDependencies` 都必须省略。`devDependencies` 只有 `@types/node` 与
`typescript`。

### 3.1 需要的运行时模块与获取方式

| 需求 | 获取方式 |
| --- | --- |
| 挂载 MCP 插件 | **profile 解析** `@deepseek-ai/dsh-mcp-client`（必须真模块，`ctx.plugin()` 需要插件本体） |
| 原子写 + 文件锁 | **profile 解析** `@deepseek-ai/dsh-atomic-write`；失败则降级为"同目录临时文件 + rename" |
| 项目根发现 | **自实现**（向上找 `.git`）；不依赖 `skill-filesystem` 内部函数 |
| 命令注册 | **鸭子类型**（`ctx.get('commands')`） |
| 系统提示注入 | **鸭子类型**（`ctx.get('systemPrompt')`） |
| 遍历 Loader 树 | **鸭子类型**（`ctx.get('loader')`） |

降级原则：运行时模块加载失败时**降级而非启动失败**，并记一条警告。MCP 挂载无法降级——
拿不到 `mcp-client` 时功能整体不可用，此时记错误并**保持静默不挂载**（安全侧：宁可不挂，
不可错挂）。命令仍然注册：查看状态、批准、撤销都不需要 `mcp-client`，缺了它们用户连
"为什么没挂上"都查不到。

### 3.2 Peer 解析契约

DSH 0.1.7-rc 起，宿主的组合批次经模块 hooks 管线并行动态 import 官方插件的 ESM；在同步
求值里 `require(esm)` 会撞 Node 的 `not yet fully loaded`（管线被当前同步栈阻塞，同步重试
永远等不到加载完成）。因此 `profile-modules.ts` 必须：

1. 模块顶层用 `require.resolve` **只解析**（不求值、无竞态）；
2. 读目标包 `package.json` 的 `exports['.']`，取其中的 `import` 条目（退回 `default`，
   再退回 `main`，最后退回 require 条目）；
3. 以文件 URL **异步 import 预载**（模块顶层 `await`）；
4. 预载失败后才走同步 `require` 兜底（脱离 profile 的测试 / CLI 环境），再失败即
   **永久降级**并返回 `null`。

**profile 名解析**：`--profile <name>` 优先；无该标志时，Electron 环境（桌面版 Host）固定
为 `desktop`，否则为 `web`。桌面版不能落回 `web` 默认，否则 `createRequire` 会锚到 web
profile，拿不到与桌面运行时同实例的 DSH 模块。

**路径拼接**统一用 `posix.join`（输出跨平台确定，Windows 的 `fs` / `createRequire` 同样
接受正斜杠）；但**向上回溯**必须用平台感知的 `dirname`——`posix.dirname` 对 Windows 盘符
路径会返回 `.`，会让 Windows 上的项目根发现静默止步于 cwd。

## 4. 不可破坏的约束

1. **不得**把 `@deepseek-ai/*` 写入 `dependencies` / `peerDependencies`。
2. **相对导入一律写 `.js` 扩展名**（如 `from './discovery.js'`），即使源文件是 `.ts`；
   测试文件同理（`from '../trust.js'`）。
3. `serverName` 必须匹配 `/^[A-Za-z0-9_-]{1,32}$/`；命令名必须匹配
   `/^[a-z][a-z0-9_-]*$/u`。
4. 信任文件权限 `0600`；写失败**不吞**（静默失败会让"已批准"成为假象）。
5. 展开后的环境变量值**永不**进入日志、错误消息、会话记录或任何持久化产物；只记变量名。
6. 所有诊断只由服务器名、变量名与自造的 `reason` 文本拼成，不回显 `.mcp.json` 内容。
7. 会话创建路径上的任何函数**都不抛异常**（抛异常会中断会话创建）。
8. 挂载必须设 `failOnStartupError: false` 且**不 await 连接**。
9. 挂载与提示段的 disposer 必须**双份登记**：注册落在 `agent.ctx`（作用域正确），
   disposer 同时按 agent 键控地留在插件自己的 `ctx.effect` 里。`agent.ctx` 上的注册有
   两个 owner，插件卸载（禁用、HMR 重载）**不会**回收它们。
10. `lib/` 与 `.tsbuild/` 不得手改。
11. `ctx.get('loader')` 必须传 **Loader 本体**而非 `loader.root`：`entries()` 在 Loader 上，
   传 root 会让全局名单静默变成空集、撞名守卫完全失效。
12. 信任键（`projectRoot` + `fingerprint`）必须与 `isApproved` 的查询键**逐字一致**；
   批准时复用计划携带的值，不自行推导（如用进程 cwd）。
13. 文档与源码中不写本机绝对路径。
14. 提交标题以中文开头。

## 5. `inject` 声明与缺服务的 profile

`src/index.ts` 导出：

```ts
export const inject = ['commands', 'loader', 'systemPrompt'] as const
```

显式声明而不是在 `apply` 里碰运气：缺少任一服务时 Cordis 让插件保持**未激活**并等待，
而不是让 `apply` 在半个装配状态下抛错。这是缺服务时的正确行为（不激活而非抛错）。

**后果**：`sdk-minimal` profile 的 bundle **不提供 `commands`**（它不叠加 `dsh-base`，
自己的 patch 是完整树，且没有 commands 行）。该 profile 上本插件会保持 PENDING——
连 `/mcp-project` 命令也不出现。`web` / `desktop` / `headless` 等叠加 `dsh-base` 的
profile 都提供这三个服务。

声明之后仍保留服务缺失分支的诊断：服务可能在 `apply` 之后被卸载，而 `commands` 缺失会让
命令面无声消失、`loader` 缺失会让撞名守卫静默退化为空集，这两种退化都必须留下可查日志。

## 6. 构建与测试

```powershell
npm install
npm run build        # tsc -p tsconfig.json && tsc -p tsconfig.tests.json
npm run typecheck    # tsc -p tsconfig.json --noEmit
npm test             # npm run build && node --test ".tsbuild/tests/*.test.mjs"
npm pack --dry-run   # 核对打包内容
```

单独跑一个测试文件：

```powershell
npm run build && node --test ".tsbuild/tests/session.test.mjs"
```

`tsconfig.json`：`target ES2024`、`module ESNext`、`moduleResolution Bundler`、
`rootDir src`、`outDir lib`、`strict`、`verbatimModuleSyntax`、`noEmitOnError`、
`include: ["src/*.ts"]`。

`tsconfig.tests.json` 继承前者，`outDir .tsbuild`、`noCheck: true`、`declaration: false`、
`include: ["src/*.ts", "src/tests/*.mts"]`。`noCheck` 意味着测试文件的模块解析错误只在
**运行期**暴露——构建 exit 0 不代表测试能加载。

### 6.1 打包

`package.json` 的 `files` 字段决定 npm tarball 内容：

```
lib, cordis.patch.yml, README.md, README.en.md, LICENSE, docs, !docs/plans,
src, !src/tests, tsconfig.json, tsconfig.tests.json
```

没有 `files` 时 `npm pack` 会把 `.superpowers/`、`src/tests`、`docs/plans/` 与
`package-lock.json` 全部打包（实测 65 个文件）。加了之后是 **61** 个（`npm pack --dry-run`
实测），且上述内容均不在其中。注意 `tsconfig.json` 与 `tsconfig.tests.json` **在**
`files` 里、也**确实**在 tarball 里——它们是有意发布的，不要把它们列进"不应含"清单。
改动 `files` 后必须重跑 `npm pack --dry-run` 核对。

## 7. 测试策略

### 7.1 分层

| 层 | 覆盖 | 命令 |
| --- | --- | --- |
| 纯函数单测 | `discovery` / `translate` / `values` / `health` / `serve` / `trust` / `global-rows` / `session` / `notice` / `config-guard` / `session-tag` | `npm test` |
| 装配集成 | `plugin-smoke`（假 ctx，验证注册与清理可逆）、`commands`（注入 `CommandDeps`，验证命令输出）、`mount`（真实 fs + 假 agent ctx，验证挂载路径）、`mount-guard`（真实 fs + 假 mcp-client，验证非法 config 被拦在 `ctx.plugin()` 之前）、`serve-mount`（真实 fs + 假 agent ctx + **真实 spawn**，验证拉起链路） | `npm test` |
| 模块解析 | `profile-modules`（`--profile` 解析、`DSH_HOME` 落点）、`profile-config-contract`（对**已安装的 profile 模块**断言 `Config['~standard']` 契约） | `npm test` |
| 类型 | `tsc --noEmit` | `npm run typecheck` |
| 打包 | tarball 内容 | `npm pack --dry-run` |

### 7.2 测试文件与用例数（当前 262）

| 文件 | 用例 | 覆盖 |
| --- | --- | --- |
| `profile-modules.test.mts` | 5 | `--profile` 标志、Electron 默认 `desktop`、非 Electron 默认 `web`、伪值忽略、`DSH_HOME/profiles/<name>` 落点 |
| `config-guard.test.mts` | 20 | 合法放行且**返回原 config（不是 schema 规范化后的 `value`）**、`value` 缺失时同样返回原配置、非法 `serverName` / 缺失 `command` 的诊断只含字段路径、无 `path` 时的通用摘要、`env` 键名可入诊断、不可信 path 段整条作废（含 `=`、超长、换行、非原始值、symbol）、数组下标合法、段数上限截断、**根级 union 无 `path` 时下钻 union 成员取字段**、成员抛错/返回 thenable 不影响主判定、非 union 不下钻、空 `issues` 视为失败、异步校验拦下、校验抛错只记类型名、非对象结果拦下、schema 缺失放行、`validate` 以 `~standard` 对象为接收者调用、`errorName` 只回类型名 |
| `mount-guard.test.mts` | 4 | **schema 不通过时非法 config 被拦在 `ctx.plugin()` 之前且日志不含敏感值**、**多条非法配置全部拦下**、**被拦下的项不进挂载记账**、**命令层 trust 路径共用同一守卫** |
| `profile-config-contract.test.mts` | 6 | 对**已安装的 profile 模块**断言：`Config` 是带 `~standard` 的 schemastery union、`validate` 同步、合法返回补齐默认值的 `value`、**非法时 `issue.message` 回显整个 config（泄密源）**、`validateMountConfig` 在真实 schema 上放行合法/拦下非法且不泄漏 |
| `discovery.test.mts` | 12 | 向上找最近的 `.git`、无 `.git` 回退 cwd、`absent` / 非法 JSON / 顶层非对象 / `mcpServers` 非对象、缺 `mcpServers` 按空、原文透传用于指纹、**尺寸超限归一为 `invalid`（带尺寸与上限）而不是 `absent`**、**非哨兵异常仍返回 `absent`** |
| `translate.test.mts` | 29 | `normalizeServerName` 六态、`expandVariables` 六态（含原型链）、`translateServer` 的 stdio / http / 别名 / sse / ws / 无 type 有 url / 非对象 / 缺 command / 变量缺失 / env 展开 / 规范名、**`env` 与 `headers` 的 `__proto__` 键保留三态（含展开后落在该键上）**、**`command` / `url` 展开为空串时跳过** |
| `trust.test.mts` | 25 | 指纹稳定性与敏感性（空白、键序、新增条目、`__proto__`、超深嵌套）、读写往返、失败关闭四态、`isApproved` 四态、`approve` / `revoke` 不改入参 |
| `global-rows.test.mts` | 9 | 收集 `mcp-client` 行、忽略非 mcp-client / 缺 `serverName` / 非字符串、`loader` 缺失或形状不符或 `entries()` 抛错时降级空集、嵌套子树 |
| `session.test.mts` | 16 | 无 cwd、子代理判据（`origin` 单条）、**分叉会话（有 `parentSession`、无 `origin`）应当挂载 / 未批准时进入 untrusted**、**两者同时存在时仍跳过**、无文件静默跳过、未信任、已信任、指纹失配、撞名跳过、损坏文件、结构错误、全候选被跳过时不要求批准、规范化去重、未知传输、变量缺失诊断 |
| `plugin-smoke.test.mts` | 6 | `apply` 注册与注销、`agent/created` 监听可逆、`renderNotice` 四态 |
| `commands.test.mts` | 17 | 未批准仍显示诊断、部分批准同时可见、空 `configs` 说明、**"已挂载"取自真实记账（计划要挂但没挂上时不谎报）**、**挂载后文件改动仍按记账呈现**、trust 用计划键、幂等（含回报去重）、未知名字报错、untrust 卸载、**untrust 刷新提示段**、**trust 刷新顺序（落盘→挂载→刷新）**、**写盘失败不刷新**、**无项目根不刷新**、未知子命令、无 agent、**命令声明 `input.hint`（缺它则带参数的行被当成对话发给模型）**、**命令名与描述齐备且符合宿主正则**、**未批准时输出可照抄的下一步命令** |
| `mount.test.mts` | 31 | 未批准不挂载（安全断言）、挂载带 `failOnStartupError: false`、loader 传本体、重复 trust 幂等、插件卸载回收、agent 销毁清理、loader 缺失诊断、commands 缺失诊断、`inject` 声明、**批准后提示段被撤下**、**撤销后提示段刷新为待批准**、**文件消失后提示段撤下**、**会话 B 不谎报已挂载**、**trust 回报实际挂载结果**、**挂载失败日志只记错误类型、不回显展开后的 env 值**、**fiber 启动失败后该名不再出现在"已挂载"里（并留下"已从挂载记账移除"诊断）**、**迟到的 fiber 拒绝不摘掉同名新条目（按身份摘除）**、**过大的 `.mcp.json` 报"过大"而非"没有 `.mcp.json"`，且不进入挂载路径**、**端到端：`env` 的 `__proto__` 键穿过守卫到达 `ctx.plugin()`**、**端到端：`headers` 的 `__proto__` 键穿过守卫到达 `ctx.plugin()`**、**同一 sessionId 的第二个 agent 对象不重复挂载**、**第二个对象发起的 untrust 能卸载第一个对象挂的 fiber**、**第二个对象销毁时回收第一个对象的 fiber**、**第二个对象不重复注入提示段**、**不同 sessionId 各自挂载**、**`agent.id` 缺失或非字符串时不挂载且有诊断（六种非法值）**、**id 不可用时"已挂载"如实为空**、**stdio 命令行带 `--project-mcp-session <sessionId>` 且追加在原有 args 之后**、**两个会话的标记不同**、**http 不追加标记**、**标记只含 SessionId，不带展开后的 env 值** |
| `session-tag.test.mts` | 10 | 标记追加在原有 args 之后、参数名带 `project-mcp` 前缀、不修改入参（含冻结对象）、连续标记两次结果相同（不累积）、`args` 缺失时标记成为唯一参数、`args` 非数组时按缺失处理、`args` 里的非字符串项被剔除、`streamable-http` 原样返回且不凭空多出 `args`、标记只含 SessionId 不带 env 值、保留 config 的其他字段 |
| `serve.test.mts` | 45 | **`planServeStart`**：默认值补齐、`command` / `args` / `env` / `health` 的变量展开、缺 `command`、非字符串 `command`、展开成空串、畸形 `args` / `env`、非对象 `serve`、`health` scheme 白名单（`file:` / `data:` / `ftp:` / 无 `//` 全拒）、`url` 推导失败、非字符串 `health`、`readyTimeoutMs` 非法退回默认（九种非法值）与超上限收敛；**`deriveHealthUrl`**：用 origin 而非替换路径、非 http(s) 与非法 URL 返回 `undefined`；**`isHttpUrl`**：只放行 http(s) 且不被 `http:x` 骗过；**`checkHealth`**：2xx、非 2xx（带状态码）、`ok` 缺失时按状态码、网络错误归一 `network`（不回显消息）、abort 归一 `timeout`、非法 scheme 不发起请求；**`waitReady`**：首次成功不 sleep、轮询到就绪、超时、每轮重读时钟、非法 scheme 不轮询；**`splitServe`**：剥离且不改入参、stdio 原样返回、无 `serve` 返回 `undefined`；**`ensureServeReady`**：健康成功不 spawn、失败 + 有 `serve` spawn 一次且参数一致、失败 + 无 `serve` 不 spawn 记 warn、超时记 warn 不抛、spawn 抛错记 warn、**并发同 url 只 spawn 一次**、不同 url 各启动一次、完成后条目删除、stdio 零额外动作、**展开后的 env 值不入日志**、非法 scheme 不 spawn、推导不出 health 时完全不探测 |
| `serve-mount.test.mts` | 11 | **真实 spawn 拉起服务且 `serve.env` 真的到了子进程**（子进程写标记文件）、**真实 HTTP 健康端点成功时不 spawn**、失败 + 无 `serve` 记 warn 仍挂载、**并发挂载同一 url 只 spawn 一次**（子进程向同一文件追加，数行数）、**`serve` 元数据被剥离绝不交给 `ctx.plugin()`**、**展开后的 `serve.env` 值不出现在任何日志**、**回归：stdio 条目零额外动作**、**回归：stdio 仍追加会话标记**、`serve` 畸形（缺 `command` / `health` scheme 非法）跳过 `serve` 仍挂载、`readyTimeoutMs` 非法退回默认并留诊断 |

### 7.3 Review Focus 的守护位置

规格未逐一钉死的五类输入/失败模式，各自有测试守护：

| 风险 | 守护用例 |
| --- | --- |
| `.mcp.json` 合法 JSON 但结构错误（顶层数组、`mcpServers` 是字符串、条目 `null`） | `discovery.test.mts` 的三条 invalid 用例 + `session.test.mts`「结构错误的 .mcp.json 不抛异常」 |
| `${VAR}` 引用未定义变量，且不泄漏值 | `translate.test.mts`「变量缺失时跳过且只报变量名」+ `session.test.mts`「诊断不含变量值」 |
| 同名服务器同时存在于全局行与 `.mcp.json` | `session.test.mts`「与全局行撞名的服务器被跳过」+ `mount.test.mts`「loader 传的是 Loader 本体」 |
| 信任文件损坏或未知版本 | `trust.test.mts` 四条失败关闭用例 |
| 批准后文件被修改（含 `git pull` 拉入新条目） | `trust.test.mts`「对新增条目敏感」+ `session.test.mts`「指纹不匹配时回到未信任」 |
| 上游给 `Config` 加了必填字段 → 插件产出的配置不再满足 schema | `profile-config-contract.test.mts`（对真实 schema 断言）+ `mount-guard.test.mts`（非法 config 被拦在 `ctx.plugin()` 之前，日志不含展开后的 env 值） |
| `serve` 元数据被误交给 `ctx.plugin()`（它不是 `mcp-client` 的字段） | `serve-mount.test.mts`「`serve` 元数据被剥离」+ `serve.test.mts` 的三条 `splitServe` 用例 |
| 拉起服务时把展开后的 `serve.env` 值写进日志 | `serve.test.mts`「展开后的 env 值不出现在任何日志」+ `serve-mount.test.mts` 的同名端到端用例 |
| 两个会话同时挂载同一 `url` → 拉起两个服务（第二个因端口占用失败） | `serve.test.mts`「并发同 url 只 spawn 一次」+ `serve-mount.test.mts`「并发挂载同一 url 只 spawn 一次」（数子进程写出的行数） |
| `serve.command` 写错 → `spawn` 的 `'error'` 事件带崩宿主 | 由 `spawnDetached` 的 `child.on('error', () => {})` 承担；无自动化守护（需要真实宿主进程），见 §9 |

### 7.3.1 为什么自校验必须在 `mountInto` 里

`ctx.plugin()` 内部先跑 `resolveConfig`（`vendor/cordis/src/fiber.ts:641-644`），失败即抛
`ValidationError`，而 **Cordis 自己在 `_reload` 的 catch 里把该异常整条记进日志**
（同文件 `:659-663`）。schemastery 的 union 错误消息是
`` `expected ${toString()} but got ${JSON.stringify(data)}` ``
（`vendor/schemastery/src/index.ts:834`），会把**整个 config**——含展开后的 `env` /
`headers` 凭据——写进日志。因此：

- 只在插件**自己**的日志点改记 `errorName()` 是不够的，堵不住 Cordis 那一处；
- 唯一根治办法是让非法 config **永远到不了** `ctx.plugin()`：`config-guard.ts` 在挂载前
  用同一份 schema 先校验，不通过就跳过并记一条只含服务器名与字段路径的诊断；
- 守卫放在 `mountInto`（而不是事件回调）里，因为挂载有**两个入口**
  （`agent/created` 与 `/mcp-project trust`），放错位置只堵住一半。

### 7.4 测试夹具手法

- **注入 I/O**：`discovery` / `translate` / `trust` / `session` 的读写与 `exists` 全部由参数
  注入，单测不碰真实文件系统。`health.ts` 把 `fetch` / `sleep` / `now` / `timeoutSignal` 全部
  注入（真实实现见 `index.ts` 的 `serveIo`），因此超时、非法 scheme、轮询这些分支都能确定性
  复现且**不花真实时间**——否则"等满 120 秒"这类用例要么慢到不可接受，要么根本无法构造。
- **假 ctx**：`plugin-smoke.test.mts` 与 `commands.test.mts` 用记录式的假宿主服务，断言
  注册、注销与输出文本。
- **真实 fs + 假 agent ctx**：`mount.test.mts` 用 `mkdtempSync` 建临时项目与临时
  `DSH_HOME`，只把宿主服务与 agent ctx 换成可观测的假实现；`DSH_HOME` 必须在 **import
  被测模块之前**设置——`profile-modules.ts` 在模块顶层就解析并缓存 DSH 运行时模块。
- **真实 spawn + 标记文件**：`serve-mount.test.mts` 用 `process.execPath`（当前 Node）跑一段
  内联 `-e` 脚本，把 `serve.env` 里的探针值写进标记文件后立即退出。这样既能断言"进程真的被
  拉起来了"与"`env` 真的到了子进程"，又不留下常驻进程、不依赖任何外部命令。并发去重的用例
  让子进程往**同一个文件**追加一行，**行的数量就是 spawn 的次数**。
- **`fire` 必须 await**：`agent/created` 的监听器现在是 async（HTTP 条目要先确保服务就绪），
  因此夹具的 `fire` 按 Cordis `serial` 的语义 `await cb(...)`。同步遍历会让断言跑在挂载之前
  ——"未挂载"的断言假性通过，"已挂载"的断言必然失败，两种都是错误的观测。
- **变异测试**：新增守护后用变异验证鉴别力（改回缺陷实现，确认恰好红掉对应用例）。
  `noEmitOnError` 会让编译失败的变异静默跑旧产物，变异后必须确认构建真的产出了新文件。

## 8 验证分层与未验证项

**已由测试与命令覆盖**：上表 262 个用例、`npm run typecheck`、`npm pack --dry-run` 的
tarball 内容。

**未在真实 DSH 运行时验证**（需要真实 profile 与会话，无法在纯单元测试中覆盖）：

- `agent/created` 在 `clear` / `compact` source 下的幂等性；
- 非阻塞挂载下 `ctx.plugin()` 返回的 fiber 在 agent dispose 时是否被正确清理；
- 从 `agent.ctx` 遍历 Loader 树能否拿到完整条目集（scope 继承是否覆盖 root）；
- 首条消息是否真的赶不上工具注册；
- `/mcp-project` 与提示段在真实 GUI 会话中的实际渲染；
- `src/index.ts` 的挂载拒绝处理器对**真实 Cordis fiber** 是否会在
  `failOnStartupError: false` 下以**拒绝**结算：夹具给的是 thenable 桩，`mount.test.mts`
  自造的 fiber 由测试决定何时拒绝；真实 fiber 走 `fiber.await()`
  （`vendor/cordis/src/registry.ts:332-334` 的 `wrapped.then = (onFulfilled, onRejected) => fiber.await().then(...)`），
  而 `failOnStartupError: false` 时 mcp-client 自己**不抛**（`packages/mcp/mcp-client/src/index.ts`
  的 `if (outcome.error !== undefined && config.failOnStartupError)`）——因此"启动失败但
  fiber 并不拒绝"时记账不会被摘除，与 `mount.test.mts` 那条守护的假设不同。属未验证。
- **DSH 退出后被 `serve` 拉起的服务是否存活**：`detached + unref` 能让服务脱离**直接父
  进程**（已用独立脚本实测），但"DSH 进程整体退出"这条只能等真实会话验证——`serve-mount`
  的用例里父进程就是测试进程，且子进程写完标记即退出，不构成证据。
- **真实 MudMCP 的首次建索引耗时**：默认 120 秒的依据是实测"可能超过 90 秒"，但那是在
  本机、本仓库条件下的观测；不同项目/机器上的合适上限可能需要调整（可配）。
- **`agent/created` 的 serial 等待是否真的挡住首条消息**：契约（`runtime-types.ts:257`
  的 "AgentLoop holds queued input until all listeners finish"）与派发点
  （`packages/core/agent/src/index.ts:550` 的 `await this.ctx.serial(...)`）都已核实，但
  "用户实际感受到的等待时长"未经真实会话测量。

Host 半边没有热通道，验证这些需要由使用者重启一次 DSH。**不要在未重启的情况下**用旧
进程的行为推断新构建的行为。

### 8.1 文档与已提交代码的一致性

本文件与 [`behavior.md`](behavior.md) 描述的是 **HEAD 中实际存在的代码**，不是计划或评审
记录里声称的行为。

历史上这里记录过两处"评审记录声称已修复、代码里并不存在"的失配（评审者 A 提出、因分发
失误未落地），**现已补修并有测试守护**：

- 批准后刷新会话提示段：`CommandDeps.refreshNotice` 在 `runTrust` / `runUntrust` 写盘之后
  调用，内部"先撤下、再按 `renderNotice(当前计划)` 重注入或留空"（`index.ts`）；
- "已挂载"一列改读真实挂载记账：`ProjectInspection.mounted` 由 `index.ts` 的
  `AgentRegistrations.servers` 提供，`renderList` 不再取 `plan.configs`。

核对方法：

```powershell
# 刷新必须由命令层调用，而不是只有 agent/created 一处
Select-String -Path src\*.ts -Pattern 'refreshNotice'
# "已挂载"不得退回读计划
Select-String -Path src\commands.ts -Pattern 'plan\.configs'
```

第一条应命中 `commands.ts`（接口 + 两处调用）与 `index.ts`（定义 + 注入）；第二条应**无**
命中。守护用例见 §7.2 的 `commands.test.mts` 与 `mount.test.mts` 行。

### 8.2 诊断：分辨一个 MCP 子进程属于哪个会话

每个 stdio 服务器在命令行末尾带 `--project-mcp-session <SessionId>`（见
[`behavior.md` §10](behavior.md#10-挂载语义) 与 `session-tag.ts`）。同一份 `.mcp.json` 在
多个会话下的 `command` / `args` / `cwd` **逐字相同**，因此这段标记是唯一可区分归属的字段。

```powershell
# 按标记筛选出本插件启动的全部子进程，并列出各自的会话 id
Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'dotnet.exe'" |
  Where-Object { $_.CommandLine -match '--project-mcp-session' } |
  Select-Object ProcessId, ParentProcessId, CommandLine

# 只看标记本身（会话 id 列表）
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match '--project-mcp-session\s+(\S+)' } |
  ForEach-Object { [regex]::Match($_.CommandLine, '--project-mcp-session\s+(\S+)').Groups[1].Value }
```

判定规则：

| 观察 | 含义 |
| --- | --- |
| 同一 `SessionId` 出现**两个**进程，且 `ParentProcessId` 相同、启动时间相近 | 重复挂载（会话被 `agent/created` 报告两次却记了两笔账）——记账键必须按 `agent.id` |
| 进程数 == 不同 `SessionId` 数 | 正常：每会话一份连接与子进程 |
| 有进程但**没有** `--project-mcp-session` | 该进程不是本插件启动的（全局 MCP 行、用户自己起的服务器），或进程起于标记功能之前 |
| 进程的 `cwd` 与会话工作区不符 | 与本插件无关；本插件把 `cwd` 设为会话工作区（`translate.ts` 的 `options.cwd`） |

进程命令行对本机所有用户可见，因此标记**只含 SessionId**：不得把 `.mcp.json` 的内容或
展开后的环境变量值（红线 3）放进任何命令行参数。`mount.test.mts` 的"标记只含 SessionId"
用例守护这一条。

Host 半边没有热通道：标记要进入长跑进程，需要使用者重启一次 DSH。**在重启之前**看到的
命令行没有标记是正常的，不代表功能没实现。

### 8.3 诊断：`serve` 为什么没把服务拉起来

`serve` 的每一步失败都只记日志（会话创建路径不抛异常），因此**排查入口是 DSH 日志**，
不是 `/mcp-project`——后者只回答"现在什么是活的"，而"服务没被拉起"时条目仍会挂载（工具
暂时不可用），列表上看不出异常。

| 日志文本（含） | 含义 | 下一步 |
| --- | --- | --- |
| `serve 配置已被忽略` + 字段名 | `serve` 字段畸形（缺 `command`、`args` / `env` 形状不对、`health` scheme 非法、`url` 推导不出 `health`） | 按日志里的字段名修 `.mcp.json`；改完**必须重新批准**（指纹变了） |
| `serve 配置已被修正` + `readyTimeoutMs` | `readyTimeoutMs` 不是有限正数，或超过 30 分钟上限，已退回默认 120000 / 收敛 | 想用别的值就写一个合法数字；否则无需处理 |
| `…且该条目没有 serve 配置，无法自动拉起服务` | 健康检查失败，且该条目没写 `serve` | 要么手动启服务，要么补上 `serve` |
| `拉起…的服务失败（错误类型：…）` | `spawn` 抛错（命令不存在、权限不足等） | 核对 `command` 是不是绝对路径、能不能在 PATH 上找到；`Error` 的 `code` 不在日志里（红线 3），必要时手动跑一次同样的命令 |
| `已拉起…但等待就绪超过 N 毫秒仍未就绪` | 服务启动了但健康端点没在 `readyTimeoutMs` 内变成 2xx | 确认 `health` 路径对；服务若是首次建索引，调大 `readyTimeoutMs` |
| `确保…的服务就绪时出错（错误类型：…）` | `ensureServeReady` 内部意外抛错（契约漂移的兜底） | 属缺陷，记录错误类型与复现步骤 |

**注意日志里不会有**：`serve.env` 展开后的值、`.mcp.json` 的内容、健康端点的响应体。
因此"服务到底收到了什么环境变量"只能靠**服务自己**的输出（把日志写进文件）确认，本插件
不代传。

诊断命令：

```powershell
# 本插件拉起的服务（`serve` 启动的进程命令行里是 command + args，没有会话标记）
# 判定依据是"父进程已退出"——脱离进程的父进程会变成已退出的那个 PID
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq 'dotnet.exe' -and $_.CommandLine -match 'MudBlazor\.Mcp' } |
  Select-Object ProcessId, ParentProcessId, CreationDate, CommandLine

# 健康端点是否就绪（把端口换成 .mcp.json 里的那个）
try { (Invoke-WebRequest -Uri 'http://127.0.0.1:19701/health/ready' -TimeoutSec 2).StatusCode } catch { $_.Exception.Message }
```

**"等了很久"怎么判断**：默认 `readyTimeoutMs` 是 120 秒，因此"服务没起得来"时首次打开
会话最多卡 2 分钟——这是**预期行为**，不是死锁（会话最终会建起来，只是工具暂时不可用）。
要区分"在等"与"卡死"，看服务进程是否真的在跑（上面第一条命令）以及它的日志：进程在跑
且 CPU 在动 = 在建索引，等就是了；进程不在 = `spawn` 失败或服务立刻退出了，看服务自己的
输出。

## 9. 已知局限（实现层面）

| 局限 | 位置 | 说明 |
| --- | --- | --- |
| `disabled: true` 的全局行仍被计入名单 | `global-rows.ts` | 见 [`behavior.md` 第 8.3 节](behavior.md#83-已知局限-被禁用的全局行仍占名) |
| 模块名精确匹配 | `global-rows.ts` | 行名写成子路径或相对路径时漏检 |
| `readProjectMcpFile` 把任何读错误当作 `absent` | `discovery.ts` | 无法区分 `ENOENT` 与 `EACCES`；方向是 fail-safe |
| 每会话独立连接 | `index.ts` | N 个会话 = N 份连接与子进程 |
| 挂载只发生在会话创建时或本会话批准时 | `index.ts` | 别的会话批准后，本会话的计划已是"已批准"但不会自动挂载；`/mcp-project` 把它列在"已批准但本会话未挂载"下，`/mcp-project trust` 即挂上。这是**如实呈现**，不再是口径错误 |
| 首条消息可能赶不上工具 | `index.ts` | 非阻塞挂载的固有代价。配了 `serve` 的 HTTP 条目是例外：首条消息会等服务就绪（有上限） |
| `findProjectRoot` 不规范化路径 | `discovery.ts` | 同一目录的反斜杠与正斜杠写法在信任存储里是两个键 |
| `runTrust` 在锁外读、锁内写 | `commands.ts` + `index.ts` | 并发批准不同项目理论上会丢更新 |
| `3100` 提示段排序位是复制的字面量 | `index.ts` | 上游改动会静默分叉 |
| `serve` 不检查端口归属、不重试 | `serve.ts` | 端口被别的进程占用时只记日志，由 `mcp-client` 自己连；不猜测、不抢占 |
| `serve` 拉起的进程无法回收 | `serve.ts` | 生命周期归服务自己（设计决策）；插件卸载、DSH 退出都不会 kill 它。服务写错时会留下一个常驻进程，只能手动结束 |
| `spawnDetached` 的 `'error'` 事件被吞掉 | `serve.ts` | 异步事件，而该函数是同步的、没有 logger；写错的 `command` 只在后续"等待就绪超时"里间接可见 |
| 健康检查只认 2xx | `health.ts` | 3xx（含重定向）算未就绪；`redirect: 'error'` 刻意不跟随——跟随会打到没打算探测的地址 |
