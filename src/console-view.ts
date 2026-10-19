/**
 * 控制台视图合成（**纯函数**，零 I/O）：把会话的挂载计划与挂载记账合成给 UI 的状态快照。
 *
 * ## 这个模块解决什么
 *
 * 输入区按钮与弹层需要回答三个问题：有没有项目级 MCP（没有就完全不显示按钮）、每个服务器
 * 现在是什么状态、有几个需要用户动作。这些答案散在三处——`session.ts` 的计划、`index.ts`
 * 的挂载记账、serve 的进行中启动表——本模块把它们合成一个**可序列化**的视图，Host 经
 * `console-bridge.ts` 的路由送给 Client，Client 不自己做任何折叠（practices：Client 不折
 * 会话数据，只渲染算好的值）。
 *
 * ## 为什么是纯函数
 *
 * 状态口径（什么算"没启动"、什么算需要动作）是用户可见语义，必须能被单测逐条钉住；
 * 装配层只负责把活的数据源接进来。
 */
import type { SessionMountPlan } from './session.js'

/** 一个服务器在控制台里的状态。 */
export type ConsoleServerState =
  /** 未授权：`.mcp.json` 里有它，但信任记录里没有它（或指纹已变）。 */
  | 'unauthorized'
  /** 已挂载（fiber 已登记；连接成败由 `failed` 另行表达）。 */
  | 'mounted'
  /** serve 正在拉起服务（进行中启动表里有它的 url），或本会话正在 settle。 */
  | 'starting'
  /** 已授权但**本会话**没挂上（插件换血/批准发生在会话创建之后）。点"启动"即补挂。 */
  | 'not-mounted'
  /** 挂载 fiber 被拒绝：启动或握手失败。 */
  | 'failed'
  /** 被跳过（传输不支持 / 变量缺失 / 撞名 / 重名），带原因。 */
  | 'skipped'

/** 弹层里的一行。`detail` 只含原因/错误类型名，**不含**任何配置值与 env 值（红线 3）。 */
export interface ConsoleServerRow {
  serverName: string
  /** 被规范化重命名时的原名；否则省略。 */
  originalName?: string
  transport: string
  state: ConsoleServerState
  detail?: string
}

/** 整个按钮/弹层的视图。`null` = 该会话没有项目级 MCP 可言，按钮不渲染。 */
export interface ConsoleView {
  projectRoot?: string
  /** 文件级问题（无法解析等）：没有逐行状态，只有这一句。 */
  fileNote?: string
  rows: ConsoleServerRow[]
  /** 需要用户动作的行数：未授权 + 失败。按钮徽标用它。 */
  actionCount: number
}

/** `composeConsoleView` 的输入：全部由装配层从活的数据源取出。 */
export interface ComposeConsoleInput {
  plan: SessionMountPlan
  renamed: ReadonlyArray<{ originalName: string; serverName: string }>
  /** 本会话已挂载（fiber 已登记）的服务器名。 */
  mounted: ReadonlySet<string>
  /** 本会话挂载失败的服务器名 → 错误类型名。 */
  failed: ReadonlyMap<string, string>
  /** 本会话在插件侧有登记项（`agent/created` 跑过）。没有 → 已授权却没挂 = `not-mounted`。 */
  sessionKnown: boolean
  /** serve 正在进行中的启动表键（条目的 url）。 */
  startingUrls: ReadonlySet<string>
}

/** 传输名：视图只展示类别，不展示配置内容。 */
function transportOf(config: { transport?: string; url?: string }): string {
  return config.transport === 'streamable-http' ? 'http' : 'stdio'
}

/**
 * 合成控制台视图。
 *
 * 口径（与 `docs/design-mcp-console.md` §5 一致）：
 * - 计划为 `skip`（含静默与非静默）→ 返回 `null`：没有项目级 MCP 可言，按钮不渲染；
 * - 计划为 `invalid` → 只有 `fileNote`，`actionCount = 1`（让用户点开看原因）；
 * - 计划为 `untrusted` → 每个 pending 一行 `unauthorized`；
 * - 计划为 `mount` → 逐条取 `failed` > `mounted` > `starting`（serve 在拉、或本会话正在
 *   settle）> `not-mounted`（本会话连登记项都没有：插件换血或批准发生在会话创建之后，
 *   点"启动"即补挂），外加计划里的 `skipped` 行。
 */
export function composeConsoleView(input: ComposeConsoleInput): ConsoleView | null {
  const { plan, renamed, mounted, failed, startingUrls, sessionKnown } = input
  const originalOf = (serverName: string): string | undefined =>
    renamed.find(item => item.serverName === serverName && item.originalName !== serverName)?.originalName

  if (plan.kind === 'skip') return null

  if (plan.kind === 'invalid') {
    return { fileNote: plan.reason, rows: [], actionCount: 1 }
  }

  if (plan.kind === 'untrusted') {
    const rows: ConsoleServerRow[] = plan.pending.map(item => ({
      serverName: item.serverName,
      ...(originalOf(item.serverName) === undefined ? {} : { originalName: originalOf(item.serverName) }),
      transport: 'unknown',
      state: 'unauthorized' as const,
    }))
    return { projectRoot: plan.projectRoot, rows, actionCount: rows.length }
  }

  const rows: ConsoleServerRow[] = plan.configs.map(config => {
    const name = config.serverName
    const failure = failed.get(name)
    const state: ConsoleServerState =
      failure !== undefined
        ? 'failed'
        : mounted.has(name)
          ? 'mounted'
          : config.transport === 'streamable-http' && config.url !== undefined && startingUrls.has(config.url)
            ? 'starting'
            : sessionKnown
              ? 'starting'
              : 'not-mounted'
    return {
      serverName: name,
      ...(originalOf(name) === undefined ? {} : { originalName: originalOf(name) }),
      transport: transportOf(config),
      state,
      ...(failure === undefined ? {} : { detail: failure }),
    }
  })
  // 部分批准时未批准的条目不在 `configs` 里：单独成行，否则它们会在弹层里静默消失。
  for (const item of plan.pending) {
    rows.push({
      serverName: item.serverName,
      ...(originalOf(item.serverName) === undefined ? {} : { originalName: originalOf(item.serverName) }),
      transport: 'unknown',
      state: 'unauthorized',
    })
  }
  for (const note of plan.skipped) {
    rows.push({
      serverName: note.name,
      ...(originalOf(note.name) === undefined ? {} : { originalName: originalOf(note.name) }),
      transport: 'unknown',
      state: 'skipped',
      detail: note.reason,
    })
  }
  const actionCount = rows.filter(
    row => row.state === 'unauthorized' || row.state === 'failed' || row.state === 'not-mounted',
  ).length
  return { projectRoot: plan.projectRoot, rows, actionCount }
}
