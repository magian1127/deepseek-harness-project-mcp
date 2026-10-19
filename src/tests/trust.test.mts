import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canonicalize,
  configHashOf,
  fingerprint,
  readTrustStore,
  writeTrustStore,
  isApproved,
  approve,
  revoke,
} from '../trust.js'
import type { TrustStore } from '../trust.js'

const EMPTY = { version: 2 as const, projects: {} }

// —— 哈希原语：canonicalize / fingerprint ——
//
// 这两个函数同时服务"整文件指纹"（诊断/历史）与"单条目哈希"（v2 批准粒度），
// 规范化语义必须对两者一致：键序与空白不敏感、内容敏感。

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

// —— 回归守卫：`__proto__` 键必须参与哈希 ——
//
// 保护的是**静默退化**：把 canonicalValue 里的 Object.fromEntries 改回朴素的
// `out[key] = value`，`__proto__` 条目会被丢弃、哈希对它重新失敏，而上面全部用例
// 仍会通过。删除这两个用例前请先读懂 `trust.ts` 里对应注释。

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

// —— configHashOf：v2 的批准粒度 ——

test('configHashOf 对同一条目稳定且带 sha256 前缀', () => {
  const entry = { type: 'http', url: 'http://127.0.0.1:19701/mcp' }
  const hash = configHashOf(entry)
  assert.match(hash, /^sha256:[0-9a-f]{64}$/)
  assert.equal(hash, configHashOf({ url: 'http://127.0.0.1:19701/mcp', type: 'http' }))
})

test('configHashOf 忽略键序与嵌套层内的键序', () => {
  const a = { command: 'node', args: ['-v'], env: { TOKEN: '${T}', REGION: 'cn' } }
  const b = { env: { REGION: 'cn', TOKEN: '${T}' }, args: ['-v'], command: 'node' }
  assert.equal(configHashOf(a), configHashOf(b))
})

test('configHashOf 对任何实质改动敏感（改命令 / 加参数 / 改 env 字面量）', () => {
  const base = { command: 'node', args: ['-v'], env: { TOKEN: '${T}' } }
  assert.notEqual(configHashOf(base), configHashOf({ ...base, command: 'evil' }))
  assert.notEqual(configHashOf(base), configHashOf({ ...base, args: ['-v', '--evil'] }))
  assert.notEqual(configHashOf(base), configHashOf({ ...base, env: { TOKEN: '${OTHER}' } }))
})

test('configHashOf 对新增 __proto__ 键敏感（与 fingerprint 同源，不得失敏）', () => {
  const before = { command: 'x' }
  const after = JSON.parse('{"command":"x","__proto__":{"command":"rm -rf"}}')
  assert.notEqual(configHashOf(before), configHashOf(after))
})

// —— readTrustStore：失败关闭 ——

test('readTrustStore 文件缺失时返回空存储', () => {
  assert.deepEqual(readTrustStore(() => { throw new Error('ENOENT') }), EMPTY)
})

test('readTrustStore 损坏 JSON 时返回空存储（失败关闭）', () => {
  assert.deepEqual(readTrustStore(() => '{ broken'), EMPTY)
})

test('readTrustStore 未知版本号时返回空存储', () => {
  const text = '{"version":99,"projects":{"/p":{"servers":{}}}}'
  assert.deepEqual(readTrustStore(() => text), EMPTY)
})

test('readTrustStore 把 v1 存储读为空（v2 不迁移：升级后需重新点一次启动）', () => {
  // v1 只存整文件指纹，展开不出 per-server 哈希，无法迁移；刻意失败关闭而不是猜。
  const v1 = '{"version":1,"projects":{"/p":{"approvedAt":"t","fingerprint":"sha256:x","servers":["a"]}}}'
  assert.deepEqual(readTrustStore(() => v1), EMPTY)
})

test('readTrustStore 结构损坏时返回空存储', () => {
  assert.deepEqual(readTrustStore(() => '{"version":2,"projects":"nope"}'), EMPTY)
  assert.deepEqual(readTrustStore(() => '[1,2]'), EMPTY)
  // 服务器记录缺 configHash / 哈希无前缀 / 项目键为空串，都算结构不符
  assert.deepEqual(
    readTrustStore(() => '{"version":2,"projects":{"/p":{"servers":{"a":{"approvedAt":"t"}}}}}'),
    EMPTY,
  )
  assert.deepEqual(
    readTrustStore(() => '{"version":2,"projects":{"/p":{"servers":{"a":{"approvedAt":"t","configHash":"xx"}}}}}'),
    EMPTY,
  )
  assert.deepEqual(
    readTrustStore(() => '{"version":2,"projects":{"":{"servers":{}}}}'),
    EMPTY,
  )
})

test('readTrustStore 读取合法存储并逐字段重建', () => {
  const text =
    '{"version":2,"projects":{"/p":{"servers":{"a":{"approvedAt":"t1","configHash":"sha256:ha","extra":"drop me"}}}}}'
  const store = readTrustStore(() => text)
  assert.deepEqual(store.projects['/p']?.servers.a, { approvedAt: 't1', configHash: 'sha256:ha' })
})

test('writeTrustStore 输出可被 readTrustStore 读回', () => {
  let written = ''
  const next = approve(EMPTY, '/p', 'a', 'sha256:ha', '2026-01-01T00:00:00.000Z')
  writeTrustStore((_p, text) => { written = text }, next)
  assert.deepEqual(readTrustStore(() => written), next)
})

// —— isApproved：服务器 × 配置 ——

test('isApproved 在服务器与配置哈希都匹配时返回 true', () => {
  const store = approve(EMPTY, '/p', 'a', 'sha256:ha', 't')
  assert.equal(isApproved(store, '/p', 'a', 'sha256:ha'), true)
})

test('isApproved 在配置哈希不匹配时返回 false（改了 .mcp.json 该条 → 重新需动作）', () => {
  const store = approve(EMPTY, '/p', 'a', 'sha256:ha', 't')
  assert.equal(isApproved(store, '/p', 'a', 'sha256:other'), false)
})

test('isApproved 在服务器未批准 / 项目未知时返回 false', () => {
  const store = approve(EMPTY, '/p', 'a', 'sha256:ha', 't')
  assert.equal(isApproved(store, '/p', 'b', 'sha256:hb'), false)
  assert.equal(isApproved(EMPTY, '/p', 'a', 'sha256:ha'), false)
})

// —— approve / revoke：per-server 粒度（v2 的核心语义） ——

test('approve 只授权一个服务器，其余已有批准原样保留（改 A 不连累 B）', () => {
  const first = approve(EMPTY, '/p', 'a', 'sha256:ha', 't1')
  const second = approve(first, '/p', 'b', 'sha256:hb', 't2')
  assert.deepEqual(Object.keys(second.projects['/p']!.servers).sort(), ['a', 'b'])
  assert.deepEqual(second.projects['/p']!.servers.a, { approvedAt: 't1', configHash: 'sha256:ha' })
  assert.deepEqual(second.projects['/p']!.servers.b, { approvedAt: 't2', configHash: 'sha256:hb' })
})

test('approve 覆盖同名服务器的旧哈希', () => {
  const first = approve(EMPTY, '/p', 'a', 'sha256:old', 't1')
  const second = approve(first, '/p', 'a', 'sha256:new', 't2')
  assert.deepEqual(second.projects['/p']!.servers.a, { approvedAt: 't2', configHash: 'sha256:new' })
})

test('approve 不改动其他项目', () => {
  const first = approve(EMPTY, '/a', 'x', 'sha256:x', 't')
  const second = approve(first, '/b', 'y', 'sha256:y', 't')
  assert.deepEqual(second.projects['/a'], first.projects['/a'])
})

test('approve 不修改入参对象（返回新存储）', () => {
  const before = JSON.stringify(EMPTY)
  approve(EMPTY, '/p', 'a', 'sha256:ha', 't')
  assert.equal(JSON.stringify(EMPTY), before)
})

test('revoke 只撤一个服务器，同项目其余保留', () => {
  let store = approve(EMPTY, '/p', 'a', 'sha256:ha', 't')
  store = approve(store, '/p', 'b', 'sha256:hb', 't')
  const after = revoke(store, '/p', 'a')
  assert.deepEqual(Object.keys(after.projects['/p']!.servers), ['b'])
  assert.equal(isApproved(after, '/p', 'a', 'sha256:ha'), false)
  assert.equal(isApproved(after, '/p', 'b', 'sha256:hb'), true)
})

test('revoke 撤掉最后一个服务器时删除整个项目条目（不留空壳）', () => {
  const store = approve(EMPTY, '/p', 'a', 'sha256:ha', 't')
  assert.deepEqual(revoke(store, '/p', 'a'), EMPTY)
})

test('revoke 对未知项目与未知服务器都是空操作', () => {
  const store = approve(EMPTY, '/p', 'a', 'sha256:ha', 't')
  assert.deepEqual(revoke(store, '/nope', 'a'), store)
  assert.deepEqual(revoke(store, '/p', 'ghost'), store)
})

test('revoke 不修改入参对象', () => {
  const store: TrustStore = approve(EMPTY, '/p', 'a', 'sha256:ha', 't')
  const before = JSON.stringify(store)
  revoke(store, '/p', 'a')
  assert.equal(JSON.stringify(store), before)
})
