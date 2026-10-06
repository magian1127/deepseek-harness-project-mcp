import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_CONNECTION_LIMIT,
  normalizeConnectionLimit,
  selectReclaimTargets,
} from '../reclaim.js'
import type { ReclaimEntry } from '../reclaim.js'

/**
 * `selectReclaimTargets` 的穷尽单测。
 *
 * 本文件守护的是**用户明确指定的回收规则**（不得改动）：
 * 1. 上限 8；2. 超限时回收最后活跃时间最早的 `idle` 会话；3. 全部 `running` 时忽略上限；
 * 4. 排序按最后活跃时间；5. 被回收的会话下次发消息时自动重挂（重挂在 `mount.test.mts`）。
 *
 * 为什么边界要逐条钉死：这些判定决定"哪个会话的工具会突然消失"。任何依赖
 * `Map` / 数组迭代顺序的隐含行为，都会让用户看到**随机**消失的工具——那时无从诊断。
 * 因此"时间戳相同""status 非预期值""limit 为 0"这些情形都在这里显式定义并断言。
 */

function entry(sessionId: string, lastActiveAt: number, status: 'idle' | 'running'): ReclaimEntry {
  return { sessionId, lastActiveAt, status }
}

/** 造 `count` 个 idle 会话，活跃时间依次递增（`s0` 最久没动）。 */
function idles(count: number, base = 1000): ReclaimEntry[] {
  return Array.from({ length: count }, (_, index) => entry(`s${index}`, base + index, 'idle'))
}

test('未超上限时不回收', () => {
  assert.deepEqual(selectReclaimTargets([], { limit: 8 }), [])
  assert.deepEqual(selectReclaimTargets(idles(1), { limit: 8 }), [])
  // 恰好等于上限：不回收（判据是 `<=`，不是 `<`）。
  assert.deepEqual(selectReclaimTargets(idles(8), { limit: 8 }), [])
})

test('超上限且有 idle 时回收最久未活跃的 idle', () => {
  // 9 个 idle、上限 8 → 只回收 1 个，且必须是 `lastActiveAt` 最小的 `s0`。
  assert.deepEqual(selectReclaimTargets(idles(9), { limit: 8 }), ['s0'])
  // 12 个 idle、上限 8 → 回收 4 个，按"最久没动的优先"的顺序返回。
  assert.deepEqual(selectReclaimTargets(idles(12), { limit: 8 }), ['s0', 's1', 's2', 's3'])
})

test('超上限但全部 running 时不回收（绝不打断正在工作的会话）', () => {
  const entries = Array.from({ length: 9 }, (_, index) => entry(`s${index}`, 1000 + index, 'running'))
  assert.deepEqual(
    selectReclaimTargets(entries, { limit: 8 }),
    [],
    '9 个会话都在 running 时必须忽略上限——规则 3',
  )
})

test('部分 idle、需回收数大于 idle 数时只回收 idle，不碰 running', () => {
  // 10 个会话、上限 8 → 需回收 2 个；但只有 1 个 idle。
  const entries = [
    entry('busy-a', 1000, 'running'),
    entry('old-idle', 2000, 'idle'),
    ...Array.from({ length: 8 }, (_, index) => entry(`busy-b${index}`, 3000 + index, 'running')),
  ]
  assert.deepEqual(
    selectReclaimTargets(entries, { limit: 8 }),
    ['old-idle'],
    'idle 不够时只回收现有的 idle，多出的部分放弃（不打断 running）',
  )
})

test('running 会话即使最久未活跃也不被回收', () => {
  // `ancient-but-busy` 是全部候选里活跃时间**最早**的（时间戳 1），但它在 running，
  // 因此必须被跳过；回收名额要落到 idle 一侧最久没动的 `s0` 上。
  const entries = [
    entry('ancient-but-busy', 1, 'running'),
    ...idles(8, 5_000_000),
    entry('recent-idle', 9_000_000, 'idle'),
  ]
  // 10 个候选、上限 8 → 回收 2 个，两者都必须来自 idle 且是最久没动的两个。
  const targets = selectReclaimTargets(entries, { limit: 8 })
  assert.deepEqual(targets, ['s0', 's1'])
  assert.equal(
    targets.includes('ancient-but-busy'),
    false,
    '活跃时间最早但 status 是 running 的会话不得被回收',
  )
  assert.equal(
    targets.includes('recent-idle'),
    false,
    '回收的是最久未活跃的 idle；最新活跃的 idle 轮不到',
  )
})

test('lastActiveAt 相同时按 sessionId 升序决胜（不依赖迭代顺序）', () => {
  // 同一时间戳的 9 个会话、上限 8 → 回收恰好 1 个，且必须是 id 最小的 `a`。
  const tied = ['i', 'h', 'g', 'f', 'e', 'd', 'c', 'b', 'a'].map(id => entry(id, 1000, 'idle'))
  assert.deepEqual(selectReclaimTargets(tied, { limit: 8 }), ['a'])

  // 顺序完全反转后结果必须逐字相同——这是"不依赖 Map/数组迭代顺序"的判据。
  const reversed = [...tied].reverse()
  assert.deepEqual(selectReclaimTargets(reversed, { limit: 8 }), ['a'])

  // 需要回收多个时同样按 id 升序补齐。
  const many = ['d', 'c', 'b', 'a', 'z', 'y', 'x', 'w', 'v', 'u'].map(id => entry(id, 7, 'idle'))
  assert.deepEqual(selectReclaimTargets(many, { limit: 8 }), ['a', 'b'])
})

test('limit 为 0 时回收全部 idle；负数按 0 处理', () => {
  const entries = [entry('a', 1, 'idle'), entry('b', 2, 'idle'), entry('c', 3, 'running')]
  assert.deepEqual(selectReclaimTargets(entries, { limit: 0 }), ['a', 'b'])
  assert.deepEqual(selectReclaimTargets(entries, { limit: -5 }), ['a', 'b'])
  // 空数组 + 0 上限不得抛异常。
  assert.deepEqual(selectReclaimTargets([], { limit: 0 }), [])
})

test('空数组在任何上限下都不回收', () => {
  assert.deepEqual(selectReclaimTargets([], { limit: 8 }), [])
  assert.deepEqual(selectReclaimTargets([], { limit: 0 }), [])
  assert.deepEqual(selectReclaimTargets([], { limit: -1 }), [])
})

test('status 非预期值一律视为 running，永不回收', () => {
  // 契约漂移（上游改状态名）或记账损坏时，安全侧是"不动它"。
  const weird = [
    { sessionId: 'a', lastActiveAt: 1, status: undefined },
    { sessionId: 'b', lastActiveAt: 2, status: null },
    { sessionId: 'c', lastActiveAt: 3, status: 'paused' },
    { sessionId: 'd', lastActiveAt: 4, status: 'IDLE' },
    { sessionId: 'e', lastActiveAt: 5, status: true },
    { sessionId: 'f', lastActiveAt: 6, status: 0 },
  ] as unknown as ReclaimEntry[]
  // 6 个非 idle + 9 个 idle = 15 个候选，上限 8 → 需回收 7 个；全部来自 idle 一侧。
  const targets = selectReclaimTargets([...weird, ...idles(9, 500)], { limit: 8 })
  assert.deepEqual(targets, ['s0', 's1', 's2', 's3', 's4', 's5', 's6'])
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
    assert.equal(targets.includes(id), false, `非预期 status 的会话 ${id} 不得被回收`)
  }
})

test('lastActiveAt 非有限数视为最新活跃（不被优先回收）', () => {
  const entries = [
    entry('broken-nan', Number.NaN, 'idle'),
    entry('broken-inf', Number.POSITIVE_INFINITY, 'idle'),
    entry('oldest', 1, 'idle'),
    ...idles(7, 100),
  ]
  // 10 个候选、上限 8 → 回收 2 个：真正最久没动的 `oldest` 与其次的 `s0`。
  // 两个损坏时间戳排在最后，绝不因为比较结果是 NaN 而成为随机回收对象。
  assert.deepEqual(selectReclaimTargets(entries, { limit: 8 }), ['oldest', 's0'])
})

test('重复的 sessionId 只计一次，且不会让回收数虚高', () => {
  // 同一会话出现两次：真实候选是 8 个（未超限），不得因为数组长度 9 而回收任何一个。
  const duplicated = [
    entry('dup', 1, 'idle'),
    entry('dup', 1, 'idle'),
    ...idles(7, 100),
  ]
  assert.deepEqual(
    selectReclaimTargets(duplicated, { limit: 8 }),
    [],
    '按会话去重后只有 8 个候选，未超上限',
  )
})

test('sessionId 非法（空串/非字符串）的条目被跳过，不影响其余判定', () => {
  const entries = [
    entry('', 1, 'idle'),
    { sessionId: 42, lastActiveAt: 1, status: 'idle' },
    { sessionId: null, lastActiveAt: 1, status: 'idle' },
    ...idles(9, 100),
  ] as unknown as ReclaimEntry[]
  assert.deepEqual(
    selectReclaimTargets(entries, { limit: 8 }),
    ['s0'],
    '非法 id 无法被回收（没有可定位的会话），也不得占用回收名额',
  )
})

test('不修改入参数组与条目', () => {
  const entries = idles(9)
  const snapshot = JSON.stringify(entries)
  selectReclaimTargets(entries, { limit: 8 })
  assert.equal(JSON.stringify(entries), snapshot, '入参必须原样（内部排序的是副本）')
})

test('返回顺序即回收顺序：最久未活跃的在前', () => {
  const entries = [
    entry('newest', 5000, 'idle'),
    entry('oldest', 1000, 'idle'),
    entry('middle', 3000, 'idle'),
  ]
  assert.deepEqual(selectReclaimTargets(entries, { limit: 1 }), ['oldest', 'middle'])
})

test('normalizeConnectionLimit：非法配置退回默认 8，合法值取整', () => {
  // 缺失 / 类型不对 / 非有限数 → 默认值（不能是 0，那会回收掉全部连接）。
  for (const bad of [undefined, null, '8', true, {}, [], Number.NaN, Number.POSITIVE_INFINITY, -Infinity]) {
    assert.equal(
      normalizeConnectionLimit(bad),
      DEFAULT_CONNECTION_LIMIT,
      `配置值 ${JSON.stringify(bad)} 应退回默认 ${DEFAULT_CONNECTION_LIMIT}`,
    )
  }
  assert.equal(normalizeConnectionLimit(8), 8)
  assert.equal(normalizeConnectionLimit(1), 1)
  assert.equal(normalizeConnectionLimit(0), 0, '0 是显式的"上限为 0"，不是非法值')
  // 负数与小数：夹到 0 与向下取整，仍然返回可用的有限数。
  assert.equal(normalizeConnectionLimit(-3), 0)
  assert.equal(normalizeConnectionLimit(8.9), 8)
})

test('默认上限是 8', () => {
  // 用户明确指定的值；改动它必须同时改文档（behavior/README）与守护用例。
  assert.equal(DEFAULT_CONNECTION_LIMIT, 8)
})
