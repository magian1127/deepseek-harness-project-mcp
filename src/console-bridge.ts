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
 * ## 认证：boot 级 nonce（比 zcode 的裸路由严一档）
 *
 * `start` / `revoke` 会**写信任记录并 spawn 进程**，不能让本机任意进程调用。nonce 在 apply
 * 时生成，经 `webServer.tapIndex` 以 `<meta>` 注入 GUI 页面；只有真正拿到页面（即已通过
 * 宿主连接认证）的 Client 才读得到它。所有路由（含只读的 status）都校验
 * `x-project-mcp-nonce` 头，不匹配一律 403。nonce 随进程生命周期，重启即换。
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

/** `webServer` 服务的最小鸭子类型（不 import `@deepseek-ai/*`，红线 1）。 */
export interface WebServerShape {
  register(route: {
    kind: 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void
  }): () => void
  tapIndex(transform: (html: string) => string): () => void
}

/** 动作结果：`reason` 只含固定文案或错误类型名。 */
export type ConsoleActionResult = { ok: true } | { ok: false; reason: string }

/** 路由背后的全部能力，由装配层注入（本模块不碰信任存储与挂载记账）。 */
export interface ConsoleBridgeDeps {
  viewFor(sessionId: string): ConsoleView | null
  start(sessionId: string, serverName: string): Promise<ConsoleActionResult>
  revoke(sessionId: string, serverName: string): Promise<ConsoleActionResult>
}

/** 路由前缀。选这个名字避免与宿主及其他插件的路由相撞。 */
export const CONSOLE_ROUTE_PREFIX = '/project-mcp'

/** meta 标签名：Client 从这里读 nonce。 */
export const NONCE_META_NAME = 'dsh-project-mcp-nonce'

/** 请求头上送 nonce。 */
export const NONCE_HEADER = 'x-project-mcp-nonce'

const MAX_BODY_BYTES = 64 * 1024

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
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
 * 安装路由与 nonce meta；返回 disposer（随 fiber 可逆清理，父工作区 AGENTS.md 第 6 条）。
 */
export function installConsoleBridge(
  webServer: WebServerShape,
  deps: ConsoleBridgeDeps,
  nonce: string,
): () => void {
  const unregisterRoute = webServer.register({
    kind: 'prefix',
    path: CONSOLE_ROUTE_PREFIX,
    handler: (req, res) => {
      try {
        if (req.headers[NONCE_HEADER] !== nonce) {
          sendJson(res, 403, { ok: false, reason: 'forbidden' })
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
            const action = pathname.endsWith('/start') ? deps.start : deps.revoke
            void action(sessionId, serverName).then(
              result => sendJson(res, 200, result),
              error => sendJson(res, 500, { ok: false, reason: errorNameOf(error) }),
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

  const unregisterTap = webServer.tapIndex(html => {
    const meta = `<meta name="${NONCE_META_NAME}" content="${nonce}">`
    return html.includes('</head>') ? html.replace('</head>', `${meta}</head>`) : meta + html
  })

  return () => {
    unregisterRoute()
    unregisterTap()
  }
}

/** 只记错误类型名（红线 3 的口径）。 */
function errorNameOf(error: unknown): string {
  if (error === null || typeof error !== 'object') return 'Unknown'
  const name = (error as { name?: unknown }).name
  return typeof name === 'string' && name !== '' ? name : 'Error'
}
