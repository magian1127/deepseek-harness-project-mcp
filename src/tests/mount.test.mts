import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
const { approve, fingerprint, trustStorePath } = await import('../trust.js')

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
 * 写信任存储，批准该项目全部指定服务器。
 *
 * 指纹针对 `.mcp.json` 的**确切文本**计算——`isApproved` 比对的是逐字内容，
 * 用任何重新序列化出来的等价文本都会让批准静默失效（"批准了却没挂上"的经典
 * 成因，也正是本文件要守护的对象）。
 */
function approveAll(project: Project, servers: string[]): void {
  const store = approve(
    { version: 1, projects: {} },
    project.root,
    fingerprint(project.raw),
    servers,
    't',
  )
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

function createHarness(options: { loader?: unknown; withCommands?: boolean; withAgents?: boolean } = {}) {
  const withCommands = options.withCommands ?? true
  const withAgents = options.withAgents ?? true
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const effects: Array<() => void> = []
  const commands = new Map<string, { handler: (invocation: unknown) => unknown }>()
  const logs: Array<{ level: string; message: string }> = []
  /**
   * 假 `agents` 服务：`agent.id` → 活着的 agent。
   *
   * 回收判定用它回答"这个会话的 agent 还在不在"（真实实现是
   * `AgentRegistry.get(id)`，`packages/core/agent/src/index.ts:566-568`）。`agent/disposed`
   * 时把它摘掉，与真实 DSH 一致——否则回收会把已销毁的会话当成候选。
   */
  const liveAgents = new Map<string, unknown>()
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

  const host = {
    get(name: string) {
      if (name === 'commands') {
        if (!withCommands) return undefined
        return {
          register: (definition: { name: string; handler: (i: unknown) => unknown }) => {
            commands.set(definition.name, definition)
            return () => { commands.delete(definition.name) }
          },
        }
      }
      if (name === 'loader') return options.loader
      if (name === 'agents') {
        if (!withAgents) return undefined
        return { get: (id: string) => liveAgents.get(id) }
      }
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
    options: { id?: unknown; header?: Record<string, unknown>; status?: unknown } = {},
  ) {
    nextSessionId += 1
    const id = Object.hasOwn(options, 'id') ? options.id : `session-${nextSessionId}`
    const agent = {
      // 显式传 `id: undefined` 要真的落成 `undefined`（那是"id 缺失"用例），因此用
      // `hasOwn` 而不是 `??` 判默认值。
      id,
      // 默认 `idle`：与真实 DSH 的"没有 driver 在跑"一致，也是可回收的前提。
      // 需要 `running` 的用例显式传 `status`。
      status: Object.hasOwn(options, 'status') ? options.status : 'idle',
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
    return agent
  }

  return {
    host, logs, pluginCalls, fibers, sections, commands, makeAgent,
    /**
     * 当前**活着**的提示段（已 dispose 的不算）。
     *
     * 提示段刷新是"先撤下再注册"，`sections` 会同时留下新旧两条记录；只有按
     * `disposed` 过滤才能回答"模型现在看到什么"——这正是缺陷 1 的观测面。
     */
    liveSections: () => sections.filter(section => section.disposed === 0),
    fire: (name: string, payload: unknown) => {
      // 镜像真实 `AgentRegistry` 的发布/移除：`agent/created` 之后 `ctx.agents.get(id)`
      // 才拿得到该 agent，`agent/disposed` 之后拿不到。回收判定依赖这个契约
      // （拿不到 live agent 的会话不占回收名额），因此夹具必须如实模拟。
      const fired = (payload as { agent?: { id?: unknown } } | undefined)?.agent
      const firedId = typeof fired?.id === 'string' && fired.id !== '' ? fired.id : undefined
      if (firedId !== undefined) {
        if (name === 'agent/created') liveAgents.set(firedId, fired)
        else if (name === 'agent/disposed') liveAgents.delete(firedId)
      }
      for (const callback of listeners.get(name) ?? []) callback(payload)
    },
    /**
     * 以 **waterfall** 语义派发 `agent/pre-step`：把 `next` 作为最后一个参数传入，
     * 并返回最外层监听器的返回值。
     *
     * 为什么不能复用 `fire`：`pre-step` 是 waterfall（`agent.ts:276`），监听器**必须**
     * 调用 `next()` 才能让链继续。用 `fire` 派发时 `next` 是 `undefined`，监听器里
     * 那句 `return next()` 会抛 TypeError 并被自己的 catch 吞掉——于是"监听器注册了
     * 但什么都没做"和"监听器正常工作"在测试里无法区分。这个辅助函数让断言能覆盖
     * "决策被交还给链上"这一条（见 `preStep` 的返回值断言）。
     */
    preStep: (payload: unknown) => {
      const callbacks = [...(listeners.get('agent/pre-step') ?? [])] as Array<
        (payload: unknown, next: () => unknown) => unknown
      >
      // `listeners` = 链上实际跑过的监听器数（不含终止回调）；
      // `nextCalls` = 链被继续推进的次数，含最外层那一次与终止回调那一次。
      let listenersRun = 0
      let nextCalls = 0
      const next = () => {
        nextCalls += 1
        const callback = callbacks.shift()
        if (callback === undefined) return { kind: 'enter' }
        listenersRun += 1
        return callback(payload, next)
      }
      const result = next()
      return { result, listenersRun, nextCalls }
    },
    /** 卸载插件：按注册逆序跑 effect disposer，模拟 fiber 拆除。 */
    unload: () => { for (const dispose of [...effects].reverse()) dispose() },
  }
}

// —— 功能：MCP 连接的惰性回收 + 上限（默认 8） ——
//
// 用户痛点：DSH 的 WebUI **没有"关闭会话"**——左侧列表点开任意会话就触发
// `promote` → `resume` → `agent/created`，本插件随之挂上一份 MCP 连接（实测每个
// stdio 子进程约 73 MB）。浏览几个会话就积累 5 个进程、约 300 MB，而 DSH 无空闲回收。
//
// 规则（用户明确指定，不得改动）：上限 8；超限时回收**最后活跃时间最早**的
// `status === 'idle'` 会话；全部 `running` 时忽略上限（绝不打断正在工作的会话）；
// 被回收的会话下次发消息时自动重挂。
//
// 纯函数层面的穷尽守护在 `reclaim.test.mts`；这里是穿过 `apply` 的端到端面。

/** 造一个已批准的项目并返回它的会话，挂在 `harness` 上。 */
function mountedSession(
  harness: ReturnType<typeof createHarness>,
  project: Project,
  options: { id: string; status?: unknown },
) {
  const agent = harness.makeAgent(project, options)
  harness.fire('agent/created', { agent })
  return agent
}

test('超过上限时回收最久未活跃的 idle 会话，且新会话仍能挂上', async () => {
  // 上限设 2 让用例短小（规则与默认 8 完全同构）。
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, { connectionLimit: 2 })

  const first = mountedSession(harness, project, { id: 's1' })
  mountedSession(harness, project, { id: 's2' })
  assert.equal(harness.pluginCalls.length, 2, '两个会话都挂上了')

  // 第三个会话到来 → 必须先回收最久未活跃的 idle（s1），再挂自己。
  const third = mountedSession(harness, project, { id: 's3' })

  assert.equal(
    harness.fibers[0]!.disposed,
    1,
    '最久未活跃的空闲会话 s1 的连接必须被回收（走 fiber.dispose，不是杀进程）',
  )
  assert.equal(harness.fibers[1]!.disposed, 0, 's2 仍在，不得被回收')
  assert.equal(harness.pluginCalls.length, 3, '新会话 s3 照常挂载')

  const run = (agent: unknown) =>
    Promise.resolve(
      harness.commands.get('mcp-project')!.handler({ agent, rawInput: '' }),
    ) as Promise<{ kind: string; text: string }>

  // 回收后总数恰好回到上限：s1 无连接、s2 与 s3 各一份。
  const [a, b, c] = await Promise.all([run(first), run(third), run(third)])
  assert.match(a.text, /已被回收/, `s1 应报"已被回收"：${a.text}`)
  assert.match(b.text, /已挂载（模型可见的工具名为/, `s3 应报"已挂载"：${b.text}`)
  assert.doesNotMatch(c.text, /已被回收/, `s3 不得被回收：${c.text}`)
})

test('全部会话都在 running 时忽略上限，绝不打断正在工作的会话', () => {
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, { connectionLimit: 2 })

  mountedSession(harness, project, { id: 'busy-1', status: 'running' })
  mountedSession(harness, project, { id: 'busy-2', status: 'running' })
  assert.equal(harness.pluginCalls.length, 2)

  // 第三个会话也是 running：超出上限，但一个都不能回收（规则 3）。
  mountedSession(harness, project, { id: 'busy-3', status: 'running' })

  assert.equal(
    harness.fibers[0]!.disposed,
    0,
    '全部 running 时必须忽略上限——回收正在工作的会话会打断用户',
  )
  assert.equal(harness.fibers[1]!.disposed, 0, '同上')
  assert.equal(harness.pluginCalls.length, 3, '新会话照常挂载')
})

test('被回收的会话在 pre-step 时重新挂载，且 pre-step 必须 return next()', async () => {
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, { connectionLimit: 2 })

  const victim = mountedSession(harness, project, { id: 'victim' })
  mountedSession(harness, project, { id: 'other' })
  mountedSession(harness, project, { id: 'newest' })
  assert.equal(harness.fibers[0]!.disposed, 1, 'victim 应已被回收')
  assert.equal(harness.pluginCalls.length, 3)

  // victim 发消息：`agent/pre-step` 是唯一重挂落点（agent 活着时不会再触发
  // `agent/created`）。waterfall 语义由夹具的 `preStep` 模拟。
  const { result, listenersRun, nextCalls } = harness.preStep({ agent: victim })

  assert.equal(
    harness.pluginCalls.length,
    4,
    '被回收的会话下次发消息时必须自动重挂——这是"工具会自己回来"的唯一保证',
  )
  assert.equal(harness.pluginCalls[3]!.config.serverName, 'alpha')
  assert.equal(listenersRun, 1, '本插件的 pre-step 监听器应跑过一次')
  assert.equal(
    nextCalls,
    2,
    'pre-step 是 waterfall：监听器必须 return next()，否则会否决整条链（含内置行为）',
  )
  assert.deepEqual(result, { kind: 'enter' }, 'pre-step 的决策必须原样交还给链上的下一个监听者')
})

test('回收只清 servers、保留登记项与时间戳（会话还活着，之后要重挂）', async () => {
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, { connectionLimit: 1 })

  const victim = mountedSession(harness, project, { id: 'victim' })
  mountedSession(harness, project, { id: 'newest' })
  assert.equal(harness.fibers[0]!.disposed, 1, 'victim 应已被回收')

  const run = (agent: unknown, rawInput: string) =>
    Promise.resolve(
      harness.commands.get('mcp-project')!.handler({ agent, rawInput }),
    ) as Promise<{ kind: string; text: string }>

  // 条目仍在（不是 `none`）：命令能如实报出"本会话的连接已被回收"，而不是
  // "本会话没有记账"。这条正是"不 agents.delete(key)"的观测面。
  const out = await run(victim, '')
  assert.match(
    out.text,
    /已被回收/,
    `被回收的会话必须如实报告状态，而不是装作没有记账：${out.text}`,
  )
  assert.match(out.text, /连接上限：1/, `应显示当前上限：${out.text}`)
  assert.match(out.text, /下次发消息时自动重挂/, `应给出恢复路径：${out.text}`)

  // 重挂后状态回到"已挂载"。
  harness.preStep({ agent: victim })
  const after = await run(victim, '')
  assert.match(after.text, /已挂载（模型可见的工具名为/, `重挂后应报"已挂载"：${after.text}`)
  assert.doesNotMatch(after.text, /已被回收/, `重挂后不得再说"已被回收"：${after.text}`)
})

test('回收后仍可重挂：同一会话再次 pre-step 不会重复挂载（幂等）', () => {
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, { connectionLimit: 1 })

  const victim = mountedSession(harness, project, { id: 'victim' })
  mountedSession(harness, project, { id: 'newest' })
  assert.equal(harness.pluginCalls.length, 2)

  harness.preStep({ agent: victim })
  assert.equal(harness.pluginCalls.length, 3, '第一次 pre-step 应重挂')
  harness.preStep({ agent: victim })
  harness.preStep({ agent: victim })
  assert.equal(
    harness.pluginCalls.length,
    3,
    '已挂载的会话再次 pre-step 不得重复挂载（每次都会多 spawn 一个子进程）',
  )
})

test('未被回收的会话在 pre-step 时不重挂，只推时间戳', () => {
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, { connectionLimit: 8 })

  const agent = mountedSession(harness, project, { id: 'only' })
  assert.equal(harness.pluginCalls.length, 1)
  const logsBefore = harness.logs.length

  harness.preStep({ agent })
  assert.equal(harness.pluginCalls.length, 1, '连接还在时 pre-step 不得重挂')
  assert.equal(harness.fibers[0]!.disposed, 0, '也不得回收（未超上限）')

  // 诊断不得谎报：`mountInto` 本身是幂等的（同名已挂载则跳过），因此"没重挂"这件事
  // 只能靠**日志**观测。若重挂判据退化为恒真，这里会在每条消息上刷一条"已重新挂载"，
  // 而实际什么都没做——用户会据此误判连接反复重建。变异 M4' 守护这一条。
  const added = harness.logs.slice(logsBefore).map(entry => entry.message).join('\n')
  assert.equal(
    added.includes('已重新挂载'),
    false,
    `连接还在时不得报"已重新挂载"：${added}`,
  )
})

test('重挂日志只在确实重挂时出现一次（不随每次消息重复刷）', () => {
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, { connectionLimit: 1 })

  const victim = mountedSession(harness, project, { id: 'victim' })
  mountedSession(harness, project, { id: 'newest' })

  harness.preStep({ agent: victim })
  const first = harness.logs.filter(entry => entry.message.includes('已重新挂载')).length
  assert.equal(first, 1, `被回收的会话重挂时应恰好报一次：${JSON.stringify(harness.logs)}`)

  harness.preStep({ agent: victim })
  harness.preStep({ agent: victim })
  const second = harness.logs.filter(entry => entry.message.includes('已重新挂载')).length
  assert.equal(second, 1, '后续消息不得再报"已重新挂载"（连接已经在）')
})

test('agent/disposed 后该会话不再占回收名额', () => {
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, { connectionLimit: 2 })

  const gone = mountedSession(harness, project, { id: 'gone' })
  const stay = mountedSession(harness, project, { id: 'stay' })
  harness.fire('agent/disposed', { agent: gone })
  assert.equal(harness.fibers[0]!.disposed, 1, '销毁会话应回收它的连接')

  // `gone` 已从记账与 `agents` 服务里移除，因此新会话到来时它不占名额——
  // 于是 `stay` 不会被误回收（回收名额只该被活着的会话占用）。
  mountedSession(harness, project, { id: 'fresh' })
  assert.equal(harness.fibers[1]!.disposed, 0, '`stay` 不得因为已销毁会话占名额而被回收')
})

test('回收日志只含会话 id 与数量，不含任何配置内容', () => {
  const secret = 'placeholder-token-not-a-real-credential'
  process.env.PROJECT_MCP_RECLAIM_TOKEN = secret
  const project = makeProject({
    alpha: { command: 'node', env: { TOKEN: '${PROJECT_MCP_RECLAIM_TOKEN}' } },
  })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, { connectionLimit: 1 })

  mountedSession(harness, project, { id: 'victim' })
  mountedSession(harness, project, { id: 'newest' })

  const joined = harness.logs.map(entry => entry.message).join('\n')
  assert.match(joined, /已回收最久未活跃的空闲会话/, `应留下可查诊断：${joined}`)
  assert.match(joined, /victim/, `诊断应指出被回收的会话：${joined}`)
  assert.equal(joined.includes(secret), false, `日志不得回显展开后的环境变量值：${joined}`)
})

test('agents 服务缺失时不回收（判不出空闲就绝不动它），其余功能照常', () => {
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])
  // 不声明 `agents` 到 `inject`：拿不到就退化为"不回收"，而不是让插件整体不激活。
  const harness = createHarness({ withAgents: false })
  apply(harness.host as never, { connectionLimit: 1 })

  mountedSession(harness, project, { id: 's1' })
  mountedSession(harness, project, { id: 's2' })

  assert.equal(
    harness.fibers[0]!.disposed,
    0,
    '判不出会话是否空闲时绝不回收（安全侧：误回收会打断正在工作的会话）',
  )
  assert.equal(harness.pluginCalls.length, 2, '挂载不受影响')
})

test('回归：Config 缺失或 schemastery 不可用时默认上限 8，且不抛', () => {
  // 本仓库的测试 profile 里**没有** schemastery（夹具只造了 mcp-client），因此
  // `loadSchemastery()` 返回 null → `Config === undefined`。这正是要守护的降级路径：
  // 宿主设置页对 schema 做 `'toJSON' in Config`，`null` 会抛错并带崩整页。
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])

  for (const config of [undefined, {}, { connectionLimit: '8' }, { connectionLimit: Number.NaN }]) {
    const harness = createHarness()
    assert.doesNotThrow(
      () => apply(harness.host as never, config),
      `配置 ${JSON.stringify(config)} 不得让 apply 抛异常`,
    )
    // 默认 8：7 个会话不回收，第 9 个才触发。
    for (let index = 1; index <= 8; index += 1) {
      mountedSession(harness, project, { id: `s${index}` })
    }
    assert.equal(harness.pluginCalls.length, 8, '8 个会话都在上限内')
    assert.equal(harness.fibers.filter(fiber => fiber.disposed > 0).length, 0, '未超上限不回收')

    mountedSession(harness, project, { id: 's9' })
    assert.equal(
      harness.fibers.filter(fiber => fiber.disposed > 0).length,
      1,
      '第 9 个会话到来时应回收 1 个（默认上限 8）',
    )
  }
})

test('回归：Config 导出的是 schema 或 undefined，绝不是 null', async () => {
  // `null` 会让宿主设置页的 `'toJSON' in Config` 抛 TypeError 并带崩整页。
  const mod = await import('../index.js')
  assert.notEqual(mod.Config, null, 'Config 不得为 null（宿主 settings 会抛错）')
  if (mod.Config === undefined) return
  // 有 schema 时必须是带 `toJSON` 的可调用对象（宿主据此判定"可配置"）。
  assert.equal(typeof mod.Config, 'function', 'schemastery schema 是可调用对象')
  assert.equal('toJSON' in (mod.Config as object), true, 'schema 必须有 toJSON')
})

test('回归：connectionLimit 为 0 时回收全部空闲连接（显式语义）', () => {
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, { connectionLimit: 0 })

  mountedSession(harness, project, { id: 's1' })
  // 第 2 个会话到来：预留 1 个名额后有效上限为 -1 → 按 0 处理 → 回收全部空闲。
  mountedSession(harness, project, { id: 's2' })

  assert.equal(harness.fibers[0]!.disposed, 1, '上限 0 时 s1 必须被回收')
  assert.equal(harness.pluginCalls.length, 2, '新会话仍能挂上')
})

test('pre-step 不抛异常：监听器注册且随插件卸载注销', () => {
  const harness = createHarness()
  apply(harness.host as never, {})

  // 监听器确实挂上了（`plugin-smoke.test.mts` 断言的是计数，这里补一条行为面）。
  const project = makeProject({ alpha: { command: 'node' } })
  const agent = harness.makeAgent(project, { id: 'x' })
  assert.doesNotThrow(() => harness.preStep({ agent }), 'pre-step 监听器不得抛异常')
  assert.doesNotThrow(() => harness.preStep({}), 'payload 形状不符时也不得抛异常')

  harness.unload()
  assert.equal(
    harness.preStep({ agent }).listenersRun,
    0,
    '插件卸载后 pre-step 监听器必须已注销（listenersRun 为 0 说明链上已无本插件的监听器）',
  )
})

test('新会话不会挂载任何东西时不得触发回收（不能平白拆掉别的会话）', () => {
  // 打开一个与 MCP 无关的项目会话是很常见的动作（没有 `.mcp.json`，或未批准）。
  // 那种会话一个服务器都不会挂，却会占用"新会话"名额——若照样按 `reserve: 1` 回收，
  // 就会平白拆掉一个正在用的空闲会话，而新会话根本不需要那个名额。
  const withMcp = makeProject({ alpha: { command: 'node' } })
  approveAll(withMcp, ['alpha'])
  const bare = makeProject({ beta: { command: 'node' } }) // 存在但**未批准**
  const harness = createHarness()
  apply(harness.host as never, { connectionLimit: 2 })

  mountedSession(harness, withMcp, { id: 'keep-1' })
  mountedSession(harness, withMcp, { id: 'keep-2' })
  assert.equal(harness.pluginCalls.length, 2)

  // 第三个会话所在项目没有可挂载项 → 计划不是 `mount` → 不得回收。
  mountedSession(harness, bare, { id: 'no-mcp' })

  assert.equal(
    harness.fibers[0]!.disposed,
    0,
    '新会话不会挂载任何东西时不得回收——否则浏览一个无关项目的会话就会拆掉别人的连接',
  )
  assert.equal(harness.fibers[1]!.disposed, 0, '同上')
  assert.equal(harness.pluginCalls.length, 2, '未批准的项目不挂载')
})

test('未批准时 pre-step 不重挂（计划不是 mount 就不该有连接）', () => {
  const project = makeProject({ alpha: { command: 'node' } })
  const harness = createHarness()
  apply(harness.host as never, { connectionLimit: 1 })

  const agent = harness.makeAgent(project, { id: 'pending' })
  harness.fire('agent/created', { agent })
  assert.equal(harness.pluginCalls.length, 0, '未批准不挂载')

  harness.preStep({ agent })
  assert.equal(
    harness.pluginCalls.length,
    0,
    '未批准时 pre-step 不得挂载——重挂只对"已批准但被回收"的会话生效',
  )
})

test('未批准时 agent/created 不调用 plugin（规格 §13.4 安全断言）', () => {
  const project = makeProject({ alpha: { command: 'node' } })
  const harness = createHarness()
  apply(harness.host as never, {})

  harness.fire('agent/created', { agent: harness.makeAgent(project) })

  assert.equal(harness.pluginCalls.length, 0, '未批准的项目服务器不得被挂载')
  // 提示必须注入：这是用户能看到"待批准"的唯一会话内渠道。
  assert.equal(harness.sections.length, 1, '未批准时应注入待批准提示段')
  assert.equal(harness.sections[0]!.name, 'project-mcp')
  assert.equal(harness.sections[0]!.order, 3100)
  assert.equal(harness.sections[0]!.interpolate, false)
  const text = (harness.sections[0]!.text as () => string)()
  assert.match(text, /alpha/)
})

test('已批准时挂载进 agent scope，配置带 failOnStartupError: false', () => {
  const project = makeProject({ alpha: { command: 'node', args: ['-v'] } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})

  harness.fire('agent/created', { agent: harness.makeAgent(project) })

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

test('ctx.get(loader) 传的是 Loader 本体：全局撞名项被跳过', () => {
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

  harness.fire('agent/created', { agent: harness.makeAgent(project) })

  assert.deepEqual(
    harness.pluginCalls.map(call => call.config.serverName),
    ['free'],
    '与全局行同名的项必须被跳过；传 root 会让这份名单变成空集',
  )
})

test('重复 trust 只挂载一次（幂等），命令层每次都按计划调用', async () => {
  const project = makeProject({ alpha: { command: 'node' } })
  const harness = createHarness()
  apply(harness.host as never, {})

  const agent = harness.makeAgent(project)
  harness.fire('agent/created', { agent })
  assert.equal(harness.pluginCalls.length, 0)

  const definition = harness.commands.get('mcp-project')!
  const run = (rawInput: string) => Promise.resolve(definition.handler({ agent, rawInput }))

  const first = (await run('trust')) as { kind: string; text: string }
  assert.equal(first.kind, 'success', first.text)
  assert.equal(harness.pluginCalls.length, 1, '批准后应立即挂载')

  const second = (await run('trust')) as { kind: string; text: string }
  assert.equal(second.kind, 'success', second.text)
  assert.equal(harness.pluginCalls.length, 1, '重复批准不得重复挂载同一 serverName')
})

test('插件卸载回收 agent 维度注册：挂载 fiber 与提示段都被拆除', () => {
  const mounted = makeProject({ alpha: { command: 'node' } })
  approveAll(mounted, ['alpha'])
  const pending = makeProject({ beta: { command: 'node' } })
  const harness = createHarness()
  apply(harness.host as never, {})

  // 两个**不同**会话（默认 id 各自唯一）：一个已批准、一个待批准，两条注册都必须能回收。
  harness.fire('agent/created', { agent: harness.makeAgent(mounted) })
  harness.fire('agent/created', { agent: harness.makeAgent(pending) })

  assert.equal(harness.pluginCalls.length, 1)
  assert.equal(harness.sections.length, 1)
  assert.equal(harness.fibers[0]!.disposed, 0)

  // 插件被禁用 / HMR 重载：agent.ctx 上的注册**不会**自动消失，必须由插件自己回收。
  harness.unload()

  assert.equal(harness.fibers[0]!.disposed, 1, '插件卸载后项目级 MCP 挂载仍存活')
  assert.equal(harness.sections[0]!.disposed, 1, '插件卸载后提示段仍存活')
})

test('agent 销毁清理插件侧登记项，且与插件卸载可任意顺序重复拆除', () => {
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})

  const agent = harness.makeAgent(project)
  harness.fire('agent/created', { agent })
  assert.equal(harness.fibers[0]!.disposed, 0)

  harness.fire('agent/disposed', { agent })
  assert.equal(harness.fibers[0]!.disposed, 1, 'agent 销毁应回收插件侧登记项')

  // 插件随后卸载不得二次 dispose（登记项已清空）——重复拆除是幂等的。
  harness.unload()
  assert.equal(harness.fibers[0]!.disposed, 1, '重复拆除不得再次 dispose')
})

test('loader 缺失时留下可查诊断（撞名守卫退化必须可见）', () => {
  const project = makeProject({ alpha: { command: 'node' } })
  const harness = createHarness()
  apply(harness.host as never, {})

  harness.fire('agent/created', { agent: harness.makeAgent(project) })

  assert.ok(
    harness.logs.some(entry => entry.message.includes('loader')),
    `缺少 loader 时应记日志，实际：${JSON.stringify(harness.logs)}`,
  )
})

test('commands 服务缺失时留下可查诊断，而不是命令面无声消失', () => {
  const harness = createHarness({ withCommands: false })
  apply(harness.host as never, {})

  assert.ok(
    harness.logs.some(entry => entry.message.includes('commands')),
    `缺少 commands 服务时应记日志，实际：${JSON.stringify(harness.logs)}`,
  )
})

test('声明 inject：apply 同步依赖的宿主服务必须显式列出', () => {
  // `apply` 同步调用 `ctx.get('commands')` 与 `ctx.get('loader')`，`injectNotice` 还
  // 要 `systemPrompt`。不声明的话，缺少这些服务的 profile 上插件会以半个装配状态
  // 运行，而 `practices.md`「Stability」要求放进 `inject` 让插件保持未激活并等待。
  assert.deepEqual(
    [...inject].sort(),
    ['commands', 'loader', 'systemPrompt'],
    'inject 必须声明 apply 同步依赖的全部服务',
  )
})

test('批准后提示段被撤下：模型不再看到"未启用任何项目级 MCP"', async () => {
  // 这是插件的主流程：首次会话 → 提示未批准 → `/mcp-project trust` → 挂载成功。
  // 若提示段不刷新，模型在整个会话剩余时间里被"本会话未启用任何项目级 MCP"
  // 持续误导，而挂载其实已经成功。
  const project = makeProject({ alpha: { command: 'node' } })
  const harness = createHarness()
  apply(harness.host as never, {})
  const agent = harness.makeAgent(project)

  harness.fire('agent/created', { agent })
  assert.equal(harness.liveSections().length, 1, '未批准时应注入待批准提示段')
  const before = (harness.liveSections()[0]!.text as () => string)()
  assert.match(before, /尚未批准/, `创建时提示应说明未批准：${before}`)

  const definition = harness.commands.get('mcp-project')!
  const out = (await Promise.resolve(definition.handler({ agent, rawInput: 'trust' }))) as {
    kind: string
    text: string
  }
  assert.equal(out.kind, 'success', out.text)
  assert.equal(harness.pluginCalls.length, 1, '批准后应立即挂载')

  // 批准后计划是 `mount`，`renderNotice` 对它返回空串 → 旧段必须被撤下。
  const live = harness.liveSections()
  assert.equal(
    live.length,
    0,
    `批准后不得留下"未启用"提示段；仍活着：${live.map(s => (s.text as () => string)()).join(' | ')}`,
  )
  // 旧段的 disposer 必须真的被调用过（不是"没记录"而是"已拆除"）。
  assert.equal(harness.sections[0]!.disposed, 1, '批准后旧提示段的 disposer 未被调用')
})

test('撤销后提示段被刷新到当前状态（不留下已批准时期的旧段）', async () => {
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})
  const agent = harness.makeAgent(project)

  // 已批准：挂载、无提示段。
  harness.fire('agent/created', { agent })
  assert.equal(harness.pluginCalls.length, 1)
  assert.equal(harness.liveSections().length, 0, 'mount 计划不注入提示')

  const definition = harness.commands.get('mcp-project')!
  const out = (await Promise.resolve(definition.handler({ agent, rawInput: 'untrust' }))) as {
    kind: string
    text: string
  }
  assert.equal(out.kind, 'success', out.text)

  // 撤销后计划回到 `untrusted`，提示段必须出现并说明待批准——会话创建时没有段，
  // 因此这是"新注入"，与会话创建路径的文本同源。
  const live = harness.liveSections()
  assert.equal(live.length, 1, `撤销后应有待批准提示段，实际 ${live.length} 条`)
  const text = (live[0]!.text as () => string)()
  assert.match(text, /尚未批准/, `撤销后提示应说明未批准：${text}`)
  assert.match(text, /alpha/)
})

test('撤销后若文件已不可用，提示段被撤下而不是留着旧文本', async () => {
  // `refreshNotice` 按 `renderNotice(撤销后的计划)` 求值：`.mcp.json` 被删除后计划是
  // 静默 `skip`，渲染空串 → 撤下。这条守护"刷新 == 重算"而不是"刷新 == 重新注入"。
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})
  const agent = harness.makeAgent(project)

  harness.fire('agent/created', { agent })
  assert.equal(harness.liveSections().length, 0)

  const definition = harness.commands.get('mcp-project')!
  const run = (rawInput: string) =>
    Promise.resolve(definition.handler({ agent, rawInput })) as Promise<{ kind: string; text: string }>

  const out = await run('untrust')
  assert.equal(out.kind, 'success', out.text)
  // 撤销后是 `untrusted`（文件还在）→ 注入一条。
  assert.equal(harness.liveSections().length, 1)

  // 文件消失后计划是静默 `skip`（`silent: true`）→ 渲染空串 → 旧段必须撤下。
  // 用 rename 而不是删除：工作区规则禁止永久删除文件（临时目录同样适用）。
  renameSync(join(project.root, '.mcp.json'), join(project.root, '.mcp.json.moved'))
  const again = await run('untrust')
  assert.equal(again.kind, 'success', again.text)
  assert.equal(
    harness.liveSections().length,
    0,
    '文件消失后计划是静默 skip，旧提示段必须被撤下',
  )
})

test('/mcp-project 的"已挂载"取自真实记账：会话 B 不谎报计划要挂的服务器', async () => {
  // 会话 A 批准 → 挂载。会话 B 在此**之前**已创建（`agent/created` 早已触发，
  // 那时还没批准），因此 B 的计划同样是 `mount`（信任是全局的）但一个都没挂上。
  // 命令的唯一职责是回答"现在什么是活的"，按计划渲染会把 B 的情况报成"已挂载"。
  const project = makeProject({ alpha: { command: 'node' } })
  const harness = createHarness()
  apply(harness.host as never, {})

  const agentA = harness.makeAgent(project)
  const agentB = harness.makeAgent(project)
  assert.notEqual(agentA.id, agentB.id, '这条用例的前提是两个**不同**会话')
  harness.fire('agent/created', { agent: agentA })
  harness.fire('agent/created', { agent: agentB })
  assert.equal(harness.pluginCalls.length, 0, '未批准时两个会话都不挂载')

  const definition = harness.commands.get('mcp-project')!
  const run = (agent: unknown, rawInput: string) =>
    Promise.resolve(definition.handler({ agent, rawInput })) as Promise<{ kind: string; text: string }>

  // A 批准：A 立即挂载，B 不受影响（挂载是 agent scope 的）。
  const trust = await run(agentA, 'trust')
  assert.equal(trust.kind, 'success', trust.text)
  assert.equal(harness.pluginCalls.length, 1, '只有 A 挂了')

  const listA = await run(agentA, '')
  assert.match(listA.text, /已挂载（模型可见的工具名为/, `A 确实挂了：${listA.text}`)
  assert.match(listA.text, /- alpha/)

  const listB = await run(agentB, '')
  assert.doesNotMatch(
    listB.text,
    /已挂载（模型可见的工具名为/,
    `B 一个服务器都没挂，不得报"已挂载"：${listB.text}`,
  )
  assert.match(listB.text, /已批准但本会话未挂载/, `B 应看到"已批准但本会话未挂载"：${listB.text}`)
  assert.match(listB.text, /alpha/)
})

test('trust 回报的是实际挂载结果，不是请求挂载的 configs', async () => {
  // `mountInto` 在 mcp-client 解析不到时**静默跳过**（只记日志）。此时若按
  // `configs` 回报"本会话已挂载"，用户会以为工具已就位，而实际一个都没有。
  const project = makeProject({ alpha: { command: 'node' } })
  const harness = createHarness()
  apply(harness.host as never, {})
  const agent = harness.makeAgent(project)
  harness.fire('agent/created', { agent })

  // 让 agent scope 拒绝挂载：`ctx.plugin` 抛错 → 记账里没有该项。
  agent.ctx.plugin = () => { throw new Error('mcp-client 不可用') }

  const definition = harness.commands.get('mcp-project')!
  const out = (await Promise.resolve(definition.handler({ agent, rawInput: 'trust' }))) as {
    kind: string
    text: string
  }
  assert.equal(out.kind, 'success', out.text)
  assert.doesNotMatch(out.text, /本会话已挂载：/, `挂载失败时不得回报"已挂载"：${out.text}`)
  assert.match(out.text, /本会话没有可挂载的服务器/)
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

  harness.fire('agent/created', { agent })
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

  harness.fire('agent/created', { agent })
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(harness.pluginCalls.length, 1, '已批准的项目服务器应尝试挂载一次')
  assert.ok(
    harness.logs.some(
      entry => entry.message.includes('启动失败') && entry.message.includes('已从挂载记账移除'),
    ),
    `启动失败应留下"已从挂载记账移除"的可查诊断：${JSON.stringify(harness.logs)}`,
  )

  const definition = harness.commands.get('mcp-project')!
  const out = (await Promise.resolve(definition.handler({ agent, rawInput: '' }))) as {
    kind: string
    text: string
  }
  assert.doesNotMatch(
    out.text,
    /已挂载（模型可见的工具名为/,
    `启动失败的服务器不得被报成"已挂载"：${out.text}`,
  )
  assert.match(
    out.text,
    /已批准但本会话未挂载/,
    `应如实列在"已批准但本会话未挂载"下：${out.text}`,
  )
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

  harness.fire('agent/created', { agent })
  assert.equal(calls, 1, '首次挂载应走被扣住拒绝的第一条 fiber')

  const definition = harness.commands.get('mcp-project')!
  const run = (rawInput: string) =>
    Promise.resolve(definition.handler({ agent, rawInput })) as Promise<{ kind: string; text: string }>

  // untrust 清空记账（旧 fiber 被 dispose）→ trust 挂上同名的**新**条目。
  assert.equal((await run('untrust')).kind, 'success')
  assert.equal((await run('trust')).kind, 'success')
  assert.equal(calls, 2, 'untrust 之后应能重新挂载同名服务器')

  // 旧 fiber 的拒绝现在才到：它不属于记账里的当前条目。
  rejectFirst?.(new Error('stale failure'))

  const out = await run('')
  assert.match(out.text, /已挂载（模型可见的工具名为/, `新条目仍在，必须报"已挂载"：${out.text}`)
  assert.match(out.text, /- alpha/, `新条目仍在，必须列出 alpha：${out.text}`)
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
  harness.fire('agent/created', { agent })

  assert.equal(harness.pluginCalls.length, 0, '超限文件不得进入挂载路径')

  const definition = harness.commands.get('mcp-project')!
  const out = (await Promise.resolve(definition.handler({ agent, rawInput: '' }))) as {
    kind: string
    text: string
  }
  assert.match(out.text, /过大/, `应报"过大"而不是别的失败：${out.text}`)
  assert.doesNotMatch(
    out.text,
    /没有 \.mcp\.json/,
    `文件明明在，不得谎报"没有 .mcp.json"：${out.text}`,
  )
  // 诊断必须给出可行动的尺寸信息，且只含路径/尺寸，不含文件内容（红线 3）。
  assert.match(out.text, new RegExp(String(1024 * 1024)), `应报出上限：${out.text}`)
  assert.equal(
    out.text.includes('padding'),
    false,
    `诊断不得回显文件内容：${out.text}`,
  )

  // `invalid` 计划会注入会话提示：用户必须在会话里就能看到"文件太大"。
  const live = harness.liveSections()
  assert.equal(live.length, 1, `超限应注入会话提示，实际 ${live.length} 条`)
  const text = (live[0]!.text as () => string)()
  assert.match(text, /过大/, `会话提示应说明过大：${text}`)
  assert.equal(text.includes('padding'), false, `会话提示不得回显文件内容：${text}`)
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

test('端到端：.mcp.json 的 env 含 __proto__ 键，交给 ctx.plugin 的 config 仍有该键', () => {
  // 用 JSON.parse 而不是字面量：对象字面量里的 `__proto__` 是**设置原型**的特殊语法，
  // 根本不会成为自有键，测不到任何东西。`.mcp.json` 是外部输入，走 JSON.parse。
  const entry = JSON.parse('{"command":"node","env":{"__proto__":"X","OK":"v"}}')
  const project = makeProject({ alpha: entry })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})

  harness.fire('agent/created', { agent: harness.makeAgent(project) })

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

test('端到端：.mcp.json 的 headers 含 __proto__ 键，交给 ctx.plugin 的 config 仍有该键', () => {
  const entry = JSON.parse('{"type":"http","url":"https://example.invalid","headers":{"__proto__":"Y","H":"v"}}')
  const project = makeProject({ alpha: entry })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})

  harness.fire('agent/created', { agent: harness.makeAgent(project) })

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

test('同一 sessionId 的第二个 agent 对象不再重复挂载（缺陷 1 端到端守护）', () => {
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})

  const { first, second } = duplicateAgents(harness, project, 'session-dup')
  harness.fire('agent/created', { agent: first })
  assert.equal(harness.pluginCalls.length, 1, '首次创建应挂载一次')

  harness.fire('agent/created', { agent: second })
  assert.equal(
    harness.pluginCalls.length,
    1,
    `同一 sessionId 的第二个 agent 对象不得重复挂载：实际 ${harness.pluginCalls.length} 次。` +
      '每次 ctx.plugin 都会建一个 mcp-client 实例并 spawn 一个子进程，多一次就是多一个命令行相同的进程',
  )
  assert.equal(harness.fibers.length, 1, '不得多建一个 fiber')
})

test('同一 sessionId 的第二个 agent 对象复用同一份记账：untrust 卸载的是它挂的 fiber', async () => {
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})

  const { first, second } = duplicateAgents(harness, project, 'session-dup')
  harness.fire('agent/created', { agent: first })
  assert.equal(harness.fibers[0]!.disposed, 0)

  // 用**第二个**对象发 untrust：登记项必须落在同一个键上。按对象引用记账时这里什么都
  // 不会卸载，第一个对象挂的 fiber 会一直活到插件卸载——"撤销了但进程还在"。
  const definition = harness.commands.get('mcp-project')!
  const out = (await Promise.resolve(definition.handler({ agent: second, rawInput: 'untrust' }))) as {
    kind: string
    text: string
  }
  assert.equal(out.kind, 'success', out.text)
  assert.equal(
    harness.fibers[0]!.disposed,
    1,
    '第二个 agent 对象发起的 untrust 必须能卸载第一个对象挂的 fiber',
  )
})

test('同一 sessionId 的第二个 agent 对象销毁时清理插件侧登记项（agent/disposed 用同一个键）', () => {
  // `agent/disposed` 同样按对象引用取登记项时，清理会落空 → fiber 与提示段一直挂在插件侧
  // （泄漏），直到插件自己被卸载。键必须与挂载时逐字相同。
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})

  const { first, second } = duplicateAgents(harness, project, 'session-dup')
  harness.fire('agent/created', { agent: first })
  assert.equal(harness.fibers[0]!.disposed, 0)

  harness.fire('agent/disposed', { agent: second })
  assert.equal(harness.fibers[0]!.disposed, 1, '销毁第二个对象必须回收第一个对象挂的 fiber')

  // 登记项已删：插件随后卸载不得二次 dispose（重复拆除是幂等的）。
  harness.unload()
  assert.equal(harness.fibers[0]!.disposed, 1, '重复拆除不得再次 dispose')
})

test('同一 sessionId 的第二个 agent 对象命中提示段幂等，不重复注入', () => {
  // 未批准 → 会话创建时注入待批准提示段。两个 agent 对象的 ctx 各自独立，因此"幂等"只能
  // 靠插件侧记账判定：按对象引用记账时第二个对象看不到 `record.notice`，会再注册一条。
  const project = makeProject({ alpha: { command: 'node' } })
  const harness = createHarness()
  apply(harness.host as never, {})

  const { first, second } = duplicateAgents(harness, project, 'session-dup')
  harness.fire('agent/created', { agent: first })
  assert.equal(harness.liveSections().length, 1, '未批准时应注入待批准提示段')

  harness.fire('agent/created', { agent: second })
  assert.equal(
    harness.liveSections().length,
    1,
    `同一会话不得留下两条提示段：${harness.liveSections()
      .map(section => (section.text as () => string)())
      .join(' | ')}`,
  )
})

test('不同 sessionId 各自挂载，不误拦', () => {
  // 修复的方向是"按会话身份记账"，不是"全局只挂一次"：N 个会话就是 N 份连接与子进程
  // （规格 §10）。把键改成任何全局唯一值都会让第二个会话静默拿不到工具。
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})

  const a = harness.makeAgent(project, { id: 'session-a' })
  const b = harness.makeAgent(project, { id: 'session-b' })
  harness.fire('agent/created', { agent: a })
  harness.fire('agent/created', { agent: b })

  assert.equal(harness.pluginCalls.length, 2, '两个不同会话各挂一次')
  assert.equal(harness.fibers.length, 2, '每个会话有自己的 fiber')
})

test('agent.id 缺失或非字符串时不挂载，并留下可查诊断', () => {
  // 键不可用时**宁可少挂一次**：退回对象引用正是缺陷 1 的成因，重复挂载会多 spawn 一个
  // 子进程而用户没有任何可见线索；少挂一次在 `/mcp-project` 里看得见（未挂载），重开
  // 会话即恢复。因此这条路径必须是"跳过 + 记日志"，不是"尽力而为地挂上"。
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])

  const badIds: unknown[] = [undefined, null, '', 42, { id: 'x' }, ['session-1']]
  for (const badId of badIds) {
    const harness = createHarness()
    apply(harness.host as never, {})
    harness.fire('agent/created', { agent: harness.makeAgent(project, { id: badId }) })

    const shown = JSON.stringify(badId)
    assert.equal(harness.pluginCalls.length, 0, `id=${shown} 时不得挂载`)
    assert.ok(
      harness.logs.some(entry => entry.level === 'warn' && entry.message.includes('无法按会话记账')),
      `id=${shown} 时应留下可查诊断：${JSON.stringify(harness.logs)}`,
    )
  }
})

test('id 不可用时命令层的"已挂载"如实为空（不得谎报）', async () => {
  // 跳过挂载必须对命令面可见：否则用户看到"已挂载"却没有任何工具。
  const project = makeProject({ alpha: { command: 'node' } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})

  const agent = harness.makeAgent(project, { id: undefined })
  harness.fire('agent/created', { agent })

  const definition = harness.commands.get('mcp-project')!
  const out = (await Promise.resolve(definition.handler({ agent, rawInput: '' }))) as {
    kind: string
    text: string
  }
  assert.doesNotMatch(
    out.text,
    /已挂载（模型可见的工具名为/,
    `id 不可用时什么都没挂，不得报"已挂载"：${out.text}`,
  )
  assert.match(out.text, /已批准但本会话未挂载/, `应如实列在"已批准但本会话未挂载"下：${out.text}`)
})

// —— 功能 3：自动注入的会话标记 ——
//
// 需求是"一眼看出是哪个会话/哪个宿主启动的进程"，且标记不影响 dotnet 运行。标记追加在
// 文件给出的 `args` **之后**，只含 SessionId（进程命令行对本机所有用户可见，不得携带
// 任何配置内容）。纯函数层面的守护（不修改入参、args 缺失、http 直通）在
// `session-tag.test.mts`；这里是穿过 `apply` 的端到端面。

test('stdio 挂载的命令行带 --project-mcp-session <sessionId>，追加在原有 args 之后', () => {
  const project = makeProject({ alpha: { command: 'node', args: ['--stdio', '--version', '9.10.0'] } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})

  harness.fire('agent/created', { agent: harness.makeAgent(project, { id: 'session-1f4830f2' }) })

  assert.deepEqual(
    harness.pluginCalls[0]!.config.args,
    ['--stdio', '--version', '9.10.0', '--project-mcp-session', 'session-1f4830f2'],
    '标记必须追加在文件给出的 args 之后（既不覆盖也不重排它们）',
  )
})

test('两个会话的标记不同：多进程可据此分辨归属', () => {
  // 这是本功能的全部理由：同一份 `.mcp.json` 产出的命令行**逐字相同**，唯一能区分
  // "哪个进程属于哪个会话"的就是这一段。
  const project = makeProject({ alpha: { command: 'node', args: ['--stdio'] } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})

  harness.fire('agent/created', { agent: harness.makeAgent(project, { id: 'session-a' }) })
  harness.fire('agent/created', { agent: harness.makeAgent(project, { id: 'session-b' }) })

  const tail = (index: number) => harness.pluginCalls[index]!.config.args!.slice(-2)
  assert.deepEqual(tail(0), ['--project-mcp-session', 'session-a'])
  assert.deepEqual(tail(1), ['--project-mcp-session', 'session-b'])
  assert.notDeepEqual(tail(0), tail(1), '两个会话的命令行必须可区分')
})

test('streamable-http 挂载不追加标记（没有子进程命令行可标记）', () => {
  const project = makeProject({ alpha: { type: 'http', url: 'https://example.invalid/mcp' } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})

  harness.fire('agent/created', { agent: harness.makeAgent(project, { id: 'session-1' }) })

  const config = harness.pluginCalls[0]!.config as { transport?: string; args?: unknown; url?: string }
  assert.equal(config.transport, 'streamable-http')
  assert.equal(config.args, undefined, 'http 分支不得凭空多出 args 字段')
  assert.equal(config.url, 'https://example.invalid/mcp', 'url 必须原样保留')
})

test('标记只含 SessionId：不得把展开后的 env 值带进命令行', () => {
  // 红线 3 的新通道：命令行对本机所有用户可见（任务管理器、`wmic process get
  // commandline`、`/proc/<pid>/cmdline`）。标记是插件唯一新增的命令行内容，必须证明它
  // 只有 SessionId。
  const secret = 'placeholder-token-not-a-real-credential'
  process.env.PROJECT_MCP_TAG_TOKEN = secret
  const project = makeProject({ alpha: { command: 'node', env: { TOKEN: '${PROJECT_MCP_TAG_TOKEN}' } } })
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})

  harness.fire('agent/created', { agent: harness.makeAgent(project, { id: 'session-1' }) })

  const args = JSON.stringify(harness.pluginCalls[0]!.config.args)
  assert.equal(args.includes(secret), false, `命令行不得携带展开后的环境变量值：${args}`)
  assert.deepEqual(
    harness.pluginCalls[0]!.config.args,
    ['--project-mcp-session', 'session-1'],
    '标记必须是命令行的全部新增内容',
  )
})
