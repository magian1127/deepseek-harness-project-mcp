# deepseek-harness-project-mcp

[中文](README.md) · [English](README.en.md)

**让项目根目录的 `.mcp.json` 决定该项目下的会话启用哪些 MCP 服务器**，且未启用的服务器
**完全不建立连接、不启动子进程**。

DSH 的 MCP 配置原本只有 profile（进程）作用域：写进 profile 补丁的服务器在 DSH 启动时
就连接、就 spawn 子进程，那时还没有任何会话。本插件把"项目专属"的那部分搬到项目里——
配置随仓库走，是否启用由你按项目批准。

## 功能

| 能力 | 说明 |
| --- | --- |
| 项目级配置 | 项目根目录的 `.mcp.json`（Claude Code 约定格式）声明该项目专属的 MCP 服务器 |
| 不批准就不连 | 未批准的服务器不 spawn 进程、不发网络连接；克隆陌生仓库并打开它不会执行其中任何命令 |
| 指纹绑定 | 批准绑定到 `.mcp.json` 的**确切内容**，`git pull` 拉进新条目后必须重新批准 |
| 仓库无法自我批准 | 批准记录只存在于 `${DSH_HOME:-~/.dsh}`，项目内没有可写入的批准通道 |
| 会话内批准 | `/mcp-project trust` 批准后服务器**立即挂进当前会话**，无需重开会话 |
| 两种传输 | `stdio` 与 `streamable-http`（`http` 是别名） |
| HTTP 服务按需拉起 | HTTP 条目可用 `serve` 声明"服务没在跑时怎么启动"；健康检查失败时插件把它拉起来，等就绪再连接 |
| 变量展开 | `command` / `args` / `env` / `url` / `headers` / `serve.*` 支持 `${VAR}` 与 `${VAR:-default}` |
| 全局撞名保护 | 与 profile 全局 MCP 行同名的项目服务器不重复挂载 |
| 子代理不重复挂载 | 子代理会话（`origin === 'subagent'`）与父会话共享工作区，不重复建连接与子进程；分叉会话是独立会话，照常挂载 |
| 不打扰 | 没有 `.mcp.json` 时完全静默；只有需要你采取行动时才注入会话提示 |

## 环境要求

- DeepSeek Harness 0.2.x（源码核对基线 0.2.1-alpha.1）
- Node.js `^22.19.0 || >=24.0.0`
- 本插件只有 Host 半边，没有 Web 配置表单，也不注册模型工具

## 安装

```powershell
dsh plugin --profile web add "link:<本仓库路径>"
```

把 `<本仓库路径>` 换成本插件源码目录。安装前先构建一次：

```powershell
npm install
npm run build
```

`--profile web` 是 Web GUI 使用的 profile；按实际使用的 profile 替换（例如桌面版为
`desktop`）。`link:` 指向本仓库后，改动源码只需重新 `npm run build`。

安装完成后，该 profile 的 bundle 列表应含 `deepseek-harness-project-mcp`，Loader 里应出现
`dsh-project-mcp` 行：

```powershell
dsh plugin --profile web list
```

本插件只有 Host 半边，没有客户端配置表单。Host 半边没有热通道：新构建进入长跑进程需要
由你重启一次 `dsh web`。

## `.mcp.json` 格式

放在**项目根目录**（从会话工作区向上找到的第一个含 `.git` 的目录；一路到根都没有
`.git` 时用工作区目录本身）：

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    },
    "docs": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN:-}" }
    }
  }
}
```

| 字段 | 语义 |
| --- | --- |
| 键（`github` / `docs`） | 服务器名。合法字符为 `[A-Za-z0-9_-]`，长度 1–32；不合法会被规范化并重命名 |
| `command` + `args` + `env` | stdio 服务器。`env` 是附加环境变量，`cwd` 为会话工作区 |
| `type: "http"` 或 `"streamable-http"` + `url` + `headers` | HTTP 服务器 |
| `serve`（HTTP 条目可选） | 服务没在跑时怎么启动它，见下 |
| `type: "sse"` / `"ws"` / `"sdk"` | **不支持**，跳过并给出原因（DSH 的传输工厂只有 stdio 与 streamable-http 两个分支） |
| 只有 `url` 没有 `type` | **跳过**，并提示无法判断传输类型 |

服务器的工具会以 `mcp__<服务器名>__<工具名>` 的形式出现；被规范化重命名过的服务器，
工具名用的是规范名。完整语义、跳过原因与边界见 [行为契约](docs/behavior.md)。

### HTTP 服务按需拉起（`serve`）

HTTP 模式下 DSH **不启动任何子进程**——它只向 `url` 发请求，服务必须已经在跑。若服务没在
跑，DSH 连不上、工具不可用。`serve` 让插件在这种情况下**把服务拉起来**，等它就绪再连接：

```json
{
  "mcpServers": {
    "mudblazor": {
      "type": "http",
      "url": "http://127.0.0.1:19701/mcp",
      "serve": {
        "command": "dotnet",
        "args": ["<MudBlazor.Mcp.dll 的路径>", "--version", "9.10.0"],
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
| `command` | ✅ | 可执行文件（或绝对路径）。与 stdio 的 `command` 同语义，**不经 shell 解释** |
| `args` | ❌ | 参数数组，默认 `[]` |
| `env` | ❌ | **追加**环境变量（宿主环境之上叠加） |
| `health` | ❌ | 就绪检查 URL（只允许 `http://` / `https://`）。省略时用 `url` 的 origin + `/health/ready` |
| `readyTimeoutMs` | ❌ | 等待就绪的上限（毫秒），默认 `120000` |

行为要点：

- **服务已在跑就完全不碰它**：先做一次健康检查（2 秒超时），成功就直接连接，零额外动作。
- **只在健康检查失败时才拉起**，然后每 250 毫秒轮询 `health`，就绪后交给 DSH 连接。
- **首条消息会等服务就绪**（最多 `readyTimeoutMs`）。这是 `serve` 唯一会让用户感知到的
  代价：等待发生在会话创建路径上，因此工具在首次请求前就注册好。等待**只影响该条目**，
  同一会话里其他服务器照旧立即挂上。
- **超时后仍会连接**：记一条日志，交给 DSH 自己重试（工具会注册但暂时不可用）。
- **拉起的服务脱离 DSH 存活**：以独立进程组启动、不继承管道、启动后立即丢弃引用。插件
  不 kill 它、不监控它、不重启它——多个 DSH 实例（或 DSH 重启）复用同一个服务，何时退出
  由服务自己决定。想结束它就手动结束该进程。
- **两个会话同时挂载同一 `url` 只拉起一次**（按 `url` 去重）。
- **`serve` 写错不影响使用**：畸形时只丢弃 `serve`、记一条日志，该服务器照常挂载。

完整语义见 [行为契约 §3.2](docs/behavior.md#32-servehttp-条目的按需拉起可选)；
"服务没被拉起"与"等很久"的排查见 [故障排查](docs/troubleshooting.md)。

## 信任批准流程

1. 在含 `.mcp.json` 的项目里新建会话。
2. 若文件里存在可挂载的服务器但尚未批准，会话会注入一条提示，列出**待批准**的服务器名。
3. 在会话里运行：

| 命令 | 行为 |
| --- | --- |
| `/mcp-project` | 列出项目路径、状态、已挂载、未批准、已跳过（含原因）与规范化重命名 |
| `/mcp-project trust` | 批准整个文件（记录当前指纹），并**立即挂进当前会话** |
| `/mcp-project trust <名称>…` | 只批准指定服务器；已批准的其他项保留 |
| `/mcp-project untrust` | 撤销该项目的批准，并卸载本会话已挂载的项目服务器 |

批准不需要重开会话。改动 `.mcp.json` 的任何内容（含新增条目）都会让指纹失配，需要重新
批准——这正是 `git pull` 拉入新服务器时的保护。

**批准是持久的，不是每个会话都要做**：批准记录写在 `${DSH_HOME:-~/.dsh}/project-mcp-trust.json`，
同一项目批准一次之后，之后所有会话都会直接挂载，不再询问。只有两种情况需要再次批准：

- 该项目的**首次**使用；
- `.mcp.json` 的内容发生了变化（例如 `git pull` 拉入了新服务器）。

诊断信息（每条服务器为什么被跳过、哪个名字被规范化、"这份文件没有可用服务器"）由
`/mcp-project` 承载，不注入会话提示；会话提示只在**你需要采取行动**时出现（文件无法
解析或超过 1 MiB、或存在待批准项）。

`/mcp-project` 的输出末尾会直接给出**可照抄的下一步命令**，不必记住子命令拼写。

## 数据边界

| 数据 | 位置 | 内容 |
| --- | --- | --- |
| 信任记录 | `${DSH_HOME:-~/.dsh}/project-mcp-trust.json`（权限 `0600`） | 版本号、项目根路径、批准时间、`.mcp.json` 内容指纹（`sha256:<hex>`）、被批准的服务器名列表 |

- 信任文件**不含** `.mcp.json` 的内容，也**不含**任何展开后的环境变量值。
- `.mcp.json` 只读，本插件不写入、不管理它。
- 展开后的变量值只在内存中用于启动服务器，不写日志、不写错误消息、不写会话记录、不落盘。
- 变量未定义且无默认值时，该服务器被跳过，诊断只报**变量名**，不报值。
- 插件不收集遥测，不维护上述以外的持久数据。
- **网络请求**：本插件自己只发起一种请求——对 `serve` 的 `health`（或由 `url` 推导出的
  `/health/ready`）做就绪探测，且**只允许 `http://` / `https://`**。除此之外的网络连接
  都由 DSH 自己的 MCP 客户端发起（连你批准的 `url`）。
- **进程启动**：本插件只在 `serve` 声明且健康检查失败时启动进程，且只启动 `serve.command`
  ——不经 shell 解释，因此 `&&`、管道、重定向、通配符都不生效。未批准时既不 spawn 也不连。

## 已知限制

| 限制 | 说明 |
| --- | --- |
| 每会话独立连接 | 项目级服务器在 N 个会话下就是 N 份连接与子进程（profile 里的全局行则只有一份）。stdio 服务器在 `.mcp.json` 给出的 `args` 之后会追加 `--project-mcp-session <会话 id>`，用来分辨进程归属——同一份 `.mcp.json` 在多个会话下的命令行其余部分逐字相同。标记只含会话 id，不含任何配置内容；服务器忽略未知参数，不影响运行 |
| 首条消息可能赶不上工具 | 挂载不等待 MCP 连接，会话秒开的代价是首条消息的当轮可能看不到这些工具，下一轮即可见。**例外**：配了 `serve` 的 HTTP 条目会先等健康检查（有上限、失败不抛），见上文 |
| 不支持的传输 | `sse` / `ws` / `sdk` 一律跳过；SSE 已被 MCP 规范废弃，主流服务器都提供 `streamable-http` |
| 被禁用的全局行仍占名 | 判定全局撞名时只看行的模块名与 `serverName`，不看该行是否 `disabled: true`；后果是禁用行会让同名项目服务器被当作"全局已提供"跳过，而全局侧实际不连接 |
| 全局行不受管辖 | 写在 profile 补丁里的 MCP 行仍会在 DSH 启动时连接；本插件能检测到它们（名单只用于撞名过滤），但**不提示**，也无法阻止。能做的只有改 profile 补丁，那已超出本插件的管辖范围，因此不为一条你无能为力的信息在启动时打扰你 |
| 模块名精确匹配 | 全局行检测要求行的模块名**精确等于** `@deepseek-ai/dsh-mcp-client`；写成子路径或相对路径时漏检 |
| `.mcp.json` 上限 1 MiB | 超过即**拒读**（不读进内存）并给出"过大"诊断。读盘在会话创建的同步路径上，无上限会让陌生仓库里的异常大文件拖住会话创建；真实的 `.mcp.json` 远小于 100 KiB |
| 无 `commands` 服务的 profile | 本插件声明依赖 `commands` / `loader` / `systemPrompt`；在缺服务的 profile（如 `sdk-minimal`）上会保持未激活，`/mcp-project` 命令也不出现 |
| 挂载只发生在会话创建时或本会话批准时 | 别的会话批准后，本会话的计划已是"已批准"，但服务器不会自动挂进本会话；`/mcp-project` 会把它列在"已批准但本会话未挂载"下，运行 `/mcp-project trust` 即挂上 |
| `serve` 不管服务生命周期 | 拉起的服务脱离 DSH 存活，插件不 kill、不监控、不重启。好处是多实例复用同一个服务；代价是 `serve` 写错时会留下一个常驻进程，只能手动结束 |
| `serve` 不检查端口归属 | 端口被别的进程占用时只记一条日志，不抢占、不重试；照常交给 DSH 连接（可能连上那个别的实例） |
| `serve` 的等待有上限 | 默认 120 秒（可配，硬上限 30 分钟）。超时后仍会挂载，工具暂时不可用，由 DSH 自己重连 |

## 卸载

```powershell
dsh plugin --profile web remove deepseek-harness-project-mcp
```

卸载会回收本插件在活会话里挂载的项目级 MCP 与提示段，不会删除 DSH 会话数据。
`${DSH_HOME:-~/.dsh}/project-mcp-trust.json` 会保留——重新安装后此前的批准仍有效。
若要一并清除，请在确认没有其他项目仍需该记录后自行删除该文件。

## 开发文档

- [行为契约](docs/behavior.md)：`.mcp.json` 字段语义、传输矩阵、命名规范化、信任模型、命令输出与失败模式
- [设计说明](docs/design.md)：目标、架构依据与取舍
- [开发指南](docs/development.md)：源码地图、依赖策略、构建与测试
- [故障排查](docs/troubleshooting.md)：按症状诊断

## License

[MIT](LICENSE)
