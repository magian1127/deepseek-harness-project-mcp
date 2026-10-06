import test from 'node:test'
import assert from 'node:assert/strict'
import { findProjectRoot, McpFileTooLargeError, readProjectMcpFile } from '../discovery.js'

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

// —— 尺寸超限的诊断必须与"文件不存在"分开 ——
//
// 尺寸检查本身在注入实现里（`index.ts` 的 `readFileUtf8`，因为本模块不 import
// `node:fs`）。这里守护的是本模块对哨兵的**归一**：超限必须成为 `invalid`（带尺寸与
// 上限），而不是 `absent`——塌进 `absent` 会让 `/mcp-project` 谎报"没有 .mcp.json"，
// 用户也无从知道要把它改小。

test('readProjectMcpFile 把尺寸超限归一为 invalid（带尺寸与上限），而不是 absent', () => {
  const result = readProjectMcpFile('/repo', () => {
    throw new McpFileTooLargeError('/repo/.mcp.json', 5 * 1024 * 1024, 1024 * 1024)
  })
  assert.equal(result.kind, 'invalid', '超限不得被当成"文件不存在"')
  if (result.kind !== 'invalid') return
  assert.match(result.reason, /过大/)
  assert.match(result.reason, /5242880/, `诊断应含实测大小：${result.reason}`)
  assert.match(result.reason, /1048576/, `诊断应含上限：${result.reason}`)
  assert.match(result.reason, /\.mcp\.json/, `诊断应含路径：${result.reason}`)
})

test('readProjectMcpFile 对非哨兵异常仍返回 absent', () => {
  // 只有尺寸哨兵走 `invalid`；ENOENT / EACCES 等真实读取失败维持原语义。
  const result = readProjectMcpFile('/repo', () => {
    throw new Error('ENOENT: no such file or directory')
  })
  assert.deepEqual(result, { kind: 'absent' })
})
