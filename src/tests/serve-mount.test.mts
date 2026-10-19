import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TrustStore } from '../trust.js'

/**
 * `serve` 的**端到端**守护：穿过真实 `apply` + 真实 `agent/created` + 真实 spawn。
 *
 * ## 为什么必须有这个文件（`serve.test.mts` 覆盖不到什么）
 *
 * `serve.test.mts` 的 `spawnDetached` 是**注入**的——它能精确断言"调用了几次、参数是什么"，
 * 但证明不了下面这几件事，而它们恰好是最容易写错、后果最严重的地方：
 *
 * 1. **`spawnDetached` 真的把进程拉起来了**。注入版只是记录一次调用；真实的
 *    `spawn(command, args, { detached, stdio: 'ignore', windowsHide, env })` 里任何一个
 *    参数写错（比如 `stdio: 'ignore'` 漏掉、`env` 忘了合并 `process.env`）都不会被单测发现。
 * 2. **`serve` 元数据真的没被交给 `ctx.plugin()`**。剥离发生在 `mountInto` 里，注入层看不到
 *    `ctx.plugin()` 的入参。
 * 3. **会话创建路径真的会 await**。本文件的 `fire` 按 Cordis 的 serial 语义 await 监听器，
 *    因此"await 之后 spawn 已经发生"是一个可观测事实——`mountInto` 退回同步会让这条变红。
 * 4. **stdio 条目完全不受影响**（规格 §7 最后一行）：连健康检查都不做。
 *
 * ## 真实 spawn 怎么做才不会留下垃圾
 *
 * 用**当前 Node 可执行文件**（`process.execPath`）跑一个内联的 `-e` 脚本：它把
 * `serve.env` 里的探针值写进一个标记文件，然后**立即退出**。于是：
 * - 断言可以读标记文件，证明 `env` 真的被传给了子进程（而不是只存在于本进程内存里）；
 * - 子进程立刻退出，不留下常驻服务；
 * - 不需要真的 dotnet 或任何外部依赖。
 *
 * 标记文件落在临时目录里（本文件的每个项目都有自己的 `mkdtempSync`）。**临时目录刻意不
 * 清理**：工作区规则禁止代理永久删除文件，且它们位于系统临时目录下。
 *
 * ## 假 mcp-client 与 DSH_HOME
 *
 * 与 `mount.test.mts` 同一手法：在临时 profile 里放一个假 mcp-client，因此不依赖本机真实
 * profile，也不写真实 `$DSH_HOME`。假 mcp-client **带 Config schema**（且 schema 里**没有**
 * `serve`），因此"带着 serve 进 `ctx.plugin()`"在本文件里是一个可断言的失败。
 */

// 必须在导入被测模块之前改 DSH_HOME：`profile-modules.ts` 在模块顶层就按 profile 解析并
// 缓存 DSH 运行时模块，之后再改环境变量不会重新解析。
const home = mkdtempSync(join(tmpdir(), 'project-mcp-serve-home-'))
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
 * 假 mcp-client。
 *
 * 关键点：schema 里**没有** `serve`。真实 `Config` 的 union
 * （`packages/mcp/mcp-client/src/index.ts:119-142`）同样没有它，因此本文件的 schema 忠实
 * 复刻了那个约束。而 schemastery 的 object resolver 在非 strict 下会把未知键**原样带进**
 * `apply` 收到的配置（`merge(result, data)`）——也就是说**即使带着 `serve` 也照样通过校验**。
 * 所以"不得带 serve"这条不能靠校验失败来发现，必须**显式断言** `ctx.plugin()` 的入参
 * （见下面的 `pluginCalls`）：剥离掉之后断言 `Object.hasOwn(config, 'serve') === false`，
 * 把剥离回退掉立刻变红。
 */
writeFileSync(join(fakeClientDir, 'index.mjs'), `
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

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
      env: { ...(value.env ?? {}) },
      cwd: typeof value.cwd === 'string' ? value.cwd : '',
      failOnStartupError: value.failOnStartupError === true,
    }
  }
  if (value.transport === 'streamable-http') {
    if (typeof value.url !== 'string' || value.url === '') return undefined
    return {
      transport: 'streamable-http',
      serverName: value.serverName,
      url: value.url,
      headers: { ...(value.headers ?? {}) },
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

const { apply } = await import('../index.js')
const { approve, configHashOf, trustStorePath } = await import('../trust.js')
const { normalizeServerName } = await import('../translate.js')

interface Project {
  root: string
  /** `.mcp.json` 的确切文本；指纹必须针对它计算。 */
  raw: string
}

/** 建一个临时项目：含 `.git`（供 `findProjectRoot` 定位）与 `.mcp.json`。 */
function makeProject(servers: Record<string, unknown>): Project {
  const root = mkdtempSync(join(tmpdir(), 'project-mcp-serve-proj-'))
  mkdirSync(join(root, '.git'), { recursive: true })
  const raw = JSON.stringify({ mcpServers: servers }, null, 2)
  writeFileSync(join(root, '.mcp.json'), raw)
  return { root, raw }
}

/**
 * 写信任存储，批准该项目指定的服务器（v2：服务器 × 配置哈希）。
 *
 * 哈希从 `.mcp.json` 的**原文条目**算出，与计划算的是同一份输入——手搓哈希会让
 * "批准了却没挂上"这类失配缺陷在测试里看不见。
 */
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

/**
 * 一个**真实可跑**的 `serve.command`：把 `serve.env` 里的值写进标记文件后立即退出。
 *
 * `process.execPath` 是当前 Node 可执行文件（绝对路径），因此不依赖 PATH 上有什么。
 * 脚本通过 `-e` 内联传入，**不含**任何项目路径（`env` 由 `serve.env` 提供）。
 */
function markerCommand(markerPath: string): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [
      '-e',
      `require('node:fs').writeFileSync(process.env.PROJECT_MCP_SERVE_MARKER, ` +
        `JSON.stringify({ token: process.env.PROJECT_MCP_SERVE_TOKEN ?? null }))`,
    ],
  }
}

interface FiberShape {
  disposed: number
  dispose(): Promise<void>
}

function createHarness() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const effects: Array<() => void> = []
  const logs: Array<{ level: string; message: string }> = []
  /**
   * 传给 `ctx.plugin()` 的每一对 (模块, 配置)。
   *
   * 本文件最关键的观测面：断言入参**没有** `serve` 键（剥离的端到端守护），以及
   * `transport` / `url` 原样保留。
   */
  const pluginCalls: Array<{ module: unknown; config: Record<string, unknown> }> = []
  const fibers: FiberShape[] = []

  const host = {
    get(name: string) {
      // 命令面已删除；`loader` 缺席意味着全局撞名名单为空（本文件不关心撞名）。
      if (name === 'loader') return undefined
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

  let nextSessionId = 0
  function makeAgent(project: Project, options: { id?: unknown } = {}) {
    nextSessionId += 1
    const agent = {
      id: Object.hasOwn(options, 'id') ? options.id : `session-${nextSessionId}`,
      session: { header: { cwd: project.root } },
    } as any
    agent.ctx = {
      get: () => undefined,
      on: () => () => {},
      effect(dispose: () => void | (() => void)) {
        return dispose() ?? (() => {})
      },
      plugin(module: unknown, config: unknown) {
        pluginCalls.push({ module, config: config as Record<string, unknown> })
        const fiber: FiberShape = { disposed: 0, dispose: async () => { fiber.disposed += 1 } }
        fibers.push(fiber)
        return Object.assign(fiber, {
          then: (onOk?: unknown, onErr?: unknown) => Promise.resolve().then(onOk as never, onErr as never),
        })
      },
    }
    return agent
  }

  return {
    host, logs, pluginCalls, fibers, makeAgent,
    /** 全部日志文本（含 warn 与 error），用于"不含敏感值"断言。 */
    joined: () => logs.map(entry => entry.message).join('\n'),
    /**
     * 派发事件，**按 Cordis 的 serial 语义 await 每个监听器**。
     *
     * 真实 `agent/created` 是 serial 且被 await（`packages/core/agent/src/index.ts:550`），
     * 契约是 "AgentLoop holds queued input until all listeners finish"
     * （`runtime-types.ts:257`）。同步遍历会让断言跑在监听器完成之前，"await 之后服务已
     * 被拉起"这条断言就无从成立。
     */
    fire: async (name: string, payload: unknown) => {
      for (const callback of listeners.get(name) ?? []) await callback(payload)
    },
  }
}

/** 等到 `check()` 为真，或超时。用于等待**子进程**真的写完标记文件。 */
async function until(check: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return check()
}

// —— 端到端：健康检查失败 → 真的把服务拉起来 → 挂载继续 ——

test('端到端：健康检查失败 + 有 serve → 真实 spawn 拉起服务，并把 serve.env 传给子进程', async () => {
  // 这个端口上没有任何服务：健康检查必然失败（Windows 上是 ECONNREFUSED，立即返回）。
  const port = 19731
  const marker = join(mkdtempSync(join(tmpdir(), 'project-mcp-marker-')), 'started.json')
  const { command, args } = markerCommand(marker)

  const project = makeProject({
    mudblazor: {
      type: 'http',
      url: `http://127.0.0.1:${port}/mcp`,
      serve: {
        command,
        args,
        env: { PROJECT_MCP_SERVE_MARKER: marker, PROJECT_MCP_SERVE_TOKEN: 'placeholder-token-not-real' },
        // 极短超时：服务不会真的就绪（它写完标记就退出了），本用例关心的是"拉起"这一步。
        readyTimeoutMs: 300,
      },
    },
  })
  approveAll(project, ['mudblazor'])
  const harness = createHarness()
  apply(harness.host as never, {})

  await harness.fire('agent/created', { agent: harness.makeAgent(project) })

  // 1. 服务**真的**被拉起来了：标记文件由子进程写出。
  const started = await until(() => existsSync(marker))
  assert.ok(started, `子进程未写出标记文件 ${marker}，说明真实 spawn 没有发生`)
  const written = JSON.parse(readFileSync(marker, 'utf8')) as { token: string | null }
  assert.equal(
    written.token,
    'placeholder-token-not-real',
    'serve.env 必须真的被传给子进程（而不是只存在于本进程内存里）',
  )

  // 2. 超时后**仍然挂载**（设计 §8 决策 2：交给 mcp-client 自己重试）。
  assert.equal(harness.pluginCalls.length, 1, '超时不得阻止挂载')
  assert.equal(harness.pluginCalls[0]!.config.transport, 'streamable-http')
  assert.equal(harness.pluginCalls[0]!.config.url, `http://127.0.0.1:${port}/mcp`)
  assert.equal(harness.pluginCalls[0]!.config.failOnStartupError, false)

  // 3. 超时留下可查诊断。
  assert.match(harness.joined(), /等待就绪/, `应留下超时诊断：${harness.joined()}`)
})

test('端到端：健康检查成功 → 不 spawn（serve 完全不被触碰）', async () => {
  // 起一个**真实的**最小 HTTP 健康端点：成功路径只有真打一次网络才算证明。
  const { createServer } = await import('node:http')
  const server = createServer((request, response) => {
    void request
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('Healthy')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  const port = address.port

  try {
    const marker = join(mkdtempSync(join(tmpdir(), 'project-mcp-marker-')), 'started.json')
    const { command, args } = markerCommand(marker)
    const project = makeProject({
      mudblazor: {
        type: 'http',
        url: `http://127.0.0.1:${port}/mcp`,
        serve: {
          command,
          args,
          env: { PROJECT_MCP_SERVE_MARKER: marker },
          readyTimeoutMs: 1000,
        },
      },
    })
    approveAll(project, ['mudblazor'])
    const harness = createHarness()
    apply(harness.host as never, {})

    await harness.fire('agent/created', { agent: harness.makeAgent(project) })

    // 服务已在跑（健康端点 200）→ 零额外动作：不 spawn，也没有超时诊断。
    assert.equal(existsSync(marker), false, '健康检查成功时不得 spawn 服务')
    assert.doesNotMatch(harness.joined(), /等待就绪/, `不得留下超时诊断：${harness.joined()}`)
    assert.doesNotMatch(harness.joined(), /拉起/, `不得留下拉起诊断：${harness.joined()}`)
    assert.equal(harness.pluginCalls.length, 1, '照常挂载')
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('端到端：健康检查失败 + 无 serve → 不 spawn、记 warn、仍挂载', async () => {
  const project = makeProject({
    mudblazor: { type: 'http', url: 'http://127.0.0.1:19732/mcp' },
  })
  approveAll(project, ['mudblazor'])
  const harness = createHarness()
  apply(harness.host as never, {})

  await harness.fire('agent/created', { agent: harness.makeAgent(project) })

  assert.equal(harness.pluginCalls.length, 1, '没有 serve 也必须照常挂载')
  const logs = harness.joined()
  assert.match(logs, /mudblazor/, `诊断应含服务器名：${logs}`)
  assert.match(logs, /没有 serve/, `诊断应说明缺少 serve 配置：${logs}`)
})

test('端到端：两个会话同时挂载同一 url → 只 spawn 一次（并发去重）', async () => {
  // 去重表由 `apply` 持有并跨会话共享，因此必须走**同一个 apply**。两个 agent 的
  // `agent/created` 并发派发（`Promise.all` 而不是逐个 await），才真正构成"同时挂载"。
  const port = 19733
  const dir = mkdtempSync(join(tmpdir(), 'project-mcp-marker-'))
  const project = makeProject({
    mudblazor: {
      type: 'http',
      url: `http://127.0.0.1:${port}/mcp`,
      serve: {
        command: process.execPath,
        // 每次启动都往**同一个**目录里追加一行：行的数量就是 spawn 的次数。
        args: [
          '-e',
          `require('node:fs').appendFileSync(process.env.PROJECT_MCP_SERVE_LOG, 'spawned\\n')`,
        ],
        env: { PROJECT_MCP_SERVE_LOG: join(dir, 'spawns.log') },
        readyTimeoutMs: 400,
      },
    },
  })
  approveAll(project, ['mudblazor'])
  const harness = createHarness()
  apply(harness.host as never, {})

  await Promise.all([
    harness.fire('agent/created', { agent: harness.makeAgent(project, { id: 'session-a' }) }),
    harness.fire('agent/created', { agent: harness.makeAgent(project, { id: 'session-b' }) }),
  ])

  // 两个会话各自挂载了自己的 mcp-client 实例（每个会话一份连接，规格 §10）。
  assert.equal(harness.pluginCalls.length, 2, '两个会话各挂一次')

  const logPath = join(dir, 'spawns.log')
  await until(() => existsSync(logPath))
  const lines = existsSync(logPath)
    ? readFileSync(logPath, 'utf8').split('\n').filter(line => line.trim() !== '')
    : []
  assert.equal(
    lines.length,
    1,
    `同一 url 的并发挂载只应 spawn 一次，实际 ${lines.length} 次——第二个服务会因端口占用失败`,
  )
})

test('端到端：serve 元数据被剥离，绝不交给 ctx.plugin()（它不是 mcp-client 的字段）', async () => {
  // `serve` 不在真实 `Config` 的 union 里。剥离发生在 `mountInto`，只有断言 `ctx.plugin()`
  // 的入参才能守护它——把 `splitServe` 回退掉，本用例立刻变红。
  const project = makeProject({
    mudblazor: {
      type: 'http',
      url: 'http://127.0.0.1:19734/mcp',
      serve: { command: 'node', readyTimeoutMs: 200 },
    },
  })
  approveAll(project, ['mudblazor'])
  const harness = createHarness()
  apply(harness.host as never, {})

  await harness.fire('agent/created', { agent: harness.makeAgent(project) })

  assert.equal(harness.pluginCalls.length, 1)
  const config = harness.pluginCalls[0]!.config
  assert.equal(
    Object.hasOwn(config, 'serve'),
    false,
    `serve 必须被剥离；实际 keys=${JSON.stringify(Object.keys(config))}`,
  )
  // 其余字段原样保留（剥离只去掉 serve，不能顺手改别的）。
  assert.equal(config.transport, 'streamable-http')
  assert.equal(config.url, 'http://127.0.0.1:19734/mcp')
  assert.deepEqual(config.headers, {})
  assert.equal(config.failOnStartupError, false)
})

test('端到端：展开后的 serve.env 值不出现在任何日志（红线 3）', async () => {
  const secret = 'placeholder-token-not-a-real-credential'
  process.env.PROJECT_MCP_SERVE_E2E_TOKEN = secret
  const project = makeProject({
    mudblazor: {
      type: 'http',
      url: 'http://127.0.0.1:19735/mcp',
      serve: {
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        // 经 `${VAR}` 展开：日志里绝不能出现展开后的值。
        env: { TOKEN: '${PROJECT_MCP_SERVE_E2E_TOKEN}' },
        readyTimeoutMs: 200,
      },
    },
  })
  approveAll(project, ['mudblazor'])
  const harness = createHarness()
  apply(harness.host as never, {})

  await harness.fire('agent/created', { agent: harness.makeAgent(project) })

  const logs = harness.joined()
  assert.match(logs, /等待就绪/, `前置条件：确实走到了超时诊断：${logs}`)
  assert.equal(logs.includes(secret), false, `日志不得回显展开后的环境变量值：${logs}`)
})

// —— 回归：stdio 条目完全不受影响（规格 §7 最后一行） ——

test('回归：stdio 条目零额外动作——不探测、不 spawn、不记 serve 相关日志', async () => {
  // 给 stdio 条目配一个**能跑起来**的 serve：若实现错误地对 stdio 也走健康检查流程，
  // 标记文件就会出现。这是"stdio 完全不受影响"的强断言。
  const marker = join(mkdtempSync(join(tmpdir(), 'project-mcp-marker-')), 'started.json')
  const { command, args } = markerCommand(marker)
  const project = makeProject({
    alpha: {
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      serve: { command, args, env: { PROJECT_MCP_SERVE_MARKER: marker } },
    },
  })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})

  await harness.fire('agent/created', { agent: harness.makeAgent(project) })

  assert.equal(harness.pluginCalls.length, 1, 'stdio 条目照常挂载')
  assert.equal(harness.pluginCalls[0]!.config.transport, 'stdio')
  assert.equal(existsSync(marker), false, 'stdio 条目不得触发任何 spawn')
  assert.doesNotMatch(harness.joined(), /等待就绪/, 'stdio 条目不得有任何就绪等待')
  assert.doesNotMatch(harness.joined(), /没有 serve/, 'stdio 条目不得有 serve 相关诊断')
})

test('回归：stdio 条目仍然追加会话标记，且不受 serve 解析影响', async () => {
  const project = makeProject({ alpha: { command: 'node', args: ['--stdio'] } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})

  await harness.fire('agent/created', { agent: harness.makeAgent(project, { id: 'session-1' }) })

  assert.deepEqual(harness.pluginCalls[0]!.config.args, [
    '--stdio',
    '--project-mcp-session',
    'session-1',
  ])
})

// —— serve 畸形：跳过 serve、记 warn、仍挂载 ——

test('serve 畸形（缺 command）→ 跳过 serve + 记 warn，条目仍挂载', async () => {
  const project = makeProject({
    mudblazor: {
      type: 'http',
      url: 'http://127.0.0.1:19736/mcp',
      serve: { args: ['x'] },
    },
  })
  approveAll(project, ['mudblazor'])
  const harness = createHarness()
  apply(harness.host as never, {})

  await harness.fire('agent/created', { agent: harness.makeAgent(project) })

  assert.equal(harness.pluginCalls.length, 1, 'serve 畸形不得让整条条目消失')
  assert.equal(Object.hasOwn(harness.pluginCalls[0]!.config, 'serve'), false)
  const logs = harness.joined()
  assert.match(logs, /serve 配置已被忽略/, `应留下可查诊断：${logs}`)
  assert.match(logs, /command/, `诊断应指出是哪个字段：${logs}`)
})

test('serve 畸形（health scheme 非法）→ 跳过 serve + 记 warn，不抛、仍挂载', async () => {
  const project = makeProject({
    mudblazor: {
      type: 'http',
      url: 'http://127.0.0.1:19737/mcp',
      serve: { command: 'node', health: 'file:///etc/passwd' },
    },
  })
  approveAll(project, ['mudblazor'])
  const harness = createHarness()
  apply(harness.host as never, {})

  await harness.fire('agent/created', { agent: harness.makeAgent(project) })

  assert.equal(harness.pluginCalls.length, 1, '仍挂载')
  assert.match(harness.joined(), /serve 配置已被忽略/, `应留下可查诊断：${harness.joined()}`)
})

test('readyTimeoutMs 非法 → 退回默认并留下可查诊断（不是静默忽略）', async () => {
  // 用**真实的**健康端点让服务"已在跑"：这样健康检查成功、`mountInto` 零等待，用例瞬间
  // 跑完。而 `serve` 字段的解析与诊断发生在**翻译期**（`translateServe`），与健康状态
  // 无关——因此"非法值必须留下诊断"这条依然被完整穿过 `apply` 验证。
  //
  // 刻意**不**让健康检查失败：那会真的走 spawn + 等满退回后的默认值（120 秒），用例会慢
  // 到不可接受，且它要证明的东西与等待无关。
  const { createServer } = await import('node:http')
  const server = createServer((request, response) => {
    void request
    response.writeHead(200)
    response.end('Healthy')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')

  try {
    const project = makeProject({
      mudblazor: {
        type: 'http',
        url: `http://127.0.0.1:${address.port}/mcp`,
        serve: { command: process.execPath, args: ['-e', 'process.exit(0)'], readyTimeoutMs: 'soon' },
      },
    })
    approveAll(project, ['mudblazor'])
    const harness = createHarness()
    apply(harness.host as never, {})

    await harness.fire('agent/created', { agent: harness.makeAgent(project) })

    const logs = harness.joined()
    assert.match(logs, /serve 配置已被修正/, `非法值必须留下可查诊断：${logs}`)
    assert.match(logs, /readyTimeoutMs/, `诊断应指出是哪个字段：${logs}`)
    assert.match(logs, /120000/, `应报出退回后的默认值：${logs}`)
    assert.equal(harness.pluginCalls.length, 1, '仍照常挂载')
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
