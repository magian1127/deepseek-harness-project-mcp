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

test('expandVariables 不把原型链成员当成已定义', () => {
  const result = expandVariables('${toString}', {})
  assert.deepEqual(result, { missing: 'toString' })
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

// —— 回归守卫：`env` / `headers` 的 `__proto__` 键不得被静默丢弃 ——
//
// 键来自**不受信**的 `.mcp.json`。用朴素的 `record[key] = item` 落盘时，`__proto__`
// 会命中原型 setter 而被静默丢弃（字符串值 → no-op）：服务器拿到缺一个变量的环境，
// 认证失败却没有任何诊断，而指纹把该键算在内——用户批准的内容与实际生效的不一致。
// `trust.ts` 的 `canonicalValue` 出于同一原因用 `Object.fromEntries`，并有对应守卫
// （`trust.test.mts`）；下面两个用例补上 `translate.ts` 的同一处加固。

test('translateServer 保留 env 里的 __proto__ 键', () => {
  const entry = JSON.parse('{"command":"x","env":{"__proto__":"X","OK":"v"}}')
  const result = translateServer('s', entry, { cwd: '/w', env: {} })
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok' && result.config.transport === 'stdio') {
    const env = result.config.env
    assert.equal(Object.hasOwn(env, '__proto__'), true)
    assert.equal(env['__proto__'], 'X')
    assert.equal(env.OK, 'v')
    // 键必须是自有数据属性，而不是改写结果对象的原型
    assert.equal(Object.getPrototypeOf(env), Object.prototype)
  }
})

test('translateServer 保留 headers 里的 __proto__ 键', () => {
  const entry = JSON.parse('{"type":"http","url":"https://x","headers":{"__proto__":"Y","H":"v"}}')
  const result = translateServer('h', entry, { cwd: '/w', env: {} })
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok' && result.config.transport === 'streamable-http') {
    const headers = result.config.headers
    assert.equal(Object.hasOwn(headers, '__proto__'), true)
    assert.equal(headers['__proto__'], 'Y')
    assert.equal(headers.H, 'v')
  }
})

test('translateServer 保留展开后落在 __proto__ 上的 env 键', () => {
  const result = translateServer(
    's',
    { command: 'x', env: { '${K}': 'v' } },
    { cwd: '/w', env: { K: '__proto__' } },
  )
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok' && result.config.transport === 'stdio') {
    assert.equal(Object.hasOwn(result.config.env, '__proto__'), true)
    assert.equal(result.config.env['__proto__'], 'v')
  }
})

// —— 回归守卫：展开后必须复查非空 ——
//
// 非空检查原本在展开**之前**，于是 `${CMD:-}` 展开成空串后照常返回 `ok`。`command`
// 的 schema 是 `z.string().required()`（不校验非空），空串会一路走到 `spawn('')` 才抛
// "The argument 'file' cannot be empty"，只落一条日志，而 `/mcp-project` 仍把它列为
// 已挂载——`behavior.md` §3 承诺的是"跳过该条"。

test('translateServer 在 command 展开为空串时跳过', () => {
  const result = translateServer('e', { command: '${CMD:-}' }, { cwd: '/w', env: {} })
  assert.equal(result.kind, 'skip')
  if (result.kind === 'skip') assert.match(result.reason, /command/)
})

test('translateServer 在 command 展开为已定义空串时跳过', () => {
  const result = translateServer('e', { command: '${CMD}' }, { cwd: '/w', env: { CMD: '' } })
  assert.equal(result.kind, 'skip')
})

test('translateServer 在 url 展开为空串时跳过', () => {
  const result = translateServer('u', { type: 'http', url: '${U:-}' }, { cwd: '/w', env: {} })
  assert.equal(result.kind, 'skip')
  if (result.kind === 'skip') assert.match(result.reason, /url/)
})
