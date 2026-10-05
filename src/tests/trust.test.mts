import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalize, fingerprint, readTrustStore, writeTrustStore, isApproved, approve, revoke } from '../trust.js'

const EMPTY = { version: 1 as const, projects: {} }

test('fingerprint 对相同内容稳定', () => {
  assert.equal(fingerprint('{"a":1}'), fingerprint('{"a":1}'))
})

test('fingerprint 对不同内容不同', () => {
  assert.notEqual(fingerprint('{"a":1}'), fingerprint('{"a":2}'))
})

test('fingerprint 带 sha256: 前缀', () => {
  assert.match(fingerprint('x'), /^sha256:[0-9a-f]{64}$/)
})

test('fingerprint 忽略空白差异（规范化）', () => {
  assert.equal(fingerprint('{"a":1}'), fingerprint('{ "a" : 1 }'))
})

test('fingerprint 忽略键序差异（规范化）', () => {
  assert.equal(fingerprint('{"a":1,"b":2}'), fingerprint('{"b":2,"a":1}'))
})

test('fingerprint 对新增条目敏感（git pull 场景）', () => {
  const before = '{"mcpServers":{"a":{"command":"x"}}}'
  const after = '{"mcpServers":{"a":{"command":"x"},"evil":{"command":"rm -rf"}}}'
  assert.notEqual(fingerprint(before), fingerprint(after))
})

test('readTrustStore 文件缺失时返回空存储', () => {
  const store = readTrustStore(() => { throw new Error('ENOENT') })
  assert.deepEqual(store, EMPTY)
})

test('readTrustStore 损坏 JSON 时返回空存储（失败关闭）', () => {
  const store = readTrustStore(() => '{ broken')
  assert.deepEqual(store, EMPTY)
})

test('readTrustStore 未知版本号时返回空存储', () => {
  const store = readTrustStore(() => '{"version":99,"projects":{"/p":{"approvedAt":"t","fingerprint":"f","servers":["a"]}}}')
  assert.deepEqual(store, EMPTY)
})

test('readTrustStore 结构损坏时返回空存储', () => {
  assert.deepEqual(readTrustStore(() => '{"version":1,"projects":"nope"}'), EMPTY)
  assert.deepEqual(readTrustStore(() => '[1,2]'), EMPTY)
})

test('readTrustStore 读取合法存储', () => {
  const text = '{"version":1,"projects":{"/p":{"approvedAt":"t","fingerprint":"f","servers":["a"]}}}'
  const store = readTrustStore(() => text)
  assert.equal(store.projects['/p']?.servers[0], 'a')
})

test('writeTrustStore 输出可被 readTrustStore 读回', () => {
  let written = ''
  const next = approve(EMPTY, '/p', 'fp1', ['a', 'b'], '2026-01-01T00:00:00.000Z')
  writeTrustStore((_p, text) => { written = text }, next)
  const read = readTrustStore(() => written)
  assert.deepEqual(read, next)
})

test('isApproved 在指纹匹配且服务器在列时返回 true', () => {
  const store = approve(EMPTY, '/p', 'fp1', ['a'], 't')
  assert.equal(isApproved(store, '/p', 'fp1', 'a'), true)
})

test('isApproved 在指纹不匹配时返回 false', () => {
  const store = approve(EMPTY, '/p', 'fp1', ['a'], 't')
  assert.equal(isApproved(store, '/p', 'fp2', 'a'), false)
})

test('isApproved 在服务器未被批准时返回 false', () => {
  const store = approve(EMPTY, '/p', 'fp1', ['a'], 't')
  assert.equal(isApproved(store, '/p', 'fp1', 'b'), false)
})

test('isApproved 在项目未知时返回 false', () => {
  assert.equal(isApproved(EMPTY, '/p', 'fp1', 'a'), false)
})

test('approve 覆盖同项目的旧指纹', () => {
  const first = approve(EMPTY, '/p', 'fp1', ['a'], 't1')
  const second = approve(first, '/p', 'fp2', ['b'], 't2')
  assert.equal(second.projects['/p']?.fingerprint, 'fp2')
  assert.deepEqual(second.projects['/p']?.servers, ['b'])
  assert.equal(second.projects['/p']?.approvedAt, 't2')
})

test('approve 不改动其他项目', () => {
  const first = approve(EMPTY, '/a', 'fp', ['x'], 't')
  const second = approve(first, '/b', 'fp', ['y'], 't')
  assert.deepEqual(second.projects['/a'], first.projects['/a'])
})

test('approve 不修改入参对象', () => {
  const before = JSON.stringify(EMPTY)
  approve(EMPTY, '/p', 'fp', ['a'], 't')
  assert.equal(JSON.stringify(EMPTY), before)
})

test('revoke 移除项目条目', () => {
  const store = approve(EMPTY, '/p', 'fp', ['a'], 't')
  assert.deepEqual(revoke(store, '/p'), EMPTY)
})

test('revoke 对未知项目是空操作', () => {
  assert.deepEqual(revoke(EMPTY, '/nope'), EMPTY)
})

// —— 回归守卫：`__proto__` 键必须参与指纹 ——
//
// 这两个用例保护的是**静默退化**：把 canonicalValue 里的 Object.fromEntries 改回
// 朴素的 `out[key] = value`，`__proto__` 条目会被丢弃、指纹对它重新失敏（规格 §7.2
// 要防的 git pull 场景），而上面全部用例仍会通过。删除这两个用例前请先读懂那段注释。

test('fingerprint 对新增 __proto__ 条目敏感（原型键不得被丢弃）', () => {
  const before = '{"mcpServers":{"a":{"command":"x"}}}'
  const after = '{"mcpServers":{"a":{"command":"x"},"__proto__":{"command":"rm -rf"}}}'
  assert.notEqual(fingerprint(before), fingerprint(after))
})

test('canonicalize 保留 __proto__ 键（输出含该键且不改写原型）', () => {
  const out = canonicalize('{"__proto__":1}')
  assert.match(out, /__proto__/)
  // 键必须是自有数据属性，而非被写进结果对象的原型
  assert.equal(Object.getPrototypeOf(JSON.parse(out)), Object.prototype)
})

// —— 回归守卫：递归必须有深度上限 ——
//
// 递归输入来自不受信文件，而 JSON.parse 接受的嵌套深度只受输入长度约束。无上限时
// 这段 18 KB 输入会让 canonicalize/fingerprint 抛 RangeError——本模块运行在会话创建
// 路径上，抛异常会中断会话（规格 §7.4）。两个用例都断言"不抛 + 降级返回原文"。

/** 生成 `depth` 层嵌套的对象文本，最内层键序故意与字典序相反（用于探测是否降级）。 */
function deepObject(depth: number): string {
  return '{"a":'.repeat(depth) + '{"b":1,"a":2}' + '}'.repeat(depth)
}

test('canonicalize 对超深嵌套不抛，降级返回原文', () => {
  const deep = deepObject(3000)
  assert.ok(Buffer.byteLength(deep, 'utf8') > 18000)
  // JSON.parse 接受该输入——所以深度守卫是唯一防线
  assert.doesNotThrow(() => JSON.parse(deep))
  assert.equal(canonicalize(deep), deep)
})

test('fingerprint 对超深嵌套不抛，且指纹稳定', () => {
  const deep = deepObject(3000)
  assert.doesNotThrow(() => fingerprint(deep))
  assert.equal(fingerprint(deep), fingerprint(deep))
})
