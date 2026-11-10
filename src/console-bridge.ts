/**
 * 控制台桥接：把 Host 侧的项目级 MCP 状态与动作暴露给 Web Client（**本模块唯一的真实 I/O**）。
 *
 * ## 通道选择：`webServer` 前缀路由 + 同源 fetch（不用 typert `@Remote`）
 *
 * 同工作区的 `deepseek-harness-zcode_mask` 已用这条通道跑通"Client 按钮触发 Host 动作"
 * （`/zcode-quota/*`）：`webServer.register({ kind: 'prefix', path, handler })` 拿到的是
 * 原生 `IncomingMessage` / `ServerResponse`，Client 侧同源 `fetch` 即可。typert 的 `@Remote`
 * 要走 generator 的静态分析管线（"Remote methods require TypertRemoteService or
 * bindTypertRemote"），对第三方插件的可行性未证实，不为它冒险。
 *
 * ## 认证：同源三重围栏（与 `debug-bridge.ts` 共用 `same-origin.ts`）
 *
 * `start` / `revoke` 会**写信任记录并 spawn 进程**，不能让浏览器跨站调用。准入判据是
 * peer 回环 + `Host` 白名单 + `sec-fetch-site`/`Origin`（详见 `same-origin.ts` 模块头），
 * 与被挡住的调试面完全同一套。
 *
 * **不要**换回 boot 级 nonce（`webServer.tapIndex` 注入 `<meta>` + 校验自定义头）。那条
 * 通道只在 Web 版成立：桌面版（Electron）的页面文档由 `protocol.handle` 直接读打包 dist，
 * `tapIndex` 的原始变换**永不执行**（桌面只消费结构化注入行），于是 nonce 恒缺席、
 * 每个请求 403、输入区按钮按"本项目没有项目级 MCP"静默隐藏（2026-10-28 桌面版实测）。
 *
 * ## 红线
 *
 * - 响应体**只含** `console-view.ts` 的视图字段：服务器名、状态、原因/错误类型名。不含
 *   `.mcp.json` 内容、不含展开后的 env 值（红线 3 延伸到 HTTP 面）；
 * - 路由处理器内任何异常都转成 500 JSON，**不抛**（红线 4 的方向：辅助面不得影响宿主）；
 * - 请求体上限 64 KiB，超限直接 413，不让陌生请求拖住事件循环。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { ConsoleView } from './console-view.js'
import { requestAllowed } from './same-origin.js'

/** `webServer` 服务的最小鸭子类型（不 import `@deepseek-ai/*`，红线 1）。 */
export interface WebServerShape {
  register(route: {
    kind: 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void
  }): () => void
}

/**
 * 动作结果：`reason` 只含固定文案或错误类型名。
 *
 * `accepted` 表示"已受理、但工作还没做完"：`start` **不再**等待 MCP 挂载（对 HTTP
 * 条目那最多可能是 `readyTimeoutMs`），批准写入完成即返回。前端拿到 `ok` 就刷新，
 * 随后的轮询会看到 `starting` / `mounted` / `failed`。
 */
export type ConsoleActionResult = { ok: true; accepted?: boolean } | { ok: false; reason: string }

/** 路由背后的全部能力，由装配层注入（本模块不碰信任存储与挂载记账）。 */
export interface ConsoleBridgeDeps {
  viewFor(sessionId: string): ConsoleView | null
  start(sessionId: string, serverName: string): Promise<ConsoleActionResult>
  revoke(sessionId: string, serverName: string): Promise<ConsoleActionResult>
}

/** 路由前缀。选这个名字避免与宿主及其他插件的路由相撞。 */
export const CONSOLE_ROUTE_PREFIX = '/project-mcp'

const MAX_BODY_BYTES = 64 * 1024

/**
 * 单个动作请求的等待上限。
 *
 * 动作本身**不再**等待 MCP 挂载（挂载已移到 Host 侧的后台路径），所以这里的上限只兜
 * "信任写入卡在文件锁上"这类异常。绝不能让一个 HTTP 请求无限占住浏览器的同源连接
 * ——那会连带堵住整个页面（含会话数据与子代理会话内容），正是 2026-10-29 那次
 * "整段对话卡住"的一半成因。
 */
const ACTION_TIMEOUT_MS = 15_000

/**
 * 回写 JSON。
 *
 * 客户端可能已经断开（用户关标签、页面卸载、请求超时被 abort）：对已结束/已销毁的
 * `res` 再写会抛 `ERR_STREAM_WRITE_AFTER_END`，而**异步回调里**的抛出会变成未处理
 * 拒绝——辅助面绝不能因此影响宿主。写不出去就丢弃。
 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  } catch {
    // 响应无处可去：页面侧关闭连接的正常后果，不需要诊断。
  }
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        finish(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => finish(null))
  })
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 安装控制台路由；返回 disposer（随 fiber 可逆清理，父工作区 AGENTS.md 第 6 条）。
 */
export function installConsoleBridge(
  webServer: WebServerShape,
  deps: ConsoleBridgeDeps,
): () => void {
  /**
   * 在途动作表：键 = `动作类型\0会话\0服务器`。
   *
   * 同一动作并发到达时，后到的请求**立刻**拿到 `accepted`，不排在同一条连接上等前一个
   * 跑完。多开会话/连点两次因此不会把浏览器的同源连接池占满。
   */
  const inFlight = new Map<string, Promise<ConsoleActionResult>>()

  /** 给动作套一层上限：到点按失败结算，绝不让 `res` 一直悬着。 */
  const settleWithin = (promise: Promise<ConsoleActionResult>): Promise<ConsoleActionResult> =>
    new Promise<ConsoleActionResult>(resolve => {
      let settled = false
      const finish = (result: ConsoleActionResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), ACTION_TIMEOUT_MS)
      // 与 `bridge-retry` 定时器同理：未 unref 的定时器会把测试进程吊到超时。
      timer.unref?.()
      promise.then(finish, (error: unknown) => finish({ ok: false, reason: errorNameOf(error) }))
    })

  const runAction = (
    kind: 'start' | 'revoke',
    sessionId: string,
    serverName: string,
  ): Promise<ConsoleActionResult> => {
    const key = `${kind}\u0000${sessionId}\u0000${serverName}`
    if (inFlight.has(key)) return Promise.resolve({ ok: true, accepted: true })
    const action = kind === 'start' ? deps.start : deps.revoke
    // `Promise.resolve().then(...)` 让动作里的**同步**抛出也变成拒绝，统一走 settleWithin。
    const promise = settleWithin(Promise.resolve().then(() => action(sessionId, serverName)))
      .finally(() => {
        inFlight.delete(key)
      })
    inFlight.set(key, promise)
    return promise
  }

  const unregisterRoute = webServer.register({
    kind: 'prefix',
    path: CONSOLE_ROUTE_PREFIX,
    handler: (req, res) => {
      try {
        const guard = requestAllowed(req)
        if (!guard.ok) {
          sendJson(res, 403, { ok: false, reason: guard.reason })
          return
        }
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const pathname = url.pathname
        const session = asString(url.searchParams.get('session'))

        if (req.method === 'GET' && pathname === `${CONSOLE_ROUTE_PREFIX}/status`) {
          if (session === undefined) {
            sendJson(res, 400, { ok: false, reason: 'missing-session' })
            return
          }
          sendJson(res, 200, { ok: true, view: deps.viewFor(session) })
          return
        }

        if (req.method === 'POST' && (pathname === `${CONSOLE_ROUTE_PREFIX}/start` || pathname === `${CONSOLE_ROUTE_PREFIX}/revoke`)) {
          void readBody(req).then(raw => {
            if (raw === null) {
              sendJson(res, 413, { ok: false, reason: 'body-too-large' })
              return
            }
            let parsed: unknown
            try {
              parsed = JSON.parse(raw)
            } catch {
              sendJson(res, 400, { ok: false, reason: 'bad-json' })
              return
            }
            const body = parsed as { session?: unknown; server?: unknown }
            const sessionId = asString(body.session)
            const serverName = asString(body.server)
            if (sessionId === undefined || serverName === undefined) {
              sendJson(res, 400, { ok: false, reason: 'missing-fields' })
              return
            }
            const kind = pathname.endsWith('/start') ? 'start' : 'revoke'
            // `runAction` 自带去重与等待上限：去重命中时立刻回 `accepted`，不排队。
            void runAction(kind, sessionId, serverName).then(result =>
              sendJson(res, 200, result),
            )
          })
          return
        }

        sendJson(res, 404, { ok: false, reason: 'not-found' })
      } catch (error) {
        // 路由是辅助面：任何意外都降级为 500，绝不让它冒到宿主（红线 4）。
        sendJson(res, 500, { ok: false, reason: errorNameOf(error) })
      }
    },
  })

  return () => {
    unregisterRoute()
  }
}

/** 只记错误类型名（红线 3 的口径）。 */
function errorNameOf(error: unknown): string {
  if (error === null || typeof error !== 'object') return 'Unknown'
  const name = (error as { name?: unknown }).name
  return typeof name === 'string' && name !== '' ? name : 'Error'
}
