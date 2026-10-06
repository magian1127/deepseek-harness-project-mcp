# 设计：MCP 挂载模式（会话级 / 工作区级）

状态：**待用户确认**（控制器已实测验证核心机制）
日期：2026-10-06
前置：`docs/design.md`（本插件总设计）、`docs/behavior.md`（用户可见行为）

## 1 要解决的问题

当前实现是**每会话一份 MCP 连接**（挂载点 `agent.ctx`）。实测代价：

| 场景 | 连接数 | 内存 |
| --- | --- | --- |
| 1 个会话 | 1 | ~73 MB |
| 5 个会话 | 5 | ~365 MB |

而 DSH 的 WebUI **没有"关闭会话"**——左侧列表点开任意会话就会触发 `promote` → `resume` → `agent/created` → 拉起一份 MCP。用户实测：浏览几个会话就积累 4-5 个进程、300+ MB。

**用户要求**：新增一种"**每工作区一份**"模式——同一工作区的多个会话共享一个 MCP 连接；首次打开该工作区的会话（或新建会话）时启动。

**同时要求保留**：现有的"每会话一份"模式，作为可选（"万一有些时候我需要按照会话启用的功能"）。

## 2 核心机制（已实测验证）

### 2.1 可行路径：全局挂一份 + 按 agent `restrict` 过滤

```
全局层（ctx.root）：挂一份 MCP → 工具注册进全局层
                     mcp__projA__tool1, mcp__projA__tool2, mcp__projB__tool1
                              ↓ 继承
agentA（cwd=A）: restrict → 只见 mcp__projA__*
agentB（cwd=B）: restrict → 只见 mcp__projB__*
```

**实测结果**（控制器验证，非推断）：
```
agentA 可见: ["mcp__projA__tool1","mcp__projA__tool2"]   ✅
agentB 可见: ["mcp__projB__tool1"]                        ✅
```

**依据**：`packages/core/tools/src/index.ts:1163` 原文——
> A restriction filters what a scope inherits — the global layer and every ancestor layer on its chain — and never what its OWN layer registers.

### 2.2 `restrict` 的正确用法（踩坑记录，务必照做）

来源：生产代码 `packages/experimental/browser-use-runtime/src/mcp.ts:114-117`。

```js
// 1) 用【外层 ctx】建 scope，不是插件的 inner ctx
const scope = createScope(ctx, agent)

// 2) 必须在【带 inject: ['tools'] 的作用域内】调用，否则抛
//    `cannot get property "tools" without inject`
await ctx.plugin(Object.assign(inner => { scope = createScope(inner, agent) }, { inject: ['tools'] }))

// 3) restrict 必须在 scoped context 上；全局 ctx 调用会抛
//    `tools.restrict() requires a scoped context (agent.ctx)`
scope.ctx.tools.restrict({ deny: [...] })

// 4) 查询用 agent 对象，不是 scope.ctx
tools.schemas(agent)
```

**约束**：`restrict` 的 `allow`/`deny` 只能命名**已注册**的工具名，未知名抛错（`packages/core/tools/src/index.ts:1114-1118`）。

### 2.3 因此用 `deny` 而非 `allow`

MCP 工具是**异步注册**的（连接建立 + 工具发现之后才有），挂载时**还不知道**会有哪些名字。所以：

- ❌ `allow: [自己的工具名]` —— 挂载时不知道
- ✅ `deny: [其他工作区的 mcp__<server>__*]` —— 只需知道**别的**工作区有什么

**deny 列表的构造**：对所有**其他**已挂载工作区的 `serverName`，deny 其 `mcp__<serverName>__*` 命名空间。工具名有稳定前缀 `mcp__<serverName>__`（`packages/mcp/mcp-client/src/tools.ts:8`）。

## 3 配置

新增 `Config`：

```yaml
- id: dsh-project-mcp
  name: deepseek-harness-project-mcp
  config:
    mode: session      # session（默认）| workspace
```

| 值 | 行为 |
| --- | --- |
| `session`（默认） | 现状不变：每会话一份连接，挂 `agent.ctx` |
| `workspace` | 每工作区一份连接，挂全局层 + 每 agent `restrict` |

**默认必须是 `session`** —— 不改变现有用户的行为。

### 3.1 Config 的实现方式

当前 `export const Config = undefined`（本插件无配置）。加配置需引入 schemastery，但**红线 1 禁止把 `@deepseek-ai/*` 写进 dependencies**。

**做法照抄 hashline**（`deepseek-harness-hashline/src/index.ts:86-90`）：

```js
// src/profile-modules.ts 新增
const schemasteryState = { cache: undefined, failed: false }
await importFromProfile('@deepseek-ai/schemastery', schemasteryState)
export function loadSchemastery() { return loadFromProfile('@deepseek-ai/schemastery', schemasteryState) }

// src/index.ts
const schemaFactory = loadSchemastery()
export const Config = schemaFactory === null ? undefined : schemaFactory.object({
  mode: schemaFactory.union(['session', 'workspace']).default('session'),
})
```

**为什么必须允许 `undefined` 回退**：宿主 `settings` 的 `'toJSON' in schema` 检查对 `undefined` 短路、对 `null` 抛（`packages/settings/settings/src/index.ts:427`）。profile 无 schemastery 时（脱离 profile 的环境）降级为"无配置"，`apply` 用默认值。

## 4 工作区级模式的实现

### 4.1 连接记账

```ts
interface WorkspaceConnection {
  projectRoot: string
  servers: Map<string, PluginFiberShape>   // serverName → fiber
  scopes: Map<AgentKey, Scope>             // 已 restrict 的 agent scope
  users: Set<AgentKey>                     // 正在使用该连接的会话
}
const workspaces = new Map<string, WorkspaceConnection>()   // key = projectRoot
```

### 4.2 挂载流程（`agent/created`）

```
1. 算出该会话的 projectRoot（复用 findProjectRoot）
2. workspaces.get(projectRoot)
   - 不存在 → 挂载：对每个已批准 config 调 ctx.plugin(McpClient, withSessionTag(cfg, key))
             （挂在外层 ctx = 全局层）
   - 存在   → 复用，不重复挂
3. users.add(agentKey)
4. 对该 agent 建 scope 并 restrict：
   - deny 所有【其他】工作区的 mcp__<server>__ 命名空间
   - 注意：MCP 工具异步注册，需在工具出现后补一次 restrict（见 4.4）
5. 注入会话提示段（与 session 模式相同）
```

### 4.3 回收（工作区级）

当某工作区的 `users` 变空（所有会话都被回收或销毁）→ dispose 该工作区的全部 fiber + scope，从 `workspaces` 删除。

**触发时机**：`agent/disposed`、惰性检查（用户此前要求的回收策略）、插件卸载。

### 4.4 restrict 的时序（用户推断已验证，方案因此简化）

**关键发现（由用户推断，控制器已核实）**：`agent/created` 是 **`serial` 模式且被 `await`**：

```js
// packages/core/agent/src/index.ts:550
await this.ctx.serial(entry.carrier, 'agent/created', { agent, source, signal })
```

且契约明确（`packages/core/agent/src/runtime-types.ts:257`）：
> **AgentLoop holds queued input until all listeners finish.**

**因此 `workspace` 模式可以在 `agent/created` 里 await 连接完成** —— 用户的输入会等到监听器结束，MCP 工具在首次请求前就已注册完毕，`restrict` 可以**一次性精确完成**。

**这消除了原本设计里的"两步 restrict"**（先 deny 已知前缀、工具注册后再补一次）。

### 4.5 等待策略：await + 10s 超时

`workspace` 模式必须等工具名才能 restrict，因此**必须 await**（与 `session` 模式的"不 await"刻意不同）：

| 模式 | 挂载时机 | 理由 |
| --- | --- | --- |
| `session`（默认） | **不 await**（保持现状） | 会话秒开优先；用户已接受"首条消息可能赶不上" |
| `workspace` | **await，10s 超时** | 必须拿到工具名才能 restrict |

**超时后的降级**：**不 restrict + 记 warn**（而非拒绝挂载）。理由：用户已经等了 10 秒，此时拒绝挂载等于白等；"临时全可见"至少能用，且 warn 可查。

超时值做成常量并写清理由（10s 是"用户可接受的等待"与"MCP 冷启动可能耗时"之间的折中；MudBlazor 实测 249ms，但 `npx` 类首次下载可能数十秒）。


## 5 两种模式的差异对照

| 维度 | `session`（现状） | `workspace`（新） |
| --- | --- | --- |
| 挂载点 | `agent.ctx` | 外层 ctx（全局层） |
| 连接数 | = 会话数 | = 活跃工作区数 |
| 工具可见性 | 天然隔离 | 靠 `restrict` 过滤 |
| 连接生命周期 | 随会话 | 随工作区（所有使用者消失才回收） |
| 会话标记 | `--project-mcp-session <id>` | 建议 `--project-mcp-workspace <root>`（连接归属变了，标记应反映真实归属） |
| 风险 | 低（现有实现） | 中（restrict 时序、跨会话共享的连接故障影响面更大） |

## 6 风险与降级

| 风险 | 处理 |
| --- | --- |
| `restrict` 时序没赶上（工具已注册但未过滤） | **安全侧**：宁可多显示（临时）也不误删。在 `pre-step` 补一次 |
| `createScope` 失败 | 降级为不 restrict（工具全可见）并记 warn；或降级回 session 模式（待定） |
| `schemastery` 解析失败 | `Config = undefined`，`mode` 取默认 `session` |
| 共享连接被某会话的错误配置搞崩 | 该工作区所有会话失去工具 —— **这是 workspace 模式的固有风险**，需在文档明示 |
| `restrict` 的 deny 列表与其他工作区耦合 | 新工作区挂载时，**已存在的** agent scope 需要补 deny 新工作区的前缀（否则会看到新工作区的工具） |

**最后一条容易被忽略**：工作区 B 挂载后，已存在的 agentA 的 restrict 列表**不含** B 的前缀 → A 会看到 B 的工具。所以挂载新工作区时，必须**回填所有现存 agent 的 restrict**。

## 7 测试矩阵

| 用例 | 断言 |
| --- | --- |
| `mode: session` | 行为与现状完全一致（回归） |
| `mode: workspace`，两个工作区各一个会话 | 只挂 2 份连接；各自只见自己的工具 |
| `mode: workspace`，同一工作区 3 个会话 | 只挂 **1** 份连接；3 个会话都只见该工作区的工具 |
| 工作区 B 后挂载 | agentA 的可见工具**不含** B 的（回填 restrict） |
| 某工作区所有会话销毁 | 该工作区连接被回收 |
| `restrict` 抛错（工具未注册） | 降级 + 记 warn，不中断会话创建 |
| `Config` 缺失 / schemastery 不可用 | 默认 `session`，不抛 |
| deny 列表正确性 | 只 deny 其他工作区的前缀，不误伤自己的 |

## 8 已确认的决策（用户确认于 2026-10-06）

| # | 决策 | 用户选择 |
| --- | --- | --- |
| 1 | 默认模式 | **保持 `session`**（不改变现有行为） |
| 2 | `workspace` 模式的子进程标记 | **改用 `--project-mcp-workspace <projectRoot>`**（反映真实归属，避免排查时困惑） |
| 3 | 等待策略与降级 | **await + 10s 超时**；超时后**不 restrict + 记 warn**（用户推断 `agent/created` 可 await，控制器已核实成立，方案因此简化——不再需要两步 restrict） |

## 9 不在本次范围

- DSH 无原生"工作区作用域"（workspace 是 UI 分组实体）——本方案是**在插件内模拟**，不改 DSH。
- 惰性回收 + 上限 8（用户此前的要求）——独立特性，可与本设计并存。

