/**
 * `/mcp-project` 斜杠命令（规格 §11）。
 *
 * 四个子动作共用**一个**注册名 `mcp-project`：DSH 的命令注册以 `name` 为键
 * （`packages/interaction/commands/src/index.ts` 的 `COMMAND_NAME` 要求
 * `/^[a-z][a-z0-9_-]*$/u`，同名重复注册会抛错），子动作从 `rawInput` 解析，
 * 与 `/goal` 的 `parseGoalCommand` 同一手法。
 *
 * - `/mcp-project`              列出当前项目的服务器与状态
 * - `/mcp-project trust`        批准整个文件并立即挂载进当前会话
 * - `/mcp-project trust <名称>…` 只批准指定服务器
 * - `/mcp-project untrust`      撤销批准并卸载
 *
 * 本模块不做任何 I/O：读盘、写信任存储、挂载与卸载全部由 `index.ts` 经 `CommandDeps`
 * 注入，因此输出可被确定性单测。
 *
 * 输出承载**诊断**（规格 §12）：每条服务器的跳过原因、规范化重命名、未获批准的条目、
 * "这份文件没有可用服务器"等都在这里呈现。会话提示（`notice.ts`）只负责需要用户行动
 * 的情形，两者刻意分工，避免把诊断信息灌进模型上下文。
 *
 * 安全：所有文本只由计划携带的 `reason`（任务 3/6 已保证不含变量值）与服务器名拼成，
 * 不含 `.mcp.json` 内容或展开后的环境变量值。
 */
import { approve, isApproved, revoke } from './trust.js'
import type { TrustStore } from './trust.js'
import type { AgentShape, CommandsService, Disposer, HostContext, McpClientConfig } from './types.js'
import type { SessionMountPlan } from './session.js'

/**
 * 一次项目检视的结果：挂载计划 + 展示所需的完整名单。
 *
 * 为什么不直接只用 `SessionMountPlan`：部分批准时（`approved.length > 0` 但未全批准），
 * 未获批准的条目**既不在** `configs`（只含已批准项）**也不在** `skipped`（只含被跳过项），
 * 直接照搬会让这些服务器在 `/mcp-project` 里静默消失。`mountable` 补齐这份名单，
 * 命令再对每条自行重算批准状态。
 */
export interface ProjectInspection {
  /** 项目根路径；无法定位（会话没有工作区）时为 `undefined`。 */
  projectRoot?: string
  /** 当前信任状态下的挂载计划。 */
  plan: SessionMountPlan
  /** 文件里全部**可挂载**服务器的规范化名（与信任状态无关，按挂载顺序）。 */
  mountable: string[]
  /** 规范化后与文件里的键不同的服务器（原名 → 规范名），用于展示重命名。 */
  renamed: Array<{ originalName: string; serverName: string }>
}

/** 命令执行结果，对齐 DSH `CommandResult`（本插件只产出这两态）。 */
export type CommandOutcome =
  | { readonly kind: 'success'; readonly text: string }
  | { readonly kind: 'error'; readonly text: string }

/** `registerCommands` 注入的宿主能力；真实 I/O 全在 `index.ts`。 */
export interface CommandDeps {
  /** 读当前信任存储（真实 fs）。 */
  readStore(): TrustStore
  /** 写信任存储（原子写 + `0600`）；失败必须抛出，静默失败会让"已批准"成为假象。 */
  writeStore(store: TrustStore): Promise<void>
  /** 检视该 agent 所在项目。 */
  inspect(agent: AgentShape): ProjectInspection
  /** 把配置挂进该 agent 的 scope；同名已挂载则跳过（幂等）。 */
  mountInto(agent: AgentShape, configs: McpClientConfig[]): void
  /** 卸载该 agent 已挂载的全部项目服务器。 */
  unmountFrom(agent: AgentShape): void
}

const COMMAND_NAME = 'mcp-project'
const DESCRIPTION = '查看或批准当前项目 .mcp.json 里的项目级 MCP 服务器'
const USAGE = '用法：/mcp-project [trust [<名称>…] | untrust]'

/** 解析后的子动作。 */
type ParsedInput =
  | { kind: 'list' }
  | { kind: 'trust'; names: string[] }
  | { kind: 'untrust' }
  | { kind: 'unknown'; verb: string }

/**
 * 只解析本命令自己的语法。
 *
 * 动词大小写不敏感（与 `/goal` 的控制词一致），**服务器名保持原样**：`serverName`
 * 的合法字符集 `[A-Za-z0-9_-]` 区分大小写，lowercase 会让 `GitHub` 找不到。
 */
export function parseInput(rawInput: string | undefined): ParsedInput {
  const input = (rawInput ?? '').trim()
  if (input === '') return { kind: 'list' }

  const parts = input.split(/\s+/u)
  const verb = parts[0]!.toLowerCase()
  if (verb === 'trust') return { kind: 'trust', names: parts.slice(1) }
  if (verb === 'untrust') return { kind: 'untrust' }
  return { kind: 'unknown', verb: parts[0]! }
}

/** 计划携带的信任锚点（项目根 + 指纹）；只有这两个变体有。 */
function trustAnchor(plan: SessionMountPlan): { projectRoot: string; fingerprint: string } | undefined {
  if (plan.kind === 'untrusted' || plan.kind === 'mount') {
    return { projectRoot: plan.projectRoot, fingerprint: plan.fingerprint }
  }
  return undefined
}

/** 计划里的跳过诊断；`invalid` 与 `untrusted` 不携带。 */
function skippedNotes(plan: SessionMountPlan): Array<{ name: string; reason: string }> {
  if (plan.kind === 'skip') return plan.skipped ?? []
  if (plan.kind === 'mount') return plan.skipped
  return []
}

/** 逐条重算批准状态：`mountable` 里哪些已获批准（规格 §11 的"状态"列）。 */
function approvedNames(view: ProjectInspection, store: TrustStore): string[] {
  const anchor = trustAnchor(view.plan)
  if (anchor === undefined) return []
  return view.mountable.filter(name => isApproved(store, anchor.projectRoot, anchor.fingerprint, name))
}

/** 列表输出的标题行：说明这份文件当前处于什么状态。 */
function stateLine(plan: SessionMountPlan): string {
  switch (plan.kind) {
    case 'skip':
      return `项目级 MCP 未启用：${plan.reason}`
    case 'invalid':
      return `项目级 MCP 未启用：${plan.reason}`
    case 'untrusted':
      return '尚未批准，本会话未挂载任何项目级 MCP'
    case 'mount':
      // 不在这里猜"为什么没有可挂载项"：`configs` 为空有两种成因（一条服务器都没声明，
      // 或全部翻译失败），两者的区别由下面的"已跳过"逐条说明。这里下结论会误导用户。
      return plan.configs.length === 0
        ? '已批准，但这份文件没有可挂载的服务器'
        : '已批准'
  }
}

/** 渲染 `/mcp-project` 的列表输出。 */
function renderList(view: ProjectInspection, store: TrustStore): CommandOutcome {
  const { plan, projectRoot } = view
  const approved = approvedNames(view, store)
  const approvedSet = new Set(approved)
  const mounted = plan.kind === 'mount' ? plan.configs.map(config => config.serverName) : []
  const unapproved = view.mountable.filter(name => !approvedSet.has(name))
  const skipped = skippedNotes(plan)

  const lines: string[] = []
  lines.push(`项目：${projectRoot ?? '（无法定位项目根）'}`)
  lines.push(`状态：${stateLine(plan)}`)

  if (mounted.length > 0) {
    lines.push('已挂载（模型可见的工具名为 mcp__<名称>__*）：')
    for (const name of mounted) lines.push(`  - ${name}`)
  }

  if (unapproved.length > 0) {
    lines.push('未批准（用 /mcp-project trust <名称>… 只批准指定项）：')
    for (const name of unapproved) lines.push(`  - ${name}`)
  }

  if (skipped.length > 0) {
    lines.push('已跳过：')
    for (const note of skipped) lines.push(`  - ${note.name}：${note.reason}`)
  }

  if (view.renamed.length > 0) {
    lines.push('规范化重命名：')
    for (const item of view.renamed) lines.push(`  - ${item.originalName} → ${item.serverName}`)
  }

  if (mounted.length === 0 && unapproved.length === 0 && skipped.length === 0 && plan.kind === 'mount') {
    // `mcpServers` 缺失与空对象在 `readProjectMcpFile` 里归一到同一个 `{}`，此处无法
    // 区分，如实并列说明，不猜。
    lines.push('（.mcp.json 里没有声明任何服务器。）')
  }

  lines.push(USAGE)
  return { kind: 'success', text: lines.join('\n') }
}

/** 批准：写信任存储，然后按新状态重新挂载（幂等）。 */
async function runTrust(
  agent: AgentShape,
  names: string[],
  deps: CommandDeps,
): Promise<CommandOutcome> {
  const view = deps.inspect(agent)
  const anchor = trustAnchor(view.plan)

  if (anchor === undefined) {
    return {
      kind: 'error',
      text: `没有可批准的项目级 MCP 配置：${stateLine(view.plan)}`,
    }
  }
  if (view.mountable.length === 0) {
    return {
      kind: 'error',
      text: `这份 .mcp.json 没有可挂载的服务器，无需批准。运行 /mcp-project 查看原因。`,
    }
  }

  // 只认规范化名：`/mcp-project` 列出的、以及会话提示里 `pending` 列出的都是规范化名，
  // 用户照着复制即可。名字打错就报错而不是写进信任存储——写进去的条目永远不会命中
  // `isApproved`，批准会静默失效。
  const unknown = names.filter(name => !view.mountable.includes(name))
  if (unknown.length > 0) {
    return {
      kind: 'error',
      text: `未知的服务器名：${unknown.join('、')}。本文件的可挂载服务器：${view.mountable.join('、')}`,
    }
  }

  const store = deps.readStore()
  const already = new Set(approvedNames(view, store))
  // 无参数 = 批准整个文件；带参数 = 只批准指定项，同时**保留**同一指纹下已有的批准，
  // 否则 `trust a` 之后再 `trust b` 会把 a 挤掉。`already` 只含当前指纹命中的名字，
  // 因此文件改动后的陈旧记录不会被带过来。
  const requested = names.length === 0 ? new Set(view.mountable) : new Set(names)
  const servers = view.mountable.filter(name => requested.has(name) || already.has(name))

  try {
    // 复用计划携带的 projectRoot 与 fingerprint：信任键必须与 `isApproved` 的查询键
    // 逐字一致，自行推导（如用进程 cwd）会让批准永不生效（规格 §7.1）。
    await deps.writeStore(
      approve(store, anchor.projectRoot, anchor.fingerprint, servers, new Date().toISOString()),
    )
  } catch (error) {
    return { kind: 'error', text: `写入信任存储失败，未做任何改动：${message(error)}` }
  }

  // 按新状态重新检视再挂载：走同一条计划路径，保证 `/mcp-project` 显示与实际挂载一致。
  const after = deps.inspect(agent)
  const configs = after.plan.kind === 'mount' ? after.plan.configs : []
  deps.mountInto(agent, configs)

  const added = servers.filter(name => !already.has(name))
  const lines = [
    added.length === 0
      ? `已批准（无新增）：${servers.join('、')}`
      : `已批准：${added.join('、')}`,
  ]
  if (configs.length > 0) lines.push(`本会话已挂载：${configs.map(c => c.serverName).join('、')}`)
  else lines.push('本会话没有可挂载的服务器，运行 /mcp-project 查看原因。')
  return { kind: 'success', text: lines.join('\n') }
}

/** 撤销：写信任存储，然后卸载本会话已挂载的项目服务器。 */
async function runUntrust(agent: AgentShape, deps: CommandDeps): Promise<CommandOutcome> {
  const view = deps.inspect(agent)
  if (view.projectRoot === undefined) {
    return { kind: 'error', text: '无法定位当前会话的项目根，没有可撤销的项目级 MCP 批准。' }
  }

  const store = deps.readStore()
  const hadRecord = Object.hasOwn(store.projects, view.projectRoot)
  try {
    await deps.writeStore(revoke(store, view.projectRoot))
  } catch (error) {
    return { kind: 'error', text: `写入信任存储失败，未做任何改动：${message(error)}` }
  }
  deps.unmountFrom(agent)

  return {
    kind: 'success',
    text: hadRecord
      ? `已撤销 ${view.projectRoot} 的项目级 MCP 批准，并卸载本会话已挂载的项目服务器。`
      : `${view.projectRoot} 没有批准记录；已清理本会话的项目服务器挂载。`,
  }
}

/** 取错误消息文本；非 Error 抛出物降级为字符串。 */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 注册 `/mcp-project` 命令，返回可逆的注销函数。
 *
 * `commands` 服务缺失（极简宿主）时返回空操作：本插件在那种宿主上只剩会话提示与
 * 挂载能力，不应该让整个 `apply` 失败。
 */
export function registerCommands(ctx: HostContext, deps: CommandDeps): Disposer {
  const commands = ctx.get('commands') as CommandsService | undefined
  if (commands === undefined || typeof commands.register !== 'function') return () => {}

  return commands.register({
    name: COMMAND_NAME,
    description: DESCRIPTION,
    handler: (invocation) => {
      const agent = invocation.agent
      // 命令由某个会话的 UI 派发；没有 agent 就无法定位项目、也无处挂载。
      if (agent === undefined) {
        return { kind: 'error', text: `该命令必须在会话中运行。${USAGE}` }
      }

      const parsed = parseInput(invocation.rawInput)
      switch (parsed.kind) {
        case 'list':
          return renderList(deps.inspect(agent), deps.readStore())
        case 'trust':
          return runTrust(agent, parsed.names, deps)
        case 'untrust':
          return runUntrust(agent, deps)
        case 'unknown':
          return { kind: 'error', text: `未知的子命令「${parsed.verb}」。${USAGE}` }
      }
    },
  })
}
