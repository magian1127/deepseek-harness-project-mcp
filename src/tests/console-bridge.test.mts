import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { CONSOLE_ROUTE_PREFIX, installConsoleBridge } from '../console-bridge.js'
import type { ConsoleActionResult, ConsoleBridgeDeps } from '../console-bridge.js'

/**
 * 控制台路由的**动作语义**单测（假 req/res 直接打到捕获的 handler）。
 *
 * 这里不碰 `index.ts`、不碰真实 fs：路由的准入围栏、状态视图与真实挂载已有
 * `mount.test.mts` 的端到端用例守护，本文件只钉住 2026-10-29 那次"整个 GUI 卡住"
 * 修复带来的三条**协议级**契约：
 *
 * 1. **动作结果原样透传**：`start` 不再等挂载，返回 `{ ok: true, accepted: true }`；
 *    前端据此显示"已受理"，随后的轮询看到 `starting` / `mounted` / `failed`。
 * 2. **同一 (kind, session, server) 的在途动作去重**：并发/连点只执行一次动作，后到的
 *    请求**立刻**拿到 `accepted`，不排在前一个请求上——排上去就等于重新把浏览器连接
 *    池占满（正是那次事故的另一半成因）。
 * 3. **有界**：动作永不结算时，到上限（`ACTION_TIMEOUT_MS`）按 `timeout` 失败收场，
 *    绝不让 `res` 一直悬着；迟到的结算不得二次写响应。
 *
 * 以及一条**分层**守护：缓存不属于这一层。`viewFor` 的短 TTL 缓存必须留在 `index.ts`
 * 的装配层——它的失效点（批准写入后、后台挂载落定、撤销写入后、会话销毁）全都发生在
 * 装配层，缓存放这里会让那些失效点根本不可达，用户点完"启动"仍会在 TTL 内看到"未授权"。
 */

interface Recorded {
  status: number
  body: any
}

/** 一次请求的观测面：写出的响应（正常应恰好一条）与那个 res 本身。 */
interface Invocation {
  res: any
  written: Recorded[]
}

interface FakeResponse extends Record<string, any> {
  statusCode: number
  writableEnded: boolean
  destroyed: boolean
  writeHead(status: number): unknown
  end(text?: string): unknown
}

/**
 * 安装控制台路由并返回一个"发请求"的入口。
 *
 * 假请求默认是浏览器同源形态（回环 peer + 本机 `Host`），因此每个用例都不必重复写
 * 围栏所需的头——围栏本身的正反用例在 `mount.test.mts` 与 `debug-bridge.test.mts`。
 */
function install(deps: ConsoleBridgeDeps) {
  const routes: Array<{ path: string; handler: (req: any, res: any) => void }> = []
  const webServer = {
    register(route: { kind: string; path: string; handler: (req: any, res: any) => void }) {
      routes.push(route)
      return () => {
        const at = routes.indexOf(route)
        if (at >= 0) routes.splice(at, 1)
      }
    },
  }
  const dispose = installConsoleBridge(webServer as never, deps)

  /**
   * 发一个请求。
   *
   * `patchRes` 在 handler 之前作用于 res：用来构造"客户端已经断开"（`destroyed`）与
   * "响应已经结束"（`writableEnded`）这两种真实场景——它们在真实宿主里每时每刻都在
   * 发生（用户关标签、页面卸载、前端 4 秒超时 abort）。
   */
  const invoke = (
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
    patchRes?: (res: FakeResponse) => void,
  ): Invocation => {
    const route = routes.find(item => item.path === CONSOLE_ROUTE_PREFIX)
    assert.ok(route !== undefined, '控制台路由未安装')

    const req = new EventEmitter() as any
    req.method = method
    req.url = path
    req.headers = { host: '127.0.0.1:3080' }
    req.socket = { remoteAddress: '127.0.0.1' }
    req.destroy = () => {}

    const written: Recorded[] = []
    const res: FakeResponse = {
      statusCode: 0,
      writableEnded: false,
      destroyed: false,
      writeHead(status: number) {
        res.statusCode = status
        return res
      },
      end(text?: string) {
        // 刻意**不**学真实 ServerResponse 抛 ERR_STREAM_WRITE_AFTER_END：这里要能
        // 观察到"写了几次"，把是否越界留给断言判断。
        written.push({ status: res.statusCode, body: text === undefined ? null : JSON.parse(text) })
        res.writableEnded = true
        return res
      },
    }
    patchRes?.(res)

    route!.handler(req, res)
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
    return { res, written }
  }

  return {
    invoke,
    status: (session: string) =>
      invoke('GET', `${CONSOLE_ROUTE_PREFIX}/status?session=${encodeURIComponent(session)}`),
    start: (session: string, server: string) =>
      invoke('POST', `${CONSOLE_ROUTE_PREFIX}/start`, { session, server }),
    revoke: (session: string, server: string) =>
      invoke('POST', `${CONSOLE_ROUTE_PREFIX}/revoke`, { session, server }),
    routeCount: () => routes.length,
    dispose,
  }
}

/**
 * 只排空微任务。
 *
 * 刻意**不**用 `setTimeout`：超时用例开了 mock timers，真实定时器在那里不再前进，
 * 用它排空会把用例吊死。
 */
async function drain(rounds = 32): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve()
}

const idle = {
  viewFor: () => null,
  start: async (): Promise<ConsoleActionResult> => ({ ok: true }),
  revoke: async (): Promise<ConsoleActionResult> => ({ ok: true }),
}

test('bridge 不缓存视图：同一 session 连续两次 GET status 各调用一次 viewFor', () => {
  // 分层守护（详见文件头）：缓存必须在 `index.ts` 的装配层，否则批准写入、后台挂载
  // 落定、撤销写入这些失效点作废不了它——用户点完"启动"仍会在 TTL 内看到"未授权"。
  // 把 viewCache 挪进 console-bridge，本用例立刻变红。
  let calls = 0
  const view = { rows: [{ serverName: 'alpha', transport: 'stdio', state: 'mounted' }], actionCount: 0 }
  const harness = install({ ...idle, viewFor: () => { calls += 1; return view } })

  const first = harness.status('session-1')
  const second = harness.status('session-1')

  assert.equal(calls, 2, '缓存不属于路由层：每次 status 请求都应重新取视图')
  assert.equal(first.written.length, 1)
  assert.deepEqual(first.written[0]!.body, { ok: true, view }, '视图必须原样下发')
  assert.equal(second.written.length, 1)
  assert.deepEqual(second.written[0]!.body, { ok: true, view })
})

test('动作结果原样透传：accepted 语义在 200 响应里表达', async () => {
  // `start` 不再等挂载（HTTP 条目最多可能是 readyTimeoutMs），因此"已受理"必须能被
  // 前端看见：`{ ok: true, accepted: true }`。前端据 accepted 显示"已受理"，再靠轮询
  // 收敛到 starting / mounted / failed。
  const harness = install({
    ...idle,
    start: async () => ({ ok: true, accepted: true }),
    revoke: async () => ({ ok: false, reason: 'not-approved' }),
  })

  const start = harness.start('session-1', 'alpha')
  await drain()
  assert.equal(start.written.length, 1)
  assert.equal(start.written[0]!.status, 200, 'accepted 仍是成功响应（不是 202，也不是 500）')
  assert.deepEqual(start.written[0]!.body, { ok: true, accepted: true })

  const revoke = harness.revoke('session-1', 'alpha')
  await drain()
  assert.equal(revoke.written[0]!.status, 200)
  assert.deepEqual(revoke.written[0]!.body, { ok: false, reason: 'not-approved' })
})

test('同一 (kind, session, server) 的在途动作去重：动作只执行一次，后到的请求立即拿到 accepted', async () => {
  // 连点两次 / 两台设备同时点 / 前端重试，都不该产生第二个动作（第二次 ctx.plugin 会撞
  // 重名守卫，HTTP 条目则会再等一轮服务就绪）。更关键的是**后到的请求不能排队**：
  // 排上去就把浏览器同源连接池重新占满，等于把事故原样搬回来。
  let actionCalls = 0
  let release: (result: ConsoleActionResult) => void = () => {}
  const harness = install({
    ...idle,
    start: () => {
      actionCalls += 1
      return new Promise<ConsoleActionResult>(resolve => {
        release = resolve
      })
    },
  })

  const first = harness.start('session-1', 'alpha')
  const second = harness.start('session-1', 'alpha')
  await drain()

  assert.equal(actionCalls, 1, '并发 start 只能执行一次动作')
  assert.equal(first.written.length, 0, '第一个请求必须等它自己的动作结算')
  assert.equal(second.written.length, 1, '去重命中必须在事件循环一轮内返回，不排在前一个请求上')
  assert.deepEqual(second.written[0]!.body, { ok: true, accepted: true })

  release({ ok: true, accepted: true })
  await drain()

  assert.equal(first.written.length, 1, '第一个请求仍要正常走完并写它自己的响应')
  assert.equal(second.written.length, 1, '第二个请求不得被写第二次')
  assert.notEqual(first.res, second.res, '两个请求各有独立的 res：不是同一个 res 写两遍')
})

test('去重不误伤：不同 server / 不同 session / start 与 revoke 各自执行', async () => {
  // 去重键写错（比如只按 session，或不分动作类型）会让"启动 alpha 时启动 beta"被静默
  // 吞掉——用户点了没反应，且日志里什么都没有。
  const executed: string[] = []
  const pendingForever = (): Promise<ConsoleActionResult> => new Promise<ConsoleActionResult>(() => {})
  const harness = install({
    ...idle,
    start: (session, server) => {
      executed.push(`start:${session}:${server}`)
      return pendingForever()
    },
    revoke: (session, server) => {
      executed.push(`revoke:${session}:${server}`)
      return pendingForever()
    },
  })

  harness.start('session-1', 'alpha')
  harness.start('session-1', 'beta')
  harness.start('session-2', 'alpha')
  harness.revoke('session-1', 'alpha')
  await drain()

  assert.deepEqual(
    executed.sort(),
    ['revoke:session-1:alpha', 'start:session-1:alpha', 'start:session-1:beta', 'start:session-2:alpha'],
    '四种不同动作必须各自执行（去重键含动作类型 + 会话 + 服务器）',
  )
})

test('动作超过上限时返回失败而不是永久挂起；迟到的结算不再二次写响应', async t => {
  // 唯一还剩的"可能挂住"的地方是信任写入卡在文件锁上。上限的意义是**保证有界**：
  // 15 秒后按 timeout 失败收场，绝不让 res 一直悬着（页面的同源连接池按 origin 计数，
  // 每悬一个就少一条）。
  //
  // 用 mock timers 推进，不真等 15 秒；`Date.now` 不 mock（本用例不依赖它）。
  t.mock.timers.enable({ apis: ['setTimeout'] })

  let settle: (result: ConsoleActionResult) => void = () => {}
  const harness = install({
    ...idle,
    start: () =>
      new Promise<ConsoleActionResult>(resolve => {
        settle = resolve
      }),
  })

  const pending = harness.start('session-1', 'alpha')
  await drain()
  assert.equal(pending.written.length, 0, '动作未结算前不得写响应')

  t.mock.timers.tick(4_500)
  await drain()
  assert.equal(pending.written.length, 0, '上限未到不得提前判失败')

  t.mock.timers.tick(15_000)
  await drain()
  assert.equal(pending.written.length, 1, '超过上限必须写出失败响应，而不是让 res 悬着')
  assert.equal(pending.written[0]!.status, 200)
  assert.deepEqual(pending.written[0]!.body, { ok: false, reason: 'timeout' })

  settle({ ok: true, accepted: true })
  await drain()
  assert.equal(pending.written.length, 1, '超时之后动作才结算，也不得二次写响应')
})

test('动作被拒绝时归一为 { ok:false, reason:<错误类型名> }，不透出错误消息', async () => {
  // 拒绝的来源可能是信任写入失败（磁盘只读、锁超时）。诊断口径与日志一致：只记类型名
  // ——错误消息可能带路径甚至配置片段（红线 3）。
  const secret = 'placeholder-token-not-a-real-credential'
  const harness = install({
    ...idle,
    start: async () => {
      const error = new Error(`写入失败：${secret}`)
      error.name = 'StartupError'
      throw error
    },
  })

  const out = harness.start('session-1', 'alpha')
  await drain()

  assert.equal(out.written.length, 1)
  assert.equal(out.written[0]!.status, 200)
  assert.deepEqual(out.written[0]!.body, { ok: false, reason: 'StartupError' })
  assert.equal(
    JSON.stringify(out.written[0]!.body).includes(secret),
    false,
    '错误消息不得透出到 HTTP 面（只记类型名）',
  )
})

test('客户端已断开时动作完成不写、不抛（辅助面不得影响宿主）', async () => {
  // 前端有 4 秒 AbortController 超时，用户也会关标签；此时对已销毁/已结束的 res 再写
  // 会抛 ERR_STREAM_WRITE_AFTER_END，而它在**异步回调**里就会变成未处理拒绝——辅助面
  // 绝不能因此影响宿主进程。
  const harness = install({ ...idle, start: async () => ({ ok: true, accepted: true }) })

  const destroyed = harness.invoke(
    'POST',
    `${CONSOLE_ROUTE_PREFIX}/start`,
    { session: 'session-1', server: 'alpha' },
    res => {
      res.destroyed = true
    },
  )
  const ended = harness.invoke(
    'POST',
    `${CONSOLE_ROUTE_PREFIX}/start`,
    { session: 'session-1', server: 'beta' },
    res => {
      res.writableEnded = true
    },
  )
  await drain()

  assert.equal(destroyed.written.length, 0, '已销毁的 res 不得再写')
  assert.equal(ended.written.length, 0, '已结束的 res 不得再写')
})

test('disposer 注销路由（随 fiber 可逆清理）', () => {
  const harness = install(idle)
  assert.equal(harness.routeCount(), 1)
  harness.dispose()
  assert.equal(harness.routeCount(), 0, '卸载后不得留下路由')
})
