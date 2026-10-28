import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { TrustStore } from '../trust.js'

/**
 * `agent/created` 挂载路径的集成测试（规格 §5.1 / §13.4）。
 *
 * 为什么必须有这个文件：`plugin-smoke.test.mts` 的假 agent 既没有 `ctx` 也没有
 * 工作区，计划恒为 `skip`，因此 `mountInto` / `injectNotice` **从未被进入过**。
 * 于是这一整条路径（agent scope 挂载、`failOnStartupError: false`、
 * `ctx.get('loader')` 传本体、未批准不挂载、重复批准幂等、插件卸载回收 agent
 * 维度注册）全部没有 committed 守护；`commands.test.mts` 反而断言命令层"每次都
 * 按计划挂载"，把幂等责任完全推给了无测试的挂载层。
 *
 * 本文件用真实 fs（临时项目 + 临时 DSH_HOME）跑 `apply`，只把宿主服务与 agent ctx
 * 换成可观测的假实现。`loadMcpClient()` 从临时 profile 里解析到一个假 mcp-client，
 * 因此**不依赖本机真实 profile**，也不写真实 `$DSH_HOME`。
 *
 * 临时目录刻意不清理：工作区规则禁止代理永久删除文件，且它们位于系统临时目录下。
 */

// 必须在导入被测模块之前改 DSH_HOME：`profile-modules.ts` 在模块顶层就按 profile
// 解析并缓存 DSH 运行时模块，之后再改环境变量不会重新解析（模块级缓存不失效）。
const home = mkdtempSync(join(tmpdir(), 'project-mcp-home-'))
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
/**
 * 假 mcp-client **带 Config schema**。
 *
 * 为什么必须有 schema：没有 `Config` 时 `validateMountConfig` 走"无从校验、原样放行"
 * 的分支（`config-guard.ts`），守卫整段被绕过——本文件要守护的"`env` 的 `__proto__`
 * 键一路保留到 `ctx.plugin()`"就无从验证。给夹具一份 schema，挂载路径才会真正穿过守卫。
 *
 * schema 刻意复刻 schemastery 的**规范化落盘方式**：dict resolver 用朴素赋值
 * `result[rKey] = property(...)`（`vendor/schemastery/src/index.ts:790-792`）。键名
 * `__proto__` 会命中原型 setter，字符串值不满足其对象要求 → 静默 no-op，键被丢弃。
 * 这正是"守卫若回传 `result.value` 就会把 `translate.ts` 刚保住的键又抹掉"的机制；
 * 把守卫改回 `value ?? config`，下面那条端到端用例立刻变红。
 */
writeFileSync(join(fakeClientDir, 'index.mjs'), `
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

// 复刻 schemastery 的 dict resolver：朴素赋值会丢掉 __proto__ 键。
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
`)

const { apply, inject } = await import('../index.js')
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
  const root = mkdtempSync(join(tmpdir(), 'project-mcp-proj-'))
  mkdirSync(join(root, '.git'), { recursive: true })
  const raw = JSON.stringify({ mcpServers: servers }, null, 2)
  writeFileSync(join(root, '.mcp.json'), raw)
  return { root, raw }
}

/**
 * 写信任存储，批准该项目指定的服务器（v2：服务器 × 配置哈希）。
 *
 * 哈希必须从 `.mcp.json` 的**原文条目**算出——与计划算的是同一份输入。手搓哈希会让
 * "批准了却没挂上"这类哈希失配缺陷在测试里看不见，而那正是本文件要守护的对象。
 */
function approveAll(project: Project, servers: string[]): void {
  const parsed = JSON.parse(project.raw) as { mcpServers: Record<string, unknown> }
  let store: TrustStore = { version: 2, projects: {} }
  for (const serverName of servers) {
    // 测试传的是规范名；条目按文件里的原始键存（两者在重命名用例里不同）。
    const originalKey =
      Object.keys(parsed.mcpServers).find(key => normalizeServerName(key) === serverName) ?? serverName
    store = approve(store, project.root, serverName, configHashOf(parsed.mcpServers[originalKey]), 't')
  }
  writeFileSync(trustStorePath(), JSON.stringify(store, null, 2))
}

interface FiberShape {
  disposed: number
  dispose(): Promise<void>
}

interface SectionRecord {
  name: string
  order: number
  interpolate: unknown
  text: unknown
  disposed: number
}

/** 桥接返回的视图形状（测试只关心这几列，刻意不复刻 `ConsoleView` 的全部字段）。 */
interface ConsoleViewLike {
  rows: Array<{ serverName: string; state: string; detail?: string }>
  actionCount: number
  fileNote?: string
}

function createHarness(
  options: { loader?: unknown; withWebServer?: boolean; consolePeer?: string } = {},
) {
  const withWebServer = options.withWebServer ?? true
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const effects: Array<() => void> = []
  const logs: Array<{ level: string; message: string }> = []
  /**
   * 传给 `ctx.plugin()` 的每一对 (模块, 配置)，按调用顺序。
   *
   * `config` 保留**原样引用**：夹具把它直接存起来而不是复制，因此测试能看到调用方是否
   * 就地修改了 `plan.configs` 里的对象（会话标记必须按值追加，见 `withSessionTag`）。
   */
  const pluginCalls: Array<{
    module: unknown
    config: { serverName: string; failOnStartupError?: boolean; transport?: string; args?: string[] }
  }> = []
  const fibers: FiberShape[] = []
  const sections: SectionRecord[] = []
  /** 活 agent 注册表：桥接的 `viewFor` / `start` 经 `ctx.get('agents').get(id)` 取会话。 */
  const agentsById = new Map<string, unknown>()
  /** 假 webServer 捕获的路由（控制台桥接的安装面）。 */
  const routes: Array<{ path: string; handler: (req: never, res: never) => void }> = []
  /** `tapIndex` 注册次数：两座桥都**不得**再注册（桌面版 tapIndex 永不执行）。 */
  let tapRegistrations = 0

  const webServerFake = {
    register(route: { kind: string; path: string; handler: (req: never, res: never) => void }) {
      routes.push(route)
      return () => {
        const at = routes.indexOf(route)
        if (at >= 0) routes.splice(at, 1)
      }
    },
    tapIndex(_transform: (html: string) => string) {
      tapRegistrations += 1
      return () => { tapRegistrations -= 1 }
    },
  }

  const host = {
    get(name: string) {
      if (name === 'agents') return { get: (id: string) => agentsById.get(id) }
      if (name === 'webServer') return withWebServer ? webServerFake : undefined
      if (name === 'loader') return options.loader
      return undefined
    },
    on(name: string, callback: (payload: unknown) => void) {
      const set = listeners.get(name) ?? new Set()
      listeners.set(name, set)
      set.add(callback)
      return () => { set.delete(callback) }
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

  /**
   * 假 agent 的默认会话 id：每次调用自增。
   *
   * 默认**每个 agent 都是独立会话**，与真实 DSH 一致：`agent.id` 就是 SessionId
   * （`packages/core/agent/src/types.ts:15-18` 的 `readonly id: SessionId`，
   * `AgentRegistry.enter` 还断言 `agent.id === agent.session.id`）。两个 agent 对象
   * 共享同一个 id 只发生在"同一会话被报告两次"的场景——那正是缺陷 1 的触发条件，
   * 必须由测试**显式**构造（见下面的 `id` 选项），不能靠默认值碰巧撞上。
   */
  let nextSessionId = 0

  /** 假 agent：`ctx.plugin()` 与 `ctx.effect()` 都可观测。 */
  function makeAgent(
    project: Project,
    options: { id?: unknown; header?: Record<string, unknown> } = {},
  ) {
    nextSessionId += 1
    const agent = {
      // 显式传 `id: undefined` 要真的落成 `undefined`（那是"id 缺失"用例），因此用
      // `hasOwn` 而不是 `??` 判默认值。
      id: Object.hasOwn(options, 'id') ? options.id : `session-${nextSessionId}`,
      session: { header: { cwd: project.root, ...options.header } },
    } as any
    agent.ctx = {
      get(name: string) {
        if (name !== 'systemPrompt') return undefined
        return {
          section: (section: { name: string; order: number; interpolate: unknown; text: unknown }) => {
            const record: SectionRecord = { ...section, disposed: 0 }
            sections.push(record)
            return () => { record.disposed += 1 }
          },
        }
      },
      on: () => () => {},
      effect(dispose: () => void | (() => void)) {
        return dispose() ?? (() => {})
      },
      plugin(module: unknown, config: unknown) {
        pluginCalls.push({ module, config: config as { serverName: string } })
        const fiber: FiberShape = { disposed: 0, dispose: async () => { fiber.disposed += 1 } }
        fibers.push(fiber)
        // `mcp-client` 的 fiber 同时是 thenable；只观察启动结果，不触发 dispose。
        return Object.assign(fiber, {
          then: (onOk?: unknown, onErr?: unknown) => Promise.resolve().then(onOk as never, onErr as never),
        })
      },
    }
    if (typeof agent.id === 'string') agentsById.set(agent.id, agent)
    return agent
  }

  return {
    host, logs, pluginCalls, fibers, sections, makeAgent,
    /** `tapIndex` 当前注册数（两座桥都应为 0）。 */
    tapRegistrations: () => tapRegistrations,
    /**
     * 控制台桥接的调用面：命令面删除后，批准 / 撤销 / 查询的唯一入口。
     *
     * 刻意走**真实路由**（假 req/res 打到捕获的 handler），而不是直接调内部函数：
     * 围栏判定、路由分派、视图序列化因此都在观测范围内——把路由名改错、或把准入
     * 从同源围栏改回别的机制，这些用例立刻变红。
     *
     * 假请求默认构造"浏览器同源"形态（回环 peer + 本机 `Host`），与真实页面一致。
     */
    consoleApi: () => {
      const call = (
        method: 'GET' | 'POST',
        path: string,
        body?: Record<string, unknown>,
        headers: Record<string, string> = { host: '127.0.0.1:3080' },
        remoteAddress: string = options.consolePeer ?? '127.0.0.1',
      ): Promise<{ status: number; body: { ok: boolean; view?: unknown; reason?: string } | null }> =>
        new Promise((resolve, reject) => {
          const route = routes.find(item => item.path === CONSOLE_ROUTE_PREFIX)
          if (route === undefined) return reject(new Error('控制台路由未安装'))
          const req = new EventEmitter() as EventEmitter & Record<string, unknown>
          req.method = method
          req.url = path
          req.headers = headers
          req.socket = { remoteAddress }
          req.destroy = () => {}
          let statusCode = 0
          const res = {
            writeHead: (status: number) => { statusCode = status; return res },
            end: (text?: string) => {
              resolve({ status: statusCode, body: text === undefined ? null : JSON.parse(text) })
              return res
            },
          }
          route.handler(req as never, res as never)
          if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
          req.emit('end')
        })
      return {
        status: (session: string) =>
          call('GET', `${CONSOLE_ROUTE_PREFIX}/status?session=${encodeURIComponent(session)}`),
        start: (session: string, server: string) =>
          call('POST', `${CONSOLE_ROUTE_PREFIX}/start`, { session, server }),
        revoke: (session: string, server: string) =>
          call('POST', `${CONSOLE_ROUTE_PREFIX}/revoke`, { session, server }),
        raw: call,
      }
    },
    /**
     * 当前**活着**的提示段（已 dispose 的不算）。
     *
     * 提示段刷新是"先撤下再注册"，`sections` 会同时留下新旧两条记录；只有按
     * `disposed` 过滤才能回答"模型现在看到什么"——这正是缺陷 1 的观测面。
     */
    liveSections: () => sections.filter(section => section.disposed === 0),
    /**
     * 派发事件，并**按 Cordis 的 serial 语义 await 每个监听器**。
     *
     * 为什么必须 await（而不是像以前那样同步遍历）：`agent/created` 的监听器在
     * `mountInto` 里会先为 HTTP 条目"确保服务就绪"（`serve.ts`），因此它返回 promise。
     * 真实 Cordis 的 `serial` 派发是 `await cb(...args)`
     * （`vendor/cordis/src/events.ts` 的 `serial`），而 `agent/created` 的派发点同样 await
     * 整个 serial 结果（`packages/core/agent/src/index.ts:550`）——契约是 "AgentLoop holds
     * queued input until all listeners finish"（`runtime-types.ts:257`）。
     *
     * 同步的 `fire` 会让所有断言在监听器完成**之前**执行：挂载还没发生，"未挂载"的断言
     * 会假性通过，"已挂载"的断言则必然失败——两种都是错误的观测。await 之后，本文件里
     * 每条 `await harness.fire(...)` 都精确对应"会话创建完成"这一时刻。
     */
    fire: async (name: string, payload: unknown) => {
      for (const callback of listeners.get(name) ?? []) await callback(payload)
    },
    /** 卸载插件：按注册逆序跑 effect disposer，模拟 fiber 拆除。 */
    unload: () => { for (const dispose of [...effects].reverse()) dispose() },
  }
}

test('未批准时 agent/created 不调用 plugin（规格 §13.4 安全断言）', async () => {
  const project = makeProject({ alpha: { command: 'node' } })
  const harness = createHarness()
  apply(harness.host as never, {})

  await harness.fire('agent/created', { agent: harness.makeAgent(project) })

  assert.equal(harness.pluginCalls.length, 0, '未批准的项目服务器不得被挂载')
  // G4（design-mcp-console.md §3.4）：未批准时**不得**往系统提示词写任何内容；
  // "需要行动"的信号改由输入区按钮与弹层承载。把注入加回来本用例立刻变红。
  assert.equal(harness.sections.length, 0, 'G4：未批准也不得注入任何提示段')
})

test('已批准时挂载进 agent scope，配置带 failOnStartupError: false', async () => {
  const project = makeProject({ alpha: { command: 'node', args: ['-v'] } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})

  await harness.fire('agent/created', { agent: harness.makeAgent(project) })

  assert.equal(harness.pluginCalls.length, 1, '已批准的项目服务器应挂载一次')
  assert.equal(harness.pluginCalls[0]!.config.serverName, 'alpha')
  assert.equal(
    harness.pluginCalls[0]!.config.failOnStartupError,
    false,
    '启动失败不得中断会话（规格 §5.1）',
  )
  // 挂载进 agent scope 而不是宿主 ctx——否则第一个会话的项目服务器会泄漏给所有会话。
  // `makeAgent` 是唯一提供 `ctx.plugin` 的地方，调用成功即证明走的是 agent scope。
  assert.ok(harness.pluginCalls[0]!.module, 'plugin 模块应已解析（loadMcpClient 非空）')
  // mount 计划不注入提示（诊断归 /mcp-project）。
  assert.equal(harness.sections.length, 0)
})

test('ctx.get(loader) 传的是 Loader 本体：全局撞名项被跳过', async () => {
  const project = makeProject({ taken: { command: 'node' }, free: { command: 'node' } })
  approveAll(project, ['taken', 'free'])
  // 只有 Loader **本体**有 entries()；root 是 EntryGroup，没有 entries。
  const loader = {
    entries: () => [
      { options: { name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'taken' } } },
    ],
    root: {},
  }
  const harness = createHarness({ loader })
  apply(harness.host as never, {})

  await harness.fire('agent/created', { agent: harness.makeAgent(project) })

  assert.deepEqual(
    harness.pluginCalls.map(call => call.config.serverName),
    ['free'],
    '与全局行同名的项必须被跳过；传 root 会让这份名单变成空集',
  )
})

test('控制台路由准入：同源浏览器形态放行，非回环/跨站/异源一律 403（且不注册 tapIndex）', async () => {
  const project = makeProject({ alpha: { command: 'node' } })
  const harness = createHarness()
  apply(harness.host as never, {})
  const agent = harness.makeAgent(project)
  await harness.fire('agent/created', { agent })
  const api = harness.consoleApi()

  // 真实页面的形态：同源 fetch 不带任何凭据头。这条断言守护 2026-10-28 的桌面版修复
  // ——桌面（Electron）文档不经 Host 渲染，`tapIndex` 永不执行，任何"页面注入凭据"
  // 都会让请求 403、输入区按钮静默消失。把 nonce 机制加回来这里立刻变红。
  const ok = await api.status(agent.id)
  assert.equal(ok.status, 200, '同源请求必须放行')
  assert.equal(harness.tapRegistrations(), 0, '两座桥都不得注册 tapIndex 注入')

  const remote = await api.raw(
    'GET',
    `${CONSOLE_ROUTE_PREFIX}/status?session=${encodeURIComponent(agent.id)}`,
    undefined,
    { host: '127.0.0.1:3080' },
    '10.0.0.7',
  )
  assert.equal(remote.status, 403, '非回环 peer 必须拒绝')
  assert.equal(remote.body?.reason, 'loopback-only')

  const rebound = await api.raw(
    'GET',
    `${CONSOLE_ROUTE_PREFIX}/status?session=${encodeURIComponent(agent.id)}`,
    undefined,
    { host: 'evil.example:3080' },
  )
  assert.equal(rebound.status, 403, 'DNS rebinding（非本机 Host）必须拒绝')
  assert.equal(rebound.body?.reason, 'loopback-only')

  const crossSite = await api.raw(
    'GET',
    `${CONSOLE_ROUTE_PREFIX}/status?session=${encodeURIComponent(agent.id)}`,
    undefined,
    { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' },
  )
  assert.equal(crossSite.status, 403, '跨站浏览器请求必须拒绝')
  assert.equal(crossSite.body?.reason, 'same-origin-only')

  const otherOrigin = await api.raw(
    'GET',
    `${CONSOLE_ROUTE_PREFIX}/status?session=${encodeURIComponent(agent.id)}`,
    undefined,
    { host: '127.0.0.1:3080', origin: 'http://evil.example' },
  )
  assert.equal(otherOrigin.status, 403, '异源 Origin 必须拒绝')
})

test('重复启动只挂载一次（幂等）：批准走控制台，挂载层自己保证幂等', async () => {
  const project = makeProject({ alpha: { command: 'node' } })
  const harness = createHarness()
  apply(harness.host as never, {})

  const agent = harness.makeAgent(project)
  await harness.fire('agent/created', { agent })
  assert.equal(harness.pluginCalls.length, 0)

  const api = harness.consoleApi()
  const first = await api.start(agent.id, 'alpha')
  assert.equal(first.body?.ok, true, first.body?.reason)
  assert.equal(harness.pluginCalls.length, 1, '批准后应立即挂载')

  const second = await api.start(agent.id, 'alpha')
  assert.equal(second.body?.ok, true, second.body?.reason)
  assert.equal(harness.pluginCalls.length, 1, '重复批准不得重复挂载同一 serverName')
})

test('插件卸载回收 agent 维度注册：挂载 fiber 被拆除', async () => {
  const mounted = makeProject({ alpha: { command: 'node' } })
  approveAll(mounted, ['alpha'])
  const pending = makeProject({ beta: { command: 'node' } })
  const harness = createHarness()
  apply(harness.host as never, {})

  // 两个**不同**会话（默认 id 各自唯一）：一个已批准、一个待批准，两条注册都必须能回收。
  await harness.fire('agent/created', { agent: harness.makeAgent(mounted) })
  await harness.fire('agent/created', { agent: harness.makeAgent(pending) })

  assert.equal(harness.pluginCalls.length, 1)
  assert.equal(harness.sections.length, 0, 'G4：不再注入提示段')
  assert.equal(harness.fibers[0]!.disposed, 0)

  // 插件被禁用 / HMR 重载：agent.ctx 上的注册**不会**自动消失，必须由插件自己回收。
  harness.unload()

  assert.equal(harness.fibers[0]!.disposed, 1, '插件卸载后项目级 MCP 挂载仍存活')
})

test('agent 销毁清理插件侧登记项，且与插件卸载可任意顺序重复拆除', async () => {
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})

  const agent = harness.makeAgent(project)
  await harness.fire('agent/created', { agent })
  assert.equal(harness.fibers[0]!.disposed, 0)

  await harness.fire('agent/disposed', { agent })
  assert.equal(harness.fibers[0]!.disposed, 1, 'agent 销毁应回收插件侧登记项')

  // 插件随后卸载不得二次 dispose（登记项已清空）——重复拆除是幂等的。
  harness.unload()
  assert.equal(harness.fibers[0]!.disposed, 1, '重复拆除不得再次 dispose')
})

test('loader 缺失时留下可查诊断（撞名守卫退化必须可见）', async () => {
  const project = makeProject({ alpha: { command: 'node' } })
  const harness = createHarness()
  apply(harness.host as never, {})

  await harness.fire('agent/created', { agent: harness.makeAgent(project) })

  assert.ok(
    harness.logs.some(entry => entry.message.includes('loader')),
    `缺少 loader 时应记日志，实际：${JSON.stringify(harness.logs)}`,
  )
})

test('webServer 缺席时降级为无控制台：挂载路径照常工作，不抛', async () => {
  // 无 Web GUI 的 profile（headless / SDK）拿不到 `webServer`。控制台是辅助面，
  // 缺它不得影响既有能力：已批准的服务器照常挂进会话（红线 4 的降级方向）。
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])
  const harness = createHarness({ withWebServer: false })
  apply(harness.host as never, {})

  const agent = harness.makeAgent(project)
  await harness.fire('agent/created', { agent })
  assert.equal(harness.pluginCalls.length, 1, '没有 webServer 也必须照常挂载')
})

test('声明 inject：apply 同步依赖的宿主服务必须显式列出', async () => {
  // 命令面与系统提示注入删除后，`apply` 同步只依赖 `loader`（全局撞名名单）。
  // `webServer` 刻意**不在** inject 里：它可能晚于本插件出现，桥接用秒级重试安装，
  // 声明成硬依赖反而会让无 Web GUI 的 profile 上整个插件不激活（见上一条用例）。
  assert.deepEqual([...inject], ['loader'], 'inject 必须声明 apply 同步依赖的全部服务')
})

test('G4：批准全流程不注入任何提示段（模型上下文零污染）', async () => {
  // 控制台化（design-mcp-console.md §3.4）后，"需要行动"的信号由输入区按钮与弹层承载；
  // 系统提示词在**任何**阶段都不得出现项目级 MCP 内容。主流程仍是
  // 首次会话 → 未批准 → 控制台点"启动" → 挂载成功，只是全程无提示段。
  const project = makeProject({ alpha: { command: 'node' } })
  const harness = createHarness()
  apply(harness.host as never, {})
  const agent = harness.makeAgent(project)

  await harness.fire('agent/created', { agent })
  assert.equal(harness.sections.length, 0, '未批准时不得注入提示段')

  const out = await harness.consoleApi().start(agent.id, 'alpha')
  assert.equal(out.body?.ok, true, out.body?.reason)
  assert.equal(harness.pluginCalls.length, 1, '批准后应立即挂载')
  assert.equal(harness.sections.length, 0, '批准后同样不得注入提示段')
})

test('G4：撤销后也不注入提示段（状态只走控制台）', async () => {
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})
  const agent = harness.makeAgent(project)

  // 已批准：挂载、无提示段。
  await harness.fire('agent/created', { agent })
  assert.equal(harness.pluginCalls.length, 1)
  assert.equal(harness.sections.length, 0)

  const api = harness.consoleApi()
  const out = await api.revoke(agent.id, 'alpha')
  assert.equal(out.body?.ok, true, out.body?.reason)
  assert.equal(harness.sections.length, 0, '撤销回到 untrusted 也不得注入提示段')
})

test('G4：撤销后文件不可用时同样不注入提示段', async () => {
  // 旧实现里这条守护"刷新 == 重算"（文件消失 → 静默 skip → 撤下旧段）。控制台化后
  // 所有计划状态都不得注入提示段，因此守护退化为"全程零段"，但流程仍要走完：
  // 撤销 → 文件消失 → 再撤销，任何一步都不得冒出提示段。
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})
  const agent = harness.makeAgent(project)

  await harness.fire('agent/created', { agent })
  assert.equal(harness.liveSections().length, 0)

  const api = harness.consoleApi()
  const out = await api.revoke(agent.id, 'alpha')
  assert.equal(out.body?.ok, true, out.body?.reason)
  assert.equal(harness.liveSections().length, 0)

  // 用 rename 而不是删除：工作区规则禁止永久删除文件（临时目录同样适用）。
  // 已撤销后再撤销：没有批准记录可撤，桥接如实回 `not-approved`，同样不得冒出提示段。
  renameSync(join(project.root, '.mcp.json'), join(project.root, '.mcp.json.moved'))
  const again = await api.revoke(agent.id, 'alpha')
  assert.equal(again.body?.ok, false)
  assert.equal(harness.liveSections().length, 0, '任何计划状态下都不得注入提示段')
})

test('控制台状态取自真实挂载记账：会话 B 不谎报计划要挂的服务器', async () => {
  // 会话 A 批准 → A 挂载。会话 B 在此**之前**已创建（`agent/created` 早已触发，
  // 那时还没批准），因此 B 的计划同样是 `mount`（信任是全局的）但一个都没挂上。
  // 视图的唯一职责是回答"现在什么是活的"，按计划渲染会把 B 的情况报成"已挂载"。
  const project = makeProject({ alpha: { command: 'node' } })
  const harness = createHarness()
  apply(harness.host as never, {})

  const agentA = harness.makeAgent(project)
  const agentB = harness.makeAgent(project)
  assert.notEqual(agentA.id, agentB.id, '这条用例的前提是两个**不同**会话')
  await harness.fire('agent/created', { agent: agentA })
  await harness.fire('agent/created', { agent: agentB })
  assert.equal(harness.pluginCalls.length, 0, '未批准时两个会话都不挂载')

  const api = harness.consoleApi()
  const trust = await api.start(agentA.id, 'alpha')
  assert.equal(trust.body?.ok, true, trust.body?.reason)
  assert.equal(harness.pluginCalls.length, 1, '只有 A 挂了')

  const viewA = (await api.status(agentA.id)).body?.view as ConsoleViewLike
  assert.equal(viewA.rows.find(row => row.serverName === 'alpha')?.state, 'mounted')
  assert.equal(viewA.actionCount, 0, 'A 没有需要用户处理的事')

  const viewB = (await api.status(agentB.id)).body?.view as ConsoleViewLike
  assert.equal(
    viewB.rows.find(row => row.serverName === 'alpha')?.state,
    'not-mounted',
    'B 一个服务器都没挂，不得报 mounted；它是"已授权但本会话未挂载"，要让用户点得动',
  )
  assert.equal(viewB.actionCount, 1, '这种情况必须上徽标，否则用户永远看不到自己缺工具')
})

test('trust 回报的是实际挂载结果，不是请求挂载的 configs', async () => {
  // `mountInto` 在 mcp-client 解析不到时**静默跳过**（只记日志）。此时若按
  // `configs` 回报"本会话已挂载"，用户会以为工具已就位，而实际一个都没有。
  const project = makeProject({ alpha: { command: 'node' } })
  const harness = createHarness()
  apply(harness.host as never, {})
  const agent = harness.makeAgent(project)
  await harness.fire('agent/created', { agent })

  // 让 agent scope 拒绝挂载：`ctx.plugin` 抛错 → 记账里没有该项。
  agent.ctx.plugin = () => { throw new Error('mcp-client 不可用') }

  const api = harness.consoleApi()
  const out = await api.start(agent.id, 'alpha')
  // 批准本身成功了；失败的是挂载——两件事必须能分开回答，否则用户以为"没批准"。
  assert.equal(out.body?.ok, true, out.body?.reason)
  assert.equal(harness.pluginCalls.length, 0, 'agent scope 拒绝了注册')
  const view = (await api.status(agent.id)).body?.view as ConsoleViewLike
  assert.equal(
    view.rows.find(row => row.serverName === 'alpha')?.state,
    'failed',
    '同步抛错也必须落成 failed，否则控制台会永远显示"启动中"',
  )
  assert.equal(view.actionCount, 1, '失败要上徽标，用户才知道该点重试')
})

// —— 回归守卫：挂载失败的日志不得回显 config ——
//
// fiber 拒绝的一种来源是 Config 校验失败，而 schemastery 的 union 错误消息是
// `` `expected ${toString()} but got ${JSON.stringify(data)}` ``
// （`vendor/schemastery/src/index.ts:834`），会把**整个 config**——含展开后的
// `env` / `headers` 凭据——拼进 message。透传 `message(error)` 会让这条日志成为真实
// 泄密通道（违反红线 3）。逐字段核对表明当前插件产出的 config 全部通过 mcp-client 的
// schema，因此该路径目前**不可达**；但只要上游给 Config 加一个必填字段它立刻可达。
//
// 下面的用例让 fiber 以一个"回显了整个 config"的错误拒绝，断言日志里既留下可查诊断、
// 又**不含**展开后的值。改回 `message(error)` 会让这条用例变红。

test('挂载失败的日志只记错误类型，不回显展开后的 env 值', async () => {
  const secret = 'placeholder-token-not-a-real-credential'
  process.env.PROJECT_MCP_TEST_TOKEN = secret
  const project = makeProject({
    alpha: { command: 'node', env: { TOKEN: '${PROJECT_MCP_TEST_TOKEN}' } },
  })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})
  const agent = harness.makeAgent(project)

  // 模拟 Config 校验失败：错误消息里带整个 config（含已展开的 env）。
  agent.ctx.plugin = (_module: unknown, config: unknown) => {
    const error = new Error(`expected Config but got ${JSON.stringify(config)}`)
    error.name = 'ValidationError'
    const fiber = {
      disposed: 0,
      dispose: async () => { fiber.disposed += 1 },
      then: (_onOk?: unknown, onErr?: (e: unknown) => unknown) =>
        Promise.resolve().then(() => { throw error }).catch(onErr as never),
    }
    return fiber
  }

  await harness.fire('agent/created', { agent })
  await new Promise(resolve => setTimeout(resolve, 0))

  const joined = harness.logs.map(entry => entry.message).join('\n')
  assert.match(joined, /启动失败/, `应留下可查诊断：${joined}`)
  assert.match(joined, /ValidationError/, `诊断应含错误类型：${joined}`)
  assert.equal(
    joined.includes(secret),
    false,
    `日志不得回显展开后的环境变量值：${joined}`,
  )
})

// —— 回归守卫：挂载记账必须回答"现在什么是活的"，而不是"曾经挂过谁" ——
//
// 修复前 `mountInto` 的拒绝处理器只记日志、**不把条目摘掉**，于是启动失败的服务器会
// 永久留在 `AgentRegistrations.servers` 里，`/mcp-project` 把它列进"已挂载（模型可见的
// 工具名为 mcp__<名称>__*）"——而那条命令的唯一职责就是回答"现在什么是活的"。

test('fiber 启动失败后该名不再出现在"已挂载"里，并留下"已从挂载记账移除"的诊断', async () => {
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})
  const agent = harness.makeAgent(project)

  // 真实形状：`mcp-client` 的 fiber 以启动失败拒绝（连接失败、工具同步失败、重名等）。
  // `failOnStartupError: false` 只保证它不打断会话，不保证实例活着——失败的 fiber 停在
  // FAILED 状态（`vendor/cordis/src/fiber.ts:576` 的 `_getState` 把 `_error` 映射成 FAILED）。
  agent.ctx.plugin = (module: unknown, config: unknown) => {
    harness.pluginCalls.push({ module, config: config as { serverName: string } })
    const fiber: FiberShape = { disposed: 0, dispose: async () => { fiber.disposed += 1 } }
    const error = new Error('startup failed')
    error.name = 'StartupError'
    return Object.assign(fiber, {
      then: (_ok?: unknown, onErr?: (e: unknown) => unknown) =>
        Promise.resolve().then(() => { throw error }).catch(onErr as never),
    })
  }

  await harness.fire('agent/created', { agent })
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(harness.pluginCalls.length, 1, '已批准的项目服务器应尝试挂载一次')
  assert.ok(
    harness.logs.some(
      entry => entry.message.includes('启动失败') && entry.message.includes('已从挂载记账移除'),
    ),
    `启动失败应留下"已从挂载记账移除"的可查诊断：${JSON.stringify(harness.logs)}`,
  )

  const view = (await harness.consoleApi().status(agent.id)).body?.view as ConsoleViewLike
  assert.equal(
    view.rows.find(row => row.serverName === 'alpha')?.state,
    'failed',
    '启动失败的服务器不得被报成"已挂载"',
  )
  assert.equal(view.actionCount, 1, '失败的项要计入需动作数，用户才看得到要点重试')
})

test('迟到的 fiber 拒绝不得摘掉同名的新条目（按身份摘除）', async () => {
  // 摘除必须按**身份**而不是按名字：条目可能已被后来者替换（用户 untrust 再 trust），
  // 此时旧 fiber 的拒绝若照名删除，会把活着的新实例从记账里抹掉——那是与缺陷 1 相反的
  // 同一个错误（记账再次说错"现在什么是活的"）。
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})
  const agent = harness.makeAgent(project)

  // 第一条 fiber 的拒绝被扣住，等同名的新条目挂上之后再放行。
  let rejectFirst: ((error: unknown) => void) | undefined
  const original = agent.ctx.plugin.bind(agent.ctx)
  let calls = 0
  agent.ctx.plugin = (module: unknown, config: unknown) => {
    calls += 1
    if (calls > 1) return original(module, config)
    harness.pluginCalls.push({ module, config: config as { serverName: string } })
    const fiber: FiberShape = { disposed: 0, dispose: async () => { fiber.disposed += 1 } }
    return Object.assign(fiber, {
      then: (_ok?: unknown, onErr?: (e: unknown) => unknown) => {
        rejectFirst = onErr as (error: unknown) => void
        return Promise.resolve()
      },
    })
  }

  await harness.fire('agent/created', { agent })
  assert.equal(calls, 1, '首次挂载应走被扣住拒绝的第一条 fiber')

  const api = harness.consoleApi()
  // revoke 清空记账（旧 fiber 被 dispose）→ start 挂上同名的**新**条目。
  assert.equal((await api.revoke(agent.id, 'alpha')).body?.ok, true)
  assert.equal((await api.start(agent.id, 'alpha')).body?.ok, true)
  assert.equal(calls, 2, 'revoke 之后应能重新挂载同名服务器')

  // 旧 fiber 的拒绝现在才到：它不属于记账里的当前条目。
  rejectFirst?.(new Error('stale failure'))

  const view = (await api.status(agent.id)).body?.view as ConsoleViewLike
  assert.equal(
    view.rows.find(row => row.serverName === 'alpha')?.state,
    'mounted',
    '新条目仍在，迟到的旧失败不得把它标成 failed（控制台会对活着的服务器说谎）',
  )
})

test('过大的 .mcp.json 被拒读：报"过大"而不是"没有 .mcp.json"，且不进入挂载路径', async () => {
  // 威胁模型是"克隆陌生仓库并打开它"，而读盘发生在 `agent/created` 的**同步路径**上。
  // 修复前 `readFileSync` 无条件把整份文件读进内存（只有 >2GiB 才由 Node 抛
  // `ERR_FS_FILE_TOO_LARGE`，且会被 catch 成"文件不存在"——诊断反而更差）。
  //
  // 刻意写**合法 JSON**：这样"读到了并解析成功"与"被尺寸闸门拒读"会走出完全不同的
  // 计划形状（前者是 untrusted/mount，后者是 invalid + 过大）。把尺寸检查回退掉，
  // 本用例立刻变红。
  const root = mkdtempSync(join(tmpdir(), 'project-mcp-big-'))
  mkdirSync(join(root, '.git'), { recursive: true })
  const raw = JSON.stringify({
    mcpServers: { alpha: { command: 'node' } },
    padding: 'x'.repeat(1024 * 1024 + 4096),
  })
  writeFileSync(join(root, '.mcp.json'), raw)

  const harness = createHarness()
  apply(harness.host as never, {})
  const agent = harness.makeAgent({ root, raw })
  await harness.fire('agent/created', { agent })

  assert.equal(harness.pluginCalls.length, 0, '超限文件不得进入挂载路径')

  // 诊断归控制台：`invalid` 计划折成一条 fileNote，用户点按钮就能看到。
  const view = (await harness.consoleApi().status(agent.id)).body?.view as ConsoleViewLike
  const note = view.fileNote ?? ''
  assert.match(note, /过大/, `应报"过大"而不是别的失败：${note}`)
  assert.doesNotMatch(note, /没有 \.mcp\.json/, `文件明明在，不得谎报"没有 .mcp.json"：${note}`)
  // 诊断必须给出可行动的尺寸信息，且只含路径/尺寸，不含文件内容（红线 3）。
  assert.match(note, new RegExp(String(1024 * 1024)), `应报出上限：${note}`)
  assert.equal(note.includes('padding'), false, `诊断不得回显文件内容：${note}`)
  assert.equal(view.actionCount, 1, '文件坏了也要上徽标，否则用户根本不知道要点开看')

  // G4：`invalid` 计划也**不**注入会话提示；"文件太大"的诊断只走控制台弹层。
  assert.equal(harness.liveSections().length, 0, '超限也不得注入会话提示')
})

// —— 端到端守护：`env` / `headers` 的 `__proto__` 键必须穿过守卫到达 ctx.plugin() ——
//
// `translate.test.mts` 的 `__proto__` 用例只断言**翻译层**的输出，从不穿过守卫。于是
// "守卫在下一层把键又抹掉"这类缺陷完全没有守护：`validateMountConfig` 曾用
// `value ?? config` 返回 schema 规范化后的值，而 schemastery 的 dict resolver 用朴素赋值
// `result[rKey] = property(...)`（`vendor/schemastery/src/index.ts:790-792`）——`__proto__`
// 命中原型 setter，字符串值不满足其对象要求 → 静默 no-op。
//
// 下面的用例断言**最终交给 `ctx.plugin()` 的 config**（`pluginCalls[0].config`）仍带该键
// ——把守卫改回 `value ?? config` 立刻变红。
//
// **本用例证明的边界**：只到 `ctx.plugin()` 的入参为止。真实 Cordis 随后会在
// `_resolveConfig` 里对同一份 schema 再跑一次规范化（`vendor/cordis/src/fiber.ts:655`），
// 那一层同样会丢掉该键——**本插件无法阻止**。因此"该键到不了服务器"是下游局限，
// 见 `docs/development.md` §8 的未验证项；本用例守护的是"本插件自己不再额外丢一次"。

test('端到端：.mcp.json 的 env 含 __proto__ 键，交给 ctx.plugin 的 config 仍有该键', async () => {
  // 用 JSON.parse 而不是字面量：对象字面量里的 `__proto__` 是**设置原型**的特殊语法，
  // 根本不会成为自有键，测不到任何东西。`.mcp.json` 是外部输入，走 JSON.parse。
  const entry = JSON.parse('{"command":"node","env":{"__proto__":"X","OK":"v"}}')
  const project = makeProject({ alpha: entry })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})

  await harness.fire('agent/created', { agent: harness.makeAgent(project) })

  assert.equal(harness.pluginCalls.length, 1, '已批准的项目服务器应挂载一次')
  const env = (harness.pluginCalls[0]!.config as { env?: Record<string, string> }).env
  assert.ok(env !== undefined, 'config 必须带 env')
  assert.equal(
    Object.hasOwn(env, '__proto__'),
    true,
    `守卫不得在下一层抹掉 translate 保住的键；实际 keys=${JSON.stringify(Object.keys(env))}`,
  )
  assert.equal(env['__proto__'], 'X', '该键的值必须原样保留')
  assert.equal(env['OK'], 'v', '同一条目的其他键不得受影响')
})

test('端到端：.mcp.json 的 headers 含 __proto__ 键，交给 ctx.plugin 的 config 仍有该键', async () => {
  const entry = JSON.parse('{"type":"http","url":"https://example.invalid","headers":{"__proto__":"Y","H":"v"}}')
  const project = makeProject({ alpha: entry })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})

  await harness.fire('agent/created', { agent: harness.makeAgent(project) })

  assert.equal(harness.pluginCalls.length, 1, '已批准的项目服务器应挂载一次')
  const headers = (harness.pluginCalls[0]!.config as { headers?: Record<string, string> }).headers
  assert.ok(headers !== undefined, 'config 必须带 headers')
  assert.equal(
    Object.hasOwn(headers, '__proto__'),
    true,
    `守卫不得在下一层抹掉 translate 保住的键；实际 keys=${JSON.stringify(Object.keys(headers))}`,
  )
  assert.equal(headers['__proto__'], 'Y', '该键的值必须原样保留')
  assert.equal(headers['H'], 'v', '同一条目的其他键不得受影响')
})

// —— 缺陷 1 回归守卫：同一 sessionId、两个**不同**的 agent 对象 ——
//
// 修复前 `AgentRegistrations` 的键是 **agent 对象引用**。`agent/created` 对同一个
// sessionId 报告两次、而两次传的是不同对象时，`agents.get(agent)` 落空 → 建出一个空的
// 新条目 → `servers.has(config.serverName)` 的幂等判定失效 → 同一个服务器被
// `ctx.plugin()` 挂第二遍。而 `mcp-client` 的重名守卫按 **scope 对象**隔离
// （`activeServerNames` 是 `WeakMap<object, Set<string>>`，
// `packages/mcp/mcp-client/src/index.ts:47`），两个 agent 对象的 scope 不同，第二个实例
// 因此能挂上——于是同一个会话出现两份连接与**两个命令行逐字相同的子进程**
// （控制器实测：两个 `MudBlazor.Mcp.dll --stdio --version 9.10.0`，父进程同为 DSH，
// cwd 相同，启动时间差 4.5 秒，且两个都活着）。
//
// 键改成 `agent.id`（SessionId）之后，第二个对象命中同一个登记项，`servers.has` 重新
// 生效。把键改回对象引用，本组的第一条用例立刻变红。
//
// 为什么之前没有守护：全部既有夹具的 `makeAgent` 都把 id 硬编码成 `'a1'`，而
// **对象引用**是每个 agent 独有的——两条用例看起来"共享 id"，实际走的是两条互不相干的
// 登记项，缺陷因此在测试里完全不可见。夹具现在默认每次生成**唯一** id（与真实 DSH 一致：
// `agent.id === agent.session.id`），同 id 场景必须由用例显式构造。

/** 同一会话被报告两次：两个不同对象、同一个 `id`。 */
function duplicateAgents(harness: ReturnType<typeof createHarness>, project: Project, id: string) {
  const first = harness.makeAgent(project, { id })
  const second = harness.makeAgent(project, { id })
  assert.notEqual(first, second, '本组用例的前提是两个**不同**的 agent 对象')
  assert.equal(first.id, second.id, '两个对象必须共享同一个 sessionId')
  return { first, second }
}

test('同一 sessionId 的第二个 agent 对象不再重复挂载（缺陷 1 端到端守护）', async () => {
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})

  const { first, second } = duplicateAgents(harness, project, 'session-dup')
  await harness.fire('agent/created', { agent: first })
  assert.equal(harness.pluginCalls.length, 1, '首次创建应挂载一次')

  await harness.fire('agent/created', { agent: second })
  assert.equal(
    harness.pluginCalls.length,
    1,
    `同一 sessionId 的第二个 agent 对象不得重复挂载：实际 ${harness.pluginCalls.length} 次。` +
      '每次 ctx.plugin 都会建一个 mcp-client 实例并 spawn 一个子进程，多一次就是多一个命令行相同的进程',
  )
  assert.equal(harness.fibers.length, 1, '不得多建一个 fiber')
})

test('同一 sessionId 的第二个 agent 对象复用同一份记账：revoke 卸载的是它挂的 fiber', async () => {
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})

  const { first, second } = duplicateAgents(harness, project, 'session-dup')
  await harness.fire('agent/created', { agent: first })
  assert.equal(harness.fibers[0]!.disposed, 0)

  // 用**第二个**对象发起撤销：登记项必须落在同一个键（会话 id）上。按对象引用记账时这里
  // 什么都不会卸载，第一个对象挂的 fiber 会一直活到插件卸载——"撤销了但进程还在"。
  // `second` 也登记进了活会话表，桥接按 id 取到的正是它，因此这条同时守护"按 id 取 agent"。
  const out = await harness.consoleApi().revoke(second.id, 'alpha')
  assert.equal(out.body?.ok, true, out.body?.reason)
  assert.equal(
    harness.fibers[0]!.disposed,
    1,
    '第二个 agent 对象发起的撤销必须能卸载第一个对象挂的 fiber',
  )
})

test('同一 sessionId 的第二个 agent 对象销毁时清理插件侧登记项（agent/disposed 用同一个键）', async () => {
  // `agent/disposed` 同样按对象引用取登记项时，清理会落空 → fiber 与提示段一直挂在插件侧
  // （泄漏），直到插件自己被卸载。键必须与挂载时逐字相同。
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})

  const { first, second } = duplicateAgents(harness, project, 'session-dup')
  await harness.fire('agent/created', { agent: first })
  assert.equal(harness.fibers[0]!.disposed, 0)

  await harness.fire('agent/disposed', { agent: second })
  assert.equal(harness.fibers[0]!.disposed, 1, '销毁第二个对象必须回收第一个对象挂的 fiber')

  // 登记项已删：插件随后卸载不得二次 dispose（重复拆除是幂等的）。
  harness.unload()
  assert.equal(harness.fibers[0]!.disposed, 1, '重复拆除不得再次 dispose')
})

test('同一 sessionId 的第二个 agent 对象也不注入提示段（G4 幂等）', async () => {
  // 旧实现里这条守护"提示段幂等"（按对象引用记账会注入两条）。控制台化后两个 agent
  // 对象都不得注入任何段；挂载幂等由上面的缺陷 1 守护单独钉住。
  const project = makeProject({ alpha: { command: 'node' } })
  const harness = createHarness()
  apply(harness.host as never, {})

  const { first, second } = duplicateAgents(harness, project, 'session-dup')
  await harness.fire('agent/created', { agent: first })
  assert.equal(harness.liveSections().length, 0)

  await harness.fire('agent/created', { agent: second })
  assert.equal(harness.liveSections().length, 0, '同一会话的任何 agent 对象都不得注入提示段')
})

test('不同 sessionId 各自挂载，不误拦', async () => {
  // 修复的方向是"按会话身份记账"，不是"全局只挂一次"：N 个会话就是 N 份连接与子进程
  // （规格 §10）。把键改成任何全局唯一值都会让第二个会话静默拿不到工具。
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})

  const a = harness.makeAgent(project, { id: 'session-a' })
  const b = harness.makeAgent(project, { id: 'session-b' })
  await harness.fire('agent/created', { agent: a })
  await harness.fire('agent/created', { agent: b })

  assert.equal(harness.pluginCalls.length, 2, '两个不同会话各挂一次')
  assert.equal(harness.fibers.length, 2, '每个会话有自己的 fiber')
})

test('agent.id 缺失或非字符串时不挂载，并留下可查诊断', async () => {
  // 键不可用时**宁可少挂一次**：退回对象引用正是缺陷 1 的成因，重复挂载会多 spawn 一个
  // 子进程而用户没有任何可见线索；少挂一次在 `/mcp-project` 里看得见（未挂载），重开
  // 会话即恢复。因此这条路径必须是"跳过 + 记日志"，不是"尽力而为地挂上"。
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])

  const badIds: unknown[] = [undefined, null, '', 42, { id: 'x' }, ['session-1']]
  for (const badId of badIds) {
    const harness = createHarness()
    apply(harness.host as never, {})
    await harness.fire('agent/created', { agent: harness.makeAgent(project, { id: badId }) })

    const shown = JSON.stringify(badId)
    assert.equal(harness.pluginCalls.length, 0, `id=${shown} 时不得挂载`)
    assert.ok(
      harness.logs.some(entry => entry.level === 'warn' && entry.message.includes('无法按会话记账')),
      `id=${shown} 时应留下可查诊断：${JSON.stringify(harness.logs)}`,
    )
  }
})

test('会话不可寻址时控制台如实回空，而不是编一个状态', async () => {
  // 没有会话键（id 缺失）就没有可寻址的视图。桥接此时必须回 `null` / `session-not-found`，
  // 否则按钮会拿着一个凭空想象出来的"已挂载"骗用户。
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})

  const agent = harness.makeAgent(project, { id: undefined })
  await harness.fire('agent/created', { agent })
  assert.equal(harness.pluginCalls.length, 0, 'id 不可用时不得挂载')

  const api = harness.consoleApi()
  const ghost = await api.status('session-never-created')
  assert.equal(ghost.status, 200)
  assert.equal(ghost.body?.view, null, '无从按会话检视时如实回 null')

  const start = await api.start('session-never-created', 'alpha')
  assert.equal(start.body?.ok, false)
  assert.equal(start.body?.reason, 'session-not-found')
  assert.equal(harness.pluginCalls.length, 0, '查不到的会话不得挂到别的会话上')
})

// —— 功能 3：自动注入的会话标记 ——
//
// 需求是"一眼看出是哪个会话/哪个宿主启动的进程"，且标记不影响 dotnet 运行。标记追加在
// 文件给出的 `args` **之后**，只含 SessionId（进程命令行对本机所有用户可见，不得携带
// 任何配置内容）。纯函数层面的守护（不修改入参、args 缺失、http 直通）在
// `session-tag.test.mts`；这里是穿过 `apply` 的端到端面。

test('stdio 挂载的命令行带 --project-mcp-session <sessionId>，追加在原有 args 之后', async () => {
  const project = makeProject({ alpha: { command: 'node', args: ['--stdio', '--version', '9.10.0'] } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})

  await harness.fire('agent/created', { agent: harness.makeAgent(project, { id: 'session-1f4830f2' }) })

  assert.deepEqual(
    harness.pluginCalls[0]!.config.args,
    ['--stdio', '--version', '9.10.0', '--project-mcp-session', 'session-1f4830f2'],
    '标记必须追加在文件给出的 args 之后（既不覆盖也不重排它们）',
  )
})

test('两个会话的标记不同：多进程可据此分辨归属', async () => {
  // 这是本功能的全部理由：同一份 `.mcp.json` 产出的命令行**逐字相同**，唯一能区分
  // "哪个进程属于哪个会话"的就是这一段。
  const project = makeProject({ alpha: { command: 'node', args: ['--stdio'] } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})

  await harness.fire('agent/created', { agent: harness.makeAgent(project, { id: 'session-a' }) })
  await harness.fire('agent/created', { agent: harness.makeAgent(project, { id: 'session-b' }) })

  const tail = (index: number) => harness.pluginCalls[index]!.config.args!.slice(-2)
  assert.deepEqual(tail(0), ['--project-mcp-session', 'session-a'])
  assert.deepEqual(tail(1), ['--project-mcp-session', 'session-b'])
  assert.notDeepEqual(tail(0), tail(1), '两个会话的命令行必须可区分')
})

test('streamable-http 挂载不追加标记（没有子进程命令行可标记）', async () => {
  const project = makeProject({ alpha: { type: 'http', url: 'https://example.invalid/mcp' } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})

  await harness.fire('agent/created', { agent: harness.makeAgent(project, { id: 'session-1' }) })

  const config = harness.pluginCalls[0]!.config as { transport?: string; args?: unknown; url?: string }
  assert.equal(config.transport, 'streamable-http')
  assert.equal(config.args, undefined, 'http 分支不得凭空多出 args 字段')
  assert.equal(config.url, 'https://example.invalid/mcp', 'url 必须原样保留')
})

test('标记只含 SessionId：不得把展开后的 env 值带进命令行', async () => {
  // 红线 3 的新通道：命令行对本机所有用户可见（任务管理器、`wmic process get
  // commandline`、`/proc/<pid>/cmdline`）。标记是插件唯一新增的命令行内容，必须证明它
  // 只有 SessionId。
  const secret = 'placeholder-token-not-a-real-credential'
  process.env.PROJECT_MCP_TAG_TOKEN = secret
  const project = makeProject({ alpha: { command: 'node', env: { TOKEN: '${PROJECT_MCP_TAG_TOKEN}' } } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})

  await harness.fire('agent/created', { agent: harness.makeAgent(project, { id: 'session-1' }) })

  const args = JSON.stringify(harness.pluginCalls[0]!.config.args)
  assert.equal(args.includes(secret), false, `命令行不得携带展开后的环境变量值：${args}`)
  assert.deepEqual(
    harness.pluginCalls[0]!.config.args,
    ['--project-mcp-session', 'session-1'],
    '标记必须是命令行的全部新增内容',
  )
})
