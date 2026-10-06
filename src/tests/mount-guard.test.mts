import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 非法 config 被拦在 `ctx.plugin()` **之前**的集成守护（本轮补修的核心断言）。
 *
 * ## 为什么必须有这个文件
 *
 * `cd30688` 只把插件**自己**的日志点从 `message(error)` 改成 `errorName(error)`。
 * 但 `ctx.plugin()` 内部会先跑 `resolveConfig`（`vendor/cordis/src/fiber.ts:641-644`
 * 的 `_resolveConfig`），失败即抛 `ValidationError`，而 **Cordis 自己在 `_reload` 的
 * catch 里把这条异常整条记进日志**（`vendor/cordis/src/fiber.ts:659-663` 的
 * `this.ctx.logger.error(reason)`）。那条消息由 schemastery 的 union 错误拼成
 * （`vendor/schemastery/src/index.ts:834` 的
 * `` `expected ${toString()} but got ${JSON.stringify(data)}` ``），含**整个 config**
 * ——包括展开后的 `env` 凭据。因此"非法 config 只要进得了 `ctx.plugin()`，就必然被
 * 记录一次"，插件侧改记 `errorName()` 堵不住这一处。
 *
 * ## 本文件怎么测
 *
 * 关键手法：**假 mcp-client 的 schema 由本测试控制**，因此可以精确制造
 * "插件产出的 config 不再满足 schema"这一情形——等价于上游给 `Config` 加了一个新的
 * 必填字段。此时：
 * - 修复前：config 进入 `ctx.plugin()`，夹具复刻的 Cordis 行为把整条含敏感值的消息
 *   记进日志；
 * - 修复后：挂载前自校验拦下，`ctx.plugin()` 一次都不被调用，日志只有服务器名与字段路径。
 *
 * 夹具的 `plugin()` 刻意**复刻** Cordis 的"校验失败即记录整条消息"行为（返回一个以
 * "回显了整个 config"的错误拒绝的 fiber），因此"日志不含敏感值"与"`ctx.plugin()` 未被
 * 调用"是同一件事的两种观测——把修复回退掉，本文件的断言会立刻变红。
 *
 * 假 mcp-client 从临时 profile 解析，不依赖本机真实 profile，也不写真实 `$DSH_HOME`。
 * 临时目录刻意不清理：工作区规则禁止代理永久删除文件，且它们位于系统临时目录下。
 */

// 必须在导入被测模块之前改 DSH_HOME：`profile-modules.ts` 在模块顶层就按 profile
// 解析并缓存 DSH 运行时模块，之后再改环境变量不会重新解析（模块级缓存不失效）。
const home = mkdtempSync(join(tmpdir(), 'project-mcp-guard-home-'))
process.env.DSH_HOME = home

const SECRET = 'placeholder-token-not-a-real-credential'
process.env.PROJECT_MCP_GUARD_TOKEN = SECRET

/**
 * 假 mcp-client。
 *
 * `Config['~standard']` 复刻 schemastery 的**形状与危险语义**：
 * - 形状：`{ version: 1, vendor: 'schemastery', validate(value) }`，同步返回
 *   `{ value }` 或 `{ issues: [...] }`（`vendor/schemastery/src/index.ts:290-307`）；
 * - 危险语义：`issues[].message` 回显**整个配置**
 *   （`vendor/schemastery/src/index.ts:834`）——这正是必须被拦在 `ctx.plugin()` 之前的原因。
 *
 * `REQUIRED_EXTRA` 模拟"上游给 Config 加了新的必填字段"：插件产出的 config 必然缺它，
 * 于是每一条都会走到"schema 校验不通过"的分支。
 */
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
writeFileSync(join(fakeClientDir, 'index.mjs'), `
// 模拟"上游新增的必填字段"：本插件产出的 config 永远不含它。
const REQUIRED_EXTRA = 'upstreamAddedRequiredField'

function validateMember(value, extraPath) {
  if (value === null || typeof value !== 'object') {
    return { issues: [{ message: 'expected object but got ' + JSON.stringify(value) }] }
  }
  const issues = []
  if (typeof value[REQUIRED_EXTRA] !== 'string') {
    issues.push({ message: '$' + REQUIRED_EXTRA + ' missing required value', path: [REQUIRED_EXTRA] })
  }
  if (typeof value.serverName !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(value.serverName)) {
    issues.push({ message: '$serverName expected string to match regexp', path: ['serverName'] })
  }
  if (issues.length > 0) return { issues }
  return { value: { ...value } }
}

export function validate(value) {
  // 复刻 schemastery 的 union：逐成员尝试，全失败则在**根上**抛一条**不带 path**、
  // 但 message 里带整个配置的错误（这就是泄密源，也是"诊断拿不到字段"的原因）。
  for (const member of Config.list) {
    const result = validateMember(value, member)
    if (result.value !== undefined) return result
  }
  return { issues: [{ message: 'expected Config but got ' + JSON.stringify(value) }] }
}

const stdioMember = { '~standard': { version: 1, vendor: 'schemastery', validate: (v) => validateMember(v, 'stdio') } }
const httpMember = { '~standard': { version: 1, vendor: 'schemastery', validate: (v) => validateMember(v, 'http') } }

export const Config = {
  type: 'union',
  list: [stdioMember, httpMember],
  '~standard': { version: 1, vendor: 'schemastery', validate },
}

export default { Config, apply() {} }
`)

const { apply } = await import('../index.js')
const { approve, fingerprint, trustStorePath } = await import('../trust.js')

interface Project {
  root: string
  raw: string
}

/** 建一个临时项目：含 `.git`（供 `findProjectRoot` 定位）与 `.mcp.json`。 */
function makeProject(servers: Record<string, unknown>): Project {
  const root = mkdtempSync(join(tmpdir(), 'project-mcp-guard-proj-'))
  mkdirSync(join(root, '.git'), { recursive: true })
  const raw = JSON.stringify({ mcpServers: servers }, null, 2)
  writeFileSync(join(root, '.mcp.json'), raw)
  return { root, raw }
}

/** 写信任存储，批准该项目全部指定服务器（指纹必须针对 `.mcp.json` 的确切文本）。 */
function approveAll(project: Project, servers: string[]): void {
  const store = approve({ version: 1, projects: {} }, project.root, fingerprint(project.raw), servers, 't')
  writeFileSync(trustStorePath(), JSON.stringify(store, null, 2))
}

interface FiberShape {
  disposed: number
  dispose(): Promise<void>
}

function createHarness() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const effects: Array<() => void> = []
  const logs: Array<{ level: string; message: string }> = []
  const pluginCalls: Array<{ module: unknown; config: unknown }> = []
  const fibers: FiberShape[] = []

  const host = {
    get(name: string) {
      if (name === 'commands') return { register: () => () => {} }
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

  function makeAgent(project: Project) {
    const agent = { id: 'a1', session: { header: { cwd: project.root } } } as any
    agent.ctx = {
      get: () => undefined,
      on: () => () => {},
      effect(dispose: () => void | (() => void)) {
        return dispose() ?? (() => {})
      },
      plugin(module: unknown, config: unknown) {
        pluginCalls.push({ module, config })
        const fiber: FiberShape = { disposed: 0, dispose: async () => { fiber.disposed += 1 } }
        fibers.push(fiber)
        // 复刻 Cordis 的 `_reload` catch：校验失败 → 异常被整条记录一次
        // （`vendor/cordis/src/fiber.ts:659-663`）。
        const reason = new Error(`expected Config but got ${JSON.stringify(config)}`)
        reason.name = 'ValidationError'
        return Object.assign(fiber, {
          then: (_ok?: unknown, onErr?: (e: unknown) => unknown) =>
            Promise.resolve().then(() => { throw reason }).catch(onErr as never),
        })
      },
    }
    return agent
  }

  return {
    host, logs, pluginCalls, fibers, makeAgent,
    /** 全部日志文本（含 warn 与 error），用于"不含敏感值"断言。 */
    joined: () => logs.map(entry => entry.message).join('\n'),
    fire: (name: string, payload: unknown) => {
      for (const callback of listeners.get(name) ?? []) callback(payload)
    },
  }
}

/** 一个 `.mcp.json` 条目：env 值经 `${VAR}` 展开成敏感探针值。 */
const PROBED_SERVERS = {
  alpha: { command: 'node', env: { TOKEN: '${PROJECT_MCP_GUARD_TOKEN}' } },
}

test('schema 不通过时非法 config 被拦在 ctx.plugin 之前，日志不含敏感值', async () => {
  const project = makeProject(PROBED_SERVERS)
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})

  harness.fire('agent/created', { agent: harness.makeAgent(project) })
  // 等一个宏任务：fiber 的拒绝处理器是微任务链，日志若由它产生此时已落定。
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(
    harness.pluginCalls.length,
    0,
    `schema 校验不通过的配置不得交给 ctx.plugin()，实际调用 ${harness.pluginCalls.length} 次`,
  )
  const logs = harness.joined()
  // 诊断必须可查：指出是哪台服务器、哪个字段不满足 schema。
  assert.match(logs, /alpha/, `诊断应含服务器名：${logs}`)
  assert.match(logs, /upstreamAddedRequiredField/, `诊断应含出错字段路径：${logs}`)
  // 红线 3：诊断绝不含展开后的环境变量值。
  assert.equal(logs.includes(SECRET), false, `日志不得回显展开后的环境变量值：${logs}`)
  // 也不能含 config 的其他内容（command 值、cwd 等）。
  assert.equal(logs.includes('"transport"'), false, `日志不得回显 config 内容：${logs}`)
})

test('多条非法配置全部被拦下，每条各留一条安全诊断', async () => {
  const project = makeProject({
    alpha: { command: 'node', env: { TOKEN: '${PROJECT_MCP_GUARD_TOKEN}' } },
    beta: { command: 'node', env: { TOKEN: '${PROJECT_MCP_GUARD_TOKEN}' } },
  })
  approveAll(project, ['alpha', 'beta'])
  const harness = createHarness()
  apply(harness.host as never, {})

  harness.fire('agent/created', { agent: harness.makeAgent(project) })
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(harness.pluginCalls.length, 0, '两条非法配置都不得到达 ctx.plugin()')
  const logs = harness.joined()
  assert.match(logs, /alpha/)
  assert.match(logs, /beta/)
  assert.equal(logs.includes(SECRET), false, `日志不得回显展开后的环境变量值：${logs}`)
})

test('挂载记账不含被拦下的服务器：/mcp-project 不得谎报已挂载', async () => {
  // 自校验在 `servers.set()` **之前** `continue`，因此被拦下的项不进记账。
  // 这条守护"批准成功但没挂上"不会伪装成"已挂载"。
  const project = makeProject(PROBED_SERVERS)
  approveAll(project, ['alpha'])
  const harness = createHarness()
  apply(harness.host as never, {})

  const agent = harness.makeAgent(project)
  harness.fire('agent/created', { agent })
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(harness.fibers.length, 0, '被拦下的配置不得留下 fiber')
  assert.equal(harness.pluginCalls.length, 0)
})

test('命令层 trust 路径同样被拦下（两条挂载入口共用同一守卫）', async () => {
  // 挂载有两个入口：`agent/created` 与 `/mcp-project trust`。守卫必须在 `mountInto` 里，
  // 才能同时覆盖两者——放在事件回调里只堵住一半。
  const project = makeProject(PROBED_SERVERS)
  const harness = createHarness()
  const commands = new Map<string, { handler: (invocation: unknown) => unknown }>()
  harness.host.get = (name: string) => {
    if (name !== 'commands') return undefined
    return {
      register: (definition: { name: string; handler: (i: unknown) => unknown }) => {
        commands.set(definition.name, definition)
        return () => { commands.delete(definition.name) }
      },
    }
  }
  apply(harness.host as never, {})

  const agent = harness.makeAgent(project)
  harness.fire('agent/created', { agent })
  await new Promise(resolve => setTimeout(resolve, 0))

  const out = (await Promise.resolve(
    commands.get('mcp-project')!.handler({ agent, rawInput: 'trust' }),
  )) as { kind: string; text: string }

  assert.equal(out.kind, 'success', out.text)
  assert.equal(harness.pluginCalls.length, 0, 'trust 路径同样不得把非法配置交给 ctx.plugin()')
  assert.equal(
    harness.joined().includes(SECRET),
    false,
    `trust 路径日志不得回显展开后的环境变量值：${harness.joined()}`,
  )
  // 如实回报：没有挂上就不能说"本会话已挂载"。
  assert.match(out.text, /本会话没有可挂载的服务器/, `不得谎报已挂载：${out.text}`)
})
