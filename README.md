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
| 变量展开 | `command` / `args` / `env` / `url` / `headers` 支持 `${VAR}` 与 `${VAR:-default}` |
| 全局撞名保护 | 与 profile 全局 MCP 行同名的项目服务器不重复挂载 |
| 子代理不重复挂载 | 子代理会话与父会话共享工作区，不重复建连接与子进程 |
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
| `type: "sse"` / `"ws"` / `"sdk"` | **不支持**，跳过并给出原因（DSH 的传输工厂只有 stdio 与 streamable-http 两个分支） |
| 只有 `url` 没有 `type` | **跳过**，并提示无法判断传输类型 |

服务器的工具会以 `mcp__<服务器名>__<工具名>` 的形式出现；被规范化重命名过的服务器，
工具名用的是规范名。完整语义、跳过原因与边界见 [行为契约](docs/behavior.md)。

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

诊断信息（每条服务器为什么被跳过、哪个名字被规范化、"这份文件没有可用服务器"）由
`/mcp-project` 承载，不注入会话提示；会话提示只在**你需要采取行动**时出现（文件无法
解析、或存在待批准项）。

## 数据边界

| 数据 | 位置 | 内容 |
| --- | --- | --- |
| 信任记录 | `${DSH_HOME:-~/.dsh}/project-mcp-trust.json`（权限 `0600`） | 版本号、项目根路径、批准时间、`.mcp.json` 内容指纹（`sha256:<hex>`）、被批准的服务器名列表 |

- 信任文件**不含** `.mcp.json` 的内容，也**不含**任何展开后的环境变量值。
- `.mcp.json` 只读，本插件不写入、不管理它。
- 展开后的变量值只在内存中用于启动服务器，不写日志、不写错误消息、不写会话记录、不落盘。
- 变量未定义且无默认值时，该服务器被跳过，诊断只报**变量名**，不报值。
- 插件不发起任何自有网络请求，不收集遥测，不维护上述以外的持久数据。

## 已知限制

| 限制 | 说明 |
| --- | --- |
| 每会话独立连接 | 项目级服务器在 N 个会话下就是 N 份连接与子进程（profile 里的全局行则只有一份） |
| 首条消息可能赶不上工具 | 挂载不等待 MCP 连接，会话秒开的代价是首条消息的当轮可能看不到这些工具，下一轮即可见 |
| 不支持的传输 | `sse` / `ws` / `sdk` 一律跳过；SSE 已被 MCP 规范废弃，主流服务器都提供 `streamable-http` |
| 被禁用的全局行仍占名 | 判定全局撞名时只看行的模块名与 `serverName`，不看该行是否 `disabled: true`；后果是禁用行会让同名项目服务器被当作"全局已提供"跳过，而全局侧实际不连接 |
| 全局行不受管辖 | 写在 profile 补丁里的 MCP 行仍会在 DSH 启动时连接；本插件只能检测与警告，无法阻止 |
| 模块名精确匹配 | 全局行检测要求行的模块名**精确等于** `@deepseek-ai/dsh-mcp-client`；写成子路径或相对路径时漏检 |
| 无 `commands` 服务的 profile | 本插件声明依赖 `commands` / `loader` / `systemPrompt`；在缺服务的 profile（如 `sdk-minimal`）上会保持未激活，`/mcp-project` 命令也不出现 |
| 会话提示不随批准刷新 | 提示段在**会话创建时**生成，批准之后旧提示仍在，直到会话重启；请以 `/mcp-project` 的输出为准 |

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
