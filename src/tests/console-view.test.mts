import test from 'node:test'
import assert from 'node:assert/strict'
import { composeConsoleView } from '../console-view.js'
import type { ComposeConsoleInput } from '../console-view.js'
import type { SessionMountPlan } from '../session.js'

/**
 * 控制台视图合成的守护：按钮/弹层看到的状态口径全部在这里钉死。
 *
 * 为什么单独成文件：视图是**用户可见语义**（什么算"没启动"、徽标数怎么算），而它的输入
 * （计划、挂载记账、进行中启动表）在集成层很难精确构造——`failed` 与 `starting` 两个态
 * 尤其如此。纯函数 + 显式输入让每条分支都是确定性的。
 */

const empty = (): Omit<ComposeConsoleInput, 'plan'> => ({
  renamed: [],
  mounted: new Set<string>(),
  failed: new Map<string, string>(),
  startingUrls: new Set<string>(),
  sessionKnown: true,
})

const mountPlan = (overrides: Partial<Extract<SessionMountPlan, { kind: 'mount' }>> = {}): SessionMountPlan => ({
  kind: 'mount',
  projectRoot: '/repo',
  configs: [],
  pending: [],
  skipped: [],
  diagnostics: [],
  ...overrides,
})

test('composeConsoleView：静默 skip（无 .mcp.json / 子代理）→ null，按钮不渲染', () => {
  assert.equal(
    composeConsoleView({ ...empty(), plan: { kind: 'skip', reason: 'x', silent: true } }),
    null,
  )
  assert.equal(
    composeConsoleView({ ...empty(), plan: { kind: 'skip', reason: '子代理会话不挂载' } }),
    null,
    '非静默 skip 也没有可展示的项目级 MCP（子代理共享父会话），同样不渲染',
  )
})

test('composeConsoleView：invalid → 只有 fileNote，actionCount 为 1', () => {
  const view = composeConsoleView({ ...empty(), plan: { kind: 'invalid', reason: '不是合法 JSON' } })
  assert.notEqual(view, null)
  assert.equal(view!.fileNote, '不是合法 JSON')
  assert.deepEqual(view!.rows, [])
  assert.equal(view!.actionCount, 1, '文件坏了也要让用户点得开、看得到原因')
})

test('composeConsoleView：untrusted → 每个 pending 一行 unauthorized', () => {
  const view = composeConsoleView({
    ...empty(),
    plan: {
      kind: 'untrusted',
      projectRoot: '/repo',
      pending: [
        { serverName: 'a', configHash: 'sha256:ha' },
        { serverName: 'b', configHash: 'sha256:hb' },
      ],
    },
  })
  assert.equal(view!.projectRoot, '/repo')
  assert.deepEqual(
    view!.rows.map(row => [row.serverName, row.state]),
    [['a', 'unauthorized'], ['b', 'unauthorized']],
  )
  assert.equal(view!.actionCount, 2)
})

test('composeConsoleView：mount 各态与优先级（failed > starting > mounted）', () => {
  const plan = mountPlan({
    configs: [
      { transport: 'streamable-http', serverName: 'up', url: 'http://h/mcp', headers: {}, failOnStartupError: false },
      { transport: 'streamable-http', serverName: 'boot', url: 'http://h2/mcp', headers: {}, failOnStartupError: false },
      { transport: 'stdio', serverName: 'dead', command: 'x', args: [], env: {}, failOnStartupError: false },
      { transport: 'stdio', serverName: 'fresh', command: 'y', args: [], env: {}, failOnStartupError: false },
    ],
    skipped: [{ name: 'weird', reason: '不支持的传输类型' }],
  })
  const view = composeConsoleView({
    renamed: [],
    mounted: new Set(['up']),
    failed: new Map([['dead', 'Error']]),
    startingUrls: new Set(['http://h2/mcp']),
    sessionKnown: true,
    plan,
  })
  const stateOf = (name: string) => view!.rows.find(row => row.serverName === name)!.state
  assert.equal(stateOf('up'), 'mounted')
  assert.equal(stateOf('boot'), 'starting', 'url 在进行中启动表里 → 启动中')
  assert.equal(stateOf('dead'), 'failed')
  assert.equal(view!.rows.find(row => row.serverName === 'dead')!.detail, 'Error')
  assert.equal(stateOf('fresh'), 'starting', '既没挂上也没失败 → 视为仍在启动，不计入需动作')
  assert.equal(stateOf('weird'), 'skipped')
  assert.equal(view!.actionCount, 1, '只有 failed 计入需动作；skipped 不需要用户动作')
})

test('composeConsoleView：规范化重名带出原名', () => {
  const view = composeConsoleView({
    ...empty(),
    renamed: [{ originalName: 'my server!', serverName: 'my_server_ab12' }],
    mounted: new Set(['my_server_ab12']),
    plan: mountPlan({
      configs: [
        { transport: 'stdio', serverName: 'my_server_ab12', command: 'x', args: [], env: {}, failOnStartupError: false },
      ],
    }),
  })
  assert.equal(view!.rows[0]!.originalName, 'my server!')
})

test('composeConsoleView：本会话无登记项 → not-mounted 且计入需动作', () => {
  // 插件换血（删除→安装）或"批准发生在会话创建之后"都会留下这种会话：计划是 mount、
  // 授权也在，但本会话一个 fiber 都没有。旧口径把它折成 starting 会永远转圈；新口径
  // 让它上徽标、可在弹层里点"启动"补挂（design-mcp-console.md §5）。
  const view = composeConsoleView({
    renamed: [],
    mounted: new Set<string>(),
    failed: new Map<string, string>(),
    startingUrls: new Set<string>(),
    sessionKnown: false,
    plan: mountPlan({
      configs: [
        { transport: 'stdio', serverName: 'a', command: 'x', args: [], env: {}, failOnStartupError: false },
      ],
    }),
  })
  assert.equal(view!.rows[0]!.state, 'not-mounted')
  assert.equal(view!.actionCount, 1, '补挂是一次用户动作，必须上徽标')
})
