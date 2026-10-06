/**
 * HTTP 条目的**按需拉起服务**（`.mcp.json` 的 `serve` 字段）。
 *
 * ## 这个模块解决什么
 *
 * HTTP 模式下 DSH **不 spawn 子进程**（`packages/mcp/mcp-client/src/transport.ts:40-44`
 * 只 new 一个 `StreamableHTTPClientTransport`），服务由外部启动。于是"改了 `.mcp.json`
 * 就能用"不成立：服务没在跑时 DSH 连不上、工具不可用，而用户看不出为什么。本模块让
 * 插件在健康检查失败时把服务拉起来，等它就绪再交给 `mcp-client`。
 *
 * ## 分层：一个纯函数 + 一个注入 I/O 的编排函数 + 一处真实 I/O
 *
 * | 导出 | 性质 |
 * | --- | --- |
 * | `planServeStart` | **纯函数**、零 I/O：`serve` 字段 → 启动计划（展开、校验、推导 health） |
 * | `splitServe` | **纯函数**：把 `serve` 从 config 里剥离出来 |
 * | `deriveHealthUrl` | **纯函数**：`url` 的 origin + `/health/ready` |
 * | `ensureServeReady` | 编排：健康检查 → spawn → 等待就绪；**全部 I/O 经 `ServeIo` 注入** |
 * | `spawnDetached` | **本模块唯一的真实 I/O**：真正 spawn 那个脱离 DSH 的进程 |
 *
 * `spawnDetached` 留在这里而不是塞进 `index.ts`：它不是**会话数据** I/O（AGENTS.md 的
 * 红线说的是"`index.ts` 是唯一做会话数据 I/O 与 Cordis 交互的模块"，进程启动不属于
 * 会话数据），且与"怎么启动服务"的全部知识同处一室才不会被误改。`index.ts` 只负责把它
 * 接进 `ServeIo`。
 *
 * ## 红线
 *
 * - **不抛异常**（红线 4）：所有失败归一为日志。调用点在 `agent/created` 的等待路径上。
 * - **展开后的 `env` 值永不入日志**（红线 3）：本模块的所有诊断只含服务器名、字段名与
 *   `error.name`；`spawnDetached` 刻意不把 `env` 传出去，也不监听子进程输出。
 */
import { spawn } from 'node:child_process'

import { errorName } from './config-guard.js'
import { POLL_INTERVAL_MS, PROBE_TIMEOUT_MS, checkHealth, waitReady } from './health.js'
import type { HealthIo } from './health.js'
import { asStringArray, asStringRecord, expandList, expandRecord, expandVariables, isPlainObject } from './values.js'
import type { McpClientConfig, ServeMetadata } from './types.js'

/**
 * 等待就绪的默认上限（毫秒）。
 *
 * 120 秒而不是常见的 30 秒：MudMCP 首次启动要克隆仓库并建索引，**实测可超过 90 秒**。
 * 给 120 秒是"第一次打开某个项目时多等一会儿"与"每次都要多等"之间的取舍——超时后
 * 仍会照常挂载（`mcp-client` 自己重连），所以偏长的代价只是首次会话慢，偏短的代价是
 * 服务明明在正常启动却被判成失败。
 */
export const DEFAULT_READY_TIMEOUT_MS = 120_000

/**
 * 等待就绪的硬上限（毫秒）。
 *
 * 设计 §5 要求"超时必须有上限，不得无限等待"。用户仍可显式配一个很大的值（大索引的
 * 机器），但超过本上限即被收敛——否则 `.mcp.json` 里一个 `readyTimeoutMs: 1e12` 就能
 * 把会话创建卡到用户以为 DSH 死了。30 分钟给足合法场景的余量，同时保证上限确实存在。
 */
export const MAX_READY_TIMEOUT_MS = 1_800_000

/** 默认就绪端点路径（MudMCP 的约定）。 */
const DEFAULT_HEALTH_PATH = '/health/ready'

/** 启动计划：`skip` 携带可读原因，其余是可直接交给 `spawnDetached` 的参数。 */
export type ServePlan =
  | {
      command: string
      args: string[]
      env: Record<string, string>
      /** 就绪检查 URL；`undefined` 表示无从等待（`url` 推导失败）。 */
      health?: string
      readyTimeoutMs: number
      /** 非致命诊断（如 `readyTimeoutMs` 非法已退回默认）；调用方负责记日志。 */
      notes: string[]
    }
  | { skip: true; reason: string }

/** `planServeStart` 的输入。 */
export interface PlanServeInput {
  /** `.mcp.json` 条目里的 `serve` 原始值（**不受信**）。 */
  serve: unknown
  /** 该条目**已展开**的 MCP URL，用于推导 `health`。 */
  url: string
  /** 展开 `${VAR}` 用的环境（真实调用点传 `process.env`）。 */
  env: Record<string, string | undefined>
}

/**
 * 从 MCP URL 推导就绪端点：`origin` + `/health/ready`。
 *
 * 为什么是 origin 而不是"把 `/mcp` 换成 `/health/ready`"：`url` 的路径部分由服务器自己
 * 决定（`/mcp`、`/`、`/api/v1/mcp` 都合法），而健康端点是**服务级**的，与 MCP 端点路径
 * 无关。origin 是唯一稳定且不会猜错的锚点。
 *
 * 推导失败（不是合法 URL、或不是 http(s)）返回 `undefined`：调用方据此跳过等待，
 * **不猜**一个可能打到别的服务的地址。
 */
export function deriveHealthUrl(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  return `${parsed.origin}${DEFAULT_HEALTH_PATH}`
}

/**
 * 校验 `readyTimeoutMs`：非法则退回默认并留一条诊断。
 *
 * 只接受**有限正数**。`NaN` / `Infinity` / 负数 / 零 / 字符串一律拒绝——`Infinity` 尤其
 * 危险：它会变成"永远等待"，正是设计 §5 禁止的无上限等待。上限收敛见
 * `MAX_READY_TIMEOUT_MS`。
 */
function resolveReadyTimeout(value: unknown, notes: string[]): number {
  if (value === undefined) return DEFAULT_READY_TIMEOUT_MS
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    notes.push(`serve.readyTimeoutMs 非法（须为有限正数），已退回默认 ${DEFAULT_READY_TIMEOUT_MS}`)
    return DEFAULT_READY_TIMEOUT_MS
  }
  if (value > MAX_READY_TIMEOUT_MS) {
    notes.push(`serve.readyTimeoutMs 超过上限，已收敛为 ${MAX_READY_TIMEOUT_MS}`)
    return MAX_READY_TIMEOUT_MS
  }
  return value
}

/**
 * `serve` 字段 → 启动计划（纯函数，零 I/O）。
 *
 * ## 为什么畸形时返回 `skip` 而不是抛出
 *
 * `serve` 是**锦上添花**：它的全部作用是"服务没在跑时帮忙拉一把"。字段写错时正确行为
 * 是丢掉它、留一条诊断、让 HTTP 条目照常挂载（用户可能已经手动启好了服务）。反过来让
 * 整条条目消失，会把"辅助功能的配置写错了"升级成"这个服务器完全用不了"。
 *
 * ## 诊断口径（红线 3）
 *
 * `reason` 与 `notes` 只含**字段名**（`command` / `args` / `env` / `health` /
 * `readyTimeoutMs`）与**变量名**，绝不含字段值——`serve.env` 与 stdio 的 `env` 一样可能
 * 含凭据，而 `.mcp.json` 的内容从不进日志。
 *
 * ## `health` 不可用时跳过**整个** `serve`
 *
 * 设计 §5 说"其他 scheme 跳过检查并记 warn"。这里的实现比字面更严：健康端点不可用时
 * **不 spawn**，而不只是"不检查"。理由是流程本身：步骤 1（健康检查）是步骤 3（spawn）
 * 的**唯一**前提——没有可用的健康端点就永远判不出"服务已经在跑"，于是每个会话挂载都会
 * 尝试拉起一次，重复实例只能靠端口占用失败收场，而那条失败是**静默**的（`detached` +
 * `stdio: 'ignore'` 拿不到任何输出）。宁可不拉，也不能每次会话都盲目拉一次。
 *
 * 判为不可用的两种情形：`health` 展开后不是 `http(s)://` 开头，或 `url` 推导不出 origin。
 */
export function planServeStart(input: PlanServeInput): ServePlan {
  if (!isPlainObject(input.serve)) {
    return { skip: true, reason: 'serve 必须是 JSON 对象' }
  }
  const serve = input.serve

  // ---- command（必填，含 ${VAR} 展开）----
  if (typeof serve.command !== 'string' || serve.command === '') {
    return { skip: true, reason: 'serve.command 必须是字符串' }
  }
  const expandedCommand = expandVariables(serve.command, input.env)
  if ('missing' in expandedCommand) return { skip: true, reason: `变量 ${expandedCommand.missing} 未定义且无默认值` }
  // 展开后复查非空：`${CMD:-}` 会展开成空串，而 `spawn('')` 只会抛一个难懂的
  // "The argument 'file' cannot be empty"。在计划阶段拦下，诊断才说得清原因。
  if (expandedCommand.value === '') return { skip: true, reason: 'serve.command 展开后为空字符串' }

  // ---- args（可选）----
  let rawArgs: string[] = []
  if (serve.args !== undefined) {
    const parsed = asStringArray(serve.args)
    if (parsed === null) return { skip: true, reason: 'serve.args 必须是字符串数组' }
    rawArgs = parsed
  }
  const expandedArgs = expandList(rawArgs, input.env)
  if ('missing' in expandedArgs) return { skip: true, reason: `变量 ${expandedArgs.missing} 未定义且无默认值` }

  // ---- env（可选；展开后的值敏感）----
  let rawEnv: Record<string, string> = {}
  if (serve.env !== undefined) {
    const parsed = asStringRecord(serve.env)
    if (parsed === null) return { skip: true, reason: 'serve.env 必须是字符串到字符串的对象' }
    rawEnv = parsed
  }
  const expandedEnv = expandRecord(rawEnv, input.env)
  if ('missing' in expandedEnv) return { skip: true, reason: `变量 ${expandedEnv.missing} 未定义且无默认值` }

  // ---- health（可选；省略时从 url 推导）----
  let health: string | undefined
  if (serve.health !== undefined) {
    if (typeof serve.health !== 'string' || serve.health === '') {
      return { skip: true, reason: 'serve.health 必须是字符串' }
    }
    const expandedHealth = expandVariables(serve.health, input.env)
    if ('missing' in expandedHealth) {
      return { skip: true, reason: `变量 ${expandedHealth.missing} 未定义且无默认值` }
    }
    health = expandedHealth.value
  } else {
    health = deriveHealthUrl(input.url)
  }

  // scheme 白名单：`fetch` 还支持 `file:` / `data:` 等，而 `health` 来自不受信的
  // `.mcp.json`——放行它们等于让一份克隆下来的仓库配置指挥本插件去读本机文件。
  if (health === undefined || !/^https?:\/\//i.test(health)) {
    return {
      skip: true,
      reason:
        serve.health === undefined
          ? 'serve.health 省略且无法从 url 推导（url 不是合法的 http(s) 地址）'
          : 'serve.health 只支持 http:// 与 https://',
    }
  }

  // ---- readyTimeoutMs（可选）----
  const notes: string[] = []
  const readyTimeoutMs = resolveReadyTimeout(serve.readyTimeoutMs, notes)

  return {
    command: expandedCommand.value,
    args: expandedArgs.value,
    env: expandedEnv.value,
    health,
    readyTimeoutMs,
    notes,
  }
}

/**
 * 把 `serve` 从 config 里剥离，返回**不含该键的新对象**与元数据。
 *
 * ## 为什么必须剥离
 *
 * `serve` 是本插件自己的字段，真实 `Config` 的 union
 * （`packages/mcp/mcp-client/src/index.ts:119-142`）里没有它。带着它进 `ctx.plugin()` 有
 * 两个后果，第二个是安全性的：
 *
 * 1. schemastery 的 object resolver 在非 strict 模式下 `merge(result, data)` 会把未知键
 *    原样带进 `apply` 收到的配置——目前无害，但那是**依赖上游的实现细节**，上游一旦改成
 *    strict 校验（或改用 `z.object` 的默认行为），行为立刻改变。
 * 2. 一旦 `serve` 参与校验失败，schemastery 的 union 错误消息是
 *    `` `expected ${toString()} but got ${JSON.stringify(data)}` ``
 *    （`vendor/schemastery/src/index.ts:834`），而 Cordis 自己会把这条异常**整条**记进日志
 *    （`vendor/cordis/src/fiber.ts:659-663`）——`serve.env` 里展开后的凭据会直接落进日志，
 *    违反红线 3。`config-guard.ts` 的自校验能拦住"非法 config 到达 `ctx.plugin()`"，但
 *    拦不住"合法 config 里的多余字段"这条更隐蔽的通道。
 *
 * 因此剥离发生在**自校验之前**：进守卫、进 `withSessionTag`、进 `ctx.plugin()` 的必须是
 * 同一份无 `serve` 的配置。
 *
 * 返回新对象而不是 `delete config.serve`：`plan.configs` 里的对象由 `planSessionMount`
 * 产出并可能被复用（挂载与 `/mcp-project` 渲染共用），就地修改会让第二次消费看不到
 * `serve`——`withSessionTag` 出于同一理由也返回新对象。
 */
export function splitServe(config: McpClientConfig): { config: McpClientConfig; serve?: ServeMetadata } {
  if (config.transport !== 'streamable-http') return { config }
  const { serve, ...rest } = config
  return { config: rest, serve }
}

/**
 * 编排用的 I/O 端口：健康检查所需的一切（见 `health.ts`）**加上**启动服务的那个动作。
 *
 * 为什么把 `spawnDetached` 也做成注入项：`ensureServeReady` 的全部行为都是"外部世界
 * 的反馈"（探测成功/失败、就绪/超时、spawn 抛错），真实 `spawn` 一旦被调用就会留下一个
 * 真进程——测试无法断言"调用了几次"，也无法阻止它真的跑起来。注入之后每条分支都是
 * 确定性的，且测试不留下任何进程。
 */
export interface ServeIo extends HealthIo {
  /**
   * 启动服务；失败**必须抛出**（由 `ensureServeReady` 收拢为 warn）。
   *
   * 真实实现见 `spawnDetached`。刻意设计成"同步抛出"而不是"返回结果"：`spawn` 的
   * 大部分失败（命令不存在、权限不足）本身是异步的，同步能抛出来的只有参数非法，
   * 而那种情形在本模块里已经不可能发生（`planServeStart` 已校验）。
   */
  spawnDetached(command: string, args: string[], env: Record<string, string>): void
}

/** 日志端口；只用到 `warn`，与 `HostContext.logger` 的形状兼容。 */
export interface ServeLogger {
  warn?(message: string): void
}

/** `ensureServeReady` 的输入。 */
export interface EnsureServeInput {
  /** 服务器名，只用于诊断。 */
  serverName: string
  /**
   * 该条目的 MCP URL；**只有** `streamable-http` 条目才需要传。
   *
   * `undefined` 直接返回（零额外动作）——stdio 条目完全不受本模块影响（规格 §2 的非目标）。
   */
  url?: string
  /** 已剥离的 `serve` 元数据（`splitServe` 的产物）。 */
  serve?: ServeMetadata
  /**
   * 进行中的启动表，键是条目的 `url`。
   *
   * 由调用方（`index.ts` 的 `apply`）持有并跨会话共享：两个会话同时挂载同一个 url 时，
   * 后到的那个必须**等**前一个的启动，而不是再 spawn 一个（第二个会因端口占用失败）。
   * 键用 `url` 而不是 `serverName`：同一个服务可能被两个项目用不同的服务器名指向。
   */
  inflight: Map<string, Promise<void>>
  io: ServeIo
  logger: ServeLogger
}

/**
 * 确保该 HTTP 条目的服务就绪；失败一律降级为日志，**绝不抛异常**。
 *
 * 流程逐条对应设计 §4.1：
 *
 * ```
 * 1. 健康检查（GET health，短超时 2 秒）
 *    ├─ 成功 → 返回（零额外动作）
 *    └─ 失败 → 2
 * 2. 有 serve 吗？
 *    ├─ 没有 → 记 warn，返回（照常挂载）
 *    └─ 有   → 3
 * 3. spawn 服务（detached；同 url 的并发启动共享同一次）
 * 4. 轮询 health 直到就绪或超时
 *    ├─ 就绪 → 返回
 *    └─ 超时 → 记 warn，返回（仍挂载，交给 mcp-client 自己重试）
 * ```
 *
 * ## 等待发生在 `agent/created` 里，这是**有意**的
 *
 * `agent/created` 是 serial 且被 await（`packages/core/agent/src/index.ts:550`），且契约
 * 明确 "AgentLoop holds queued input until all listeners finish"
 * （`packages/core/agent/src/runtime-types.ts:257`）——因此**用户的第一条消息会等到服务
 * 就绪**，工具在首次请求前就注册好。这正是"等服务就绪再连"的实现方式。
 *
 * 这**不违反**红线 5（"挂载必须不 await 连接"）：那条红线针对的是 `mcp-client` 的握手
 * ——它可能永远不成功，等它就等于让会话创建卡在一个不受控的握手上。这里等的是**健康
 * 检查**：有明确上限、失败不抛、且我们自己启动了这个服务。仍然不 await 的是
 * `ctx.plugin()` 返回的 fiber。
 */
export async function ensureServeReady(input: EnsureServeInput): Promise<void> {
  const { serverName, url, serve, inflight, io, logger } = input
  // 仅 HTTP 条目：stdio 条目连健康检查都不做（回归要求见规格 §7 最后一行）。
  if (url === undefined || url === '') return

  // 健康端点：`serve.health` 优先，省略时按设计 §8 决策 1 从 `url` 推导。
  // 注意这里**不依赖** `serve` 是否存在——"服务不可达且未提供 serve 配置"这条诊断
  // 只有先探测才说得出来（设计 §4.1 步骤 2）。
  const health = serve?.health ?? deriveHealthUrl(url)
  if (health === undefined) return

  // ---- 1. 健康检查 ----
  let probe: Awaited<ReturnType<typeof checkHealth>>
  try {
    probe = await checkHealth(health, PROBE_TIMEOUT_MS, io)
  } catch (error) {
    // `checkHealth` 的契约是不抛；这里仍然兜一层——本函数的调用点在会话创建路径上，
    // 多一层 catch 的成本是一个 try 块，收益是"契约漂移不会打断会话创建"（红线 4）。
    probe = { ok: false, reason: 'network' }
    void error
  }
  if (probe.ok) return

  // ---- 2. 有 serve 吗？ ----
  if (serve === undefined) {
    logger.warn?.(
      `project-mcp：项目级 MCP 服务器「${serverName}」的健康端点未就绪（${describeFailure(probe)}），` +
        '且该条目没有 serve 配置，无法自动拉起服务；仍交给 mcp-client 自行重试',
    )
    return
  }

  // ---- 3 + 4. spawn（并发去重）+ 等待就绪 ----
  await startShared(url, serve, serverName, inflight, io, logger)
}

/**
 * 启动并等待就绪；同一 `url` 的并发调用共享同一次启动。
 *
 * ## 并发去重为什么在这里
 *
 * 两个会话同时挂载同一个 url → 同时发现服务不可达 → **同时 spawn 两个服务**，第二个会因
 * 端口占用失败。去重表由调用方持有（跨会话），键是 `url`。
 *
 * ## 为什么先注册再 await
 *
 * `inflight.set` 必须在第一个 `await` **之前**完成。反过来的话，两个并发调用会各自跑完
 * 健康检查、各自看到表是空的、各自 spawn——去重恰好失效在最需要它的时刻。
 *
 * ## 为什么完成后删除条目
 *
 * 条目描述的是"**进行中**的启动"，不是"这个服务已经启动过"。服务可能之后自己退出了
 * （用户决策：生命周期归服务自己），那时新会话应当能再拉一次。留着条目会让插件在整段
 * 存活期里永久放弃该 url。
 */
async function startShared(
  url: string,
  serve: ServeMetadata,
  serverName: string,
  inflight: Map<string, Promise<void>>,
  io: ServeIo,
  logger: ServeLogger,
): Promise<void> {
  const existing = inflight.get(url)
  if (existing !== undefined) {
    // 已有同 url 的启动在进行：等它，**绝不** spawn 第二个。
    await existing
    return
  }

  const task = runStart(serve, serverName, io, logger)
  inflight.set(url, task)
  try {
    await task
  } finally {
    inflight.delete(url)
  }
}

/** 一次真实的启动 + 等待；所有失败都转成日志，永不抛出。 */
async function runStart(
  serve: ServeMetadata,
  serverName: string,
  io: ServeIo,
  logger: ServeLogger,
): Promise<void> {
  try {
    io.spawnDetached(serve.command, serve.args, serve.env)
  } catch (error) {
    // 端口被别的进程占用、命令不存在等。照常返回，让 mcp-client 自己去连——它可能
    // 连上那个"别的实例"，也可能失败并走自己的重连预算。
    logger.warn?.(
      `project-mcp：拉起项目级 MCP 服务器「${serverName}」的服务失败` +
        `（错误类型：${errorName(error)}），仍交给 mcp-client 自行连接`,
    )
    return
  }

  // `health` 在 `planServeStart` 通过后必然存在；类型上仍按可能缺失处理，避免依赖
  // 两处判定的一致性（将来改校验规则时不会静默变成非空断言崩溃）。
  if (serve.health === undefined) return

  const ready = await waitReady(serve.health, serve.readyTimeoutMs, io, {
    pollIntervalMs: POLL_INTERVAL_MS,
  })
  if (ready) return

  // 超时**不是**失败：服务可能仍在启动（大索引），也可能起不来。两种情形下都照常挂载
  // ——`mcp-client` 会自己重连，工具会注册但暂时不可用（设计 §8 决策 2）。
  logger.warn?.(
    `project-mcp：已拉起项目级 MCP 服务器「${serverName}」的服务，但等待就绪超过 ` +
      `${serve.readyTimeoutMs} 毫秒仍未就绪；仍交给 mcp-client 自行重试`,
  )
}

/** 把探测失败归一成一句不含 URL 与响应内容的诊断。 */
function describeFailure(result: { reason: string; status?: number }): string {
  switch (result.reason) {
    case 'invalid-url':
      return '健康端点地址非法'
    case 'timeout':
      return '探测超时'
    case 'status':
      return result.status === undefined ? '健康端点返回非成功状态' : `健康端点返回 ${result.status}`
    default:
      return '无法连接健康端点'
  }
}

/**
 * 启动一个**脱离 DSH 存活**的服务进程（本模块唯一的真实 I/O）。
 *
 * ## 参数逐字对应设计 §4.3（硬要求，用户明确指定）
 *
 * - `detached: true` —— 新进程组，不随父进程的信号一起死；
 * - `stdio: 'ignore'` —— 不继承任何管道（否则父进程退出会触发 EPIPE / 阻塞）；
 * - `windowsHide: true` —— 不弹控制台窗口；
 * - `env: { ...process.env, ...serveEnv }` —— 在宿主环境之上追加 `serve.env`。
 *
 * ## 为什么必须挂 `'error'` 监听器（这不是可选的防御性代码）
 *
 * Node 对 `ChildProcess` 的 `'error'` 事件**没有默认处理器**：无监听器时事件被 emit 到
 * 一个没有 handler 的 `EventEmitter` 上，直接升级为**未捕获异常并带崩整个进程**。实测
 * （Node 22，`detached + stdio: 'ignore'`）：`spawn('不存在的命令')` 同步返回，约一个
 * tick 后抛出未捕获的 `ENOENT`，进程退出码 1。也就是说——**没有这一行，一个写错的
 * `serve.command` 就能把 DSH 打挂**。监听到之后 ENOENT 被吞掉，降级为"服务没起来"，
 * 而 `mcp-client` 那边会以"连不上"的形式如实报告。
 *
 * 不把失败记进日志：`'error'` 是异步事件，而本函数是同步的、没有 logger；调用方
 * （`runStart`）拿不到它。刻意**不**为此改成异步——那会让 `spawnDetached` 的调用点
 * 需要 await 一个"进程是否启动成功"，而设计明确要求"启动后不 kill、不 await、不监听
 * exit"。写错的 `command` 的诊断由后续的"等待就绪超时"那条 warn 承担。
 *
 * ## 为什么不 kill、不 await、不监听 exit
 *
 * 生命周期归服务自己（用户决策）：多个 DSH 实例（或 DSH 重启）应复用同一个服务，DSH
 * 不该是它的 owner。因此 `unref()` 立即丢弃引用，本插件此后不再持有它。
 *
 * ## 已实测验证（写进注释，不要重新调研）
 *
 * - Node `detached + unref` 能让服务脱离直接父进程（父脚本退出后服务仍存活、健康检查正常）；
 * - DSH 的 Job 对象（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）只用于它自己的沙箱子进程
 *   （`packages/subprocess/win32-process/src/process.ts:340,422` 的 `spawnJobProcess`），
 *   **不影响独立 spawn**；
 * - 当前 DSH 不在 Job 里（进程链 `node ← cmd ← powershell ← pwsh ← explorer`）。
 *
 * **前提**：以上成立依赖"DSH 由 explorer 这类普通父进程启动、自身不在 Job 里"。若将来
 * DSH 被放进 Job（例如由某个 IDE 或计划任务启动），脱离可能失败，届时需要退化为
 * `CREATE_BREAKAWAY_FROM_JOB` 之类的方案，或接受"服务随 DSH 退出"。
 */
export function spawnDetached(command: string, args: string[], env: Record<string, string>): void {
  const child = spawn(command, args, {
    detached: true, // 新进程组，不随父进程的信号
    stdio: 'ignore', // 不继承任何管道（否则父进程退出会触发 EPIPE / 阻塞）
    windowsHide: true, // 不弹控制台窗口
    env: { ...process.env, ...env },
  })
  // 必需，不是防御性代码：无监听器时 `'error'`（如 ENOENT）会带崩宿主进程。见函数注释。
  child.on('error', () => {})
  child.unref() // 不持有句柄，不阻塞事件循环
}
