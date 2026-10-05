# deepseek-harness-project-mcp 设计

**状态**：设计已批准，待实现计划
**日期**：2026-10-06
**目标 DSH 版本**：0.2.1-alpha.1（源码核对基线）

## 1. 目标

让项目根目录的 `.mcp.json` 决定**该项目下的会话启用哪些 MCP 服务器**，并且**不启用的服务器完全不建立连接、不启动子进程**。

成功标准：

- 在含 `.mcp.json` 的项目里新建会话，已批准服务器自动可用；未批准的一个都不连。
- 未启用的服务器不 spawn 任何进程，不发起任何网络连接。
- 克隆一个陌生仓库并打开它，**不会**自动执行其中的命令。
- 项目内文件无法自我批准。

## 2. 非目标

明确不做（YAGNI）：

- 不支持 `ws` / `sse` 传输（见 §6）。
- 不做 OAuth 流程。
- 不做 GUI 面板，只做斜杠命令。
- 不接管 profile 里的全局 MCP 行（见 §8）。
- 不做按服务器的细粒度开关（只做整文件批准与按名批准两档）。
- 不做 `.mcp.json` 的写入或管理（只读）。

## 3. 背景：为什么必须这么做

### 3.1 约束来源

DSH 的 MCP 配置作用域是 **profile（进程级）**。profile 补丁有四层，全部与工作区无关：

1. `dsh.profile.bundles` 各 bundle 的 patch
2. profile 自己的 `cordis.patch.yml`
3. home 级 `$DSH_HOME/cordis.patch.yml`
4. `--patch` 覆盖层

没有 `.mcp.json`、项目级插件发现，或"工作区 → 插件行"的通道。

### 3.2 为什么"会话级拦截"能阻止连接

`@deepseek-ai/dsh-mcp-client` 的 `apply` 在行挂载时 `await connection.ready`（`packages/mcp/mcp-client/src/index.ts:199`）。因此：

- **放在 profile 补丁里** = 进程启动即连接、即 spawn 子进程，那时还没有任何会话。
- **由插件挂进 agent scope** = 会话创建时才连接。

这是本插件能成立的全部依据。ACP（`packages/acp/acp/src/session.ts:135`）与浏览器 MCP（`packages/experimental/browser-use-runtime/src/mcp.ts:144`）走的都是后者，本插件沿用同一路径。

### 3.3 方案选择

考虑过两个方案：

- **方案 A（采纳）**：profile 保留全局 MCP 行；`.mcp.json` 管项目专属；插件只挂载项目级的。
- **方案 B（否决）**：profile 零 MCP 行，插件接管全部。语义更统一，但每个会话都要为全局服务器建独立连接与子进程（N 会话 = N 份），且需迁移现有配置。

选 A：全局服务器本就是"永远想要"的，不值得为它付出 N 份连接；"阻止连接"精确作用于需要控制的那部分。

## 4. 架构

新独立插件包，与工作区现有五个项目平级。

| 项 | 值 |
| --- | --- |
| 目录 | `deepseek-harness-project-mcp/` |
| npm 包名 | `deepseek-harness-project-mcp` |
| Cordis 插件名 | `project-mcp` |
| Loader 行 id | `dsh-project-mcp` |
| Node 要求 | `^22.19.0 \|\| >=24.0.0`（与工作区其余项目一致） |

### 4.1 模块

```
src/
  index.ts            插件 apply + Config schema + 装配
  types.ts            宿主服务的最小鸭子类型（不 import @deepseek-ai/*）
  profile-modules.ts  从 profile 解析并预载 DSH 运行时模块（§4.2）
  discovery.ts        项目根发现、.mcp.json 读取与解析
  translate.ts        .mcp.json 条目 → McpClient.Config
  trust.ts            信任存储读写（原子写 + 文件锁）
  session.ts          agent/created 钩子：解析 → 查信任 → 挂载
  commands.ts         /mcp-project 斜杠命令
  notice.ts           未信任 / 跳过原因的系统提示注入
```

`apply` 只做三件事：注册命令、订阅 `agent/created`、注册系统提示段。**它自己不连接任何 MCP，也不缓存全局名单**（§8.1）。

### 4.2 依赖策略：不把 `@deepseek-ai/*` 写进依赖

**这是本工作区的硬约定**，对齐 `deepseek-harness-hashline` 的 `src/profile-modules.ts`：

DSH 运行时模块（`@deepseek-ai/dsh-*`、`@deepseek-ai/schemastery`）**不写入本包 `dependencies`**，而是在运行时从当前 profile 的模块解析上下文加载。理由：

1. 保证与主进程**同一模块实例**——`HarnessError`、schemastery 等类型的 `instanceof` 判定依赖同一性；
2. `link:` 与 `file:` 两种安装方式走同一条路径；
3. 避免 peer 声明被宿主 preflight 按 semver 拒绝（`docs/known-runtime-drift.md` 记录：0.1.7-rc.1 起精确版本清单会被拒）。

加载契约（DSH 0.1.7-rc 起，见 hashline `docs/development.md#peer-解析`）：宿主组合批次经模块 hooks 管线并行动态 import；插件在同步求值里 `require(esm)` 会撞 Node 的 "not yet fully loaded"。因此必须：

- 模块顶层用 `require.resolve` **只解析**（不求值、无竞态）
- 读目标包 `exports` 取 `import` 条目
- 以文件 URL **异步 import 预载**（顶层 await）
- 预载失败后才走同步 `require` 兜底（脱离 profile 的测试/CLI 环境），再失败即永久降级

### 4.3 需要的运行时模块与获取方式

| 需求 | 获取方式 |
| --- | --- |
| 挂载 MCP 插件 | **profile 解析** `@deepseek-ai/dsh-mcp-client`（必须真模块，`ctx.plugin()` 需要插件本体） |
| 原子写 + 文件锁 | **profile 解析** `@deepseek-ai/dsh-atomic-write`；失败则降级为自实现的临时文件 + rename |
| 项目根发现 | **自实现**（向上找 `.git`，约 10 行）；不依赖 `skill-filesystem` 内部函数 |
| 命令注册 | **鸭子类型**（`ctx.get('commands')`），形状见 `src/types.ts` |
| 系统提示注入 | **鸭子类型**（`ctx.get('systemPrompt')`） |
| 遍历 Loader 树 | **鸭子类型**（`ctx.get('loader')`） |

降级原则（对齐 hashline）：运行时模块加载失败时**降级而非启动失败**，并记一条警告。MCP 挂载无法降级——拿不到 `mcp-client` 时本插件功能整体不可用，此时记错误并保持静默不挂载（安全侧：宁可不挂，不可错挂）。

## 5. 会话创建数据流

```
agent/created（串行事件，在排队输入运行前完成）
  │
  ├─ 子代理？ header.origin === 'subagent' → 跳过（§9）
  │
  ├─ cwd = agent.session.header.cwd
  │    undefined → 跳过（无工作区无法定位项目）
  │
  ├─ projectRoot = 从 cwd 向上找第一个含 .git 的目录
  │    走到根都没有 → 用 cwd 本身（与 skill-filesystem 同语义）
  │
  ├─ <projectRoot>/.mcp.json
  │    不存在 → 静默跳过（不打扰）
  │    解析失败 → 记日志 + 提示，不挂载
  │
  ├─ fingerprint = sha256(规范化 JSON)
  │
  ├─ 信任存储查 (projectRoot, fingerprint)
  │    ├─ 匹配 → 逐个翻译并挂载（不 await，§5.1）
  │    └─ 不匹配 → 不挂载 + 注入提示（§7）
  │
  └─ 挂载前逐条检查：
       ├─ serverName 与全局行撞名 → 跳过 + 报告（§8）
       ├─ 传输不受支持 → 跳过 + 警告（§6）
       └─ ${VAR} 未定义 → 跳过 + 警告（§10）
```

### 5.1 非阻塞挂载

`agent.ctx.plugin(McpClient, cfg)` 后立即返回，**不 await 连接**。

理由：用户要"会话秒开"。代价是首条消息可能赶在工具注册前，模型当轮看不到这些工具。

安全性：MCP 工具注册时 `ScopedLayers` 的 mutation 回调会 `ctx.emit('tools/change')`（`packages/core/tools/src/index.ts:835`），模型下一轮即可见。

必须设 `failOnStartupError: false`：坏服务器只记日志，不影响会话创建。这与 ACP 的 `failOnStartupError: true` 相反——ACP 要工具必定就位，本插件要会话必定成功。

**偏离先例的说明**：ACP 与浏览器 MCP 都 `await` 挂载。本插件刻意不 await，是有意取舍，不是疏漏。

## 6. `.mcp.json` 翻译规则

输入是 Claude Code 约定格式（[官方文档](https://code.claude.com/docs/en/mcp)）：

```json
{
  "mcpServers": {
    "<name>": { ... }
  }
}
```

| 输入形状 | 输出 | 备注 |
| --- | --- | --- |
| `{command, args?, env?}` | `transport: 'stdio'` | `cwd` = 会话工作区（`session.header.cwd`） |
| `{type: 'http'\|'streamable-http', url, headers?}` | `transport: 'streamable-http'` | `http` 是 `streamable-http` 的别名 |
| `{type: 'sse', url}` | **跳过 + 警告** | DSH 不支持，见下 |
| `{type: 'ws', url}` | **跳过 + 警告** | DSH 不支持 |
| `{url}` 无 `type` | **跳过 + 警告** | 会被误读为 stdio（Claude Code 亦然） |
| `{type: 'sdk'}` | 跳过 + 警告 | 仅 SDK 宿主可注册 |

### 6.1 为什么 SSE 不支持

MCP TypeScript SDK 2.0 确实导出 `SSEClientTransport`（已标记 deprecated），但 DSH 的 `createTransport` 是封闭 switch，只有两个分支：

```ts
// packages/mcp/mcp-client/src/transport.ts:31-46
export function createTransport(config: Config): Transport {
  switch (config.transport) {
    case 'stdio': ...
    case 'streamable-http': ...
  }
}
```

支持 SSE 必须改 DSH 源码，超出"只加插件"的范围。实际影响很小：SSE 已被 MCP 规范废弃，主流服务器都支持 `streamable-http`。

### 6.2 serverName 规范化

`Config.serverName` 必须匹配 `/^[A-Za-z0-9_-]{1,32}$/` 且在注册 scope 内唯一（`packages/mcp/mcp-client/src/index.ts:40`）。`.mcp.json` 的键允许其他字符。

规则（对齐 ACP 的 `normalizeServerName`）：

1. 已匹配 → 原样使用。
2. 不匹配 → NFKD 规范化 → 非 `[A-Za-z0-9_-]` 替换为 `_` → 去首尾 `_` → 截断 20 字符 → 追加 `_` + sha256 前 8 位。
3. 规范化后仍空 → 用 `server`。
4. 同一文件内规范化后重名 → 后者跳过 + 警告。

重命名必须在 `/mcp-project` 中明确显示原名与规范名，因为工具名会变成 `mcp__<规范化名>__<tool>`。

## 7. 信任模型

### 7.1 存储

`$DSH_HOME/project-mcp-trust.json`，权限 `0600`，原子写 + 文件锁（复用 `@deepseek-ai/dsh-atomic-write`）。

```json
{
  "version": 1,
  "projects": {
    "/abs/path/to/project": {
      "approvedAt": "2026-10-06T12:00:00.000Z",
      "fingerprint": "sha256:<hex>",
      "servers": ["github", "memory"]
    }
  }
}
```

`servers` 记录批准时该指纹下**实际存在且被批准**的服务器名。挂载时取批准列表与当前文件列表的交集。

### 7.2 指纹是安全属性

批准绑定到 `.mcp.json` 的**确切内容**（规范化 JSON 的 sha256）。文件任何改动 → 指纹不匹配 → 重新批准。

没有指纹，"批准一次"就会永久授权该路径下未来的任何内容——包括后续 `git pull` 拉进来的恶意条目。

规范化：解析后按 key 排序递归序列化，剔除纯格式差异（空白、键序）。

### 7.3 仓库无法自我批准

信任存储只存在于 `$DSH_HOME`，项目内没有任何可写入的批准通道。这与 Claude Code 的 workspace trust 语义一致（[文档](https://code.claude.com/docs/en/mcp)：*"A cloned repository can't approve its own servers"*）。

### 7.4 失败关闭

信任文件缺失、损坏、或版本不认识 → 视为**全部未信任**，不阻止 DSH 启动，记一条警告。

## 8. 全局服务器撞名

### 8.1 检测

遍历 Loader 树（`ctx.get('loader')`）收集所有 `@deepseek-ai/dsh-mcp-client` 行的 `config.serverName`，得到全局名单。

**时机**：在 `agent/created` 处理时**按需读取**，不缓存、不订阅。

理由：Loader 没有通用的条目变更事件——只有 `loader/entry-init`（条目创建时）和 `loader/partial-dispose`（条目移除时），没有覆盖"已有条目改配置"的事件（`vendor/loader/src/config/entry.ts:60,152`）。缓存名单会在 HMR 改配置后失效。按需遍历的代价很低（条目数量级为几十），换来的是始终正确。

HMR 重载本插件自身时，`apply` 重新执行，名单自然重建。

### 8.2 处理：跳过

`.mcp.json` 里的服务器若与全局名单撞名 → **不挂载**，并在 `/mcp-project` 中报告"已被全局配置提供，跳过"。

为什么不警告后仍挂载：agent 作用域的同名服务器会**静默遮蔽**全局的（`serverName` 唯一性按 scope 隔离，`packages/mcp/mcp-client/src/index.ts:162-176`），且会额外 spawn 一个子进程。跳过比遮蔽更符合"全局有的本地就不要启动了"。

## 9. 子代理

`agent/created` 的 `source` 参数只有 `'startup' | 'resume' | 'clear' | 'compact'`，**不区分主会话与子代理**。

子代理靠 session header 判断（仓库既有做法，`packages/subagent/subagent/src/archive-admission.ts:52-53`）：

```ts
const { parentSession, origin } = agent.session.header
if (parentSession !== undefined || origin === 'subagent') → 跳过
```

理由：子代理与父会话共享工作区，重复建连接与子进程没有意义。

## 10. 环境变量展开与凭据

`.mcp.json` 的 `command`、`args`、`env`、`url`、`headers` 支持 `${VAR}` 与 `${VAR:-default}` 展开。

**安全规则**：

- 展开值**永不**写入日志、错误消息、会话记录或任何持久化产物。只记变量名。
- 变量未定义且无默认值 → **跳过该服务器 + 警告**（记变量名，不记值）。
  理由：带未展开的 `${VAR}` 字面量启动，几乎必然导致服务器认证失败，且错误难以理解。
- **空串是已定义的值**：`${VAR:-default}` 在 `VAR=''` 时取空串，**不**取 default。这与 bash 的 `${VAR-default}`（不带冒号）一致，与 `${VAR:-default}`（带冒号，空串也取 default）不同。
  理由：判定条件是 `env[VAR] === undefined`，与"未定义"的字面语义一致；且空串往往是用户显式设置的结果，静默替换成 default 会掩盖配置意图。
- 展开在内存中进行，不落盘。

## 11. 命令

命令名必须匹配 `/^[a-z][a-z0-9_-]*$/u`（`packages/interaction/commands/src/index.ts:32`）。全局注册，通过 `invocation.agent` 定位会话。

| 命令 | 行为 |
| --- | --- |
| `/mcp-project` | 列出当前项目的服务器、信任状态、跳过原因（撞名/传输不支持/变量缺失） |
| `/mcp-project trust` | 批准整个文件（记指纹），**立即挂进当前会话** |
| `/mcp-project trust <name>…` | 只批准指定服务器 |
| `/mcp-project untrust` | 撤销并卸载当前会话已挂载的 |

### 11.1 为什么批准必须走命令

`ctx.approval` 只在 turn 内可用（`packages/interaction/user-approval/src/index.ts:219` 会抛 `approval.request() outside an open turn`），而会话创建时没有 open turn。所以**无法**在会话创建时弹窗确认；只能"不挂载 + 告知"，批准动作发生在 turn 内。

### 11.2 批准后立即生效

`trust` 批准后，把 MCP 挂进当前 agent scope，无需重开会话。技术上与 preset 切换同类（`ctx.plugin()` 进 agent scope）。

## 12. 错误处理

| 情形 | 行为 |
| --- | --- |
| 无 `.mcp.json` | 静默跳过 |
| `.mcp.json` 解析失败 | 记日志 + 提示，不挂载 |
| `mcpServers` 缺失或非对象 | 视为空，记警告 |
| 单条服务器配置非法 | 跳过该条 + 警告，其余照常 |
| 信任文件损坏 | 全部未信任 + 警告 |
| MCP 连接失败 | 记日志（`failOnStartupError: false`），不影响会话 |
| profile 仍有 MCP 行 | 启动警告：这些不受本插件管辖，会在进程启动时连接 |

最后一条是**能力边界**：插件能检测到全局行并警告，但**无法阻止它们连接**——它们挂载得比赛会创建早得多。

## 13. 测试

### 13.1 单元

- 项目根向上查找（含无 `.git` 回退）
- `.mcp.json` 解析：合法、非法 JSON、缺 `mcpServers`、非对象
- 传输翻译映射（stdio / http / streamable-http / 跳过项）
- serverName 规范化：已合法、需 slug、需哈希、空名、重名
- `${VAR}` / `${VAR:-default}` 展开；未定义变量
- 指纹计算：键序与空白不改变指纹；内容改变则改变
- 信任存储：读、写、损坏恢复、版本不认识

### 13.2 集成（真实 Loader）

用仓库现成的 fixture MCP 服务器（`packages/mcp/mcp-client/tests/fixture-server.ts`）：

- 创建带 cwd 的 agent，断言 `mcp__<name>__<tool>` 出现 / 不出现
- 批准路径：批准 → 挂载；改文件 → 不挂载；撤销 → 卸载
- 撞名：全局行存在时，同名项目服务器不挂载
- 子代理：子代理不重复挂载

### 13.3 非阻塞

用故意慢的 fixture 服务器，断言会话创建先于连接返回。

### 13.4 安全

- 展开值不出现在日志 / 错误 / 会话记录中
- 未批准时不 spawn 任何进程（断言无子进程）

## 14. 风险与未决

| 风险 | 说明 |
| --- | --- |
| 首条消息可能赶不上工具 | 非阻塞挂载的固有代价；若实测干扰大，改为可配置的等待上限 |
| 每会话独立连接 | 项目级服务器在 N 个会话下 = N 份连接/子进程；可接受但需在文档说明 |
| 全局行检测依赖 Loader 树 | 若 Loader 树结构变化需同步；有测试守护 |
| `clear` / `compact` 的 source | 这两个 source 下是否会重复挂载，实现时需实测确认 |
| 同一会话多次批准 | `trust` 可重复调用；需保证幂等，不重复挂载同一 serverName |
| 项目内 MCP 服务器仍是沙箱外代码 | 用户批准后才执行，但执行本身不受 agent 沙箱约束（与全局行同性质） |

## 15. 待实现时验证

- [ ] `agent/created` 在 `clear` / `compact` source 下的行为，是否需要幂等保护
- [ ] 非阻塞挂载下 `ctx.plugin()` 返回的 fiber 在 agent dispose 时是否正确清理
- [ ] 已发布 agent 上重复 `ctx.plugin()` 同一 `serverName` 的报错路径（`trust` 幂等性依赖此行为）
- [ ] 从 `agent.ctx` 遍历 Loader 树能否拿到完整条目集（scope 继承是否覆盖 root）
- [ ] 规范化 JSON 的指纹算法与跨平台行尾差异

## 16. 文档计划

按工作区约定：

- `README.md` + `README.en.md`：用户行为与安装
- `docs/behavior.md`：`.mcp.json` 语义、信任模型、命令
- `docs/design.md`：本文
- `docs/development.md`：源码地图、测试、构建
- `docs/troubleshooting.md`：常见故障
- `AGENTS.md`：红线与本地验证命令（≤200 行）

## 17. 参考

外部来源：

- [Claude Code MCP 文档](https://code.claude.com/docs/en/mcp) — `.mcp.json` 格式与信任模型约定。

DSH 源码（本文所有路径均相对 DSH checkout 根目录，见工作区 `AGENTS.local.md`）：

- `docs/subsystems/mcp.md` — MCP 子系统总览与配置作用域
- `packages/mcp/mcp-client/src/index.ts` — `Config` schema、`serverName` 约束、挂载即连接
- `packages/mcp/mcp-client/src/transport.ts` — 传输工厂（SSE 不支持的依据）
- `packages/acp/acp/src/mcp.ts` — ACP 的 per-session 挂载与 `serverName` 规范化先例
- `packages/experimental/browser-use-runtime/src/mcp.ts` — 会话级挂载的另一个先例
- `packages/hooks/hooks-claude-code/src/index.ts` — `CLAUDE_PROJECT_DIR` 的既有用法
- `packages/subagent/subagent/src/archive-admission.ts` — 子代理识别（`origin` / `parentSession`）
- `packages/core/tools/src/index.ts` — `tools/change` 发射点、`restrict()` 语义

工作区共享规则见根目录 `AGENTS.md` 的文档索引表。
