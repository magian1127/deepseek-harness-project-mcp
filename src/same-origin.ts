/**
 * 同源三重围栏：本插件两座 HTTP 桥（`console-bridge.ts` / `debug-bridge.ts`）**共用的唯一实现**。
 *
 * ## 为什么是围栏而不是 nonce（2026-10-28 桌面版实测）
 *
 * `console-bridge.ts` 原本用 `webServer.tapIndex()` 把随机 nonce 以 `<meta>` 注入 GUI 页面，
 * 路由校验 `x-project-mcp-nonce` 头。这条通道**只在 Web 版成立**：
 *
 * - Web 版的页面文档由 Host 渲染（`frontend-static` → `webServer.renderIndex()` =
 *   `applyIndexTaps(renderIndexInjections(...))`），`tapIndex` 变换会跑；
 * - 桌面版（Electron）的页面文档来自打包静态文件：`apps/desktop/src/main.ts` 用
 *   `protocol.handle` 把 `dsh-app://app/` 的 `/`、`/index.html`、`/assets/*` 交给
 *   `serveWebDocument()` 直读 `dsh-web-frontend/dist`，只额外注入 boot 脚本；注入表另走
 *   IPC（desktop-host 的 `collectIndexInjections()` 只收集**结构化 rows**，不含 `tapIndex`）。
 *
 * 于是桌面上 nonce 永远缺席：Client 读到空串 → 每个请求 403 → 输入区按钮按"本项目没有
 * 项目级 MCP"的分支静默隐藏（而同一插件的「工具调试」Tab 因为不用 nonce 照常可用）。
 * 同一坑在 2026-10-24 已经让调试台整个工具面变成 0。
 *
 * ## 围栏的四条判据
 *
 * 1. peer 必须是回环地址（`127/8`、`::1`、v4-mapped `::ffff:127.x`）；
 * 2. `Host` 头必须是本机 authority（`127.0.0.1` / `localhost` / `[::1]`）——DNS rebinding 由它挡；
 * 3. `sec-fetch-site` 只允许 `same-origin` / `none`（跨站一律拒；非浏览器客户端不发送该头，不受影响）；
 * 4. 带了 `Origin` 时，其 authority 必须与 `Host` 逐字相同。
 *
 * ## 为什么这个级别够
 *
 * 两座桥与它们所在的会话视图**同源同权限**：能打开这个页面的人本来就能在该页面里驱动
 * 整个 Agent 会话（调试台甚至能执行任意工具）。nonce 挡不住这类主体，却会在注入通道缺席时
 * 把唯一合法入口一起挡掉。非浏览器本机进程不发送 `sec-fetch-site` / `Origin`，是与页面
 * 同级的信任假设——这与宿主自身对插件前缀路由的处理口径一致。
 *
 * ## 强度差异：桌面侧实际只有两层（别误读成四层都在）
 *
 * 桌面版的页面请求由 Electron shell 的 `forwardWebRequest` 转发，转发前**删掉**
 * `origin` / `cookie` / `sec-fetch-site`（cookie 换成 shell 自己持有的 Host 凭据）。
 * 因此**桌面侧能生效的只有 peer 回环 + `Host` 白名单**；`sec-fetch-site` / `Origin` 两层
 * 只在 Web 版真正起作用。也就是说：桌面版上任何本机进程都能调 `status` / `start` /
 * `revoke`。要收紧这一点只能接入宿主自身的连接认证（cookie 或已认证 RPC 通道），本插件
 * 拿不到那种凭据——**不要**用 nonce 或自定义头去模拟，它们挡不住本机进程。
 */
import type { IncomingMessage } from 'node:http'

/** 允许的本机 authority（`Host` 头主体，不含端口）。 */
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * 从 `Host` 头取 authority 主体（不含端口）。
 *
 * IPv6 用方括号包裹（`[::1]:3080`），必须先按 `]` 截断再比较，否则会被当成一个奇怪的
 * 字符串而误判为"非本机"。
 */
export function hostAllowed(host: string): boolean {
  const authority = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : (host.split(':')[0] ?? '')
  return ALLOWED_HOSTS.has(authority)
}

/** peer 回环判定：IPv4 `127/8`、`::1`、v4-mapped（`::ffff:127.x`）。 */
export function isLoopback(remote: string): boolean {
  const address = remote.startsWith('::ffff:') ? remote.slice(7) : remote
  return address === '::1' || /^127\./.test(address)
}

/**
 * `sec-fetch-site` 第三层围栏。
 *
 * 现代浏览器对所有请求都携带该头，跨站请求即使 `Origin` 缺失/伪造也在此拦截。
 * 非浏览器客户端不发送该头，不受影响（合法值只有 `same-origin` 与 `none`）。
 */
export function fetchSiteAllowed(req: IncomingMessage): boolean {
  const header = req.headers['sec-fetch-site']
  const value = Array.isArray(header) ? header[0] : header
  if (typeof value !== 'string' || value === '') return true
  return value === 'same-origin' || value === 'none'
}

/** 同源三重围栏（peer 回环 + `Host` 白名单 + `sec-fetch-site` + `Origin`）。 */
export function requestAllowed(
  req: IncomingMessage,
): { ok: true } | { ok: false; reason: string } {
  const remote = (req.socket as { remoteAddress?: unknown } | undefined)?.remoteAddress
  if (typeof remote !== 'string' || remote === '' || !isLoopback(remote)) {
    return { ok: false, reason: 'loopback-only' }
  }
  const host = req.headers.host
  if (typeof host !== 'string' || host === '' || !hostAllowed(host)) {
    return { ok: false, reason: 'loopback-only' }
  }
  if (!fetchSiteAllowed(req)) return { ok: false, reason: 'same-origin-only' }
  const origin = req.headers.origin
  // 无 Origin 是合法形态：同源 GET 与 curl 都不带，Host 围栏已经约束了目标。
  if (typeof origin !== 'string' || origin === '') return { ok: true }
  try {
    return new URL(origin).host === host ? { ok: true } : { ok: false, reason: 'same-origin-only' }
  } catch {
    return { ok: false, reason: 'same-origin-only' }
  }
}
