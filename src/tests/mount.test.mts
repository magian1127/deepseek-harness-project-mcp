import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
writeFileSync(join(fakeClientDir, 'index.mjs'), 'export default class FakeMcpClient {}\n')

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

function createHarness(options: { loader?: unknown; withCommands?: boolean } = {}) {
  const withCommands = options.withCommands ?? true
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const effects: Array<() => void> = []
  const commands = new Map<string, { handler: (invocation: unknown) => unknown }>()
  const logs: Array<{ level: string; message: string }> = []
  /** 传给 `ctx.plugin()` 的每一对 (模块, 配置)，按调用顺序。 */
  const pluginCalls: Array<{ module: unknown; config: { serverName: string; failOnStartupError?: boolean } }> = []
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

  /** 假 agent：`ctx.plugin()` 与 `ctx.effect()` 都可观测。 */
  function makeAgent(project: Project, header: Record<string, unknown> = {}) {
    const agent = {
      id: 'a1',
      session: { header: { cwd: project.root, ...header } },
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
    fire: (name: string, payload: unknown) => {
      for (const callback of listeners.get(name) ?? []) callback(payload)
    },
    /** 卸载插件：按注册逆序跑 effect disposer，模拟 fiber 拆除。 */
    unload: () => { for (const dispose of [...effects].reverse()) dispose() },
  }
}

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
