import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_READY_TIMEOUT_MS,
  MAX_READY_TIMEOUT_MS,
  deriveHealthUrl,
  ensureServeReady,
  planServeStart,
  splitServe,
} from '../serve.js'
import type { ServeIo } from '../serve.js'
import { POLL_INTERVAL_MS, PROBE_TIMEOUT_MS, checkHealth, isHttpUrl, waitReady } from '../health.js'
import type { HealthIo } from '../health.js'
import type { McpClientConfig, ServeMetadata } from '../types.js'

/**
 * `serve` 字段的**单元**层守护：计划（纯函数）、URL 推导、剥离、健康检查与轮询。
 *
 * 为什么单独成文件：`serve-mount.test.mts` 走的是"真实 `apply` + 假 ctx"的集成路径，
 * 那里每条用例都要先建临时项目、写信任存储、造 agent。而本模块的绝大多数行为是**纯
 * 函数**或**注入 I/O 的编排**——超时、非法 scheme、`readyTimeoutMs` 退化这些分支在集成
 * 层很难精确构造（需要真的等满 120 秒，或真的打一个非法 scheme 的地址）。这里用注入的
 * `fetch` / `sleep` / `now` 把每条分支都变成确定性的，且**不花真实时间**。
 *
 * 本文件不 import `node:fs`，也不改 `DSH_HOME`：与 `session.test.mts` 一样是纯单测。
 */

/** 假 I/O：记录每次探测与每次 sleep，行为由用例给出。 */
function makeIo(options: {
  /** 依次返回的探测结果；用尽后重复最后一项。 */
  responses?: Array<{ ok?: boolean; status?: number } | Error>
  /** 每次 sleep 推进的假时钟毫秒数（默认不推进，模拟"立刻返回"）。 */
  advancePerSleep?: number
} = {}) {
  const responses = options.responses ?? [{ ok: true }]
  const advance = options.advancePerSleep ?? 0
  const probed: string[] = []
  const slept: number[] = []
  let clock = 0
  let index = 0

  const io: HealthIo = {
    fetch: async (url: string) => {
      probed.push(url)
      const response = responses[Math.min(index, responses.length - 1)]!
      index += 1
      if (response instanceof Error) throw response
      return response
    },
    sleep: async (ms: number) => {
      slept.push(ms)
      clock += advance
    },
    now: () => clock,
    timeoutSignal: () => new AbortController().signal,
  }
  return {
    io, probed, slept,
    /** 直接推进假时钟（模拟"单次探测本身很慢"）。 */
    tick: (ms: number) => { clock += ms },
  }
}

/** 一个最小可用的 `serve` 原始值；用例按需覆盖字段。 */
function serveEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { command: 'dotnet', args: ['srv.dll'], ...overrides }
}

// —— 纯函数：planServeStart ——

test('planServeStart 接受最小配置并补齐默认值', () => {
  const plan = planServeStart({
    serve: serveEntry(),
    url: 'http://127.0.0.1:19701/mcp',
    env: {},
  })
  assert.ok(!('skip' in plan), JSON.stringify(plan))
  if ('skip' in plan) return
  assert.equal(plan.command, 'dotnet')
  assert.deepEqual(plan.args, ['srv.dll'])
  assert.deepEqual(plan.env, {})
  // 省略 health 时按设计 §8 决策 1 从 url 的 origin 推导。
  assert.equal(plan.health, 'http://127.0.0.1:19701/health/ready')
  assert.equal(plan.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS)
  assert.deepEqual(plan.notes, [])
})

test('planServeStart 的默认超时是 120 秒（MudMCP 首建索引实测可超 90 秒）', () => {
  assert.equal(DEFAULT_READY_TIMEOUT_MS, 120_000)
})

test('planServeStart 展开 command / args / env / health 里的变量', () => {
  const plan = planServeStart({
    serve: serveEntry({
      command: '${DOTNET}',
      args: ['${DLL}', '--version', '${VER:-9.10.0}'],
      env: { ASPNETCORE_URLS: '${BASE_URL}' },
      health: '${BASE_URL}/health/ready',
    }),
    url: 'http://127.0.0.1:19701/mcp',
    env: { DOTNET: 'dotnet', DLL: 'srv.dll', BASE_URL: 'http://127.0.0.1:19701' },
  })
  assert.ok(!('skip' in plan))
  if ('skip' in plan) return
  assert.equal(plan.command, 'dotnet')
  assert.deepEqual(plan.args, ['srv.dll', '--version', '9.10.0'])
  assert.deepEqual(plan.env, { ASPNETCORE_URLS: 'http://127.0.0.1:19701' })
  assert.equal(plan.health, 'http://127.0.0.1:19701/health/ready')
})

test('planServeStart 在变量缺失时跳过，且原因只含变量名', () => {
  const secret = 'placeholder-token-not-a-real-credential'
  const plan = planServeStart({
    serve: serveEntry({ env: { TOKEN: '${PROJECT_MCP_SERVE_MISSING}' } }),
    url: 'http://127.0.0.1:1/mcp',
    env: { PROJECT_MCP_SERVE_MISSING: undefined, OTHER: secret },
  })
  assert.ok('skip' in plan)
  if (!('skip' in plan)) return
  assert.match(plan.reason, /PROJECT_MCP_SERVE_MISSING/)
  assert.equal(plan.reason.includes(secret), false, '诊断不得含任何环境变量值')
})

test('planServeStart 对缺 command / 非字符串 command 跳过', () => {
  for (const bad of [undefined, null, '', 42, ['dotnet'], {}]) {
    const plan = planServeStart({
      serve: bad === undefined ? { args: [] } : serveEntry({ command: bad }),
      url: 'http://127.0.0.1:1/mcp',
      env: {},
    })
    assert.ok('skip' in plan, `command=${JSON.stringify(bad)} 应跳过`)
    if ('skip' in plan) assert.match(plan.reason, /command/)
  }
})

test('planServeStart 对 command 展开成空串跳过（不留给 spawn 抛难懂的错）', () => {
  const plan = planServeStart({ serve: serveEntry({ command: '${EMPTY:-}' }), url: 'http://x/mcp', env: {} })
  assert.ok('skip' in plan)
  if ('skip' in plan) assert.match(plan.reason, /空字符串/)
})

test('planServeStart 对畸形 args / env 跳过', () => {
  const badArgs = [['a', 1], 'str', { a: 1 }]
  for (const args of badArgs) {
    const plan = planServeStart({ serve: serveEntry({ args }), url: 'http://x/mcp', env: {} })
    assert.ok('skip' in plan, `args=${JSON.stringify(args)} 应跳过`)
    if ('skip' in plan) assert.match(plan.reason, /args/)
  }
  const badEnv = [{ A: 1 }, 'str', ['A']]
  for (const env of badEnv) {
    const plan = planServeStart({ serve: serveEntry({ env }), url: 'http://x/mcp', env: {} })
    assert.ok('skip' in plan, `env=${JSON.stringify(env)} 应跳过`)
    if ('skip' in plan) assert.match(plan.reason, /env/)
  }
})

test('planServeStart 对非对象 serve 跳过', () => {
  for (const bad of [null, 'str', 42, []]) {
    const plan = planServeStart({ serve: bad, url: 'http://x/mcp', env: {} })
    assert.ok('skip' in plan, `serve=${JSON.stringify(bad)} 应跳过`)
  }
})

test('planServeStart 拒绝非 http(s) 的 health（fetch 还支持 file: / data:）', () => {
  const schemes = ['file:///etc/passwd', 'data:text/html,x', 'ftp://x/h', 'ws://x/h', 'x/y']
  for (const health of schemes) {
    const plan = planServeStart({ serve: serveEntry({ health }), url: 'http://x/mcp', env: {} })
    assert.ok('skip' in plan, `health=${health} 应跳过`)
    if ('skip' in plan) assert.match(plan.reason, /http:\/\/ 与 https:\/\//)
  }
})

test('planServeStart 接受 http:// 与 https:// 的 health', () => {
  for (const health of ['http://127.0.0.1:1/h', 'https://example.invalid/h', 'HTTP://X/h']) {
    const plan = planServeStart({ serve: serveEntry({ health }), url: 'http://x/mcp', env: {} })
    assert.ok(!('skip' in plan), `health=${health} 应接受`)
  }
})

test('planServeStart 在 url 推导不出 health 时跳过（不猜一个可能打错的地址）', () => {
  const plan = planServeStart({ serve: serveEntry(), url: 'not-a-url', env: {} })
  assert.ok('skip' in plan)
  if ('skip' in plan) assert.match(plan.reason, /无法从 url 推导/)
})

test('planServeStart 拒绝非字符串 health', () => {
  for (const health of [42, null, {}, ['x']]) {
    const plan = planServeStart({ serve: serveEntry({ health }), url: 'http://x/mcp', env: {} })
    assert.ok('skip' in plan, `health=${JSON.stringify(health)} 应跳过`)
    if ('skip' in plan) assert.match(plan.reason, /health/)
  }
})

// —— readyTimeoutMs 的退化与收敛 ——

test('planServeStart 对非法 readyTimeoutMs 退回默认并留 note', () => {
  const bads: unknown[] = [0, -1, NaN, Infinity, -Infinity, '1000', null, {}, []]
  for (const bad of bads) {
    const plan = planServeStart({ serve: serveEntry({ readyTimeoutMs: bad }), url: 'http://x/mcp', env: {} })
    assert.ok(!('skip' in plan), `readyTimeoutMs=${JSON.stringify(bad)} 不该让整条跳过`)
    if ('skip' in plan) return
    assert.equal(plan.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS, `readyTimeoutMs=${JSON.stringify(bad)}`)
    assert.equal(plan.notes.length, 1, `readyTimeoutMs=${JSON.stringify(bad)} 应留一条 note`)
    assert.match(plan.notes[0]!, /readyTimeoutMs/)
  }
})

test('planServeStart 对超上限的 readyTimeoutMs 收敛（不得无限等待）', () => {
  const plan = planServeStart({ serve: serveEntry({ readyTimeoutMs: 1e12 }), url: 'http://x/mcp', env: {} })
  assert.ok(!('skip' in plan))
  if ('skip' in plan) return
  assert.equal(plan.readyTimeoutMs, MAX_READY_TIMEOUT_MS)
  assert.match(plan.notes[0]!, /上限/)
})

test('planServeStart 接受合法的 readyTimeoutMs', () => {
  const plan = planServeStart({ serve: serveEntry({ readyTimeoutMs: 5000 }), url: 'http://x/mcp', env: {} })
  assert.ok(!('skip' in plan))
  if ('skip' in plan) return
  assert.equal(plan.readyTimeoutMs, 5000)
  assert.deepEqual(plan.notes, [], '合法配置不该留下 note')
})

// —— deriveHealthUrl ——

test('deriveHealthUrl 用 origin 而不是替换路径', () => {
  assert.equal(deriveHealthUrl('http://127.0.0.1:19701/mcp'), 'http://127.0.0.1:19701/health/ready')
  assert.equal(deriveHealthUrl('http://127.0.0.1:19701/'), 'http://127.0.0.1:19701/health/ready')
  assert.equal(deriveHealthUrl('http://127.0.0.1:19701'), 'http://127.0.0.1:19701/health/ready')
  // 路径由服务器自己决定，健康端点是服务级的：`/api/v1/mcp` 也要推出同一个地址。
  assert.equal(deriveHealthUrl('http://127.0.0.1:19701/api/v1/mcp'), 'http://127.0.0.1:19701/health/ready')
  assert.equal(deriveHealthUrl('https://host:8443/mcp?x=1'), 'https://host:8443/health/ready')
})

test('deriveHealthUrl 对非 http(s) 与非法 URL 返回 undefined', () => {
  for (const url of ['not-a-url', '', 'file:///etc/passwd', 'ftp://x/m', 'ws://x/m']) {
    assert.equal(deriveHealthUrl(url), undefined, `url=${url}`)
  }
})

// —— isHttpUrl / checkHealth ——

test('isHttpUrl 只放行 http(s)，且不被同协议相对引用骗过', () => {
  assert.equal(isHttpUrl('http://x/h'), true)
  assert.equal(isHttpUrl('https://x/h'), true)
  assert.equal(isHttpUrl('HTTP://X/h'), true)
  for (const url of ['file:///etc/passwd', 'data:text/html,x', 'http:x', 'x/y', '']) {
    assert.equal(isHttpUrl(url), false, `url=${url}`)
  }
})

test('checkHealth 对 2xx 成功', async () => {
  const { io } = makeIo({ responses: [{ ok: true, status: 200 }] })
  assert.deepEqual(await checkHealth('http://x/h', 1000, io), { ok: true })
})

test('checkHealth 对非 2xx 失败并带上状态码', async () => {
  const { io } = makeIo({ responses: [{ ok: false, status: 503 }] })
  assert.deepEqual(await checkHealth('http://x/h', 1000, io), { ok: false, reason: 'status', status: 503 })
})

test('checkHealth 在 ok 缺失时按状态码判定（与真实 Response 一致）', async () => {
  const okIo = makeIo({ responses: [{ status: 204 }] })
  assert.deepEqual(await checkHealth('http://x/h', 1000, okIo.io), { ok: true })
  const badIo = makeIo({ responses: [{ status: 404 }] })
  assert.deepEqual(await checkHealth('http://x/h', 1000, badIo.io), { ok: false, reason: 'status', status: 404 })
})

test('checkHealth 吞掉网络错误并归一为 network（不抛）', async () => {
  const { io } = makeIo({ responses: [new Error('ECONNREFUSED')] })
  const result = await checkHealth('http://x/h', 1000, io)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.reason, 'network')
    assert.equal(JSON.stringify(result).includes('ECONNREFUSED'), false, '诊断不得回显错误消息')
  }
})

test('checkHealth 把 abort 归一为 timeout', async () => {
  const error = new Error('aborted')
  error.name = 'TimeoutError'
  const { io } = makeIo({ responses: [error] })
  const result = await checkHealth('http://x/h', 1000, io)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'timeout')
})

test('checkHealth 对非法 scheme 直接失败且**不发起请求**', async () => {
  const { io, probed } = makeIo()
  const result = await checkHealth('file:///etc/passwd', 1000, io)
  assert.deepEqual(result, { ok: false, reason: 'invalid-url' })
  assert.deepEqual(probed, [], '非法 scheme 不得被 fetch 出去')
})

// —— waitReady ——

test('waitReady 首次探测成功即返回，不 sleep', async () => {
  const { io, slept } = makeIo({ responses: [{ ok: true }] })
  assert.equal(await waitReady('http://x/h', 1000, io, { pollIntervalMs: POLL_INTERVAL_MS }), true)
  assert.deepEqual(slept, [])
})

test('waitReady 轮询到就绪', async () => {
  const { io, slept, probed } = makeIo({
    responses: [{ ok: false, status: 503 }, { ok: false, status: 503 }, { ok: true }],
    advancePerSleep: 100,
  })
  assert.equal(await waitReady('http://x/h', 10_000, io, { pollIntervalMs: POLL_INTERVAL_MS }), true)
  assert.equal(probed.length, 3)
  assert.equal(slept.length, 2, '成功之后不得再 sleep')
})

test('waitReady 超时返回 false（不抛）', async () => {
  const { io } = makeIo({ responses: [{ ok: false, status: 503 }], advancePerSleep: 1000 })
  assert.equal(await waitReady('http://x/h', 3000, io, { pollIntervalMs: POLL_INTERVAL_MS }), false)
})

test('waitReady 在每次探测本身很慢时不会跑过头（每轮重新读时钟）', async () => {
  // 单次探测耗时 2000 毫秒（真实 `PROBE_TIMEOUT_MS` 量级），上限 3000 毫秒：第一轮就用掉
  // 三分之二预算，第二轮结束即到点。**每轮都重新 `now()`** 是这条用例的判据——若改用
  // 循环外的单次读数，轮数会由 sleep 次数决定而不是时间，循环会一直跑到 sleep 的假时钟
  // 推过上限为止（本例里 sleep 不推进时钟，于是**永远不返回**，用例直接超时）。
  const probed: number[] = []
  let clock = 0
  const io: HealthIo = {
    fetch: async () => {
      probed.push(clock)
      clock += 2000
      return { ok: false, status: 503 }
    },
    sleep: async () => { clock += 1 },
    now: () => clock,
    timeoutSignal: () => new AbortController().signal,
  }
  assert.equal(await waitReady('http://x/h', 3000, io, { pollIntervalMs: POLL_INTERVAL_MS }), false)
  assert.equal(probed.length, 2, `上限 3000 / 每次 2000 应恰好探测 2 轮，实际 ${probed.length}`)
})

test('waitReady 对非法 scheme 直接返回 false，不进入轮询', async () => {
  const { io, probed } = makeIo()
  assert.equal(await waitReady('file:///x', 10_000, io, { pollIntervalMs: POLL_INTERVAL_MS }), false)
  assert.deepEqual(probed, [])
})

test('单次探测超时是 2 秒，轮询间隔是 250 毫秒', () => {
  assert.equal(PROBE_TIMEOUT_MS, 2000)
  assert.equal(POLL_INTERVAL_MS, 250)
})

// —— splitServe ——

test('splitServe 剥离 serve 并返回元数据（HTTP 条目）', () => {
  const serve = { command: 'dotnet', args: [], env: {}, readyTimeoutMs: 1000 }
  const config: McpClientConfig = {
    transport: 'streamable-http',
    serverName: 'x',
    url: 'http://x/mcp',
    headers: {},
    failOnStartupError: false,
    serve,
  }
  const split = splitServe(config)
  assert.equal(split.serve, serve)
  assert.equal(Object.hasOwn(split.config, 'serve'), false, '剥离后的 config 不得带 serve')
  assert.equal(Object.hasOwn(config, 'serve'), true, '不得修改入参（计划里的对象可能被复用）')
})

test('splitServe 对 stdio 条目原样返回', () => {
  const config: McpClientConfig = {
    transport: 'stdio',
    serverName: 'x',
    command: 'node',
    args: [],
    env: {},
    cwd: '/w',
    failOnStartupError: false,
  }
  const split = splitServe(config)
  assert.equal(split.config, config)
  assert.equal(split.serve, undefined)
})

test('splitServe 对无 serve 的 HTTP 条目返回 undefined 元数据', () => {
  const config: McpClientConfig = {
    transport: 'streamable-http',
    serverName: 'x',
    url: 'http://x/mcp',
    headers: {},
    failOnStartupError: false,
  }
  const split = splitServe(config)
  assert.equal(split.serve, undefined)
  assert.equal(Object.hasOwn(split.config, 'serve'), false)
})

// —— 编排：ensureServeReady ——
//
// 这里是"spawn 调用一次 / 并发去重 / 超时仍继续 / env 不入日志"这几条断言的**权威**位置：
// `spawnDetached` 是注入的，因此调用次数与入参都能精确断言，且测试不会真的留下进程。
// `serve-mount.test.mts` 再从 `apply` 那一层用**真实** spawn（写标记文件）证明整条链路通。

/** 记录每次 spawn 的入参，行为由用例给出。 */
function makeServeIo(options: {
  responses?: Array<{ ok?: boolean; status?: number } | Error>
  advancePerSleep?: number
  spawnThrows?: unknown
} = {}) {
  const base = makeIo(options)
  const spawned: Array<{ command: string; args: string[]; env: Record<string, string> }> = []
  const io: ServeIo = {
    ...base.io,
    spawnDetached: (command, args, env) => {
      spawned.push({ command, args, env })
      if (options.spawnThrows !== undefined) throw options.spawnThrows
    },
  }
  return { io, spawned, probed: base.probed, slept: base.slept }
}

/** 收集 warn 文本的假 logger。 */
function makeLogger() {
  const warnings: string[] = []
  return { logger: { warn: (message: string) => warnings.push(message) }, warnings }
}

const HEALTH = 'http://127.0.0.1:19701/health/ready'

/** 一份已就绪的 serve 元数据；用例按需覆盖。 */
function serveMeta(overrides: Partial<ServeMetadata> = {}): ServeMetadata {
  return {
    command: 'dotnet',
    args: ['srv.dll'],
    env: {},
    health: HEALTH,
    readyTimeoutMs: 1000,
    ...overrides,
  }
}

test('ensureServeReady：健康检查成功时不 spawn（serve 完全不被触碰）', async () => {
  const { io, spawned, probed } = makeServeIo({ responses: [{ ok: true }] })
  const { logger, warnings } = makeLogger()

  await ensureServeReady({
    serverName: 'mudblazor',
    url: 'http://127.0.0.1:19701/mcp',
    serve: serveMeta(),
    inflight: new Map(),
    io,
    logger,
  })

  assert.deepEqual(probed, [HEALTH], '应当只探测一次')
  assert.equal(spawned.length, 0, '服务已在跑时不得 spawn')
  assert.deepEqual(warnings, [], '服务已在跑时不得留下 warn')
})

test('ensureServeReady：健康检查失败 + 有 serve → spawn 一次，参数与 serve 一致', async () => {
  const { io, spawned } = makeServeIo({
    responses: [{ ok: false, status: 503 }, { ok: true }],
    advancePerSleep: 10,
  })
  const { logger, warnings } = makeLogger()

  await ensureServeReady({
    serverName: 'mudblazor',
    url: 'http://127.0.0.1:19701/mcp',
    serve: serveMeta({ command: 'dotnet', args: ['a.dll', '--version', '9.10.0'], env: { PORT: '19701' } }),
    inflight: new Map(),
    io,
    logger,
  })

  assert.equal(spawned.length, 1, '应恰好 spawn 一次')
  assert.equal(spawned[0]!.command, 'dotnet')
  assert.deepEqual(spawned[0]!.args, ['a.dll', '--version', '9.10.0'])
  assert.deepEqual(spawned[0]!.env, { PORT: '19701' })
  assert.deepEqual(warnings, [], '轮询到就绪不得留 warn')
})

test('ensureServeReady：健康检查失败 + 无 serve → 不 spawn、记 warn、仍返回', async () => {
  const { io, spawned, probed } = makeServeIo({ responses: [{ ok: false, status: 503 }] })
  const { logger, warnings } = makeLogger()

  await ensureServeReady({
    serverName: 'mudblazor',
    url: 'http://127.0.0.1:19701/mcp',
    inflight: new Map(),
    io,
    logger,
  })

  assert.deepEqual(probed, [HEALTH], '省略 serve 时 health 仍从 url 推导并探测一次')
  assert.equal(spawned.length, 0, '没有 serve 就无从拉起')
  assert.equal(warnings.length, 1, '必须留下可查诊断')
  assert.match(warnings[0]!, /mudblazor/)
  assert.match(warnings[0]!, /没有 serve/)
})

test('ensureServeReady：轮询超时 → 记 warn、不抛（调用方仍会挂载）', async () => {
  const { io, spawned } = makeServeIo({ responses: [{ ok: false, status: 503 }], advancePerSleep: 1000 })
  const { logger, warnings } = makeLogger()

  await ensureServeReady({
    serverName: 'mudblazor',
    url: 'http://127.0.0.1:19701/mcp',
    serve: serveMeta({ readyTimeoutMs: 500 }),
    inflight: new Map(),
    io,
    logger,
  })

  assert.equal(spawned.length, 1, '仍然尝试过拉起')
  assert.equal(warnings.length, 1, '超时必须留下可查诊断')
  assert.match(warnings[0]!, /mudblazor/)
  assert.match(warnings[0]!, /500/)
})

test('ensureServeReady：spawn 抛错 → 记 warn、不抛', async () => {
  const { io, spawned } = makeServeIo({
    responses: [{ ok: false, status: 503 }],
    spawnThrows: Object.assign(new Error('EADDRINUSE'), { name: 'Error' }),
  })
  const { logger, warnings } = makeLogger()

  await ensureServeReady({
    serverName: 'mudblazor',
    url: 'http://127.0.0.1:19701/mcp',
    serve: serveMeta(),
    inflight: new Map(),
    io,
    logger,
  })

  assert.equal(spawned.length, 1)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /拉起/)
  // 诊断只记错误类型名，不回显 spawn 的入参（含展开后的 env 值）。
  assert.match(warnings[0]!, /Error/)
})

test('ensureServeReady：两个会话同时挂载同一 url → 只 spawn 一次', async () => {
  // 这是并发去重的权威守护：`inflight` 按 url 共享，后到的那个**等**前一个的启动，
  // 而不是再拉一个（第二个会因端口占用失败）。
  const shared = new Map<string, Promise<void>>()
  const { io, spawned } = makeServeIo({
    responses: [{ ok: false, status: 503 }],
    advancePerSleep: 200,
  })
  const { logger, warnings } = makeLogger()

  const input = (serverName: string) => ({
    serverName,
    url: 'http://127.0.0.1:19701/mcp',
    serve: serveMeta({ readyTimeoutMs: 600 }),
    inflight: shared,
    io,
    logger,
  })

  await Promise.all([ensureServeReady(input('a')), ensureServeReady(input('b'))])

  assert.equal(spawned.length, 1, `同一 url 的并发挂载只应 spawn 一次，实际 ${spawned.length}`)
  // 第二个会话不是"什么都不做"：它等了同一个启动，因此也拿到了同一条超时诊断。
  assert.equal(warnings.length, 1, '超时诊断由那次共享启动产生一次')
})

test('ensureServeReady：不同 url 各自启动，不误拦', async () => {
  // 去重按 url 而不是按服务器名/全局：两个不同的服务互不影响。
  const shared = new Map<string, Promise<void>>()
  const { io, spawned } = makeServeIo({
    responses: [{ ok: false, status: 503 }],
    advancePerSleep: 1000,
  })
  const { logger } = makeLogger()

  await Promise.all([
    ensureServeReady({
      serverName: 'a',
      url: 'http://127.0.0.1:1/mcp',
      serve: serveMeta({ readyTimeoutMs: 200 }),
      inflight: shared,
      io,
      logger,
    }),
    ensureServeReady({
      serverName: 'b',
      url: 'http://127.0.0.1:2/mcp',
      serve: serveMeta({ readyTimeoutMs: 200 }),
      inflight: shared,
      io,
      logger,
    }),
  ])

  assert.equal(spawned.length, 2, '两个不同 url 各启动一次')
})

test('ensureServeReady：启动完成后条目被删除（服务之后自己退出时能再拉一次）', async () => {
  const shared = new Map<string, Promise<void>>()
  const { io } = makeServeIo({ responses: [{ ok: true }] })
  const { logger } = makeLogger()

  await ensureServeReady({
    serverName: 'a',
    url: 'http://127.0.0.1:19701/mcp',
    serve: serveMeta(),
    inflight: shared,
    io,
    logger,
  })

  assert.equal(shared.size, 0, '条目描述的是"进行中的启动"，完成后必须删除')
})

test('ensureServeReady：stdio 条目（无 url）零额外动作', async () => {
  const { io, spawned, probed } = makeServeIo()
  const { logger, warnings } = makeLogger()

  await ensureServeReady({ serverName: 'a', serve: serveMeta(), inflight: new Map(), io, logger })

  assert.deepEqual(probed, [], 'stdio 条目连健康检查都不做')
  assert.equal(spawned.length, 0)
  assert.deepEqual(warnings, [])
})

test('ensureServeReady：展开后的 env 值不出现在任何日志（红线 3）', async () => {
  const secret = 'placeholder-token-not-a-real-credential'
  const { io, spawned } = makeServeIo({
    responses: [{ ok: false, status: 503 }],
    advancePerSleep: 1000,
  })
  const { logger, warnings } = makeLogger()

  // 覆盖全部会写日志的分支：健康检查失败 + 有 serve + 超时。
  await ensureServeReady({
    serverName: 'mudblazor',
    url: 'http://127.0.0.1:19701/mcp',
    serve: serveMeta({ env: { TOKEN: secret }, readyTimeoutMs: 300 }),
    inflight: new Map(),
    io,
    logger,
  })
  // 再覆盖"无 serve"与"spawn 失败"两条分支。
  await ensureServeReady({
    serverName: 'b',
    url: 'http://127.0.0.1:19701/mcp',
    inflight: new Map(),
    io,
    logger,
  })

  assert.equal(spawned.length, 1, '前置条件：确实走到过 spawn（它拿到了含敏感值的 env）')
  assert.ok(warnings.length >= 2, `前置条件：确实写过多条日志，实际 ${warnings.length}`)
  const joined = warnings.join('\n')
  assert.equal(joined.includes(secret), false, `日志不得回显展开后的环境变量值：${joined}`)
})

test('ensureServeReady：health 非法 scheme 时不 spawn（宁可不拉，也不每次会话盲拉）', async () => {
  // `planServeStart` 对非法 scheme 返回 skip，因此 config 上没有 serve 元数据。此时
  // `ensureServeReady` 会退回"从 url 推导 health"——url 是合法的，于是探测一次、失败、
  // 记"没有 serve"的 warn。**关键断言是不 spawn**。
  const { io, spawned } = makeServeIo({ responses: [{ ok: false, status: 503 }] })
  const { logger, warnings } = makeLogger()

  await ensureServeReady({
    serverName: 'a',
    url: 'http://127.0.0.1:19701/mcp',
    inflight: new Map(),
    io,
    logger,
  })

  assert.equal(spawned.length, 0)
  assert.equal(warnings.length, 1)
})

test('ensureServeReady：url 推导不出 health 且无 serve.health → 完全不探测', async () => {
  const { io, spawned, probed } = makeServeIo()
  const { logger, warnings } = makeLogger()

  await ensureServeReady({
    serverName: 'a',
    url: 'not-a-url',
    inflight: new Map(),
    io,
    logger,
  })

  assert.deepEqual(probed, [], '无从探测就不探测（也不猜地址）')
  assert.equal(spawned.length, 0)
  assert.deepEqual(warnings, [], '这不是配置错误：url 合法性由 translate 层负责')
})
