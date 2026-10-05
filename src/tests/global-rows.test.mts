import test from 'node:test'
import assert from 'node:assert/strict'
import { collectGlobalServerNames } from '../global-rows.js'

/**
 * 构造一个真实 Loader 形状：`entries()` 在 Loader 本体上（Loader extends
 * EntryTree），不在 `loader.root`（那是 EntryGroup，没有 entries）。
 * 条目形状是 `{ options: { name, config } }`，与 DSH 自身生产代码一致
 * （packages/extensions/tool-cordis/src/config.ts:102 用 `[...loader.entries()]`，
 * 同文件 :75 按 `entry.options.name` 取名）。
 */
function loaderOf(entries: Array<{ name: string; config?: unknown }>): unknown {
  return { entries: () => entries.map(options => ({ options })) }
}

test('收集 mcp-client 行的 serverName', () => {
  const loader = loaderOf([
    { name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'github' } },
    { name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'memory' } },
  ])
  assert.deepEqual([...collectGlobalServerNames(loader)].sort(), ['github', 'memory'])
})

test('忽略非 mcp-client 行', () => {
  const loader = loaderOf([
    { name: '@deepseek-ai/dsh-tools' },
    { name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'x' } },
  ])
  assert.deepEqual([...collectGlobalServerNames(loader)], ['x'])
})

test('忽略缺 serverName 的 mcp-client 行', () => {
  const loader = loaderOf([{ name: '@deepseek-ai/dsh-mcp-client', config: {} }])
  assert.deepEqual([...collectGlobalServerNames(loader)], [])
})

test('忽略 serverName 非字符串的行', () => {
  const loader = loaderOf([{ name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 42 } }])
  assert.deepEqual([...collectGlobalServerNames(loader)], [])
})

test('loader 为 undefined 时返回空集', () => {
  assert.deepEqual([...collectGlobalServerNames(undefined)], [])
})

test('loader 形状不符时返回空集，不抛异常', () => {
  assert.deepEqual([...collectGlobalServerNames({})], [])
  assert.deepEqual([...collectGlobalServerNames({ entries: 'nope' })], [])
})

test('entries() 抛错时返回空集，不抛异常', () => {
  const loader = { entries: () => { throw new Error('boom') } }
  assert.deepEqual([...collectGlobalServerNames(loader)], [])
})

test('条目缺 options 或 options 形状不符时被忽略，不抛异常', () => {
  const loader = { entries: () => [null, 42, {}, { options: null }, { options: {} }] }
  assert.deepEqual([...collectGlobalServerNames(loader)], [])
})

test('嵌套子树的条目也被收集', () => {
  const child = { options: { name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'nested' } } }
  const parent = { options: { name: 'group' }, subtree: { entries: () => [child] } }
  const loader = { entries: () => [parent] }
  assert.deepEqual([...collectGlobalServerNames(loader)].sort(), ['nested'])
})
