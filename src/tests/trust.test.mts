import test from 'node:test'
import assert from 'node:assert/strict'
import { fingerprint, readTrustStore, writeTrustStore, isApproved, approve, revoke } from '../trust.js'

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
