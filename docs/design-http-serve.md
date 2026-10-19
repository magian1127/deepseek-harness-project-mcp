# 设计：HTTP 模式的按需拉起服务（`serve` 字段）

状态：**已实现**（用户可见语义见 [`behavior.md` §3.2](behavior.md#32-servehttp-条目的按需拉起可选)；
实现位置与调试方法见 [`development.md`](development.md#2-源码地图)）
日期：2026-10-06
前置：[`design.md`](design.md)（本插件总设计）、[`behavior.md`](behavior.md)（用户可见行为）
相关：[`design-workspace-mode.md`](design-workspace-mode.md)（另一个暂缓的设计）

> 实现要点见 §9；实现与设计的两处**有意偏差**（`serve` 不可用时跳过整个 `serve` 而不只是
> 跳过检查、`readyTimeoutMs` 的硬上限）记在 §9 末尾。

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

### 4.3 spawn 方式：必须脱离 DSH 存活（硬要求）

**用户明确要求**：*"拉起服务的方式不要用子进程的方式，要保证 DSH 关掉 MCP 服务还在"*。

服务必须**跨 DSH 进程存活**，理由：
- 多个 DSH 实例（或 DSH 重启）应复用同一个服务
- 服务自己管生命周期（空闲自退），DSH 不该是它的 owner

#### 已验证的事实

| 事实 | 证据 |
| --- | --- |
| Node `spawn({detached:true, stdio:'ignore'})` + `unref()` **能让服务脱离直接父进程存活** | 实测：spawn 后父脚本退出，服务 PID 43448 仍存活、`/health/live`=Healthy |
| **DSH 的 Job 对象不影响独立 spawn** | `createKillOnCloseJob`（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）只用于 `spawnJobProcess`（`packages/subprocess/win32-process/src/process.ts:340,422`），出口是 `spawnInheritedJobProcess` / `spawnCurrentTokenJobProcess` —— **DSH 自己的沙箱子进程**，不是任意外部 spawn |
| 当前 DSH 不在 Job 里 | 进程链 `node.exe ← cmd.exe ← powershell.exe ← pwsh.exe ← explorer.exe`（普通 explorer 启动链） |
| 孤儿进程确实能长期存活 | 当前 MudMCP 服务 PID 44696 的父进程已退出，它仍运行 10+ 分钟 |
| **Windows 上 `detached: true` 会让 PowerShell 静默空转** | 实测：`detached: true` + `pwsh -Command "exit 7"` 退出码是 **0**、零输出，`Set-Content` 的标记文件根本没出现；去掉 `detached` 后退出码是 **7**、脚本正常执行。`powershell.exe`(5.1) 同样。同一个服务改用 `dotnet <dll>` 在 `detached: true` 下**正常**（0.1 秒就绪）——只有 PowerShell 会哑掉。见下面的"Windows 例外" |

#### 实现要求

```js
const child = spawn(command, args, {
  // 按平台与命令取值：Windows 上 detached 会变成 DETACHED_PROCESS（子进程没有控制台），
  // PowerShell 在那种情形下一行都不执行；而其他命令又需要它来脱离宿主控制台。
  // 见下面的「Windows 例外」。
  detached: platform === 'win32' ? !isPowerShellCommand(command) : true,
  stdio: 'ignore',         // 不继承任何管道（否则父进程退出会触发 EPIPE / 阻塞）
  windowsHide: true,       // 不弹控制台窗口
  env: { ...process.env, ...serveEnv },
})
child.on('error', () => {}) // 必需：无监听器时 ENOENT 会带崩宿主（见 §7）
child.unref()              // 不持有句柄，不阻塞事件循环
```

**启动后立即 `unref()` 并丢弃 `child` 引用**：插件**不** kill 它、**不** await 它退出、**不**监听它的 exit 事件。生命周期完全归服务自己。

#### Windows 例外：`detached` 与 PowerShell 互斥，只能按命令分流（已实测）

Node 在 Windows 上把 `detached: true` 实现成 `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`
（libuv 的 `uv_spawn`），其中 `DETACHED_PROCESS` 意味着子进程**没有控制台**。两个方向的实测
证据都存在，而且**互相冲突**：

| 实验（同一台机器、同一个 Node，每次只改一个变量） | 结果 |
| --- | --- |
| `detached: true` + `pwsh -NoProfile -Command "exit 7"` | 退出码 **0**（不是 7），零输出 |
| `detached: true` + `pwsh -Command "Set-Content <标记文件>"` | 标记文件**没有被创建**（脚本体一行都没跑） |
| `detached: true` + `powershell.exe`（5.1）同一条命令 | 同样退出码 0 |
| `detached: false` + `pwsh -NoProfile -Command "exit 7"` | 退出码 **7**（正常执行） |
| `detached: true` + `dotnet <服务 dll>` | 正常，0.1 秒就绪，父进程退出后**仍存活** |
| `detached: false` + `dotnet <服务 dll>` | 能起来（health 200），但父进程退出、控制台拆除后**跟着消失** |
| `detached: false` + `pwsh -File <启动脚本>`（脚本内用 `Start-Process -WindowStyle Hidden`） | 脚本正常执行、服务数秒就绪，父进程退出后**仍存活**（孙进程没有控制台） |
| `windowsHideConsole` / `windowsHideGui`（期望 `CREATE_NO_WINDOW` / `DETACHED_PROCESS`） | Node **不认**这两个选项：`windowsHideGui` 本该让 pwsh 哑掉，实测仍退出码 7 → 被忽略 |

**方向一：`detached: true` 让 PowerShell 一行都不执行。** `serve.command` 写成 `pwsh` /
`powershell`（Windows 上极常见——用它包一层启动脚本）时，插件 spawn 出一个立刻空转退出的
进程，然后**白等满 `readyTimeoutMs`（默认 120 秒）**，而会话创建正卡在这段等待上；
`stdio: 'ignore'` 又让失败完全无声。用户看到的是"新建会话卡了两分钟，服务还是没起来"，
日志里只有一条"等待就绪超时"。表中 `dotnet` 那行也解释了为什么本节最初的实测没有暴露它：
那次用的是 `dotnet` 直接拉起，而普通控制台程序在 `DETACHED_PROCESS` 下工作正常——**只有
PowerShell 会哑掉**。

**方向二：`detached: false` 让服务随宿主控制台一起死。** 不 detached 的子进程挂在宿主的控制台
上；控制台被拆除（用户 Ctrl+C、关掉终端、父进程退出）时，挂在它上面的进程会收到
`CTRL_CLOSE_EVENT` 并被带走——表中 `detached: false` + `dotnet` 那行就是这个现象。这与本节
"必须跨 DSH 存活"的硬要求直接冲突。

**两全的 `CREATE_NO_WINDOW` 拿不到。** 它恰好同时满足两边：进程没有控制台（免疫控制台事件），
又不像 `DETACHED_PROCESS` 那样让 PowerShell 哑掉——PowerShell 自己的 `Start-Process
-WindowStyle Hidden` 用的就是它，实测那种方式起的 pwsh 能正常执行。但 Node 只向 libuv 转发
`windowsHide` 与 `windowsVerbatimArguments`，`windowsHideConsole` / `windowsHideGui` 都不是
公开选项（表中最后一行实测被忽略）。于是 Node 能表达的只有两种：
"`DETACHED_PROCESS` + 新进程组"或"继承宿主控制台"。

**结论：按命令分流。** Windows 上只对 PowerShell 关掉 `detached`（先保证"能执行"），其余命令
保持 `detached`（保住"能存活"）。这不会牺牲 PowerShell 那条路径的存活性：这类 `serve.command`
在实践中只是个转手的启动脚本，真正的服务由脚本自己创建，而 `Start-Process -WindowStyle Hidden`
创建出来的进程没有控制台，因此免疫（表中倒数第二行已实测）。

| 平台 | `serve.command` | `detached` |
| --- | --- | --- |
| POSIX | 任意 | `true` |
| Windows | PowerShell（`pwsh` / `powershell`） | `false` |
| Windows | 其他 | `true` |

判定刻意保守（按**基名**匹配 `pwsh` / `powershell`，大小写不敏感、容忍 `.exe` 后缀，因此绝对
路径写法同样命中）：误判成"是"会让一个本该 detached 的命令失去控制台隔离，误判成"不是"会让
PowerShell 静默空转；带后缀的变体（如 `pwsh-preview`）行为未实测，不猜。

实现上这条决策落在 `src/serve.ts` 的 `isPowerShellCommand` 与 `spawnOptionsFor(platform, command)`
（都是纯函数，各分支都有单测覆盖，且经过双向变异测试），`spawnDetached` 只是消费它。

#### 参考实现：AIVC 的三层策略

`D:\Projects\My\AIVirtualCompany` 的 `DaemonLaunchers.cs` 用了更完整的三层（本插件**不需要**这么复杂，但值得记录）：

| 层 | 方式 | 位置 |
| --- | --- | --- |
| 1 | **计划任务**（`schtasks /create /run`）—— 最强脱离 | `ScheduledTaskDaemonLauncher.cs:108-171` |
| 2 | 直接 `CreateProcess`（`CREATE_BREAKAWAY_FROM_JOB` + 新进程组 + 不继承句柄） | `WindowsProcessStarter.cs:20,44` |
| 3 | 退化子进程 | `DaemonLaunchers.cs:405` |

**为什么本插件用 Node 的 detached 就够**：AIVC 的守护进程是被**IDE**（VS Code / ZCode 等）启动的，那些 IDE 可能把自己放进 Job 对象，所以需要 `BREAKAWAY`。而 DSH 从 explorer 启动、不在 Job 里（已实测），Node 的 `detached` 已足够。

**但要在文档中标注这个前提**：若将来 DSH 被放入 Job（例如由某个 IDE 或计划任务启动），脱离可能失败。届时需要退化为 AIVC 那样的方案，或接受"服务随 DSH 退出"。

#### 待实测（实现后必须验证）

**"DSH 退出时，由 DSH spawn 的服务能否存活"** —— 这条**只能等 `serve` 实现后实测**（当前的 44696 是我手动启的，不能证明 DSH spawn 的情形）。


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

## 9 实现要点（实现已完成，这里是落地位置）

| 计划 | 实际落地 |
| --- | --- |
| 新模块 `src/serve.ts` | ✅ `planServeStart`（纯函数）、`deriveHealthUrl`、`splitServe`（剥离 `serve`）、`ensureServeReady`（编排 + 并发去重）、`spawnDetached`（真实进程 I/O） |
| 新模块 `src/health.ts` | ✅ `checkHealth` / `waitReady` / `isHttpUrl`；`fetch`、`sleep`、`now`、`timeoutSignal` 全部注入 |
| `src/translate.ts` 解析 `serve` | ✅ `translateServe`（畸形时**只丢弃 `serve`**，条目仍挂载；诊断经 `diagnostics` 出参交给装配层） |
| `src/index.ts` 在 `mountInto` 前插入"确保服务就绪" | ✅ `mountInto` 转 async，逐条目先 `ensureServeReady` 再挂载；`agent/created` 的监听器返回该 promise（Cordis 的 serial 派发会 await 它） |
| `src/types.ts` 加 `serve` 元数据 | ✅ `ServeMetadata` + HTTP 变体的可选 `serve` |
| — | ➕ 新模块 `src/values.ts`：展开语义与形状守卫从 `translate.ts` 抽出，供 `serve.ts` 复用（否则两套展开语义迟早分叉） |

### 9.1 与设计的两处有意偏差

| # | 设计原文 | 实现 | 为什么 |
| --- | --- | --- | --- |
| 1 | §5「其他 scheme **跳过检查**并记 warn」 | **跳过整个 `serve`**（不 spawn） | 健康检查是 spawn 的**唯一**前提。没有可用的健康端点就永远判不出"服务已经在跑"，于是每次会话挂载都会盲目拉一次，重复实例只能靠端口占用失败收场——而那条失败是**静默的**（`stdio: 'ignore'` 拿不到输出）。宁可不拉 |
| 2 | §3「`readyTimeoutMs` 默认 120000」（未提上限） | 默认 120000，另加 **30 分钟硬上限** | §5 要求"超时必须有上限，不得无限等待"。没有硬上限时，`.mcp.json` 里一个 `1e12` 就能把会话创建卡到用户以为 DSH 死了 |

### 9.2 实测补充（实现期新发现，不是设计里的内容）

- **`spawn` 的 `'error'` 事件必须挂监听器**：Node 对它没有默认处理器，无监听器时
  `spawn('不存在的命令')` 会在约一个 tick 后抛未捕获异常并**带崩宿主进程**（Node 22，
  `detached + stdio: 'ignore'` 下实测，退出码 1）。也就是说一个写错的 `serve.command`
  足以打挂 DSH。这是实现期发现的最严重的一处，已写进 `AGENTS.md` 红线 12。
- **测试夹具的 `fire` 必须 await**：`mountInto` 转 async 后，同步遍历监听器会让断言跑在
  挂载之前——"未挂载"的断言假性通过、"已挂载"的断言必然失败，两种都是错误的观测。
- **并发去重的实测**：`serve-mount.test.mts` 让子进程往同一个文件追加一行，两个会话并发
  挂载同一 `url` 时**行的数量是 1**——这是"只 spawn 一次"的直接证据。
