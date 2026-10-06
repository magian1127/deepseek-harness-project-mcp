# 设计：HTTP 模式的按需拉起服务（`serve` 字段）

状态：**设计完成，待实现**（核心机制已实测验证）
日期：2026-10-06
前置：[`design.md`](design.md)（本插件总设计）、[`behavior.md`](behavior.md)（用户可见行为）
相关：[`design-workspace-mode.md`](design-workspace-mode.md)（另一个暂缓的设计）

## 1 要解决的问题

### 1.1 stdio 模式的内存代价

当前实现用 stdio：**每个会话 spawn 一个 MCP 子进程**，实测每进程约 **73 MB**。而 DSH 的 WebUI 没有"关闭会话"——点开任意会话就触发 `agent/created` → 挂载 → spawn。浏览几个会话就积累数百 MB，且 **DSH 不会自动回收**（agent 只在 owner unload 时销毁，Host 侧无空闲检测）。

### 1.2 惰性回收被否决（缓存理由）

曾实现的"惰性回收 + 上限"（提交 `83350dc`）被用户否决，理由是**会破坏缓存命中**。该理由**已核实成立**：

- DSH 明确用 **prefix reuse** 优化缓存（`packages/core/session/src/tool-history.ts:30-31`：*"A retained name cannot acquire a different definition without losing prefix reuse"*）
- 回收走 `fiber.dispose()` 会**真正注销工具**（`tools.ts:146` → `connection.ts:405` → `tools/index.ts:1061` 的 `@returns the exact disposer that unregisters the tool`）
- 工具列表变化 → `request/header` 记 `'change'` → **前缀复用断裂**，且每次回收+重挂都断一次

**所以需要一个"不改变工具列表"的内存方案。**

### 1.3 HTTP 模式的关键优势

HTTP 模式下 DSH **不 spawn 子进程**（`packages/mcp/mcp-client/src/transport.ts:40-44` 只 new 一个 `StreamableHTTPClientTransport`），服务由外部启动：

| 维度 | stdio | HTTP |
| --- | --- | --- |
| 进程归属 | DSH spawn | **外部启动** |
| N 会话的进程数 | N | **1**（共享） |
| 服务退出时工具列表 | 重连预算内保留、超限注销 | **同样保留**（`connection.ts:225-234`：只有 `failedAttempts > policy.maxAttempts` 才 dispose） |
| 破坏前缀复用 | 回收时会 | **不会**（连接断开会重连，工具注册保留） |

**实测已验证**（2026-10-06，会话 `session-a2650344`）：
- `.mcp.json` 改为 `{"type":"http","url":"http://127.0.0.1:19701/mcp"}` 后，DSH 成功注册 **12 个 `mcp__mudblazor__*` 工具**
- `tool-addition` 事件 **0 次** —— 工具在首次 `request/header` 里就是完整的，对缓存友好
- 插件**已支持** HTTP（`src/translate.ts:289`），无需改动即可用

## 2 目标与非目标

**目标**：HTTP 条目在健康检查失败时，由插件**按需拉起服务**，让"改了 `.mcp.json` 就能用"成立——用户不必手动先启服务。

**非目标**：
- 不改 DSH（本插件独立）
- 不管服务的生命周期（用户已决定：**服务自己管**，空闲自退）
- 不改变 stdio 模式的任何行为

## 3 配置格式

`.mcp.json` 的 HTTP 条目新增可选 **`serve`** 字段：

```json
{
  "mcpServers": {
    "mudblazor": {
      "type": "http",
      "url": "http://127.0.0.1:19701/mcp",
      "serve": {
        "command": "dotnet",
        "args": ["<path-to>/MudBlazor.Mcp.dll", "--version", "9.10.0"],
        "env": { "ASPNETCORE_URLS": "http://127.0.0.1:19701" },
        "health": "http://127.0.0.1:19701/health/ready",
        "readyTimeoutMs": 120000
      }
    }
  }
}
```

| 字段 | 必填 | 语义 |
| --- | --- | --- |
| `command` | ✅ | 可执行文件。与 stdio 的 `command` 同语义（含 `${VAR}` 展开） |
| `args` | ❌ | 参数数组，默认 `[]` |
| `env` | ❌ | 追加环境变量（**展开后的值不入日志**，红线 3） |
| `health` | ❌ | 就绪检查 URL；省略时用 `url` 的 origin + `/health/ready` 推导，推导失败则跳过等待 |
| `readyTimeoutMs` | ❌ | 等待就绪的上限，默认 **120000**（120 秒）。MudMCP 首次需克隆仓库建索引，实测可能超过 90 秒 |

**语义**：`serve` **只在健康检查失败时才使用**。服务已在跑就完全不碰它。

## 4 执行流程

### 4.1 挂载一个 HTTP 条目时

```
1. 健康检查（GET health，短超时如 2 秒）
   ├─ 成功 → 直接交给 mcp-client（现状行为，零额外动作）
   └─ 失败 → 走 2
2. 有 serve 字段吗？
   ├─ 没有 → 记 warn「服务不可达且未提供 serve 配置」，照常交给 mcp-client
   │         （让 mcp-client 自己的重连逻辑处理；工具可能暂时不可用）
   └─ 有   → 走 3
3. spawn 服务（detached，见 4.3）
4. 轮询 health 直到就绪或超时（默认 120 秒）
   ├─ 就绪 → 交给 mcp-client
   └─ 超时 → 记 warn，仍交给 mcp-client（让它自己重试）
```

**关键**：第 4 步的等待发生在 `agent/created` 里。`agent/created` 是 **serial 且被 await**（`packages/core/agent/src/index.ts:550`），且契约明确 *"AgentLoop holds queued input until all listeners finish"*（`runtime-types.ts:257`）——**所以用户的第一条消息会等到服务就绪**，工具在首次请求前就注册好。

**这是"等服务就绪再连"的实现方式**（用户决策 ②）。

### 4.2 为什么可以先等待（不违反"不 await 连接"红线）

红线 5 说"挂载必须不 await 连接"，指的是**不 await `mcp-client` 的握手**（那会卡住会话创建，且 MCP 服务器可能永远起不来）。

本设计 await 的是**健康检查**，它：
- 有**明确超时**（默认 120 秒，可配）
- 失败**不抛异常**，只是记 warn 后照常挂载
- 目的是让"拉起服务"这件事有确定的结果

两者不同：前者是"等一个不受控的握手"，后者是"等一个我自己启动的服务就绪，且我知道它的健康端点"。

**但仍需在文档中明示**：`serve` 模式下，首次打开会话可能等待最多 `readyTimeoutMs`。

### 4.3 spawn 方式：detached

**必须 detached**，理由：
- 服务要**跨 DSH 会话存活**（多会话共享）
- 服务要**在 DSH 退出后仍可存活**（由服务自己空闲自退，用户决策 ③）
- 若绑定 DSH 进程树，DSH 退出会带走它——但用户已选择"服务自己管"

**实测发现**：用 PowerShell `Start-Process` 启动的服务，在调用者进程退出后**会死**（第一次实验 PID 17068 消失）。所以必须用真正的 detached 方式（Node 的 `child_process.spawn` + `detached: true` + `stdio: 'ignore'` + `unref()`）。

**启动后不持有子进程句柄**：插件不 `kill` 它、不 await 它退出——生命周期归服务自己。

### 4.4 并发保护

两个会话可能同时挂载同一个 HTTP 条目 → 同时发现服务不可达 → **同时 spawn 两个服务**（第二个会因端口占用失败）。

**处理**：按 `url` 去重的**进行中启动表**（`Map<url, Promise<void>>`）。同一 url 的并发挂载共享同一次启动。

### 4.5 端口占用的处理

若端口已被**别的**进程占用（不是我们的服务），spawn 会失败。此时：
- 记 warn（含端口号，**不含** `.mcp.json` 内容）
- 照常交给 mcp-client（让它连，可能连上别的实例）

## 5 安全约束

| 约束 | 处理 |
| --- | --- |
| `env` 展开后的值 | **永不入日志/错误/会话记录**（红线 3）；诊断只记变量名与服务器名 |
| `serve` 的 `command`/`args` | 来自 `.mcp.json`，属于**已批准**的内容（指纹绑定），但仍是外部输入——不做 shell 解释，直接 exec |
| 健康检查 URL | 只允许 `http://` / `https://`；其他 scheme 跳过检查并记 warn |
| 超时 | 必须有上限（默认 120 秒），不得无限等待 |
| 异常 | 全部吞掉 + 记日志，**绝不打断会话创建**（红线 4） |

## 6 与现有设计的关系

| 设计 | 状态 | 与本设计的关系 |
| --- | --- | --- |
| stdio 挂载 | 已实现 | **不变**。`serve` 只影响 HTTP 条目 |
| 会话标记 `--project-mcp-session` | 已实现 | stdio 专用，HTTP 不适用（无子进程命令行） |
| 惰性回收 + 上限 8（`83350dc`） | **被否决** | 本设计是其替代方案。**待处理**：回退或默认关闭 |
| `workspace` 模式 | 暂缓 | 与本设计**正交**；若两者都实现，`workspace` 的共享连接天然适配 HTTP |

## 7 测试矩阵

| 用例 | 断言 |
| --- | --- |
| 健康检查成功 | **不 spawn**（`serve` 完全不被触碰） |
| 健康检查失败 + 有 `serve` | spawn 被调用一次，参数与 `serve` 一致 |
| 健康检查失败 + 无 `serve` | 不 spawn，记 warn，仍交给 mcp-client |
| 轮询到就绪 | 挂载继续 |
| 轮询超时 | 记 warn，仍继续挂载（不抛） |
| 两个会话同时挂载同一 url | **只 spawn 一次**（并发去重） |
| `env` 展开 | 展开后的值**不出现在任何日志**（断言日志文本不含该值） |
| `health` scheme 非法 | 跳过检查 + warn，不抛 |
| `serve` 字段畸形（command 缺失/非字符串） | 跳过 serve + warn，仍挂载 |
| `readyTimeoutMs` 非法 | 退回默认 120000 |
| stdio 条目 | **完全不受影响**（回归） |

## 8 已确认的决策（用户确认于 2026-10-06）

| # | 决策 | 用户选择 |
| --- | --- | --- |
| 1 | `health` 省略时的处理 | **自动推导**：用 `url` 的 origin + `/health/ready`（MudMCP 的约定） |
| 2 | 等待就绪超时后 | **仍挂载**，交给 `mcp-client` 自己重试（后台重连）；工具会注册但暂时不可用 |
| 3 | 被否决的惰性回收代码 | **回退**（`git revert 83350dc` → `5c3e93a`）。回退后 206/206 通过、typecheck exit 0 |

**回退后的状态**：`src/reclaim.ts` 与 `src/tests/reclaim.test.mts` 已删除；`AGENTS.md` 红线 10-12
（回收相关）随之消失，回到 190 用例版本的红线集（现为 206 用例，含会话标记等既有测试）。

## 9 实现要点（恢复工作时从这里开始）

- 新模块 `src/serve.ts`（纯函数 + 注入 I/O，便于单测）：`planServeStart(entry)` → `{ command, args, env, health, readyTimeoutMs }` 或 `{ skip, reason }`
- 新模块 `src/health.ts`：`checkHealth(url, timeoutMs)`（注入 fetch）
- `src/translate.ts`：解析 `serve` 字段（复用 `expandVariables`，**不展开到日志**）
- `src/index.ts`：`mountInto` 前插入"确保服务就绪"步骤（仅 HTTP 条目）
- `src/types.ts`：`McpClientConfig` 增加 HTTP 变体的可选 `serve` 元数据（**注意**：`serve` 不能传给 `mcp-client`，它不在其 schema 里——必须在挂载前剥离）
