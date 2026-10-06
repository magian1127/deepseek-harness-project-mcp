/**
 * 就绪健康检查：`checkHealth`（单次探测）与 `waitReady`（轮询到就绪或超时）。
 *
 * ## 为什么 I/O 全部注入
 *
 * 本模块**不 import `node:fs` 之外任何东西**，连 `fetch` / `setTimeout` / `Date.now`
 * 都从调用方注入。理由与 `session.ts` 相同：健康检查的**全部**价值在于"失败时降级"，
 * 而失败路径（超时、非 2xx、网络错误、scheme 非法）在真实环境里恰恰最难构造——真实
 * `fetch` 打真实端口，测试就只能靠"监听一个真端口再关掉它"这类不稳定手法。注入之后
 * 每条失败路径都是确定性的，且测试不花真实时间（注入的 `sleep` 立即返回）。
 *
 * ## 红线 4：本模块不抛异常
 *
 * 调用点在 `agent/created` 的等待路径上，抛异常会打断会话创建。因此：
 * - 非法 scheme **不抛**，返回 `{ ok: false, reason: 'invalid-url' }`；
 * - `fetch` 自身抛错（DNS、ECONNREFUSED、超时 abort）一律吞掉，归一为 `failed`；
 * - 响应体**不读**——`/health/ready` 的语义是状态码，读 body 只会引入第二个失败点，
 *   而 body 内容对本插件没有任何用处（也不该被记进日志）。
 *
 * ## 只允许 http / https
 *
 * `fetch` 支持 `file:` / `data:` 等 scheme，而 `health` 来自不受信的 `.mcp.json`。
 * 放行它们等于让一份克隆下来的仓库配置文件指挥本插件去读本机文件（或展开一段内联
 * 数据）——即便响应内容不被读取，"请求是否成功"本身就是一条可观测的旁路。因此非
 * http(s) 直接判为 `invalid-url` 并由调用方记 warn（规格 §5）。
 */
import type { Disposer } from './types.js'

/** 单次探测的结果；`reason` 只用于诊断，**不含** URL 或响应内容。 */
export type HealthResult = { ok: true } | { ok: false; reason: HealthFailure }
/**
 * 失败原因的分类，刻意用**闭集**而不是自由文本。
 *
 * 诊断文本由调用方按分类拼装（例如把 `status` 与状态码一起说清楚），这样"记什么"
 * 的决定权留在装配层，而本模块不需要知道日志格式。`invalid-url` 单独成一类是因为它
 * 是**配置错误**（用户要改 `.mcp.json`），其余三类是**运行时状态**（重试或等一等）。
 */
export type HealthFailure = 'invalid-url' | 'timeout' | 'status' | 'network'

/** `checkHealth` 的结果（带状态码变体）：仅测试与调用方的诊断需要状态码。 */
export type CheckHealthResult =
  | { ok: true }
  | { ok: false; reason: HealthFailure; status?: number }

/** 注入依赖：与 `fetch` 同形的实现、超时用的定时器、以及可选的 clock。 */
export interface HealthIo {
  /**
   * 单次探测用的 `fetch` 同形实现（真实调用点传全局 `fetch`）。
   *
   * `redirect` 刻意用字面量 `'error'` 而不是 `string`：真实 `fetch` 的 `RequestInit`
   * 只接受 `RequestRedirect`（`'follow' | 'error' | 'manual'`），声明成 `string` 会让
   * 真实调用点无法把本接口直接接到全局 `fetch` 上（要靠类型断言，等于把校验关掉）。
   * 健康端点跟随重定向会打到我们没打算探测的地址，因此**只有** `'error'` 一种取值。
   */
  fetch: (
    url: string,
    init: { signal: AbortSignal; redirect?: 'error' },
  ) => Promise<{ ok?: boolean; status?: number }>
  /** 超时用的 sleep；真实实现是 `setTimeout`，测试可传"立即完成"的假实现。 */
  sleep: (ms: number) => Promise<void>
  /**
   * 取"现在"（毫秒）。真实实现是 `Date.now`。
   *
   * 为什么不用 `performance.now()`：它返回的是相对时间，而轮询上限要跨 await 比较，
   * 用挂钟更直观。本模块只做**差值**比较，不依赖时钟单调性（回拨会让轮询提前结束，
   * 后果是多等一轮或少等一轮，都在容忍范围内）。
   */
  now: () => number
  /** 中止信号构造；真实实现是 `AbortSignal.timeout`。 */
  timeoutSignal: (ms: number) => AbortSignal
}

/**
 * 允许的 scheme 白名单。
 *
 * 大小写不敏感（`HTTP://` 是合法 URL），且必须带 `//`——`http:example.com` 这类
 * "同协议相对引用"形状在 `new URL()` 下解析结果与用户预期不同，直接判为非法更安全。
 */
const ALLOWED_SCHEME = /^https?:\/\//i

/**
 * 健康检查 URL 是否可用（只允许 `http://` / `https://`）。
 *
 * 刻意只做**前缀**判断而不是 `new URL(...).protocol`：`new URL` 对畸形输入会抛
 * `TypeError`，本模块的契约是"不抛"，为此在热路径上包一层 try/catch 只为了拿到一个
 * 布尔值并不划算。前缀判断对"必须是绝对 http(s) URL"这个要求已经充分，且**不会**
 * 被 `http:/x`、`file:///etc/passwd`、`data:text/html,...` 骗过。
 */
export function isHttpUrl(url: string): boolean {
  return ALLOWED_SCHEME.test(url)
}

/**
 * 单次健康探测：成功 = 响应 `ok` 为真（2xx）。
 *
 * 超时用 `AbortSignal.timeout`（注入）而不是手写 `Promise.race`：`fetch` 对 abort 的
 * 响应是拒绝 promise，天然被下面的 catch 收拢，不需要额外的竞态管理，也不会留下
 * 悬挂的定时器（`AbortSignal.timeout` 在 fetch 结束后自行清理）。
 *
 * 不读响应体：见模块头。`init.redirect` 交给调用方——健康端点通常不重定向，但跟随
 * 重定向会打到一个我们没打算探测的地址，因此调用点显式传 `'error'`。
 */
export async function checkHealth(
  url: string,
  timeoutMs: number,
  io: HealthIo,
): Promise<CheckHealthResult> {
  if (!isHttpUrl(url)) return { ok: false, reason: 'invalid-url' }

  try {
    // 超时由 `AbortSignal.timeout`（注入）负责：`fetch` 对 abort 的响应是拒绝 promise，
    // 天然被下面的 catch 收拢，不需要额外的竞态管理，也不会留下悬挂的定时器
    // （`AbortSignal.timeout` 在 fetch 结束后自行清理）。
    const signal = io.timeoutSignal(timeoutMs)
    const response = await io.fetch(url, { signal, redirect: 'error' })
    // `ok` 缺失（假实现可以只给 status）时按状态码判定，与真实 `Response` 一致。
    const ok =
      response.ok ?? (response.status !== undefined && response.status >= 200 && response.status < 300)
    if (ok) return { ok: true }
    return {
      ok: false,
      reason: 'status',
      ...(response.status === undefined ? {} : { status: response.status }),
    }
  } catch (error) {
    // abort 与网络错误都是"没就绪"，区别只影响诊断措辞。刻意不把 `error.message`
    // 往外带：`fetch` 的错误消息里含 URL（可能带凭据），而调用方只记分类。
    return { ok: false, reason: isAbortError(error) ? 'timeout' : 'network' }
  }
}

/** `AbortSignal.timeout` 触发的拒绝是 `DOMException`，`name === 'TimeoutError'`。 */
function isAbortError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const name = (error as { name?: unknown }).name
  return name === 'TimeoutError' || name === 'AbortError'
}

/**
 * 轮询到就绪或超时；返回是否就绪。
 *
 * ## 上限的算法（为什么不是"试 N 次"）
 *
 * 用**绝对截止时间**而不是"固定次数 × 固定间隔"：MudMCP 首次建索引可能耗时 90 秒以上，
 * 而服务可能在第 3 秒就绪，也可能在第 119 秒才就绪。次数制要么让间隔长到反应迟钝、
 * 要么让总时长随次数漂移；截止时间制让"最多等 `timeoutMs`"成为**逐字兑现**的承诺。
 *
 * 每轮都重新 `now()`：单次探测本身可能耗时（短超时 2 秒），用上一轮的读数会让循环
 * 多跑几轮、总时长超出上限。
 *
 * ## 为什么先探测、再 sleep
 *
 * 服务可能**已经**就绪（另一个会话刚拉起它，或它自己启动得比我们 spawn 更快），
 * 先探测能让这种情形零延迟通过——这正是"两个会话同时挂载同一 url"时第二个会话的路径。
 *
 * ## 不抛异常
 *
 * 超时返回 `false` 而不是抛：调用方（`agent/created` 的等待路径）必须照常挂载，让
 * `mcp-client` 自己去重试（规格 §8 决策 2）。
 */
export async function waitReady(
  url: string,
  timeoutMs: number,
  io: HealthIo,
  options: { pollIntervalMs: number },
): Promise<boolean> {
  // 非法 scheme 直接判未就绪：调用方已在此之前记过 warn（`serve.ts` 的启动流程），
  // 这里不再重复报错，只保证不进入轮询（否则会白等满整个上限）。
  if (!isHttpUrl(url)) return false

  const deadline = io.now() + timeoutMs
  for (;;) {
    const result = await checkHealth(url, Math.min(PROBE_TIMEOUT_MS, timeoutMs), io)
    if (result.ok) return true
    // 时间已到：即便本轮探测是"网络错误"也不再重试——上限是承诺，不是估计。
    if (io.now() >= deadline) return false
    await io.sleep(options.pollIntervalMs)
    // sleep 之后必须复查：注入的 sleep 可能"消耗"了比请求更长的时间（真实 `setTimeout`
    // 在系统繁忙时确实会晚于请求的毫秒数返回），此时应立即收工而不是再探一轮。
    if (io.now() >= deadline) return false
  }
}

/**
 * 单次探测的超时上限（毫秒）。
 *
 * 2 秒：健康端点是本地回环上的一个状态查询，正常响应在毫秒级；给 2 秒足以覆盖服务
 * 正在 GC 或首次加载的抖动，同时保证"服务根本没在跑"时（Windows 上表现为
 * ECONNREFUSED，立即返回）与"端口被防火墙丢弃"时都不会让**每一次**探测拖太久——
 * 轮询间隔本身还有等待。
 */
export const PROBE_TIMEOUT_MS = 2000

/**
 * 轮询间隔（毫秒）。
 *
 * 250 毫秒：MudMCP 首建索引的实测耗时可超 90 秒，固定间隔轮询在整段等待里会打出几百次
 * 探测；250 毫秒把上限压到 480 次左右，且"服务就绪"到"开始连接"的额外延迟不超过
 * 四分之一秒——对一次会话创建（本来就要等 MCP 握手）而言可忽略。
 */
export const POLL_INTERVAL_MS = 250
