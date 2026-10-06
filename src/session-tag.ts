/**
 * 会话标记：给 stdio 服务器的命令行追加一个**只含 SessionId** 的参数。
 *
 * 为什么需要它：本插件按会话挂载，N 个会话就是 N 个子进程，而同一份 `.mcp.json`
 * 产出的命令行**逐字相同**（`command` / `args` / `cwd` 全部一致，`cwd` 还是同一个会话
 * 工作区）。任务管理器里因此无法区分哪个进程属于哪个会话——诊断"某个会话为什么多起
 * 了一个进程"时，唯一能依靠的就是命令行里这一段。
 *
 * 为什么服务器能接受它：MCP 的 stdio 传输把 stdin/stdout 当 JSON-RPC 通道，命令行上的
 * 未知参数不参与协议（已实测 `dotnet .../MudBlazor.Mcp.dll --stdio --version 9.10.0
 * --tag 任意值` 仍能正常握手）。因此标记**不改变任何工具面**，也不影响运行。
 *
 * 安全：标记只含 SessionId，**绝不含任何敏感信息**——进程命令行对本机所有用户可见，
 * 而 `.mcp.json` 的 `env` 值（本插件的红线 3）绝不能借这条通道外泄。
 *
 * 纯函数、无 I/O、不修改入参：理由见 `withSessionTag`。
 */
import type { McpClientConfig } from './types.js'

/**
 * 标记用的参数名。
 *
 * 带 `project-mcp` 前缀而不是泛泛的 `--tag`：命令行是全局可见的命名空间，撞上服务器
 * 自己将来要用的参数名会变成"某个版本突然起不来"这类极难定位的故障；前缀把它钉死在
 * 本插件名下。
 */
export const SESSION_TAG_FLAG = '--project-mcp-session'

/**
 * 把会话标记追加到 config 的 `args` 末尾，**返回新对象**，绝不修改入参。
 *
 * 为什么不就地追加 `config.args`：`plan.configs` 里的 config 对象由
 * `planSessionMount` 产出并可能被复用（同一个计划既用于挂载，也用于 `/mcp-project`
 * 渲染），就地追加会让标记随调用次数**累积**——第二次挂载（或第二次检视）就会带上
 * 两个标记。`validateMountConfig` 返回的 config 同样按值处理：它可能是入参本身，也
 * 可能是守卫自己构造的对象，两种情况下调用方都不该依赖共享身份。
 *
 * 为什么只处理 `transport === 'stdio'`：`streamable-http` 分支没有 `args` 字段（进程是
 * 宿主自己发起的 HTTP 请求，没有子进程命令行），追加无处安放；HTTP 变体原样返回，
 * 连对象都不重建。
 *
 * `args` 在 `mcp-client` 的 schema 里是**可选**的
 * （`args: z.array(String).default([])`，`packages/mcp/mcp-client/src/index.ts:124`），
 * 本函数因此按"可能不存在或不是数组"处理：类型上它必填，但类型只描述本插件自己产出
 * 的 config，而这里要能承受任何来源的 config。缺失时标记会成为唯一的参数。
 */
export function withSessionTag(config: McpClientConfig, sessionId: string): McpClientConfig {
  if (config.transport !== 'stdio') return config

  const raw: unknown = (config as { args?: unknown }).args
  const args = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []
  return { ...config, args: [...args, SESSION_TAG_FLAG, sessionId] }
}
