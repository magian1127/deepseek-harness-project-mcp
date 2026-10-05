/**
 * 插件装配层（规格 §4.1 / §5）：本插件唯一做真实 I/O 与运行时交互的模块。
 *
 * 职责边界：
 * - 决策在 `session.ts`（纯函数），信任在 `trust.ts`（纯函数 + 注入 I/O），
 *   翻译在 `translate.ts`，解析在 `discovery.ts`。本层只把它们接到 Cordis 上。
 * - 挂载点是 `agent.ctx`（agent scope）而不是宿主 ctx：项目级 MCP 必须**按会话**
 *   生效——每个会话有自己的工作区与项目根。挂到宿主上会让第一个会话的项目服务器
 *   泄漏给所有会话，也是本插件存在的理由（规格 §5.1）。
 *
 * 安全要点：
 * - 未批准不挂载（规格 §13.4）：挂载路径只消费 `planSessionMount` 产出的
 *   `kind === 'mount'` 计划，该计划里的 `configs` 已经过 `isApproved` 过滤。
 * - 挂载**不 await 连接**（规格 §5.1）：`mcp-client` 的连接是懒的，等它就等于让
 *   会话创建卡在 MCP 握手上；`failOnStartupError: false` 保证启动失败不中断会话。
 * - 任何诊断只含服务器名与原因，绝不含 `.mcp.json` 内容或展开后的环境变量值（§10）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { readProjectMcpFile, findProjectRoot } from './discovery.js'
import { collectGlobalServerNames } from './global-rows.js'
import { renderNotice } from './notice.js'
import { loadAtomicWrite, loadMcpClient } from './profile-modules.js'
import { planSessionMount } from './session.js'
import type { SessionMountInput, SessionMountPlan } from './session.js'
import { approve, fingerprint, readTrustStore, writeTrustStore } from './trust.js'
import type { TrustStore } from './trust.js'
import { normalizeServerName } from './translate.js'
import { registerCommands } from './commands.js'
import type { CommandDeps, ProjectInspection } from './commands.js'
import type {
  AgentShape,
  HostContext,
  McpClientConfig,
  PluginFiberShape,
  SystemPromptService,
} from './types.js'

/** Cordis 插件名（与 Loader 行 `name` 无关，只用于诊断输出）。 */
export const name = 'project-mcp'

/**
 * 本插件没有可配置字段：`.mcp.json` 即配置源（规格 §4.1）。
 *
 * 刻意显式导出为 `undefined` 而不是 `null`：宿主设置页对 schema 做
 * `'toJSON' in Config` 检查（`packages/settings/settings/src/index.ts`），`null`
 * 会让 `in` 抛错并带崩整页；`undefined` 被当作"无 Config"安全降级。将来加字段时
 * 在这里放 schemastery schema，config 会以普通值传入 `apply`。
 */
export const Config = undefined

/** 会话提示段的排序位：与内置 MCP 段同档（`SECTION_ORDERS.MCP_SERVERS = 3100`）。 */
const MCP_SERVERS_ORDER = 3100

/** 会话提示段名；同一 scope 内重名会抛错，因此固定不变。 */
const NOTICE_SECTION = 'project-mcp'

/** 读文件为 UTF-8 文本；真实 fs 读，供 `session.ts` / `trust.ts` 注入。 */
function readFileUtf8(path: string): string {
  return readFileSync(path, 'utf8')
}

/** 取错误消息文本；非 Error 抛出物降级为字符串。 */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 原子写信任存储：`0600` + 文件锁（规格 §7.1）。
 *
 * `writeTrustStore` 只接受**同步** writer，而 `@deepseek-ai/dsh-atomic-write` 的
 * 原子写与文件锁都是异步 API。用一次捕获式调用向任务 4 取"目标路径 + 序列化文本"，
 * 再用异步原子写落盘——路径与格式仍由 `trust.ts` 单点决定，本层不重复实现，避免
 * 两处分叉写出读不回来的信任文件。
 *
 * profile 解析拿不到 `dsh-atomic-write` 时降级为"同目录临时文件 + rename"：rename
 * 在同一文件系统上是原子的，仍不会写出半份文件；失去的只是跨进程串行化。
 */
async function writeStoreAtomic(store: TrustStore): Promise<void> {
  let captured: { path: string; text: string } | undefined
  writeTrustStore((path, text) => {
    captured = { path, text }
  }, store)
  const { path, text } = captured!

  // withFileLock 要求父目录已存在；$DSH_HOME 在全新环境下可能还没有。
  mkdirSync(dirname(path), { recursive: true })

  const atomic = loadAtomicWrite() as
    | { writeFileAtomic?: Function; withFileLock?: Function }
    | null
  if (typeof atomic?.writeFileAtomic === 'function') {
    const commit = () => atomic.writeFileAtomic!(path, text, { mode: 0o600 })
    if (typeof atomic.withFileLock === 'function') {
      await atomic.withFileLock(path, commit)
    } else {
      await commit()
    }
    return
  }

  const temp = `${path}.tmp-${process.pid}`
  writeFileSync(temp, text, { mode: 0o600 })
  renameSync(temp, path)
}

/**
 * 把配置挂进该 agent 的 scope；同名已挂载则跳过。
 *
 * 幂等是必需的：重复 `/mcp-project trust` 会对同一个 `serverName` 再建一个
 * `mcp-client` 实例，而 `mcp-client` 用 WeakMap 守卫同 scope 内的重名
 * （`packages/mcp/mcp-client/src/index.ts`），第二个实例会在 `apply` 内抛错，
 * 结果是"批准成功但挂载没生效"。
 *
 * 不 await 返回的 fiber：只挂一个拒绝处理器，避免启动失败变成未处理拒绝
 * （`failOnStartupError: false` 时 `mcp-client` 本身不会抛，但 Config 校验失败会）。
 */
function mountInto(
  ctx: HostContext,
  mounted: WeakMap<AgentShape, Map<string, PluginFiberShape>>,
  McpClient: unknown,
  agent: AgentShape,
  configs: McpClientConfig[],
): void {
  if (configs.length === 0) return
  if (McpClient === null || McpClient === undefined) {
    ctx.logger?.warn?.('project-mcp：未能从 profile 解析到 mcp-client，跳过项目级 MCP 挂载')
    return
  }
  const agentCtx = agent.ctx
  if (agentCtx === undefined || typeof agentCtx.plugin !== 'function') return

  let byName = mounted.get(agent)
  if (byName === undefined) {
    byName = new Map()
    mounted.set(agent, byName)
  }

  for (const config of configs) {
    if (byName.has(config.serverName)) continue
    try {
      const fiber = agentCtx.plugin(McpClient, config)
      byName.set(config.serverName, fiber)
      // 只观察启动结果，不阻塞：`then` 走 `fiber.await()`，不触发 dispose。
      fiber.then(undefined, (error: unknown) => {
        ctx.logger?.warn?.(
          `project-mcp：项目级 MCP 服务器「${config.serverName}」启动失败：${message(error)}`,
        )
      })
    } catch (error) {
      ctx.logger?.error?.(
        `project-mcp：挂载项目级 MCP 服务器「${config.serverName}」失败：${message(error)}`,
      )
    }
  }
}

/** 卸载该 agent 已挂载的全部项目服务器（`/mcp-project untrust`）。 */
function unmountFrom(
  ctx: HostContext,
  mounted: WeakMap<AgentShape, Map<string, PluginFiberShape>>,
  agent: AgentShape,
): void {
  const byName = mounted.get(agent)
  if (byName === undefined) return
  for (const [serverName, fiber] of byName) {
    try {
      void Promise.resolve(fiber.dispose()).catch((error: unknown) => {
        ctx.logger?.warn?.(`project-mcp：卸载「${serverName}」失败：${message(error)}`)
      })
    } catch (error) {
      ctx.logger?.warn?.(`project-mcp：卸载「${serverName}」失败：${message(error)}`)
    }
  }
  byName.clear()
}

/**
 * 只读收集：`.mcp.json` 里全部**可挂载**服务器与全部跳过诊断（与信任状态无关）。
 *
 * 为什么要这份名单：部分批准时（批准了一部分、另一些还没批），未获批准的条目
 * **既不在** `plan.configs`（只含已批准项）**也不在** `plan.skipped`（只含被跳过项），
 * 直接照搬会让这些服务器在 `/mcp-project` 里静默消失——用户看不到它们，也就无从
 * 知道该批准什么。
 *
 * 为什么还要 `skipped`：`untrusted` 变体**不携带** `skipped`（见 `session.ts` 第 11 步），
 * 而它恰恰是用户批准**之前**看到的状态。只读 `plan.skipped` 会让"某个服务器为什么没
 * 出现"在最需要答案的时刻无从查起。这里的探针计划带着完整诊断，补上这个缺口。
 *
 * 取法：用一份"全部已批准"的合成信任存储再跑一次同一个决策函数，读它的 `configs`
 * 与 `skipped`。刻意复用任务 6 的去重与全局撞名过滤，而不是在本层重新实现一遍——
 * 两处规则一旦分叉，`/mcp-project` 显示的就会与实际挂载不符，比不显示更糟。
 */
function collectMountable(
  input: SessionMountInput,
  projectRoot: string | undefined,
): {
  mountable: string[]
  renamed: Array<{ originalName: string; serverName: string }>
  skipped: Array<{ name: string; reason: string }>
} {
  const none = { mountable: [], renamed: [], skipped: [] }
  if (projectRoot === undefined) return none

  const parsed = readProjectMcpFile(projectRoot, input.readFile)
  if (parsed.kind !== 'ok') return none

  const originalNames = Object.keys(parsed.servers)
  const normalized = originalNames.map(originalName => ({
    originalName,
    serverName: normalizeServerName(originalName),
  }))

  const everyName = [...new Set(normalized.map(item => item.serverName))]
  if (everyName.length === 0) return none

  const everythingApproved: TrustStore = approve(
    { version: 1, projects: {} },
    projectRoot,
    fingerprint(parsed.raw),
    everyName,
    '',
  )
  const probe = planSessionMount({ ...input, trust: everythingApproved })
  // 全部候选被过滤掉时探针是 `skip`（第 9 步），此时计划本身也是 `skip` 且自带
  // `skipped`，调用方回退到 `plan.skipped` 即可。
  if (probe.kind !== 'mount') return none

  const mountable = probe.configs.map(config => config.serverName)
  const mountableSet = new Set(mountable)
  const renamed = normalized.filter(
    item => item.originalName !== item.serverName && mountableSet.has(item.serverName),
  )
  return { mountable, renamed, skipped: probe.skipped }
}

/** 检视该 agent 所在项目：当前计划 + 展示所需的完整名单。 */
function inspectAgent(
  ctx: HostContext,
  agent: AgentShape,
): ProjectInspection {
  const header = agent.session?.header ?? {}
  const input: SessionMountInput = {
    header,
    projectExists: existsSync,
    readFile: readFileUtf8,
    trust: readTrustStore(readFileUtf8),
    // 必须传 Loader **本身**：`entries()` 在 Loader 上而不在 `loader.root` 上，
    // 传 root 会让名单静默变成空集，撞名守卫随之完全失效（规格 §8）。
    globalServers: collectGlobalServerNames(ctx.get('loader')),
    env: process.env,
  }

  const plan: SessionMountPlan = planSessionMount(input)

  // `invalid` / `skip` 变体不携带项目根，但提示文本需要它；用同一函数重算一次。
  const fallbackRoot = header.cwd !== undefined ? findProjectRoot(header.cwd, existsSync) : undefined
  const projectRoot =
    plan.kind === 'mount' || plan.kind === 'untrusted' ? plan.projectRoot : fallbackRoot

  return { projectRoot, plan, ...collectMountable(input, projectRoot) }
}

/**
 * 把提示写进该会话的系统提示（规格 §12）。
 *
 * 只在需要用户行动时调用（`renderNotice` 对 `mount` / `skip` 返回空串）。段文本用
 * `interpolate: false`：默认的严格 `{{变量}}` 插值会在渲染期对未知引用**抛错**，
 * 而这里的文本含用户路径，任何 `{{` 都会让整个会话的提示渲染失败。
 */
function injectNotice(ctx: HostContext, agent: AgentShape, text: string): void {
  const agentCtx = agent.ctx
  if (agentCtx === undefined || typeof agentCtx.effect !== 'function') return
  const systemPrompt = agentCtx.get('systemPrompt') as SystemPromptService | undefined
  if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') return

  agentCtx.effect(
    () =>
      systemPrompt.section({
        name: NOTICE_SECTION,
        order: MCP_SERVERS_ORDER,
        interpolate: false,
        text: () => text,
      }),
    NOTICE_SECTION,
  )
}

/**
 * 插件入口。
 *
 * 装配顺序刻意是"先命令、后监听"：命令注册是同步的，`apply` 返回后立刻可用；
 * 会话挂载依赖 `agent/created` 事件，只影响此后新建的会话。
 */
export function apply(ctx: HostContext, config: unknown): void {
  void config
  const McpClient = loadMcpClient()
  if (McpClient === null || McpClient === undefined) {
    // 安全侧：宁可不挂。命令仍然注册——查看状态、批准、撤销都不需要 mcp-client，
    // 少了它们用户连"为什么没挂上"都查不到。
    ctx.logger?.error?.(
      'project-mcp：未能从 profile 解析到 @deepseek-ai/dsh-mcp-client，本插件的项目级 MCP 挂载不可用',
    )
  }

  const mounted = new WeakMap<AgentShape, Map<string, PluginFiberShape>>()

  const deps: CommandDeps = {
    readStore: () => readTrustStore(readFileUtf8),
    writeStore: writeStoreAtomic,
    inspect: agent => inspectAgent(ctx, agent),
    mountInto: (agent, configs) => mountInto(ctx, mounted, McpClient, agent, configs),
    unmountFrom: agent => unmountFrom(ctx, mounted, agent),
  }

  // 所有注册走 ctx.effect，随 fiber 卸载可逆清理（宿主 ctx 与 agent ctx 皆是）。
  ctx.effect(() => registerCommands(ctx, deps), 'project-mcp:commands')

  ctx.effect(
    () =>
      ctx.on('agent/created', (payload: unknown) => {
        // 会话创建路径：这里的任何异常都会打断会话创建，而项目级 MCP 只是锦上添花。
        try {
          const agent = (payload as { agent?: AgentShape } | undefined)?.agent
          if (agent === undefined || agent.session === undefined) return

          const view = inspectAgent(ctx, agent)
          if (view.plan.kind === 'mount') {
            mountInto(ctx, mounted, McpClient, agent, view.plan.configs)
          }

          const notice = renderNotice(view.plan, view.projectRoot ?? '')
          if (notice !== '') injectNotice(ctx, agent, notice)
        } catch (error) {
          ctx.logger?.error?.(`project-mcp：会话挂载失败：${message(error)}`)
        }
      }),
    'project-mcp:agent-created',
  )
}
