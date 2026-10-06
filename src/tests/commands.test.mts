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
    mountedServers: () => [],
    refreshNotice: () => {},
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
      mounted: [],
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
      // "已挂载"一列现在取自**真实挂载记账**（`view.mounted`），不再取 `plan.configs`。
      // alpha 已批准且本会话确实挂上了，beta 未批准。
      mounted: ['alpha'],
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
      mounted: [],
    },
  }))

  const out = await run('')
  assert.match(out.text, /没有可挂载的服务器/)
})

test('"已挂载"取自真实挂载记账：计划要挂但本会话没挂上时不谎报', async () => {
  // 会话 B 的典型情形：会话 A 批准后，B 的计划同样是 `mount`（信任是全局的），
  // 但 B 的 `agent/created` 早在批准之前就触发过，一个服务器都没挂上。
  // 若 renderList 退回 `plan.configs`，这里会把"计划要挂"报成"已挂载"，
  // 而本命令的唯一职责就是回答"现在什么是活的"。
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
      mountable: ['alpha'],
      renamed: [],
      skipped: [],
      mounted: [], // ← 真实记账：什么都没挂
    },
    readStore: () => ({
      version: 1,
      projects: { '/repo': { approvedAt: 't', fingerprint: 'sha256:x', servers: ['alpha'] } },
    }),
  }))

  const out = await run('')
  assert.equal(out.kind, 'success')
  assert.doesNotMatch(out.text, /已挂载（模型可见的工具名为/, `不得谎报已挂载：${out.text}`)
  assert.match(out.text, /已批准但本会话未挂载/, `应说明计划已批准但本会话未挂载：${out.text}`)
  assert.match(out.text, /alpha/)
})

test('已挂载集合与计划不一致时（挂载后文件被改动）也按记账呈现', async () => {
  // 反方向偏差：服务器挂上之后 `.mcp.json` 被删除/改动，计划退回 `skip`，
  // 但先前挂上的服务器仍在（本插件不监听文件变化）。
  const run = harness(deps({
    view: {
      projectRoot: '/repo',
      plan: { kind: 'skip', reason: '未批准' },
      mountable: ['alpha'],
      renamed: [],
      skipped: [],
      mounted: ['alpha'], // ← 真实记账：仍活着
    },
  }))

  const out = await run('')
  assert.equal(out.kind, 'success')
  assert.match(out.text, /已挂载/)
  assert.match(out.text, /alpha/)
})

test('trust 用计划携带的 projectRoot 与 fingerprint 写存储', async () => {
  let written: { store: TrustStore } | undefined
  const view: ProjectInspection = {
    projectRoot: '/real/root',
    plan: { kind: 'untrusted', projectRoot: '/real/root', fingerprint: 'sha256:abc', pending: ['gh'] },
    mountable: ['gh'],
    renamed: [],
    skipped: [],
    mounted: [],
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
    mounted: ['gh'],
  })
  const run = harness(deps({
    view: view(),
    inspect: view,
    readStore: () => store,
    writeStore: async next => { store = next },
    mountInto: (_agent, configs) => { for (const c of configs) mounted.push(c.serverName) },
    // 挂载记账去重后与 `mountInto` 的调用次数无关：真实层里同名 fiber 只登记一次。
    mountedServers: () => [...new Set(mounted)],
  }))

  const first = await run('trust')
  const second = await run('trust')
  // 命令层**刻意**每次都按当前计划调用 `mountInto`：它不知道也不需要知道哪些
  // serverName 已经在 agent scope 里挂过。幂等由挂载层负责，其回归守护在
  // `mount.test.mts` 的「重复 trust 只挂载一次（幂等）」——那里注入真实的
  // `agent.ctx.plugin` 假实现，直接断言 plugin 的调用次数。
  assert.deepEqual(mounted, ['gh', 'gh'], '命令层每次都按当前计划挂载，幂等由挂载层负责')
  // 但**回报**必须按记账去重后的真实集合，否则用户会以为挂了两次。
  assert.match(first.text, /本会话已挂载：gh/)
  assert.match(second.text, /本会话已挂载：gh/)
  assert.equal(second.text.match(/gh/g)?.length, 2, `回报不应重复列出 gh：${second.text}`)
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
      mounted: [],
    },
    writeStore: async () => { writes += 1 },
  }))

  const out = await run('trust nope')
  assert.equal(out.kind, 'error')
  assert.match(out.text, /nope/)
  assert.equal(writes, 0, '未知名字不得写入信任存储')
})

test('untrust 撤销批准、卸载本会话挂载，并刷新提示段', async () => {
  let store: TrustStore = {
    version: 1,
    projects: { '/repo': { approvedAt: 't', fingerprint: 'sha256:x', servers: ['gh'] } },
  }
  let unmounted = 0
  const refreshes: string[] = []
  const run = harness(deps({
    view: {
      projectRoot: '/repo',
      plan: { kind: 'skip', reason: '未批准' },
      mountable: ['gh'],
      renamed: [],
      skipped: [],
      mounted: [],
    },
    readStore: () => store,
    writeStore: async next => { store = next },
    unmountFrom: () => { unmounted += 1 },
    refreshNotice: () => { refreshes.push('untrust') },
  }))

  const out = await run('untrust')
  assert.equal(out.kind, 'success', out.text)
  assert.equal(Object.hasOwn(store.projects, '/repo'), false)
  assert.equal(unmounted, 1)
  // 撤销后提示段必须跟着变：旧提示（若有）与新状态不再一致。
  assert.deepEqual(refreshes, ['untrust'], 'untrust 必须刷新提示段')
})

test('trust 成功后刷新提示段（批准后旧提示必须被撤下或替换）', async () => {
  let store: TrustStore = { version: 1, projects: {} }
  const order: string[] = []
  /** 假挂载记账：与 `index.ts` 的 `AgentRegistrations.servers` 同语义（同名只登记一次）。 */
  const ledger = new Set<string>()
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
    mounted: [...ledger],
  })
  const run = harness(deps({
    view: view(),
    inspect: view,
    readStore: () => store,
    writeStore: async next => { store = next; order.push('write') },
    mountInto: (_agent, configs) => { order.push('mount'); for (const c of configs) ledger.add(c.serverName) },
    mountedServers: () => [...ledger],
    refreshNotice: () => { order.push('refresh') },
  }))

  const out = await run('trust')
  assert.equal(out.kind, 'success', out.text)
  // 顺序：先落盘、再挂载、最后刷新——刷新必须看到挂载**之后**的状态。
  assert.deepEqual(order, ['write', 'mount', 'refresh'])
  assert.match(out.text, /本会话已挂载：gh/)
})

test('trust 报错时不动挂载也不刷新提示段', async () => {
  let refreshed = 0
  const run = harness(deps({
    view: {
      projectRoot: '/repo',
      plan: { kind: 'untrusted', projectRoot: '/repo', fingerprint: 'sha256:x', pending: ['gh'] },
      mountable: ['gh'],
      renamed: [],
      skipped: [],
      mounted: [],
    },
    writeStore: async () => { throw new Error('disk full') },
    refreshNotice: () => { refreshed += 1 },
  }))

  const out = await run('trust')
  assert.equal(out.kind, 'error')
  assert.match(out.text, /disk full/)
  assert.equal(refreshed, 0, '写盘失败不得改变提示段')
})

test('untrust 无法定位项目根时不刷新提示段', async () => {
  let refreshed = 0
  const run = harness(deps({
    view: {
      plan: { kind: 'skip', reason: 'no cwd' },
      mountable: [],
      renamed: [],
      skipped: [],
      mounted: [],
    },
    refreshNotice: () => { refreshed += 1 },
  }))

  const out = await run('untrust')
  assert.equal(out.kind, 'error')
  assert.equal(refreshed, 0)
})

test('未知子命令报错并给出用法', async () => {
  const run = harness(deps({
    view: {
      projectRoot: '/repo',
      plan: { kind: 'skip', reason: 'x' },
      mountable: [],
      renamed: [],
      skipped: [],
      mounted: [],
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
      mounted: [],
    },
  }))

  const out = (await definition!.handler({ rawInput: '' })) as { kind: string; text: string }
  assert.equal(out.kind, 'error')
})
