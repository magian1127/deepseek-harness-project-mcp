import test from 'node:test'
import assert from 'node:assert/strict'
import { registerCommands } from '../commands.js'
import type { CommandDeps, ProjectInspection } from '../commands.js'
import type { AgentShape, HostContext, McpClientConfig } from '../types.js'
import type { TrustStore } from '../trust.js'

/**
 * `/mcp-project` 的行为测试。
 *
 * 重点守护两类**用户可见的**语义：
 * 1. 诊断（跳过原因、重命名、未批准项）在**任何**信任状态下都可见——尤其是用户批准
 *    之前看到的 `untrusted` 状态，它不携带 `skipped`（`session.ts` 第 11 步），
 *    必须由检视层补齐，否则"某个服务器为什么不出现"在最需要答案的时刻消失。
 * 2. 批准复用计划携带的 `projectRoot` / `fingerprint`，且可重复调用。
 *
 * 本文件不做真实 I/O：`CommandDeps` 全部注入，因此断言确定性。
 */

const AGENT = { id: 'a1', session: { header: { cwd: '/repo' } } } as unknown as AgentShape

function config(serverName: string): McpClientConfig {
  return {
    transport: 'stdio',
    serverName,
    command: 'node',
    args: [],
    env: {},
    cwd: '/repo',
    failOnStartupError: false,
  }
}

/** 捕获注册的命令定义。 */
function harness(deps: CommandDeps) {
  let definition: { handler: (i: { agent?: AgentShape; rawInput?: string }) => unknown } | undefined
  const ctx = {
    get: (name: string) =>
      name === 'commands'
        ? { register: (def: never) => { definition = def; return () => { definition = undefined } } }
        : undefined,
    on: () => () => {},
    effect: (dispose: () => void | (() => void)) => { dispose(); return () => {} },
  } as unknown as HostContext

  registerCommands(ctx, deps)
  assert.ok(definition, 'mcp-project 命令未注册')
  return (rawInput: string) =>
    Promise.resolve(definition!.handler({ agent: AGENT, rawInput })) as Promise<{
      kind: string
      text: string
    }>
}

function deps(overrides: Partial<CommandDeps> & { view: ProjectInspection }): CommandDeps {
  const { view, ...rest } = overrides
  return {
    readStore: () => ({ version: 1, projects: {} }) as TrustStore,
    writeStore: async () => {},
    inspect: () => view,
    mountInto: () => {},
    unmountFrom: () => {},
    ...rest,
  }
}

test('未批准状态下仍显示跳过原因与重命名（诊断不被信任状态吞掉）', async () => {
  // `untrusted` 计划**不携带** `skipped`；跳过诊断只存在于检视层补齐的名单里。
  // 若 commands.ts 退回只读 plan.skipped，这里会看不到 global-only 的撞名原因。
  const run = harness(deps({
    view: {
      projectRoot: '/repo',
      plan: { kind: 'untrusted', projectRoot: '/repo', fingerprint: 'sha256:x', pending: ['ok'] },
      mountable: ['ok'],
      renamed: [{ originalName: 'my server', serverName: 'my_server_ab12cd34' }],
      skipped: [{ name: 'global-only', reason: '与全局 MCP 行同名（global-only），已被全局配置提供，跳过' }],
    },
  }))

  const out = await run('')
  assert.equal(out.kind, 'success')
  assert.match(out.text, /global-only/)
  assert.match(out.text, /与全局 MCP 行同名/)
  assert.match(out.text, /my server → my_server_ab12cd34/)
  assert.match(out.text, /ok/)
})

test('部分批准时未批准项与已挂载项同时可见', async () => {
  const run = harness(deps({
    view: {
      projectRoot: '/repo',
      plan: {
        kind: 'mount',
        projectRoot: '/repo',
        fingerprint: 'sha256:x',
        configs: [config('alpha')],
        skipped: [],
      },
      mountable: ['alpha', 'beta'],
      renamed: [],
      skipped: [],
    },
    readStore: () => ({
      version: 1,
      projects: { '/repo': { approvedAt: 't', fingerprint: 'sha256:x', servers: ['alpha'] } },
    }),
  }))

  const out = await run('')
  assert.match(out.text, /已挂载/)
  assert.match(out.text, /alpha/)
  assert.match(out.text, /未批准/)
  assert.match(out.text, /beta/)
})

test('mount 且 configs 为空时说明这份文件没有可挂载的服务器', async () => {
  const run = harness(deps({
    view: {
      projectRoot: '/repo',
      plan: { kind: 'mount', projectRoot: '/repo', fingerprint: 'sha256:x', configs: [], skipped: [] },
      mountable: [],
      renamed: [],
      skipped: [],
    },
  }))

  const out = await run('')
  assert.match(out.text, /没有可挂载的服务器/)
})

test('trust 用计划携带的 projectRoot 与 fingerprint 写存储', async () => {
  let written: { store: TrustStore } | undefined
  const view: ProjectInspection = {
    projectRoot: '/real/root',
    plan: { kind: 'untrusted', projectRoot: '/real/root', fingerprint: 'sha256:abc', pending: ['gh'] },
    mountable: ['gh'],
    renamed: [],
    skipped: [],
  }
  const run = harness(deps({
    view,
    // 第二次 inspect（写盘后）返回可挂载计划。
    inspect: () => view,
    writeStore: async store => { written = { store } },
  }))

  const out = await run('trust')
  assert.equal(out.kind, 'success', out.text)
  const entry = written!.store.projects['/real/root']
  assert.ok(entry, `键不匹配：${Object.keys(written!.store.projects)}`)
  assert.equal(entry.fingerprint, 'sha256:abc')
  assert.deepEqual(entry.servers, ['gh'])
})

test('trust 幂等：重复批准不重复挂载同一 serverName', async () => {
  const mounted: string[] = []
  let store: TrustStore = { version: 1, projects: {} }
  const view = (): ProjectInspection => ({
    projectRoot: '/repo',
    plan: {
      kind: 'mount',
      projectRoot: '/repo',
      fingerprint: 'sha256:x',
      configs: [config('gh')],
      skipped: [],
    },
    mountable: ['gh'],
    renamed: [],
    skipped: [],
  })
  const run = harness(deps({
    view: view(),
    inspect: view,
    readStore: () => store,
    writeStore: async next => { store = next },
    mountInto: (_agent, configs) => { for (const c of configs) mounted.push(c.serverName) },
  }))

  await run('trust')
  await run('trust')
  // 命令层**刻意**每次都按当前计划调用 `mountInto`：它不知道也不需要知道哪些
  // serverName 已经在 agent scope 里挂过。幂等由挂载层负责，其回归守护在
  // `mount.test.mts` 的「重复 trust 只挂载一次（幂等）」——那里注入真实的
  // `agent.ctx.plugin` 假实现，直接断言 plugin 的调用次数。
  assert.deepEqual(mounted, ['gh', 'gh'], '命令层每次都按当前计划挂载，幂等由挂载层负责')
})

test('trust 指定未知服务器名时报错，不写存储', async () => {
  let writes = 0
  const run = harness(deps({
    view: {
      projectRoot: '/repo',
      plan: { kind: 'untrusted', projectRoot: '/repo', fingerprint: 'sha256:x', pending: ['gh'] },
      mountable: ['gh'],
      renamed: [],
      skipped: [],
    },
    writeStore: async () => { writes += 1 },
  }))

  const out = await run('trust nope')
  assert.equal(out.kind, 'error')
  assert.match(out.text, /nope/)
  assert.equal(writes, 0, '未知名字不得写入信任存储')
})

test('untrust 撤销批准并卸载本会话挂载', async () => {
  let store: TrustStore = {
    version: 1,
    projects: { '/repo': { approvedAt: 't', fingerprint: 'sha256:x', servers: ['gh'] } },
  }
  let unmounted = 0
  const run = harness(deps({
    view: {
      projectRoot: '/repo',
      plan: { kind: 'skip', reason: '未批准' },
      mountable: ['gh'],
      renamed: [],
      skipped: [],
    },
    readStore: () => store,
    writeStore: async next => { store = next },
    unmountFrom: () => { unmounted += 1 },
  }))

  const out = await run('untrust')
  assert.equal(out.kind, 'success', out.text)
  assert.equal(Object.hasOwn(store.projects, '/repo'), false)
  assert.equal(unmounted, 1)
})

test('未知子命令报错并给出用法', async () => {
  const run = harness(deps({
    view: {
      projectRoot: '/repo',
      plan: { kind: 'skip', reason: 'x' },
      mountable: [],
      renamed: [],
      skipped: [],
    },
  }))

  const out = await run('bogus')
  assert.equal(out.kind, 'error')
  assert.match(out.text, /用法/)
})

test('没有 agent 时拒绝执行', async () => {
  let definition: { handler: (i: { agent?: AgentShape; rawInput?: string }) => unknown } | undefined
  const ctx = {
    get: (name: string) =>
      name === 'commands'
        ? { register: (def: never) => { definition = def; return () => {} } }
        : undefined,
    on: () => () => {},
    effect: (dispose: () => void | (() => void)) => { dispose(); return () => {} },
  } as unknown as HostContext
  registerCommands(ctx, deps({
    view: {
      projectRoot: '/repo',
      plan: { kind: 'skip', reason: 'x' },
      mountable: [],
      renamed: [],
      skipped: [],
    },
  }))

  const out = (await definition!.handler({ rawInput: '' })) as { kind: string; text: string }
  assert.equal(out.kind, 'error')
})
