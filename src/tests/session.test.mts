import test from 'node:test'
import assert from 'node:assert/strict'
import { planSessionMount } from '../session.js'
import { approve, configHashOf } from '../trust.js'
import type { TrustStore } from '../trust.js'
import { normalizeServerName } from '../translate.js'

const EMPTY_TRUST: TrustStore = { version: 2, projects: {} }

const DEFAULT_RAW = '{"mcpServers":{"gh":{"command":"npx","args":["-y","srv"]}}}'

/**
 * 按 v2 粒度批准：键传 `.mcp.json` 里的**原始键**，哈希取该条目的字面量。
 *
 * 刻意从原文重新解析条目而不是让测试手搓哈希：批准记录必须与计划算出的哈希**同源**，
 * 手搓会让"哈希算法改了但测试没跟上"这类缺陷静默通过。
 */
function trustFor(raw: string, originalKeys: string[], root = '/repo'): TrustStore {
  const parsed = JSON.parse(raw) as { mcpServers: Record<string, unknown> }
  let store: TrustStore = EMPTY_TRUST
  for (const key of originalKeys) {
    store = approve(store, root, normalizeServerName(key), configHashOf(parsed.mcpServers[key]), 't')
  }
  return store
}

function inputOf(overrides: Partial<Parameters<typeof planSessionMount>[0]> = {}) {
  return {
    header: { cwd: '/repo/sub' },
    projectExists: (p: string) => p === '/repo/.git',
    readFile: () => DEFAULT_RAW,
    trust: EMPTY_TRUST,
    globalServers: new Set<string>(),
    env: {},
    ...overrides,
  }
}

/** 取 pending 的名字列表（pending 是 `{serverName, configHash}` 对象数组）。 */
const pendingNames = (plan: { pending: Array<{ serverName: string }> }) => plan.pending.map(item => item.serverName)

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
// 会话误判成子代理：既不挂载项目 MCP 也不提示，且 skip 是静默的。下面的用例把
// 正确行为钉死——只改判据、不删用例。

test('fork 会话（有 parentSession、无 origin）应当挂载', () => {
  const plan = planSessionMount(inputOf({
    header: { cwd: '/repo', parentSession: 'p1' },
    trust: trustFor(DEFAULT_RAW, ['gh']),
  }))
  assert.equal(plan.kind, 'mount')
  if (plan.kind === 'mount') {
    assert.deepEqual(plan.configs.map(c => c.serverName), ['gh'])
  }
})

test('fork 会话未批准时进入 untrusted（不静默跳过）', () => {
  const plan = planSessionMount(inputOf({ header: { cwd: '/repo', parentSession: 'p1' } }))
  assert.equal(plan.kind, 'untrusted')
  if (plan.kind === 'untrusted') assert.deepEqual(pendingNames(plan), ['gh'])
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
  if (plan.kind === 'untrusted') {
    assert.deepEqual(pendingNames(plan), ['gh'])
    // 待批准项必须带哈希：控制台的"启动"就是拿它写批准记录，缺了就得在装配层重算一遍
    assert.match(plan.pending[0]!.configHash, /^sha256:[0-9a-f]{64}$/)
  }
})

test('已信任时产出挂载配置', () => {
  const plan = planSessionMount(inputOf({ trust: trustFor(DEFAULT_RAW, ['gh']) }))
  assert.equal(plan.kind, 'mount')
  if (plan.kind === 'mount') {
    assert.equal(plan.configs.length, 1)
    assert.equal(plan.configs[0]?.serverName, 'gh')
    assert.equal(plan.configs[0]?.failOnStartupError, false)
    assert.deepEqual(plan.pending, [])
  }
})

test('条目内容变了 → 哈希失配 → 回到未信任（v2 的 git-pull 保护）', () => {
  // 批准记录记的是旧条目的哈希；文件里同一条目被改成别的命令后必须重新需动作。
  const approved = trustFor('{"mcpServers":{"gh":{"command":"npx"}}}', ['gh'])
  const plan = planSessionMount(inputOf({
    readFile: () => '{"mcpServers":{"gh":{"command":"evil"}}}',
    trust: approved,
  }))
  assert.equal(plan.kind, 'untrusted')
})

test('批准只记到被批准的那一个服务器（改 A 不连累 B）', () => {
  const raw = '{"mcpServers":{"a":{"command":"x"},"b":{"command":"y"}}}'
  const plan = planSessionMount(inputOf({ readFile: () => raw, trust: trustFor(raw, ['a']) }))
  assert.equal(plan.kind, 'mount', '有一条已批准 → 计划是 mount 而不是 untrusted')
  if (plan.kind === 'mount') {
    assert.deepEqual(plan.configs.map(c => c.serverName), ['a'])
    assert.deepEqual(pendingNames(plan), ['b'], '未批准的 b 必须留在 pending 里，否则它在控制台静默消失')
  }
})

test('空白与键序差异不改变哈希（不需要重新批准）', () => {
  const compact = '{"mcpServers":{"gh":{"command":"npx","args":["-y","srv"]}}}'
  const spaced = '{"mcpServers":{"gh":{"args" : ["-y","srv"] , "command" : "npx"}}}'
  const plan = planSessionMount(inputOf({ readFile: () => spaced, trust: trustFor(compact, ['gh']) }))
  assert.equal(plan.kind, 'mount')
})

test('与全局行撞名的服务器被跳过', () => {
  const raw = '{"mcpServers":{"gh":{"command":"npx"},"other":{"command":"x"}}}'
  const plan = planSessionMount(inputOf({
    readFile: () => raw,
    trust: trustFor(raw, ['gh', 'other']),
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
  const plan = planSessionMount(inputOf({
    readFile: () => raw,
    trust: trustFor(raw, ['gh']),
    globalServers: new Set(['gh']),
  }))
  assert.equal(plan.kind, 'skip')
  if (plan.kind === 'skip') assert.equal(plan.skipped?.length, 1)
})

test('规范化后重名的条目被去重', () => {
  // normalizeServerName('a b') === normalizeServerName('a_b_c8687a08') === 'a_b_c8687a08'
  const raw = '{"mcpServers":{"a b":{"command":"x"},"a_b_c8687a08":{"command":"y"}}}'
  // 批准记在**先到者**（`a b`）的条目哈希上：去重后活下来的是它。
  const plan = planSessionMount(inputOf({ readFile: () => raw, trust: trustFor(raw, ['a b']) }))
  assert.equal(plan.kind, 'mount')
  if (plan.kind === 'mount') {
    assert.equal(plan.configs.length, 1)
    assert.equal(plan.configs[0]?.serverName, 'a_b_c8687a08')
    assert.equal(plan.skipped.length, 1)
    assert.match(plan.skipped[0]?.reason ?? '', /重名|duplicate/)
  }
})

test('未知传输的服务器被跳过，其余照常挂载', () => {
  const raw = '{"mcpServers":{"bad":{"type":"sse","url":"https://x"},"good":{"command":"x"}}}'
  const plan = planSessionMount(inputOf({ readFile: () => raw, trust: trustFor(raw, ['bad', 'good']) }))
  assert.equal(plan.kind, 'mount')
  if (plan.kind === 'mount') {
    assert.deepEqual(plan.configs.map(c => c.serverName), ['good'])
    assert.equal(plan.skipped.length, 1)
  }
})

test('变量缺失的服务器被跳过且诊断不含变量值', () => {
  const raw = '{"mcpServers":{"v":{"command":"x","env":{"T":"${MISSING_VAR}"}}}}'
  const plan = planSessionMount(inputOf({ readFile: () => raw, trust: trustFor(raw, ['v']) }))
  assert.equal(plan.kind, 'mount')
  if (plan.kind === 'mount') {
    assert.equal(plan.configs.length, 0)
    assert.match(plan.skipped[0]?.reason ?? '', /MISSING_VAR/)
    assert.equal(plan.skipped[0]?.reason.includes('${MISSING_VAR}'), false, '诊断只报变量名，不报值')
  }
})
