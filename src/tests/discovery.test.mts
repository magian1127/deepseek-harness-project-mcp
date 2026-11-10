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

// —— 兼容分支：`mcpServers` 缺失时把顶层键当服务器 ——
//
// 2026-10-29 现场：一个项目的 `.mcp.json` 把服务器**直接写在顶层**（漏了 `mcpServers`
// 包裹）。旧行为是 `mcpServers === undefined` → `ok` + 空表 → 计划 `mount` + 零条 →
// 控制台视图 `{ rows: [], actionCount: 0 }` → **按钮渲染出来了，点开一台服务器都没有，
// 也没有任何原因提示**。下面的用例把"兼容分支"的边界钉死：
//
// - 只收"值像服务器条目"的顶层键（普通对象 + 含 `command` / `url` / `type` 之一），
//   元数据键（`$schema`）与非服务器对象（`{ meta: { a: 1 } }`）不得混入；
// - **收到 ≥1 台**才置 `implicitServers: true`；零台、以及 `mcpServers` 存在（含空对象）
//   都**不得**置位——否则装配层会对一个完全合规的文件报"缺少包裹"的诊断；
// - `mcpServers` 存在即为准，顶层那些"像服务器"的键不得混进来（否则同一个文件里两套
//   写法会同时生效，用户看到的服务器比他写的多）。

test('缺少 mcpServers 包裹时按顶层键解析服务器，并标记 implicitServers', () => {
  const text = JSON.stringify({
    'winforms-designer': { type: 'stdio', command: 'dotnet', args: ['--stdio'] },
    dbhub: { type: 'stdio', command: 'npx' },
  })
  const result = readProjectMcpFile('/repo', () => text)

  assert.equal(result.kind, 'ok')
  if (result.kind !== 'ok') return
  assert.deepEqual(Object.keys(result.servers).sort(), ['dbhub', 'winforms-designer'])
  assert.deepEqual(result.servers['winforms-designer'], {
    type: 'stdio',
    command: 'dotnet',
    args: ['--stdio'],
  }, '条目内容必须原样保留（解析层不做任何改写）')
  assert.equal(result.implicitServers, true, '兼容分支必须留下标记，装配层据此记诊断')
  assert.equal(result.raw, text, '原文仍要原样带出：指纹按它计算')
})

test('顶层混入 $schema 等元数据键时只收服务器', () => {
  // `$schema` / `version` 这类键将来会真的出现在 `.mcp.json` 顶层，不能被当成服务器名。
  const text = '{"$schema":"https://example.invalid/mcp.schema.json","alpha":{"command":"node"}}'
  const result = readProjectMcpFile('/repo', () => text)

  assert.equal(result.kind, 'ok')
  if (result.kind !== 'ok') return
  assert.deepEqual(Object.keys(result.servers), ['alpha'])
  assert.equal(Object.hasOwn(result.servers, '$schema'), false, '元数据键不得变成服务器')
  assert.equal(result.implicitServers, true)
})

test('顶层混入非服务器对象（没有 command/url/type）时只收服务器', () => {
  const text = '{"meta":{"a":1},"alpha":{"url":"https://example.invalid/mcp"}}'
  const result = readProjectMcpFile('/repo', () => text)

  assert.equal(result.kind, 'ok')
  if (result.kind !== 'ok') return
  assert.deepEqual(Object.keys(result.servers), ['alpha'])
  assert.equal(Object.hasOwn(result.servers, 'meta'), false, '普通对象不等于服务器条目')
  assert.equal(result.implicitServers, true)
})

test('顶层一个服务器都不像时退回 ok + 空表，且不标记 implicitServers', () => {
  // 这条守护的是"零台也不得被标成兼容分支"：标记一旦置位，装配层会对一个完全合规的
  // 文件（比如只有元数据键的文件）报"缺少 mcpServers 包裹"的假诊断。
  const result = readProjectMcpFile('/repo', () => '{"meta":{"a":1},"version":2}')

  assert.equal(result.kind, 'ok')
  if (result.kind !== 'ok') return
  assert.deepEqual(result.servers, {})
  assert.equal(result.implicitServers, undefined, '零台服务器不得标记为兼容分支')
})

test('mcpServers 是空对象时按零台处理，且不标记 implicitServers（回归）', () => {
  // 空对象是**合法**写法（等于声明零台服务器），语义与旧实现逐字相同；它绝不能落到
  // 下面的兼容分支去扫描顶层键。
  const result = readProjectMcpFile('/repo', () => '{"mcpServers":{}}')

  assert.equal(result.kind, 'ok')
  if (result.kind !== 'ok') return
  assert.deepEqual(result.servers, {})
  assert.equal(result.implicitServers, undefined, 'mcpServers 存在即为准，不得走兼容分支')
})

test('mcpServers 存在但不是对象时仍返回 invalid（回归）', () => {
  for (const bad of ['[]', '"nope"', 'null', '3']) {
    const result = readProjectMcpFile('/repo', () => `{"mcpServers":${bad},"alpha":{"command":"node"}}`)
    assert.equal(result.kind, 'invalid', `mcpServers=${bad} 必须判 invalid，不得被顶层兼容分支救回`)
  }
})

test('mcpServers 存在时只认它：顶层像服务器的键不得混入', () => {
  // 同一个文件里两套写法并存时，混进来会让用户看到比他写的更多的服务器。
  const text = '{"mcpServers":{"declared":{"command":"node"}},"stray":{"command":"node"}}'
  const result = readProjectMcpFile('/repo', () => text)

  assert.equal(result.kind, 'ok')
  if (result.kind !== 'ok') return
  assert.deepEqual(Object.keys(result.servers), ['declared'])
  assert.equal(result.implicitServers, undefined)
})
