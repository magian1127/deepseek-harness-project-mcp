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
  /**
   * 与信任状态无关的完整跳过诊断。
   *
   * 不能只读 `plan.skipped`：`untrusted` 变体**不携带**它（`session.ts` 第 11 步），
   * 而那正是用户批准**之前**看到的状态——只看计划会让"某个服务器为什么不出现"在
   * 最需要答案的时刻无从查起（规格 §12 要求跳过原因在 `/mcp-project` 可见）。
   * `index.ts` 用一份全批准的探针计划补齐这份名单；探针不可用（如全部候选被过滤，
   * 此时计划是 `skip`）时回退到 `plan.skipped`。
   */
  skipped: Array<{ name: string; reason: string }>
  /**
   * 本会话**实际**挂载的项目服务器名（插件侧挂载记账，按挂载顺序）。
   *
   * 刻意不取 `plan.configs`：计划回答"按当前信任状态**应当**挂什么"，与"现在什么是
   * 活的"是两件事。会话 A 批准后，此前已创建、`agent/created` 早已触发过的会话 B 的
   * 计划同样是 `mount`，但 B 一个服务器都没挂上——按计划渲染会让 `/mcp-project` 把
   * "计划要挂"报成"已挂载"，而这条命令的唯一职责就是回答后者。
   *
   * 反方向的偏差同样存在：会话存续期间 `.mcp.json` 被改动或删除后，计划会退回
   * `untrusted` / `skip`，而先前挂上的服务器仍在（本插件不监听文件变化）。因此状态行
   * 与这份名单是**两个独立口径**，不一致时必须并列呈现，不能相互代言。
   */
  mounted: string[]
  /**
   * 回收面：连接上限与本会话的连接状态。
   *
   * 为什么必须展示：连接可能**在用户不知情的情况下被回收**（超过上限时回收最久未活跃
   * 的空闲会话）。若命令不说明，用户看到工具消失只会以为插件坏了——而"被回收"是一个
   * 完全正常、且下次发消息就会自愈的状态。诊断价值全在于**说清楚它发生了**。
   */
  reclaim: ReclaimStatus
}

/** 本会话相对回收机制的状态。 */
export interface ReclaimStatus {
  /**
   * - `mounted`：本会话有已挂载的连接；
   * - `reclaimed`：记账在、但连接为空——被回收过（或从未挂上，由"状态"行区分）；
   * - `none`：本插件没有本会话的记账（会话 id 不可用，或从未走过挂载路径）。
   */
  status: 'mounted' | 'reclaimed' | 'none'
  /** 当前生效的连接上限（默认 8，可经插件 Config 配置）。 */
  limit: number
  /** 插件侧当前记账的会话总数（回收判定的候选面）。 */
  sessions: number
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
  /**
   * 读该 agent **当前实际挂载**的项目服务器名（插件侧记账，无 I/O）。
   *
   * 与 `inspect().mounted` 同源，单独暴露是为了让 `runTrust` 在挂载之后如实回报
   * "这次到底挂上了什么"，而不是照抄它请求挂载的 `configs`——两者在 mcp-client
   * 缺失、`ctx.plugin` 抛错或同名已挂载时会分叉。
   */
  mountedServers(agent: AgentShape): string[]
  /**
   * 把该会话的提示段刷新到**当前计划**：先撤下旧段，再按新计划重注入或留空。
   *
   * 为什么必须由命令层调用：`injectNotice` 原本只在 `agent/created` 触发，于是用户
   * 走完主流程（首次会话 → 提示未批准 → `/mcp-project trust` → 挂载成功）后，提示段
   * 仍写着"本会话未启用任何项目级 MCP"——模型在整个会话剩余时间里被持续误导，而这
   * 恰恰是最常见的路径。
   *
   * 实现按 `renderNotice(当前计划)` 重新求值，因此批准与撤销走同一条路径：批准后
   * `mount` 计划渲染出空串（撤下旧段），撤销后 `untrusted` 计划渲染出新的待批准文本
   * （替换旧段）。两个方向都收敛到"提示段 == 当前计划"，与会话创建时的口径一致。
   *
   * 撤下与重注入必须成对：同一 scope 内重名 section 会抛错，不先拆除旧段就无法用新
   * 文本替换它。
   */
  refreshNotice(agent: AgentShape): void
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

/**
 * 跳过诊断：优先用检视携带的完整名单（与信任状态无关），缺失时回退到计划自带的。
 *
 * `untrusted` 与 `invalid` 两个变体不携带 `skipped`，而 `untrusted` 恰恰是用户批准
 * **之前**的状态——只读计划会让跳过原因在最需要答案的时刻消失。`view.skipped` 由
 * `index.ts` 的全批准探针补齐；探针不可用时（全部候选被过滤，计划本身是 `skip`）
 * 回退到 `plan.skipped`。
 */
function skippedNotes(view: ProjectInspection): Array<{ name: string; reason: string }> {
  if (view.skipped.length > 0) return view.skipped
  const { plan } = view
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
  // 取自**真实挂载记账**（`index.ts` 的 `AgentRegistrations.servers`），不是 `plan.configs`：
  // 计划回答"按当前信任状态应当挂什么"，本命令回答"现在什么是活的"。两者可以合法地
  // 不一致（别的会话批准后本会话的计划变成 `mount` 却什么都没挂；或挂载之后
  // `.mcp.json` 被改动，计划退回 `untrusted` 而旧挂载仍在），因此下面分别呈现，
  // 不用一个口径去代言另一个。
  const mounted = view.mounted
  const mountedSet = new Set(mounted)
  const unapproved = view.mountable.filter(name => !approvedSet.has(name))
  const skipped = skippedNotes(view)

  const lines: string[] = []
  lines.push(`项目：${projectRoot ?? '（无法定位项目根）'}`)
  lines.push(`状态：${stateLine(plan)}`)

  // 连接面：上限与"被回收"状态。被回收的会话必须说清楚——否则用户看到工具消失只会
  // 以为插件坏了，而实际上下次发消息就会自动重挂。
  const { reclaim } = view
  lines.push(`连接上限：${reclaim.limit} 个会话（当前记账 ${reclaim.sessions} 个）`)
  if (reclaim.status === 'reclaimed' && plan.kind === 'mount') {
    lines.push(
      '本会话的连接已被回收（超过上限时回收最久未活跃的空闲会话）：' +
        '下次发消息时自动重挂，**该次请求的工具列表仍是旧的，下一轮可见**。',
    )
  }

  if (mounted.length > 0) {
    lines.push('已挂载（模型可见的工具名为 mcp__<名称>__*）：')
    for (const name of mounted) lines.push(`  - ${name}`)
  }

  // 计划要挂、但本会话实际没挂上的项：必须在"已挂载"之外单独说明，否则用户会按
  // 计划误以为工具已就位（会话 B 的典型情形：批准发生在别处，本会话从未挂载）。
  const plannedNotMounted = approved.filter(name => !mountedSet.has(name))
  if (plannedNotMounted.length > 0) {
    lines.push('已批准但本会话未挂载（挂载只发生在会话创建时或本会话执行 trust 时）：')
    for (const name of plannedNotMounted) lines.push(`  - ${name}`)
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

  if (
    mounted.length === 0 &&
    plannedNotMounted.length === 0 &&
    unapproved.length === 0 &&
    skipped.length === 0 &&
    plan.kind === 'mount'
  ) {
    // `mcpServers` 缺失与空对象在 `readProjectMcpFile` 里归一到同一个 `{}`，此处无法
    // 区分，如实并列说明，不猜。
    lines.push('（.mcp.json 里没有声明任何服务器。）')
  }

  // 末尾给出**可照抄的下一步**，而不是只列用法：用户不必记住子命令拼写。
  // 只在确实需要用户行动时提示；已经挂好时不啰嗦（避免每条命令都刷一遍用法）。
  if (unapproved.length > 0) {
    lines.push(
      `下一步：运行 /mcp-project trust 批准这份文件的全部服务器，` +
        `或 /mcp-project trust ${unapproved.join(' ')} 只批准以上列出的项。`,
    )
  } else if (plannedNotMounted.length > 0) {
    lines.push(
      '下一步：这些服务器已在信任列表中，但本会话未挂载——重开一个会话即可挂载，' +
        '或运行 /mcp-project trust 在本会话立即挂载。',
    )
  }

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

  // 按新状态重新检视再挂载：走同一条计划路径，保证挂载集合与 `/mcp-project` 同源。
  const after = deps.inspect(agent)
  const configs = after.plan.kind === 'mount' ? after.plan.configs : []
  deps.mountInto(agent, configs)

  // 提示段必须在挂载之后刷新，且刷新的判据是**挂载后的当前计划**：
  // 走完主流程（首次会话注入"尚未批准" → 这里批准 → 挂载成功）之后，旧提示若留着，
  // 模型会在整个会话剩余时间里被"本会话未启用任何项目级 MCP"持续误导。
  // `refreshNotice` 内部按 `renderNotice(新计划)` 求值：`mount` 计划渲染空串 → 撤下。
  deps.refreshNotice(agent)

  // 如实回报**实际**挂载结果而不是请求挂载的 `configs`：两者在 mcp-client 缺失、
  // `ctx.plugin` 抛错时会分叉，照抄 `configs` 会让"批准成功但没挂上"变成假象。
  const mounted = deps.mountedServers(agent)
  const added = servers.filter(name => !already.has(name))
  const lines = [
    added.length === 0
      ? `已批准（无新增）：${servers.join('、')}`
      : `已批准：${added.join('、')}`,
  ]
  if (mounted.length > 0) lines.push(`本会话已挂载：${mounted.join('、')}`)
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

  // 撤销后旧提示同样是错的陈述：会话创建时注入的"尚未批准"已经不再成立（撤销把状态
  // 推回 `untrusted`，文本其实仍然正确），而更常见的情形是撤销前根本没有提示、撤销后
  // 反而需要一条。刷新按撤销后的计划重算：`skip`（无 `.mcp.json`）渲染空串 → 撤下；
  // `untrusted` 渲染新的待批准文本 → 替换旧段。
  deps.refreshNotice(agent)

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
 * 挂载能力，不应该让整个 `apply` 失败。但**必须留下诊断**——命令面无声消失时，
 * 用户连"为什么没有 `/mcp-project`"都无从查起，而这恰恰是他诊断"项目 MCP 没挂上"
 * 的唯一入口（规格 §12）。`apply` 之后服务被卸载也会走到这条分支。
 */
export function registerCommands(ctx: HostContext, deps: CommandDeps): Disposer {
  const commands = ctx.get('commands') as CommandsService | undefined
  if (commands === undefined || typeof commands.register !== 'function') {
    ctx.logger?.warn?.(
      'project-mcp：宿主没有 commands 服务，/mcp-project 命令未注册；本插件在缺失该服务的 profile 上仍会按会话注入提示',
    )
    return () => {}
  }

  return commands.register({
    name: COMMAND_NAME,
    description: DESCRIPTION,
    // **必须声明 `input`**：客户端只把带参数的行路由给声明了 `input` 的命令
    // （`packages/client/ui-commands/src/client/service.ts:340-344`：`desc.input !== undefined`
    // 才 `leadingClaim`，否则 `if (!bare) return undefined` → 该行作为普通消息发给模型）。
    // 漏了它，`/mcp-project trust mudblazor` 会被当成对话，而裸 `/mcp-project` 仍正常
    // ——症状极具误导性。`hint` 必须是非空字符串，否则注册时抛 TypeError
    // （`packages/interaction/commands/src/index.ts:193-206`）。
    input: { hint: '[trust [<名称>…] | untrust]' },
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
