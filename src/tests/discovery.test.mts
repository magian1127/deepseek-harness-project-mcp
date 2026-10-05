import test from 'node:test'
import assert from 'node:assert/strict'
import { findProjectRoot, readProjectMcpFile } from '../discovery.js'

/** 假文件系统：路径集合即"存在"。 */
function existsOf(...paths: string[]): (p: string) => boolean {
  const set = new Set(paths)
  return p => set.has(p)
}

test('findProjectRoot 向上找到最近的 .git', () => {
  const exists = existsOf('/repo/.git')
  assert.equal(findProjectRoot('/repo/a/b', exists), '/repo')
})

test('findProjectRoot 优先最近的一层', () => {
  const exists = existsOf('/outer/.git', '/outer/inner/.git')
  assert.equal(findProjectRoot('/outer/inner/deep', exists), '/outer/inner')
})

test('findProjectRoot 无 .git 时回退到 cwd 本身', () => {
  assert.equal(findProjectRoot('/no/git/here', existsOf()), '/no/git/here')
})

test('findProjectRoot 在 cwd 自身有 .git 时返回 cwd', () => {
  assert.equal(findProjectRoot('/repo', existsOf('/repo/.git')), '/repo')
})

test('readProjectMcpFile 文件不存在时返回 absent', () => {
  const result = readProjectMcpFile('/repo', () => { throw new Error('ENOENT') })
  assert.deepEqual(result, { kind: 'absent' })
})

test('readProjectMcpFile 非法 JSON 返回 invalid', () => {
  const result = readProjectMcpFile('/repo', () => '{ not json')
  assert.equal(result.kind, 'invalid')
})

test('readProjectMcpFile 顶层非对象返回 invalid', () => {
  const result = readProjectMcpFile('/repo', () => '[1,2,3]')
  assert.equal(result.kind, 'invalid')
})

test('readProjectMcpFile mcpServers 非对象返回 invalid', () => {
  const result = readProjectMcpFile('/repo', () => '{"mcpServers":"nope"}')
  assert.equal(result.kind, 'invalid')
})

test('readProjectMcpFile 缺少 mcpServers 时按空处理', () => {
  const result = readProjectMcpFile('/repo', () => '{}')
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') assert.deepEqual(result.servers, {})
})

test('readProjectMcpFile 返回原始文本用于指纹', () => {
  const text = '{"mcpServers":{"a":{"command":"x"}}}'
  const result = readProjectMcpFile('/repo', () => text)
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') assert.equal(result.raw, text)
})
