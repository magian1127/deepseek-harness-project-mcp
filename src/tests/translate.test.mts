import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeServerName, expandVariables, translateServer } from '../translate.js'

test('normalizeServerName 保留合法名', () => {
  assert.equal(normalizeServerName('github'), 'github')
  assert.equal(normalizeServerName('my-server_2'), 'my-server_2')
})

test('normalizeServerName 把非法字符转下划线并加哈希后缀', () => {
  const result = normalizeServerName('my server!')
  assert.match(result, /^[A-Za-z0-9_-]{1,32}$/)
  assert.match(result, /^my_server_/)
})

test('normalizeServerName 结果不超 32 字符', () => {
  assert.ok(normalizeServerName('x'.repeat(80)).length <= 32)
})

test('normalizeServerName 对同一输入稳定', () => {
  assert.equal(normalizeServerName('a b'), normalizeServerName('a b'))
})

test('normalizeServerName 对不同输入产生不同结果', () => {
  assert.notEqual(normalizeServerName('a b'), normalizeServerName('a  b'))
})

test('normalizeServerName 全非法字符时回退到 server', () => {
  assert.match(normalizeServerName('!!!'), /^server_/)
})

test('expandVariables 替换已定义变量', () => {
  const result = expandVariables('${FOO}/bar', { FOO: 'baz' })
  assert.deepEqual(result, { value: 'baz/bar' })
})

test('expandVariables 使用默认值', () => {
  const result = expandVariables('${FOO:-fallback}', {})
  assert.deepEqual(result, { value: 'fallback' })
})

test('expandVariables 已定义时优先于默认值', () => {
  const result = expandVariables('${FOO:-fallback}', { FOO: 'real' })
  assert.deepEqual(result, { value: 'real' })
})

test('expandVariables 未定义且无默认值时报告变量名', () => {
  const result = expandVariables('${MISSING}', {})
  assert.deepEqual(result, { missing: 'MISSING' })
})

test('expandVariables 不把已定义值写进缺省报告', () => {
  const result = expandVariables('${SECRET}', {})
  assert.equal('value' in result, false)
  assert.equal(JSON.stringify(result).includes('SECRET'), true)
})

test('translateServer 翻译 stdio 条目', () => {
  const result = translateServer('gh', { command: 'npx', args: ['-y', 'srv'] }, { cwd: '/work', env: {} })
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.equal(result.config.transport, 'stdio')
    assert.equal(result.serverName, 'gh')
    assert.equal(result.config.cwd, '/work')
    assert.equal(result.config.failOnStartupError, false)
  }
})

test('translateServer 翻译 http 条目', () => {
  const result = translateServer('web', { type: 'http', url: 'https://x/mcp' }, { cwd: '/work', env: {} })
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') assert.equal(result.config.transport, 'streamable-http')
})

test('translateServer 接受 streamable-http 别名', () => {
  const result = translateServer('web', { type: 'streamable-http', url: 'https://x/mcp' }, { cwd: '/work', env: {} })
  assert.equal(result.kind, 'ok')
})

test('translateServer 跳过 sse 并说明原因', () => {
  const result = translateServer('s', { type: 'sse', url: 'https://x/sse' }, { cwd: '/work', env: {} })
  assert.equal(result.kind, 'skip')
  if (result.kind === 'skip') assert.match(result.reason, /sse/i)
})

test('translateServer 跳过 ws', () => {
  const result = translateServer('w', { type: 'ws', url: 'wss://x' }, { cwd: '/work', env: {} })
  assert.equal(result.kind, 'skip')
})

test('translateServer 跳过有 url 但无 type 的条目', () => {
  const result = translateServer('bad', { url: 'https://x/mcp' }, { cwd: '/work', env: {} })
  assert.equal(result.kind, 'skip')
  if (result.kind === 'skip') assert.match(result.reason, /type/)
})

test('translateServer 跳过非对象条目', () => {
  assert.equal(translateServer('n', null, { cwd: '/w', env: {} }).kind, 'skip')
  assert.equal(translateServer('n', 'str', { cwd: '/w', env: {} }).kind, 'skip')
})

test('translateServer 跳过缺 command 的 stdio 条目', () => {
  const result = translateServer('c', { args: ['x'] }, { cwd: '/w', env: {} })
  assert.equal(result.kind, 'skip')
})

test('translateServer 在变量缺失时跳过且只报变量名', () => {
  const result = translateServer('v', { command: 'npx', env: { TOKEN: '${SECRET_TOKEN}' } }, { cwd: '/w', env: {} })
  assert.equal(result.kind, 'skip')
  if (result.kind === 'skip') {
    assert.match(result.reason, /SECRET_TOKEN/)
    assert.equal(result.reason.includes('undefined'), false)
  }
})

test('translateServer 展开 env 中的变量', () => {
  const result = translateServer('e', { command: 'x', env: { K: '${V}' } }, { cwd: '/w', env: { V: 'val' } })
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok' && result.config.transport === 'stdio') assert.equal(result.config.env.K, 'val')
})

test('translateServer 使用规范化后的 serverName', () => {
  const result = translateServer('my server', { command: 'x' }, { cwd: '/w', env: {} })
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') assert.match(result.serverName, /^[A-Za-z0-9_-]{1,32}$/)
})
