import test from 'node:test'
import assert from 'node:assert/strict'
import { planSessionMount } from '../session.js'
import { approve, fingerprint } from '../trust.js'

const EMPTY_TRUST = { version: 1 as const, projects: {} }

function inputOf(overrides: Partial<Parameters<typeof planSessionMount>[0]> = {}) {
  return {
    header: { cwd: '/repo/sub' },
    projectExists: (p: string) => p === '/repo/.git',
    readFile: () => '{"mcpServers":{"gh":{"command":"npx","args":["-y","srv"]}}}',
    trust: EMPTY_TRUST,
    globalServers: new Set<string>(),
    env: {},
    ...overrides,
  }
}

test('无 cwd 时跳过', () => {
  const plan = planSessionMount(inputOf({ header: {} }))
  assert.equal(plan.kind, 'skip')
})

test('子代理被跳过', () => {
  const plan = planSessionMount(inputOf({ header: { cwd: '/repo', origin: 'subagent' } }))
  assert.equal(plan.kind, 'skip')
  if (plan.kind === 'skip') assert.match(plan.reason, /subagent/i)
})

// —— 回归守卫：`parentSession` 不是子代理判据 ——
//
// fork（分叉会话）同样写 `parentSession`，但**不带** `origin`，是独立会话：DSH 注释
// "A fork shares the lineage field without the origin and is an independent
// conversation"（`packages/subagent/subagent/src/archive-admission.ts:45-46`），fork
// 的创建路径只写 `parentSession: source.header.id`
// （`packages/api/session-controller/src/commands.ts:274-281`）。仓库既有的正确判据是
// 两者都要（`archive-admission.ts:53`）。
//
// 旧实现用 `parentSession !== undefined || origin === 'subagent'`，把用户可见的分叉
// 会话误判成子代理：既不挂载项目 MCP 也不注入提示，且 skip 是静默的。下面的用例把
// 正确行为钉死——只改判据、不删用例。

test('fork 会话（有 parentSession、无 origin）应当挂载', () => {
  const raw = '{"mcpServers":{"gh":{"command":"npx","args":["-y","srv"]}}}'
  const trust = approve(EMPTY_TRUST, '/repo', fingerprint(raw), ['gh'], 't')
  const plan = planSessionMount(inputOf({
    header: { cwd: '/repo', parentSession: 'p1' },
    trust,
  }))
  assert.equal(plan.kind, 'mount')
  if (plan.kind === 'mount') {
    assert.deepEqual(plan.configs.map(c => c.serverName), ['gh'])
  }
})

test('fork 会话未批准时进入 untrusted（不静默跳过）', () => {
  const plan = planSessionMount(inputOf({ header: { cwd: '/repo', parentSession: 'p1' } }))
  assert.equal(plan.kind, 'untrusted')
  if (plan.kind === 'untrusted') assert.deepEqual(plan.pending, ['gh'])
})

test('同时带 parentSession 与 origin=subagent 时仍被跳过', () => {
  const plan = planSessionMount(inputOf({
    header: { cwd: '/repo', parentSession: 'p1', origin: 'subagent' },
  }))
  assert.equal(plan.kind, 'skip')
  if (plan.kind === 'skip') assert.match(plan.reason, /subagent/i)
})

test('无 .mcp.json 时静默跳过', () => {
  const plan = planSessionMount(inputOf({ readFile: () => { throw new Error('ENOENT') } }))
  assert.equal(plan.kind, 'skip')
  if (plan.kind === 'skip') assert.equal(plan.silent, true)
})

test('未信任时不挂载任何服务器', () => {
  const plan = planSessionMount(inputOf())
  assert.equal(plan.kind, 'untrusted')
  if (plan.kind === 'untrusted') assert.deepEqual(plan.pending, ['gh'])
})

test('已信任时产出挂载配置', () => {
  const raw = '{"mcpServers":{"gh":{"command":"npx","args":["-y","srv"]}}}'
  const trust = approve(EMPTY_TRUST, '/repo', fingerprint(raw), ['gh'], 't')
  const plan = planSessionMount(inputOf({ trust }))
  assert.equal(plan.kind, 'mount')
  if (plan.kind === 'mount') {
    assert.equal(plan.configs.length, 1)
    assert.equal(plan.configs[0]?.serverName, 'gh')
    assert.equal(plan.configs[0]?.failOnStartupError, false)
  }
})

test('指纹不匹配时回到未信任（文件被改）', () => {
  const trust = approve(EMPTY_TRUST, '/repo', 'sha256:deadbeef', ['gh'], 't')
  const plan = planSessionMount(inputOf({ trust }))
  assert.equal(plan.kind, 'untrusted')
})

test('与全局行撞名的服务器被跳过', () => {
  const raw = '{"mcpServers":{"gh":{"command":"npx"},"other":{"command":"x"}}}'
  const trust = approve(EMPTY_TRUST, '/repo', fingerprint(raw), ['gh', 'other'], 't')
  const plan = planSessionMount(inputOf({
    readFile: () => raw,
    trust,
    globalServers: new Set(['gh']),
  }))
  assert.equal(plan.kind, 'mount')
  if (plan.kind === 'mount') {
    assert.deepEqual(plan.configs.map(c => c.serverName), ['other'])
    assert.equal(plan.skipped.length, 1)
    assert.match(plan.skipped[0]?.reason ?? '', /全局|global/i)
  }
})

test('损坏的 .mcp.json 不挂载且给出诊断', () => {
  const plan = planSessionMount(inputOf({ readFile: () => '{ broken' }))
  assert.equal(plan.kind, 'invalid')
})

test('结构错误的 .mcp.json 不抛异常', () => {
  const plan = planSessionMount(inputOf({ readFile: () => '[1,2,3]' }))
  assert.equal(plan.kind, 'invalid')
})

test('全部候选被跳过时不要求批准', () => {
  const raw = '{"mcpServers":{"gh":{"command":"npx"}}}'
  const trust = approve(EMPTY_TRUST, '/repo', fingerprint(raw), ['gh'], 't')
  const plan = planSessionMount(inputOf({
    readFile: () => raw,
    trust,
    globalServers: new Set(['gh']),
  }))
  assert.equal(plan.kind, 'skip')
  if (plan.kind === 'skip') assert.equal(plan.skipped?.length, 1)
})

test('规范化后重名的条目被去重', () => {
  // normalizeServerName('a b') === normalizeServerName('a_b_c8687a08') === 'a_b_c8687a08'
  const raw = '{"mcpServers":{"a b":{"command":"x"},"a_b_c8687a08":{"command":"y"}}}'
  const trust = approve(EMPTY_TRUST, '/repo', fingerprint(raw), ['a_b_c8687a08'], 't')
  const plan = planSessionMount(inputOf({ readFile: () => raw, trust }))
  assert.equal(plan.kind, 'mount')
  if (plan.kind === 'mount') {
    assert.equal(plan.configs.length, 1)
    assert.equal(plan.skipped.length, 1)
    assert.match(plan.skipped[0]?.reason ?? '', /重名|duplicate/)
  }
})

test('未知传输的服务器被跳过，其余照常挂载', () => {
  const raw = '{"mcpServers":{"bad":{"type":"sse","url":"https://x"},"good":{"command":"x"}}}'
  const trust = approve(EMPTY_TRUST, '/repo', fingerprint(raw), ['bad', 'good'], 't')
  const plan = planSessionMount(inputOf({ readFile: () => raw, trust }))
  assert.equal(plan.kind, 'mount')
  if (plan.kind === 'mount') {
    assert.deepEqual(plan.configs.map(c => c.serverName), ['good'])
    assert.equal(plan.skipped.length, 1)
  }
})

test('变量缺失的服务器被跳过且诊断不含变量值', () => {
  const raw = '{"mcpServers":{"v":{"command":"x","env":{"T":"${MISSING_VAR}"}}}}'
  const trust = approve(EMPTY_TRUST, '/repo', fingerprint(raw), ['v'], 't')
  const plan = planSessionMount(inputOf({ readFile: () => raw, trust }))
  assert.equal(plan.kind, 'mount')
  if (plan.kind === 'mount') {
    assert.equal(plan.configs.length, 0)
    assert.match(plan.skipped[0]?.reason ?? '', /MISSING_VAR/)
  }
})
