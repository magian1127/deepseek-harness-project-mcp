/**
 * 插件装配层（规格 §4.1 / §5）：本插件唯一做**会话数据** I/O 与运行时交互的模块。
 * （`profile-modules.ts` 做 profile 模块解析的真实 I/O，是这条不变量的显式例外。）
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
 * - 挂载的 stdio 服务器在 `.mcp.json` 给出的 `args` 之后带一个**只含 SessionId** 的
 *   会话标记参数（`--project-mcp-session <SessionId>`）：多会话会 spawn 多个命令行
 *   逐字相同的子进程，标记是分辨归属的唯一手段。服务器忽略未知参数，因此不影响运行。
 */
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

import { errorName, validateMountConfig } from './config-guard.js'
import { McpFileTooLargeError, readProjectMcpFile, findProjectRoot } from './discovery.js'
import { collectGlobalServerNames } from './global-rows.js'
import { POLL_INTERVAL_MS, PROBE_TIMEOUT_MS } from './health.js'
import { renderNotice } from './notice.js'
import { loadAtomicWrite, loadMcpClient } from './profile-modules.js'
import { ensureServeReady, spawnDetached, splitServe } from './serve.js'
import type { ServeIo } from './serve.js'
import { planSessionMount } from './session.js'
import type { SessionMountInput, SessionMountPlan } from './session.js'
import { withSessionTag } from './session-tag.js'
import { approve, fingerprint, readTrustStore, writeTrustStore } from './trust.js'
import type { TrustStore } from './trust.js'
import { normalizeServerName } from './translate.js'
import { registerCommands } from './commands.js'
import type { CommandDeps, ProjectInspection } from './commands.js'
import type {
  AgentShape,
  Disposer,
  HostContext,
  McpClientConfig,
  PluginFiberShape,
  SystemPromptService,
} from './types.js'

/** Cordis 插件名（与 Loader 行 `name` 无关，只用于诊断输出）。 */
export const name = 'project-mcp'

/**
 * 本插件同步依赖的宿主服务。
 *
 * 显式声明而不是在 `apply` 里碰运气：缺少任一服务时 Cordis 让插件保持**未激活**
 * 并等待，而不是让 `apply` 在半个装配状态下抛错（`practices.md`「Stability」第 20 行）。
 * 声明之后下面仍保留缺失分支的诊断——服务可能在 `apply` 之后被卸载，而
 * `commands` 缺失会让命令面无声消失、`loader` 缺失会让撞名守卫静默退化为空集，
 * 这两种退化都必须留下可查的日志（规格 §8.2 / §12）。
 */
export const inject = ['commands', 'loader', 'systemPrompt'] as const

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

/**
 * `.mcp.json` 的尺寸上限：1 MiB。
 *
 * 为什么必须有上限：本插件的核心威胁模型正是"克隆陌生仓库并打开它"，而
 * `agent/created` 是**会话创建的同步路径**——`readFileSync` 会把整份文件读进内存并
 * 阻塞该路径。一个 500 MB 的 `.mcp.json` 足以在会话创建时耗掉大量内存；Node 只在
 * >2 GiB 时才抛 `ERR_FS_FILE_TOO_LARGE`，那已经太晚（且会被 catch 成"文件不存在"，
 * 诊断反而更差）。
 *
 * 为什么是 1 MiB：真实的 `.mcp.json` 只声明服务器列表（几十条条目、含 `${VAR}` 引用
 * 与少量 args），实测远小于 100 KiB；1 MiB 给了两个数量级的余量，不会误伤任何合法
 * 文件，同时把"陌生仓库里的异常大文件"挡在会话创建路径之外。
 */
const MAX_MCP_FILE_BYTES = 1024 * 1024

/**
 * 读文件为 UTF-8 文本；真实 fs 读，供 `session.ts` / `trust.ts` 注入。
 *
 * 先 `open` 再 `fstat` 取大小、超限即抛 `McpFileTooLargeError`，**不读内容**：检查必须
 * 在读之前，否则内存已经花掉了。刻意走 fd 而不是 `statSync(path)` + `readFileSync(path)`：
 * 后者的两次系统调用之间文件可能被写大（`stat` 看到 1 KiB、`read` 读到 5 GB），尺寸闸门
 * 就成了摆设；fd 版本断言的是**同一个 inode** 在打开时的大小，没有这个窗口。
 *
 * 抛哨兵而不是返回空串/截断文本——截断会让 JSON 解析失败并报成"不是合法 JSON"，把
 * "文件太大"误诊成"文件损坏"；空串会让 `discovery` 把它当成"文件不存在"。
 * `discovery.ts` 把哨兵归一为 `invalid`（含尺寸与上限），`trust.ts` 的 catch 把它归一为
 * "全部未信任"（失败关闭），两者都符合各自契约。
 *
 * 尺寸检查刻意放在这个**注入实现**里，而不是 `discovery.ts`：后者不 import `node:fs`，
 * 靠注入 I/O 保持零 I/O 可测性（见 `discovery.ts` 模块头）。
 */
function readFileUtf8(path: string): string {
  // `openSync` 自身对不存在/无权限的文件抛错，与 `readFileSync` 同语义：调用方的
  // catch（`absent` / 空存储）照常生效，因此这里不做额外处理。
  const fd = openSync(path, 'r')
  try {
    const { size } = fstatSync(fd)
    if (size > MAX_MCP_FILE_BYTES) {
      throw new McpFileTooLargeError(path, size, MAX_MCP_FILE_BYTES)
    }
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

/**
 * 取错误消息文本；非 Error 抛出物降级为字符串。
 *
 * 只用于**本插件自己产生**的错误（命令层写盘失败、提示段拆除失败等），其消息体
 * 不含 `.mcp.json` 内容。凡是错误可能携带 config 的位置一律改用 `errorName()`
 * （见 `config-guard.ts` 的说明）。
 */
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
 * 该 agent 在**插件侧**留下的登记项。
 *
 * 为什么插件要自己留一份：`agent.ctx` 上的注册有**两个 owner**（`practices.md`
 * 第 8 行）。agent 销毁会清掉 `agent.ctx` 上的注册，但插件卸载（禁用、HMR 重载）
 * **不会**——只把 disposer 交给 `agent.ctx` 的话，插件停用后活会话会一直保留项目级
 * MCP 挂载与陈旧的提示段，直到该 agent 被销毁（第 19 行明文要求"把 disposer 按
 * agent 键控地留在插件自己的 effect 里"）。
 *
 * 用 `Map` 而不是 `WeakMap`：插件卸载时要能遍历回收，而 `WeakMap` 不可迭代。
 * 代价是它强引用登记项（含 fiber 与 section disposer），因此 `agent/disposed` 必须
 * 把条目删掉，否则插件存活期间会一直攥着已销毁的会话。
 */
interface AgentRegistrations {
  /** 已挂载的项目级 MCP 服务器：`serverName` → `agent.ctx.plugin()` 返回的 fiber。 */
  servers: Map<string, PluginFiberShape>
  /** 提示段的 section disposer；未注入过提示时为 `undefined`。 */
  notice?: Disposer
}

/**
 * 插件侧登记表的键：`agent.id`（SessionId），**不是 agent 对象引用**。
 *
 * 为什么不能用对象引用（这是一个已确证的运行时缺陷）：`agent/created` 可能对**同一个
 * sessionId** 触发两次，而两次传入的是**不同的 agent 对象**（对象不是身份，`id` 才是：
 * `Agent` 的定义就是 `readonly id: SessionId`，`packages/core/agent/src/types.ts:15-18`）。
 * 按引用取登记项会落空 → 建出空的新条目 → `servers.has(...)` 的幂等判定失效 →
 * 同一个 `.mcp.json` 服务器被 `ctx.plugin()` 挂第二遍。而 `mcp-client` 的重名守卫是按
 * **scope 对象**隔离的（`activeServerNames` 是 `WeakMap<object, Set<string>>`，
 * `packages/mcp/mcp-client/src/index.ts:47`），两个 agent 对象的 scope 不同，第二个实例
 * 因此能挂上——于是同一会话出现两份连接与**两个命令行逐字相同的子进程**。
 *
 * `agent/disposed` 处理器必须用**同一个键**：否则清理会落到另一个（或根本不存在的）
 * 条目上，登记表会一直攥着已销毁会话的 fiber。
 */
type AgentKey = string

/**
 * 取该 agent 的登记键；`id` 不是非空字符串时返回 `undefined`（调用方跳过并记诊断）。
 *
 * 为什么宁可跳过挂载也不退回对象引用：`id` 是会话身份，而对象引用恰好是上面那条缺陷的
 * 成因。键不可用时"少挂一次"是安全侧——用户在 `/mcp-project` 里看到未挂载，重开会话
 * 即可恢复；重复挂载则会多 spawn 一个子进程，且用户完全没有可见的线索。`id` 缺失属于
 * 契约漂移（真实 `Agent` 一定有 `SessionId`），因此必须留下 warn。
 */
function agentKeyOf(agent: AgentShape): AgentKey | undefined {
  const id: unknown = agent.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * 取（必要时建立）该 agent 的插件侧登记项；键不可用时返回 `undefined`。
 *
 * 只有挂载与提示段注入需要**建立**条目；只读路径（`mountedServers` / `removeNotice`）
 * 键不可用时直接当作"没有条目"，不得因此凭空建一个空条目。
 */
function registrationsOf(
  agents: Map<AgentKey, AgentRegistrations>,
  agent: AgentShape,
): AgentRegistrations | undefined {
  const key = agentKeyOf(agent)
  if (key === undefined) return undefined
  let record = agents.get(key)
  if (record === undefined) {
    record = { servers: new Map() }
    agents.set(key, record)
  }
  return record
}

/**
 * 卸载一组已挂载的项目服务器。
 *
 * `dispose()` 是异步的，本函数不 await：调用方既有同步的命令处理器（`untrust`），
 * 也有同步的 effect 卸载钩子，两处都不能返回 promise。失败降级为 warning——卸载
 * 失败不该反过来打断会话或插件卸载。
 */
function disposeServers(ctx: HostContext, servers: Map<string, PluginFiberShape>): void {
  for (const [serverName, fiber] of servers) {
    try {
      void Promise.resolve(fiber.dispose()).catch((error: unknown) => {
        ctx.logger?.warn?.(`project-mcp：卸载「${serverName}」失败：${message(error)}`)
      })
    } catch (error) {
      ctx.logger?.warn?.(`project-mcp：卸载「${serverName}」失败：${message(error)}`)
    }
  }
  servers.clear()
}

/**
 * 把配置挂进该 agent 的 scope；同名已挂载则跳过。
 *
 * 幂等是必需的：重复 `/mcp-project trust` 会对同一个 `serverName` 再建一个
 * `mcp-client` 实例，而 `mcp-client` 用 WeakMap 守卫同 scope 内的重名
 * （`packages/mcp/mcp-client/src/index.ts:162-176`），第二个实例会在 `apply` 内抛错，
 * 结果是"批准成功但挂载没生效"。
 *
 * **幂等按 `agent.id` 记账**（见 `AgentKey`）：同一个 sessionId 的第二个 agent 对象
 * 必须命中同一个登记项，否则重名守卫挡不住第二个实例——它的 scope 是另一个对象。
 *
 * **非法配置在这里就被拦下**（`validateMountConfig`），永远不会到达 `ctx.plugin()`：
 * `ctx.plugin()` 内部的 `_resolveConfig` 失败会抛 `ValidationError`，而 Cordis 在
 * `_reload` 的 catch 里把它整条记进日志（`vendor/cordis/src/fiber.ts:659-663`）。
 * 那条消息由 schemastery 的 union 错误拼成
 * （`vendor/schemastery/src/index.ts:834` 的 `` `expected ... but got ${JSON.stringify(data)}` ``），
 * 含**整个 config**——包括展开后的 `env` / `headers` 凭据。插件侧改记 `errorName()`
 * 只能堵住自己的记录点，堵不住 Cordis 那一处；只有在挂载前自校验才能同时覆盖两者。
 *
 * 不 await 返回的 fiber：只挂一个拒绝处理器，避免启动失败变成未处理拒绝
 * （`failOnStartupError: false` 时 `mcp-client` 本身不会抛，但 `apply` 内仍可能抛，
 * 例如 serverName 在 agent scope 内已被别的实例占用）。
 *
 * ## 为什么是 async：HTTP 条目的"确保服务就绪"发生在挂载**之前**
 *
 * HTTP 模式下 DSH 不 spawn 子进程，服务由外部启动；服务没在跑时 DSH 连不上、工具不可用。
 * `serve` 字段让插件在健康检查失败时把服务拉起来（`serve.ts`），**等服务就绪再挂**。
 *
 * 等待发生在 `agent/created` 的监听器里，这是**有意**的：`agent/created` 是 serial 且被
 * await（`packages/core/agent/src/index.ts:550`），契约明确 "AgentLoop holds queued input
 * until all listeners finish"（`packages/core/agent/src/runtime-types.ts:257`）——因此用户
 * 的第一条消息会等到服务就绪，工具在首次请求前就注册好。
 *
 * 这**不违反**红线 5：那条红线禁止的是 await `mcp-client` 的**握手**（它可能永远不成功，
 * 等它等于让会话创建卡在一个不受控的握手上）。这里等的是**健康检查**——有明确上限
 * （`readyTimeoutMs`，默认 120 秒）、失败不抛、且服务是我们自己启动的。`ctx.plugin()`
 * 返回的 fiber **仍然不 await**（见上）。
 *
 * 关键：等待只影响**该条目自己**。同一个 agent 里其余的服务器（尤其是 stdio 条目）
 * 照旧立即挂上，不会因为一个 HTTP 条目的服务在慢慢启动而推迟。
 */
async function mountInto(
  ctx: HostContext,
  agents: Map<AgentKey, AgentRegistrations>,
  McpClient: unknown,
  agent: AgentShape,
  configs: McpClientConfig[],
  serve: { inflight: Map<string, Promise<void>>; io: ServeIo },
): Promise<void> {
  if (configs.length === 0) return
  if (McpClient === null || McpClient === undefined) {
    ctx.logger?.warn?.('project-mcp：未能从 profile 解析到 mcp-client，跳过项目级 MCP 挂载')
    return
  }
  const agentCtx = agent.ctx
  if (agentCtx === undefined || typeof agentCtx.plugin !== 'function') return

  // 键不可用就**不挂载**：退回对象引用正是重复挂载那条缺陷的成因（见 `AgentKey`）。
  // 宁可少挂一次（用户可见、重开会话即恢复），也不能因为键不可用而多 spawn 一个进程。
  const key = agentKeyOf(agent)
  if (key === undefined) {
    ctx.logger?.warn?.(
      'project-mcp：会话 agent 的 id 缺失或不是非空字符串，无法按会话记账，已跳过项目级 MCP 挂载',
    )
    return
  }
  const record = registrationsOf(agents, agent)
  // `key` 已判非空，`registrationsOf` 不可能返回 `undefined`；仍按可能缺失处理，避免
  // 依赖两处判定的一致性（将来改键规则时不会静默变成非空断言崩溃）。
  if (record === undefined) return
  const { servers } = record

  for (const config of configs) {
    if (servers.has(config.serverName)) continue

    // `serve` 是本插件自己的元数据，**不在** `mcp-client` 的 Config schema 里，必须在
    // 任何消费点之前剥离（见 `splitServe`：它还兼着"防止展开后的 env 值经 schema 校验
    // 错误消息漏进日志"的安全职责）。剥离后的 `config` 才是进守卫、进标记、进
    // `ctx.plugin()` 的那一份。
    const { config: bare, serve: serveMeta } = splitServe(config)

    // 自校验：不通过就跳过并记安全诊断，绝不交给 ctx.plugin()。诊断只含服务器名与
    // 字段路径/错误类型，不含任何配置值（红线 3）。
    //
    // 刻意放在"确保服务就绪"**之前**：下面那一步可能等满 `readyTimeoutMs`（默认 120 秒），
    // 而为一个注定不会挂载的配置去拉起一个服务、再等它两分钟，是纯粹的浪费——何况
    // 拉起来的服务会一直活着（生命周期归它自己）。
    const guarded = validateMountConfig(McpClient, bare)
    if (!guarded.ok) {
      ctx.logger?.error?.(
        `project-mcp：项目级 MCP 服务器「${bare.serverName}」的配置未通过 schema 校验，已跳过挂载（${guarded.reason}）`,
      )
      continue
    }

    // 确保服务就绪（仅 HTTP 条目；stdio 条目零额外动作）。失败一律降级为日志，
    // **绝不**抛出——调用点在会话创建路径上（红线 4）。
    try {
      await ensureServeReady({
        serverName: bare.serverName,
        ...(bare.transport === 'streamable-http' ? { url: bare.url } : {}),
        ...(serveMeta === undefined ? {} : { serve: serveMeta }),
        inflight: serve.inflight,
        io: serve.io,
        logger: ctx.logger ?? {},
      })
    } catch (error) {
      ctx.logger?.warn?.(
        `project-mcp：确保项目级 MCP 服务器「${bare.serverName}」的服务就绪时出错` +
          `（错误类型：${errorName(error)}），仍继续挂载`,
      )
    }

    // 等待期间该条目可能已被别的路径挂上（同一 agent 的并发挂载，或 `/mcp-project trust`
    // 与本函数交叉）。重名守卫只按 scope 对象隔离，挡不住同一 scope 的第二次注册——
    // 会多出一个实例与一次子进程 spawn。因此这里**复查**一次。
    if (servers.has(bare.serverName)) continue

    try {
      // 标记在守卫**之后**追加：守卫只作准入闸，标记是挂载期的修饰，且必须在交给
      // `ctx.plugin()` 的那一份上（守卫返回的 config 可能不是入参本身）。
      const fiber = agentCtx.plugin(McpClient, withSessionTag(guarded.config, key))
      // fiber 登记在插件侧：插件卸载时由 apply 的 effect 统一 dispose（见
      // AgentRegistrations）。agent 销毁时 agent.ctx 也会回收它，两条路径都成立。
      servers.set(bare.serverName, fiber)
      // 只观察启动结果，不阻塞：`then` 走 `fiber.await()`，不触发 dispose。
      //
      // 刻意**不**透传 `message(error)`：fiber 拒绝的一种来源是 Config 校验失败，而
      // schemastery 的 union 错误消息会把**整个 config**（含展开后的 `env` / `headers`
      // 凭据）回显进日志，直接违反红线 3。上面的自校验已让**非法 config 不可能**走到
      // 这里，因此这条日志实际只承载 `apply` 内的启动失败（连接、工具同步、重名等）；
      // 但校验器将来若放行、或 mcp-client 的 Config 与 schema 分叉，它仍是最后一道
      // 防线，所以口径保持"只记固定文本与 `error.name`"。
      fiber.then(undefined, (error: unknown) => {
        ctx.logger?.warn?.(
          `project-mcp：项目级 MCP 服务器「${bare.serverName}」启动失败（错误类型：${errorName(error)}），已从挂载记账移除`,
        )
        // 启动失败的 fiber 停在 FAILED 状态（`vendor/cordis/src/fiber.ts:576` 的
        // `_getState` 把 `_error` 映射成 `FiberState.FAILED`），实例并没有活着。留在
        // 记账里会让 `/mcp-project` 把"已挂载（模型可见的工具名为 mcp__<名称>__*）"报给
        // 一个不存在实例——而 `mounted` 的全部理由就是回答"现在什么是活的"。
        //
        // 按身份摘除：条目可能已被**后来者**替换（同名重挂，或本名被重新批准后挂上新的
        // fiber），那种情况下旧 fiber 的拒绝不得误删新条目。比较引用即可，不需要额外代际号。
        if (servers.get(bare.serverName) === fiber) servers.delete(bare.serverName)
      })
    } catch (error) {
      // 同步抛出同样可能是 Config 校验（`ctx.plugin()` 内部 resolveConfig 是同步的），
      // 因此这里的诊断口径与上面一致。
      ctx.logger?.error?.(
        `project-mcp：挂载项目级 MCP 服务器「${bare.serverName}」失败（错误类型：${errorName(error)}）`,
      )
    }
  }
}

/** 卸载该 agent 已挂载的全部项目服务器（`/mcp-project untrust`）。 */
function unmountFrom(
  ctx: HostContext,
  agents: Map<AgentKey, AgentRegistrations>,
  agent: AgentShape,
): void {
  const key = agentKeyOf(agent)
  if (key === undefined) return
  const record = agents.get(key)
  if (record === undefined) return
  disposeServers(ctx, record.servers)
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

/** 检视该 agent 所在项目：当前计划 + 展示所需的完整名单 + 真实挂载记账。 */
function inspectAgent(
  ctx: HostContext,
  agents: Map<AgentKey, AgentRegistrations>,
  agent: AgentShape,
): ProjectInspection {
  const header = agent.session?.header ?? {}
  // 必须传 Loader **本身**：`entries()` 在 Loader 上而不在 `loader.root` 上，
  // 传 root 会让名单静默变成空集，撞名守卫随之完全失效（规格 §8）。
  const loader = ctx.get('loader')
  if (loader === undefined) {
    // 撞名守卫退化必须可见：静默的空集会伪装成"没有任何全局行"，于是同名的项目
    // 服务器照常挂载，遮蔽全局行并多 spawn 一个子进程（规格 §8.2）。
    ctx.logger?.warn?.(
      'project-mcp：未能从宿主解析到 loader，无法收集全局 MCP 名单，撞名守卫本次退化为空集',
    )
  }
  const input: SessionMountInput = {
    header,
    projectExists: existsSync,
    readFile: readFileUtf8,
    trust: readTrustStore(readFileUtf8),
    globalServers: collectGlobalServerNames(loader),
    env: process.env,
  }

  const plan: SessionMountPlan = planSessionMount(input)

  // `serve` 字段畸形时条目**仍然挂载**，因此那条诊断不在 `skipped` 里，也没有别的展示面。
  // 会话创建路径上只记日志，**绝不**进会话提示：一条写错的辅助配置不该出现在模型上下文
  // 里（红线 4 的降级方向）。`/mcp-project` 也不展示它——那份输出的每一条都对应"用户需要
  // 做点什么"，而"serve 写错了"只影响自动拉起，服务已在跑时毫无影响。
  if (plan.kind === 'mount') {
    for (const note of plan.diagnostics) ctx.logger?.warn?.(`project-mcp：${note}`)
  }

  // `invalid` / `skip` 变体不携带项目根，但提示文本需要它；用同一函数重算一次。
  const fallbackRoot = header.cwd !== undefined ? findProjectRoot(header.cwd, existsSync) : undefined
  const projectRoot =
    plan.kind === 'mount' || plan.kind === 'untrusted' ? plan.projectRoot : fallbackRoot

  return {
    projectRoot,
    plan,
    ...collectMountable(input, projectRoot),
    // 真实挂载记账，而不是计划：`/mcp-project` 的"已挂载"一列必须回答"现在什么是活的"。
    // 会话 A 批准后，此前已创建、`agent/created` 早已触发过的会话 B 计划同样是
    // `mount`，但 B 一个服务器都没挂上——按计划渲染会把"计划要挂"报成"已挂载"。
    mounted: mountedServers(agents, agent),
  }
}

/**
 * 撤下该会话的提示段（若已注入）。
 *
 * 必须先撤下再重注入：同一 scope 内重名 section 会抛错，而 `injectNotice` 原本对
 * 已注入的会话**直接 return**——这正是"批准后提示段不刷新"的另一半成因。
 *
 * 只清 `record.notice` 而**不**删登记项：`servers` 记账必须留着（见 `AgentRegistrations`）。
 * 重复调用幂等（`notice` 已清空时直接返回）。
 */
function removeNotice(
  ctx: HostContext,
  agents: Map<AgentKey, AgentRegistrations>,
  agent: AgentShape,
): void {
  const key = agentKeyOf(agent)
  if (key === undefined) return
  const record = agents.get(key)
  if (record?.notice === undefined) return
  const dispose = record.notice
  record.notice = undefined
  try {
    dispose()
  } catch (error) {
    // 撤下失败降级为警告：提示段陈旧会误导模型，但不该反过来打断命令执行。
    ctx.logger?.warn?.(`project-mcp：移除会话提示段失败：${message(error)}`)
  }
}

/**
 * 把提示写进该会话的系统提示（规格 §12）。
 *
 * 只在需要用户行动时调用（`renderNotice` 对 `mount` / `skip` 返回空串）。段文本用
 * `interpolate: false`：默认的严格 `{{变量}}` 插值会在渲染期对未知引用**抛错**，
 * 而这里的文本含用户路径，任何 `{{` 都会让整个会话的提示渲染失败。
 *
 * 段注册在 `agent.ctx` 上（作用域正确：提示只属于该会话），但返回的 section
 * disposer **同时**留在插件侧登记项里：`agent.ctx` 上的注册有两个 owner，插件卸载
 * 不会回收它们（`practices.md` 第 8 / 19 行）。已经注入过提示的会话不重复注册——
 * 同一 scope 内重名 section 会抛错。
 *
 * 键不可用（`agent.id` 不是非空字符串）时**不注入**：登记项建立不了，disposer 就无处
 * 存放，插件卸载时无法回收这条 section（`agent.ctx` 只是它的第二个 owner）。宁可不注入。
 */
function injectNotice(
  ctx: HostContext,
  agents: Map<AgentKey, AgentRegistrations>,
  agent: AgentShape,
  text: string,
): void {
  const agentCtx = agent.ctx
  if (agentCtx === undefined || typeof agentCtx.effect !== 'function') return
  const systemPrompt = agentCtx.get('systemPrompt') as SystemPromptService | undefined
  if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') return

  const record = registrationsOf(agents, agent)
  if (record === undefined) return
  if (record.notice !== undefined) return

  // 先把注册结果交给 agent.ctx（作用域归属），再把同一个 disposer 记进插件侧：
  // `ctx.effect` 返回的是该 effect 的 disposer，与 section 的 disposer 等价可逆。
  record.notice = agentCtx.effect(
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
 * 把该会话的提示段对齐到**当前**计划（缺陷修复：批准/撤销后提示必须刷新）。
 *
 * 主流程是"首次会话 → 提示尚未批准 → `/mcp-project trust` → 挂载成功"，而
 * `injectNotice` 原本只在 `agent/created` 触发，于是挂载成功后提示段仍写着"本会话
 * 未启用任何项目级 MCP"——模型在整个会话剩余时间里被持续误导。
 *
 * 修法是"先撤下、再按新计划重注入或留空"：同一 scope 内重名 section 会抛错，不先
 * 拆除旧段就无法替换文本。判据刻意复用 `renderNotice` 而不是在命令层另写一套：
 * 提示文本与会话创建时**同源**，两条路径不可能分叉。
 *
 * 不抛异常：本函数由同步命令处理器调用，抛错会让 `/mcp-project trust` 在信任存储
 * 已写入之后报失败——批准其实生效了，报错会让用户以为没生效。
 */
function refreshNotice(
  ctx: HostContext,
  agents: Map<AgentKey, AgentRegistrations>,
  agent: AgentShape,
): void {
  try {
    removeNotice(ctx, agents, agent)
    const view = inspectAgent(ctx, agents, agent)
    const text = renderNotice(view.plan, view.projectRoot ?? '')
    if (text !== '') injectNotice(ctx, agents, agent, text)
  } catch (error) {
    ctx.logger?.warn?.(`project-mcp：刷新会话提示段失败：${message(error)}`)
  }
}

/** 读该 agent 当前实际挂载的项目服务器名（插件侧记账，无 I/O，无副作用）。 */
function mountedServers(
  agents: Map<AgentKey, AgentRegistrations>,
  agent: AgentShape,
): string[] {
  const key = agentKeyOf(agent)
  if (key === undefined) return []
  const record = agents.get(key)
  if (record === undefined) return []
  return [...record.servers.keys()]
}

/**
 * 插件入口。
 *
 * 装配顺序刻意是"先命令、后监听"：命令注册是同步的，`apply` 返回后立刻可用；
 * 会话挂载依赖 `agent/created` 事件，只影响此后新建的会话。
 *
 * 本插件对 `agent.ctx` 的每一处注册都**双份登记**：注册落在 `agent.ctx`（作用域
 * 正确），disposer 同时按**会话 id**（`AgentKey`）键控地留在插件自己的 effect 里
 * （`practices.md` 第 8 / 19 行）。因此三条拆除路径各自都能独立回收：agent 销毁、
 * 插件卸载、两者之间的任意顺序；重复拆除是幂等的（`dispose()` 后集合已清空）。
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

  /** 插件侧的 agent 登记表；键是 `agent.id`（见 `AgentKey`，刻意用可迭代的 Map）。 */
  const agents = new Map<AgentKey, AgentRegistrations>()

  /**
   * **进行中**的服务启动表，键是条目的 `url`（见 `EnsureServeInput.inflight`）。
   *
   * 必须由 `apply` 持有并跨会话共享：两个会话同时挂载同一个 url 时会同时发现服务不可达，
   * 各自 spawn 一个服务，第二个会因端口占用失败。共享这张表让后到的那个**等**前一个的
   * 启动结果，而不是再拉一个。
   *
   * 键用 `url` 而不是 `serverName`：同一个服务可能被两个项目用不同的服务器名指向，而
   * 冲突的根源是**端口**（也就是 url 的 origin），不是名字。
   *
   * 生命周期与插件一致，不需要随 agent 清理：条目在启动完成后即删除（见 `startShared`），
   * 因此它描述的是"正在启动"，不会无限增长。
   */
  const serveInflight = new Map<string, Promise<void>>()

  /**
   * 真实 I/O 端口：健康检查 + 脱离进程启动。
   *
   * `fetch` / `setTimeout` / `Date.now` / `AbortSignal.timeout` 在这里绑定，`serve.ts`
   * 本身不 import 它们——那让 `waitReady` 的每条失败路径都能被确定性单测（见 `health.ts`）。
   */
  const serveIo: ServeIo = {
    fetch: (url, init) => fetch(url, init),
    sleep: ms => new Promise<void>(resolve => { setTimeout(resolve, ms) }),
    now: () => Date.now(),
    timeoutSignal: ms => AbortSignal.timeout(ms),
    spawnDetached,
  }

  const deps: CommandDeps = {
    readStore: () => readTrustStore(readFileUtf8),
    writeStore: writeStoreAtomic,
    inspect: agent => inspectAgent(ctx, agents, agent),
    mountInto: (agent, configs) =>
      mountInto(ctx, agents, McpClient, agent, configs, { inflight: serveInflight, io: serveIo }),
    unmountFrom: agent => unmountFrom(ctx, agents, agent),
    mountedServers: agent => mountedServers(agents, agent),
    refreshNotice: agent => refreshNotice(ctx, agents, agent),
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

          const view = inspectAgent(ctx, agents, agent)
          if (view.plan.kind === 'mount') {
            // `mountInto` 现在是 async（HTTP 条目要先确保服务就绪），而 Cordis 的 serial
            // 派发**会 await 监听器返回的 promise**（`vendor/cordis/src/events.ts` 的
            // `serial`：`await cb(...args)`）——因此这里返回它即可让"用户的第一条消息等到
            // 服务就绪"成立（`packages/core/agent/src/index.ts:550`）。
            //
            // 返回 promise 也意味着**失败路径必须自己吞掉**：本函数里 `mountInto` 内部
            // 每个条目各有 try/catch，不会向外抛（红线 4）。
            return mountInto(ctx, agents, McpClient, agent, view.plan.configs, {
              inflight: serveInflight,
              io: serveIo,
            })
          }

          const notice = renderNotice(view.plan, view.projectRoot ?? '')
          if (notice !== '') injectNotice(ctx, agents, agent, notice)
          return undefined
        } catch (error) {
          ctx.logger?.error?.(`project-mcp：会话挂载失败：${message(error)}`)
          return undefined
        }
      }),
    'project-mcp:agent-created',
  )

  // agent 销毁时把插件侧的登记项也清掉：`AgentRegistrations` 用 Map（可迭代）而
  // 非 WeakMap，不清理就会让插件在整个存活期内攥住已销毁的会话。
  //
  // 键必须与挂载时**同一个**（`agent.id`）：按对象引用取会落空，清理随之失效——fiber 与
  // 提示段会一直挂在插件侧，直到插件自己被卸载。
  ctx.effect(
    () =>
      ctx.on('agent/disposed', (payload: unknown) => {
        try {
          const agent = (payload as { agent?: AgentShape } | undefined)?.agent
          if (agent === undefined) return
          const key = agentKeyOf(agent)
          if (key === undefined) return
          const record = agents.get(key)
          if (record === undefined) return
          agents.delete(key)
          disposeServers(ctx, record.servers)
          record.notice?.()
        } catch (error) {
          ctx.logger?.warn?.(`project-mcp：清理已销毁会话的登记项失败：${message(error)}`)
        }
      }),
    'project-mcp:agent-disposed',
  )

  // 插件自身的卸载钩子：把**所有** agent 维度注册一并回收。`agent.ctx` 上的注册
  // 不会随插件卸载自动消失（`practices.md` 第 8 / 19 行），缺了这一段，插件被禁用
  // 或 HMR 重载后活会话会继续保留项目级 MCP 挂载与陈旧提示段，直到 agent 被销毁。
  ctx.effect(
    () => () => {
      for (const record of agents.values()) {
        disposeServers(ctx, record.servers)
        try {
          record.notice?.()
        } catch (error) {
          ctx.logger?.warn?.(`project-mcp：移除会话提示段失败：${message(error)}`)
        }
      }
      agents.clear()
    },
    'project-mcp:agent-registrations',
  )
}
