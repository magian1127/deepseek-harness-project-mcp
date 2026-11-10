import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

import type { TrustStore } from '../trust.js'

/**
 * 控制台**取数路径的延迟**与**异步启动语义**（2026-10-29 事故的回归守护）。
 *
 * 那次事故的现场是"开了 8 个子代理后整段对话卡住、子代理会话内容加载不出来、输入区
 * 按钮永远检测中"。三条成因各自独立，却叠加在同一条链上：
 *
 * 1. `agent/created` 的监听器把 `mountInto` 的 promise 交还给 Cordis 的 serial 派发
 *    （`await cb(...args)`，宿主在 `announce` 里 await 它），于是**会话创建**被
 *    `ensureServeReady` 按住——带 `serve` 的 HTTP 条目在服务没起时最多等满
 *    `readyTimeoutMs`（默认 120 秒）。修复：监听器只把挂载丢进后台，然后
 *    `return undefined`。
 * 2. `POST /project-mcp/start` 在响应路径上 `await mountInto`，一次点击就占住浏览器
 *    一条同源连接最多两分钟；多点几次就把页面的连接池占满。修复：批准写入完成即返回
 *    `{ ok: true, accepted: true }`，挂载转后台。
 * 3. `viewFor` 每次 HTTP 轮询都**同步**做磁盘 I/O（读 `.mcp.json` 两遍、读信任文件）
 *    与整棵 Loader 树遍历，且这段开销在主线程上乘以会话数。修复：短 TTL 缓存
 *    （`VIEW_CACHE_TTL_MS = 1000`，键 = 会话 id），并在所有会改变视图的动作后失效。
 *
 * ## 为什么这些用例在**装配层**测
 *
 * 缓存属于 `index.ts` 的 `viewFor` 闭包，`console-bridge.ts` 只是原样转发（那条分层
 * 契约由 `console-bridge.test.mts` 的一条用例钉住）。因此"只合成一次"要从外面经真实
 * 路由观测，而观测点是 `loader.entries()` 的调用次数：一次视图合成必然走
 * `inspectAgent` → `collectGlobalServerNames(loader)` → `entries()`，而命中缓存时
 * **完全不进** `inspectAgent`。这个代理不依赖任何内部符号，也没有别的代码路径会碰它
 * （本文件里的 `agent/created` / `start` / `revoke` 都在同一处，测试按 delta 计数）。
 *
 * ## 为什么"不阻塞"用可控 promise 证明
 *
 * 真等 120 秒既慢又不可靠。这里把全局 `fetch` 换成一个**由测试决定何时结算**的实现：
 * 健康检查一旦挂住，`mountInto` 就挂在那一步（这正是事故里的等待点）。于是
 * "监听器返回 undefined"与"响应先于挂载完成"都能在毫秒级被确定性地证明。
 *
 * 临时目录刻意不清理：工作区规则禁止代理永久删除文件，且它们位于系统临时目录下。
 */

// 必须在导入被测模块之前改 DSH_HOME：`profile-modules.ts` 在模块顶层就按 profile
// 解析并缓存 DSH 运行时模块，之后再改环境变量不会重新解析（模块级缓存不失效）。
const home = mkdtempSync(join(tmpdir(), 'project-mcp-async-home-'))
process.env.DSH_HOME = home

const fakeClientDir = join(home, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-mcp-client')
mkdirSync(fakeClientDir, { recursive: true })
writeFileSync(
  join(fakeClientDir, 'package.json'),
  JSON.stringify({
    name: '@deepseek-ai/dsh-mcp-client',
    version: '0.0.0-test',
    type: 'module',
    exports: { '.': './index.mjs' },
  }),
)
// 带 Config schema 的假 mcp-client：没有 schema 时 `validateMountConfig` 走"无从校验、
// 原样放行"的分支，挂载路径就绕过了守卫——本文件要的是**真实的**挂载路径（与
// mount.test.mts 同款夹具，两者的 schema 形状刻意保持一致）。
writeFileSync(
  join(fakeClientDir, 'index.mjs'),
  `
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

function dict(data) {
  const result = {}
  for (const key in data) result[key] = String(data[key])
  return result
}

function normalize(value) {
  if (value === null || typeof value !== 'object') return undefined
  if (typeof value.serverName !== 'string' || !SERVER_NAME.test(value.serverName)) return undefined
  if (value.transport === 'stdio') {
    if (typeof value.command !== 'string' || value.command === '') return undefined
    return {
      transport: 'stdio',
      serverName: value.serverName,
      command: value.command,
      args: Array.isArray(value.args) ? [...value.args] : [],
      env: dict(value.env ?? {}),
      cwd: typeof value.cwd === 'string' ? value.cwd : '',
      toolCallTimeoutMs: 60000,
      failOnStartupError: value.failOnStartupError === true,
    }
  }
  if (value.transport === 'streamable-http') {
    if (typeof value.url !== 'string' || value.url === '') return undefined
    return {
      transport: 'streamable-http',
      serverName: value.serverName,
      url: value.url,
      headers: dict(value.headers ?? {}),
      toolCallTimeoutMs: 60000,
      failOnStartupError: value.failOnStartupError === true,
    }
  }
  return undefined
}

function validate(value) {
  const normalized = normalize(value)
  if (normalized === undefined) {
    return { issues: [{ message: 'expected Config but got ' + JSON.stringify(value) }] }
  }
  return { value: normalized }
}

const member = (transport) => ({
  '~standard': {
    version: 1,
    vendor: 'schemastery',
    validate: (value) => {
      const normalized = normalize(value)
      if (normalized === undefined || normalized.transport !== transport) {
        return { issues: [{ message: 'expected ' + transport + ' but got ' + JSON.stringify(value) }] }
      }
      return { value: normalized }
    },
  },
})

export default class FakeMcpClient {
  static Config = {
    type: 'union',
    list: [member('stdio'), member('streamable-http')],
    '~standard': { version: 1, vendor: 'schemastery', validate },
  }
}
`,
)

const { apply } = await import('../index.js')
const { approve, configHashOf, trustStorePath } = await import('../trust.js')
const { normalizeServerName } = await import('../translate.js')
const { CONSOLE_ROUTE_PREFIX } = await import('../console-bridge.js')

interface Project {
  root: string
  /** `.mcp.json` 的确切文本；指纹必须针对它计算。 */
  raw: string
}

/** 建一个临时项目：含 `.git`（供 `findProjectRoot` 定位）与 `.mcp.json`。 */
function makeProject(servers: Record<string, unknown>): Project {
  const root = mkdtempSync(join(tmpdir(), 'project-mcp-async-proj-'))
  mkdirSync(join(root, '.git'), { recursive: true })
  const raw = JSON.stringify({ mcpServers: servers }, null, 2)
  writeFileSync(join(root, '.mcp.json'), raw)
  return { root, raw }
}

/** 批准该项目指定的服务器（v2：服务器 × 配置哈希）；哈希取自 `.mcp.json` 原文条目。 */
function approveAll(project: Project, servers: string[]): void {
  const parsed = JSON.parse(project.raw) as { mcpServers: Record<string, unknown> }
  let store: TrustStore = { version: 2, projects: {} }
  for (const serverName of servers) {
    const originalKey =
      Object.keys(parsed.mcpServers).find(key => normalizeServerName(key) === serverName) ?? serverName
    store = approve(store, project.root, serverName, configHashOf(parsed.mcpServers[originalKey]), 't')
  }
  writeFileSync(trustStorePath(), JSON.stringify(store, null, 2))
}

interface Recorded {
  status: number
  body: any
}

interface Invocation {
  res: any
  written: Recorded[]
  /** 首次写响应即结算；不写就一直悬着（只在测试确定会写时 await 它）。 */
  settled: Promise<Recorded>
}

interface ViewLike {
  rows: Array<{ serverName: string; state: string; detail?: string }>
  actionCount: number
  fileNote?: string
}

/** 从视图里取某一行的状态；行不存在时返回 `undefined`（避免 `?.` 掩盖断言）。 */
function rowState(view: ViewLike | null, server: string): string | undefined {
  return view?.rows.find(row => row.serverName === server)?.state
}

/**
 * 排空微任务与一个宏任务。
 *
 * 后台挂载（`startMountInBackground`）在同一条链上没有任何真实等待（stdio 条目尤其），
 * 因此一个宏任务边界足以让"挂载落定 + 缓存失效"发生。用例必须在**测量之前**调用它：
 * 挂载落定的那一刻会主动失效缓存的视图，跨过它再测命中才是确定的。
 */
async function flush(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>(resolve => {
      setTimeout(resolve, 0)
    })
  }
}

/** 把一个 thenable 的拒绝吞掉：用例要在"实现误返回 promise"时拿到断言失败而不是未处理拒绝。 */
function swallow(returned: unknown): unknown {
  if (returned !== null && typeof returned === 'object' && typeof (returned as any).then === 'function') {
    void Promise.resolve(returned as Promise<unknown>).catch(() => {})
  }
  return returned
}

/**
 * 把全局 `fetch` 换成可控实现（健康检查挂住直到用例放行）。
 *
 * `index.ts` 的 `serveIo.fetch` 是 `(url, init) => fetch(url, init)`——箭头体里的
 * `fetch` 在**调用时**才从全局解析，因此这里换掉全局标识符即可接管健康检查，不需要
 * 任何实现侧的可注入性改造。
 */
function stubFetchHanging() {
  const original = globalThis.fetch
  const state = {
    /** 被调用的次数：并发 start 去重后应当只有 1 次。 */
    calls: 0,
    settled: false,
    release: (): void => {},
    restore: (): void => {
      globalThis.fetch = original
    },
  }
  globalThis.fetch = ((_url: string) => {
    state.calls += 1
    return new Promise(resolve => {
      state.release = () => {
        if (state.settled) return
        state.settled = true
        resolve({ ok: true, status: 200 })
      }
    })
  }) as unknown as typeof fetch
  return state
}

interface FiberShape {
  disposed: number
  dispose(): Promise<void>
}

function createHarness() {
  const listeners = new Map<string, Set<(payload: unknown) => unknown>>()
  const effects: Array<() => void> = []
  const logs: Array<{ level: string; message: string }> = []
  const pluginCalls: Array<{ module: unknown; config: { serverName: string } }> = []
  const fibers: FiberShape[] = []
  /** 活 agent 注册表：控制台的 `viewFor` / `start` / `revoke` 经 `ctx.get('agents').get(id)` 取会话。 */
  const agentsById = new Map<string, unknown>()
  const routes: Array<{ path: string; handler: (req: never, res: never) => void }> = []

  /**
   * Loader 的 `entries()` 调用次数 = 视图合成次数。
   *
   * `inspectAgent` 每次都会经 `collectGlobalServerNames(loader)` 调它一次，而命中缓存时
   * `viewFor` **完全不进** `inspectAgent`（见 `index.ts` 的 `viewFor`）。因此这个计数就是
   * "有没有重新做那套同步 I/O + 树遍历"的观测面。
   */
  let entriesCalls = 0
  const loader = {
    entries(): unknown[] {
      entriesCalls += 1
      return []
    },
    root: {},
  }

  const webServerFake = {
    register(route: { path: string; handler: (req: never, res: never) => void }) {
      routes.push(route)
      return () => {
        const at = routes.indexOf(route)
        if (at >= 0) routes.splice(at, 1)
      }
    },
  }

  const host = {
    get(name: string) {
      if (name === 'agents') return { get: (id: string) => agentsById.get(id) }
      if (name === 'webServer') return webServerFake
      if (name === 'loader') return loader
      return undefined
    },
    on(name: string, callback: (payload: unknown) => unknown) {
      const set = listeners.get(name) ?? new Set()
      listeners.set(name, set)
      set.add(callback)
      return () => {
        set.delete(callback)
      }
    },
    effect(dispose: () => void | (() => void)) {
      effects.push(dispose() ?? (() => {}))
      return () => {}
    },
    logger: {
      warn: (message: string) => logs.push({ level: 'warn', message }),
      error: (message: string) => logs.push({ level: 'error', message }),
    },
  }

  let nextSessionId = 0

  /** 假 agent：`ctx.plugin()` 可观测，`session.header.cwd` 指向临时项目。 */
  function makeAgent(project: Project, options: { id?: string } = {}) {
    nextSessionId += 1
    const agent = {
      id: options.id ?? `session-${nextSessionId}`,
      session: { header: { cwd: project.root } },
    } as any
    agent.ctx = {
      get: () => undefined,
      on: () => () => {},
      effect(dispose: () => void | (() => void)) {
        return dispose() ?? (() => {})
      },
      plugin(module: unknown, config: unknown) {
        pluginCalls.push({ module, config: config as { serverName: string } })
        const fiber: FiberShape = {
          disposed: 0,
          dispose: async () => {
            fiber.disposed += 1
          },
        }
        fibers.push(fiber)
        // 真实 fiber 是 thenable；挂载侧只观察启动结果，不 await 它。
        return Object.assign(fiber, {
          then: (onOk?: unknown, onErr?: unknown) =>
            Promise.resolve().then(onOk as never, onErr as never),
        })
      },
    }
    agentsById.set(agent.id, agent)
    return agent
  }

  /** 发请求并把假 req/res 打到捕获的路由 handler 上（同源浏览器形态）。 */
  const invoke = (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Invocation => {
    const route = routes.find(item => item.path === CONSOLE_ROUTE_PREFIX)
    assert.ok(route !== undefined, '控制台路由未安装')

    const req = new EventEmitter() as any
    req.method = method
    req.url = path
    req.headers = { host: '127.0.0.1:3080' }
    req.socket = { remoteAddress: '127.0.0.1' }
    req.destroy = () => {}

    const written: Recorded[] = []
    let resolveSettled: (record: Recorded) => void = () => {}
    const settled = new Promise<Recorded>(resolve => {
      resolveSettled = resolve
    })
    const res: any = {
      statusCode: 0,
      writableEnded: false,
      destroyed: false,
      writeHead(status: number) {
        res.statusCode = status
        return res
      },
      end(text?: string) {
        const record = { status: res.statusCode, body: text === undefined ? null : JSON.parse(text) }
        written.push(record)
        res.writableEnded = true
        resolveSettled(record)
        return res
      },
    }

    route!.handler(req, res)
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
    return { res, written, settled }
  }

  return {
    host,
    logs,
    pluginCalls,
    fibers,
    agentsById,
    makeAgent,
    entriesCalls: () => entriesCalls,
    /**
     * **同步**派发事件并返回监听器的返回值。
     *
     * 与 `fire` 的区别是它不 await：`agent/created` 的返回值本身就是本文件的观测对象
     * （必须是 `undefined`，不能是 promise）。await 一个"永不结算"的 promise 会让用例
     * 挂死而不是失败，所以这里刻意保持同步。
     */
    dispatch: (name: string, payload: unknown): unknown => {
      let returned: unknown
      for (const callback of listeners.get(name) ?? []) returned = callback(payload)
      return returned
    },
    /** 派发并**按 Cordis 的 serial 语义 await**（返回 undefined 时等价于同步）。 */
    fire: async (name: string, payload: unknown): Promise<void> => {
      for (const callback of listeners.get(name) ?? []) await callback(payload)
    },
    consoleApi: () => ({
      status: (session: string) =>
        invoke('GET', `${CONSOLE_ROUTE_PREFIX}/status?session=${encodeURIComponent(session)}`),
      start: (session: string, server: string) =>
        invoke('POST', `${CONSOLE_ROUTE_PREFIX}/start`, { session, server }),
      revoke: (session: string, server: string) =>
        invoke('POST', `${CONSOLE_ROUTE_PREFIX}/revoke`, { session, server }),
    }),
  }
}

// —— 缺陷 1：会话创建绝不被 serve 就绪等待阻塞 ——
//
// 修复前监听器 `return mountInto(...)`，而 Cordis 的 serial 派发是 `await cb(...args)`，
// 宿主在 `announce` 里 await 整个结果——于是带 `serve` 的 HTTP 条目在服务没起时会把
// **会话创建**按住最长 `readyTimeoutMs`（默认 120 秒）。用户看到的是"开了几个子代理后
// 整段对话卡住、子代理会话都打不开"。

test('agent/created 监听器对 mount 计划返回 undefined：挂载留在后台，不把 promise 交给宿主', async () => {
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})

  const agent = harness.makeAgent(project, { id: 'session-created' })
  const returned = swallow(harness.dispatch('agent/created', { agent }))

  assert.equal(
    returned,
    undefined,
    '监听器必须返回 undefined：Cordis 的 serial 派发会 await 返回值，返回 promise 等于让会话创建等挂载',
  )

  await flush()
  assert.equal(harness.pluginCalls.length, 1, '会话创建不被阻塞，但挂载必须仍在后台真的发生')
})

test('HTTP 条目的健康检查挂住时，agent/created 仍立即返回：会话创建不被 serve 就绪等待阻塞', async () => {
  // 这条是事故本身的形状：HTTP 条目 + 服务没起 → `ensureServeReady` 等 `readyTimeoutMs`。
  // 修复前这段等待在会话创建路径上；修复后监听器返回 undefined，挂载在后台继续等。
  const project = makeProject({ alpha: { type: 'http', url: 'http://127.0.0.1:9/mcp' } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})

  const agent = harness.makeAgent(project, { id: 'session-http' })
  const probe = stubFetchHanging()
  try {
    const returned = swallow(harness.dispatch('agent/created', { agent }))

    assert.equal(returned, undefined, '监听器不得把挂载 promise 交给宿主')
    assert.equal(probe.calls, 1, '后台挂载应真的进入了健康检查（否则测不到"没等它"）')
    assert.equal(probe.settled, false, '健康检查仍未结算：这正是修复前会卡住会话创建的那一刻')
    assert.equal(harness.pluginCalls.length, 0, '健康检查未就绪前不该挂载——但它必须在后台进行，不挡会话创建')
  } finally {
    probe.release()
    await flush()
    probe.restore()
  }
})

// —— 缺陷 3：POST /start 是"受理"而不是"等完成" ——

// 这三条都要 await 一个**动作响应**：若实现退回到"响应等挂载"，它们会挂死而不是失败。
// 给个上限，让回归以超时的形式明确报告出来（而不是把 npm test 一同吊住）。
test('POST start 在批准写入后立即回 accepted，不等待挂载完成（健康检查仍挂起）', { timeout: 5000 }, async () => {
  const project = makeProject({ alpha: { type: 'http', url: 'http://127.0.0.1:9/mcp' } })
  const harness = createHarness()
  apply(harness.host as never, {})
  const agent = harness.makeAgent(project, { id: 'session-start' })
  await harness.fire('agent/created', { agent })

  const api = harness.consoleApi()
  const probe = stubFetchHanging()
  try {
    const out = await api.start(agent.id, 'alpha').settled

    assert.equal(out.status, 200)
    assert.deepEqual(
      out.body,
      { ok: true, accepted: true },
      '响应必须是"已受理"：修复前这里会一直等到挂载落定（最多 readyTimeoutMs）',
    )
    assert.equal(probe.calls, 1, '挂载已在后台开始（健康检查已发出）')
    assert.equal(probe.settled, false, '响应写出时健康检查仍未结算——这就是 accepted 语义的证据')

    // 批准必须**先**落盘再返回：否则响应后的那次轮询会读到旧存储，刚批准的项被判成"不可挂载"。
    const store = JSON.parse(readFileSync(trustStorePath(), 'utf8')) as TrustStore
    const entry = store.projects[project.root]
    assert.ok(entry !== undefined, '批准记录必须在响应前写入信任存储')
    assert.ok(entry!.servers['alpha'] !== undefined, '只授权被点的那一个服务器')
  } finally {
    probe.release()
    await flush()
    probe.restore()
  }
})

test('同一 (session, server) 的并发 start 只执行一次挂载动作，两个请求各自立即拿到 accepted', { timeout: 5000 }, async () => {
  // 连点两下 / 两台设备同时点：第二次 `ctx.plugin()` 会撞 mcp-client 的同作用域重名守卫，
  // 而 HTTP 条目会再多等一轮服务就绪——两种都白白多一次动作。
  const project = makeProject({ alpha: { type: 'http', url: 'http://127.0.0.1:9/mcp' } })
  const harness = createHarness()
  apply(harness.host as never, {})
  const agent = harness.makeAgent(project, { id: 'session-dedup' })
  await harness.fire('agent/created', { agent })

  const api = harness.consoleApi()
  const probe = stubFetchHanging()
  try {
    const first = api.start(agent.id, 'alpha')
    const second = api.start(agent.id, 'alpha')
    const [a, b] = await Promise.all([first.settled, second.settled])

    assert.equal(a.status, 200)
    assert.equal(b.status, 200)
    assert.deepEqual(a.body, { ok: true, accepted: true })
    assert.deepEqual(b.body, { ok: true, accepted: true }, '去重命中必须立刻回 accepted，不排在前一个请求上')
    assert.equal(first.written.length, 1, '第一个请求写它自己的响应')
    assert.equal(second.written.length, 1, '第二个请求写它自己的响应（不是同一个 res 写两遍）')
    assert.notEqual(first.res, second.res)

    await flush()
    assert.equal(probe.calls, 1, `并发 start 只能执行一次挂载动作；实际发起健康检查 ${probe.calls} 次`)
  } finally {
    probe.release()
    await flush()
    probe.restore()
  }
})

// —— 缺陷 2：视图短 TTL 缓存 ——

test('TTL 内连续两次 GET status 只合成一次视图（缓存命中不再读盘、不遍历 Loader 树）', async () => {
  // 输入区按钮每 1.5 秒 GET 一次；修复前每次都要同步读两遍 `.mcp.json`、读信任文件、
  // 遍历整棵 Loader 树，且在宿主主线程上乘以会话数——这是"整个 GUI 卡住"的燃料之一。
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})

  const agent = harness.makeAgent(project, { id: 'session-cache' })
  await harness.fire('agent/created', { agent })
  // 后台挂载落定时会主动失效缓存；先让它落定，再测"命中"。
  await flush()

  const api = harness.consoleApi()
  const before = harness.entriesCalls()
  const first = await api.status(agent.id).settled
  const second = await api.status(agent.id).settled

  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.deepEqual(second.body, first.body, '命中缓存必须给出与首次逐字相同的视图（不是空视图）')
  assert.equal(
    harness.entriesCalls() - before,
    1,
    `两次 status 只应合成一次视图；实际遍历 Loader ${harness.entriesCalls() - before} 次（缓存未命中）`,
  )
})

test('start 的批准写入会失效视图缓存：挂载仍挂起时状态已是 starting，而不是 unauthorized', { timeout: 5000 }, async () => {
  // 用户在弹层里点"启动"之后，按钮不能继续在 TTL 内显示"未授权"（那会让用户以为点击
  // 没生效、又点一次）。这里让挂载永久挂起，确保失效**只可能**来自批准写入那一步：
  // 后台挂载落定的失效在这里永远不会发生。
  const project = makeProject({ alpha: { type: 'http', url: 'http://127.0.0.1:9/mcp' } })
  const harness = createHarness()
  apply(harness.host as never, {})
  const agent = harness.makeAgent(project, { id: 'session-invalidate' })
  await harness.fire('agent/created', { agent })

  const api = harness.consoleApi()
  const probe = stubFetchHanging()
  try {
    const before = await api.status(agent.id).settled
    assert.equal(rowState(before.body.view, 'alpha'), 'unauthorized', '批准前是"未授权"')

    const started = await api.start(agent.id, 'alpha').settled
    assert.deepEqual(started.body, { ok: true, accepted: true })
    assert.equal(probe.settled, false, '前提：挂载还没落定')

    const after = await api.status(agent.id).settled
    assert.equal(
      rowState(after.body.view, 'alpha'),
      'starting',
      '批准写入后缓存必须已失效：否则响应后的那次轮询仍会看到"未授权"（TTL 内）',
    )
  } finally {
    probe.release()
    await flush()
    probe.restore()
  }
})

test('revoke 的写入会失效视图缓存：立即变回 unauthorized', async () => {
  // 撤销没有"后台落定"这一拍，只有写入本身——所以它单独守护"写入即失效"。
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})

  const agent = harness.makeAgent(project, { id: 'session-revoke' })
  await harness.fire('agent/created', { agent })
  await flush()

  const api = harness.consoleApi()
  const before = await api.status(agent.id).settled
  assert.equal(rowState(before.body.view, 'alpha'), 'mounted', '前提：已批准且已挂载')

  const revoked = await api.revoke(agent.id, 'alpha').settled
  assert.deepEqual(revoked.body, { ok: true })

  const after = await api.status(agent.id).settled
  assert.equal(
    rowState(after.body.view, 'alpha'),
    'unauthorized',
    '撤销写入后缓存必须已失效：否则按钮在 TTL 内仍会显示"已挂载"',
  )
})

test('会话不可寻址时不缓存 null：会话登记后立刻能看到真实视图', async () => {
  // 不可寻址多半是"会话还在创建中"。把 null 也缓存会让输入区按钮晚一个 TTL 才出现
  // ——而这条路径本身（`agents.get` 落空）没有任何 I/O，重算的代价可以忽略。
  const project = makeProject({ alpha: { command: 'node' } })
  const harness = createHarness()
  apply(harness.host as never, {})

  const api = harness.consoleApi()
  const ghost = await api.status('session-late').settled
  assert.equal(ghost.body.view, null, '未登记会话如实回 null')

  const agent = harness.makeAgent(project, { id: 'session-late' })
  await harness.fire('agent/created', { agent })

  const real = await api.status('session-late').settled
  assert.notEqual(real.body.view, null, 'null 不得被缓存：否则按钮会晚一个 TTL 才出现')
  assert.equal(rowState(real.body.view, 'alpha'), 'unauthorized', '会话登记后应立刻给出真实状态')
})
