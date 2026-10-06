import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * 对**已安装的 profile 模块**断言自校验所依赖的契约（不是对源码，也不是对手写桩）。
 *
 * 为什么必须对真实模块断言：`config-guard.ts` 的全部价值在于"与 Cordis 用的是同一份
 * 校验契约"。Cordis 的用法是 `runtime.Config['~standard'].validate(config)`
 * （`vendor/cordis/src/fiber.ts:53`），因此只要 mcp-client 的 `Config` 形状、`~standard`
 * 的存在性或"同步返回"这一性质发生漂移，自校验就会静默退化为"放行一切"，而那时非法
 * config 又会重新进入 `ctx.plugin()` 被 Cordis 记录一次（含展开后的凭据）。
 *
 * 本文件**不依赖本机是否装了真实 profile**：解析不到就跳过并说明原因，不静默通过。
 * 路径一律从 `DSH_HOME` / profile 解析得到，不写入任何本机绝对路径（红线 2）。
 */

const home = process.env.DSH_HOME
  || posix.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
const profileDir = posix.join(home, 'profiles', 'web')

/** 按 `profile-modules.ts` 的同一手法解析 profile 内的模块入口。 */
function resolveFromProfile(name: string): string | undefined {
  try {
    const requireFromProfile = createRequire(join(profileDir, 'package.json'))
    const manifestPath: string = requireFromProfile.resolve(`${name}/package.json`)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      exports?: Record<string, unknown>
      main?: unknown
    }
    const selfExport: unknown = manifest?.exports?.['.']
    const entry = typeof selfExport === 'string'
      ? selfExport
      : typeof selfExport === 'object' && selfExport !== null
        ? (selfExport as { import?: unknown; default?: unknown }).import
          ?? (selfExport as { default?: unknown }).default
        : undefined
    if (typeof entry === 'string') return resolve(dirname(manifestPath), entry)
    if (typeof manifest?.main === 'string') return resolve(dirname(manifestPath), manifest.main)
    return requireFromProfile.resolve(name)
  } catch {
    return undefined
  }
}

const entry = resolveFromProfile('@deepseek-ai/dsh-mcp-client')
const skip = entry === undefined
  ? `profile「${profileDir}」内未解析到 @deepseek-ai/dsh-mcp-client`
  : false

const mod = entry === undefined ? undefined : await import(pathToFileURL(entry).href)
const McpClient = (mod as { default?: unknown } | undefined)?.default ?? mod

const { validateMountConfig } = await import('../config-guard.js')

const SECRET = 'placeholder-token-not-a-real-credential'

test('mcp-client 导出 Config，且它是带 ~standard 的 schemastery union', { skip }, () => {
  const Config = (McpClient as { Config?: any })?.Config
  assert.ok(Config, 'mcp-client 必须导出 Config（Cordis 的 resolveConfig 依赖它）')
  assert.equal(typeof Config, 'function', 'schemastery schema 是可调用对象')
  assert.equal(Config.type, 'union', 'Config 是 z.union([...])（packages/mcp/mcp-client/src/index.ts:119）')

  const std = Config['~standard']
  assert.ok(std, '~standard 必须存在，否则自校验无从进行')
  assert.equal(std.version, 1)
  assert.equal(std.vendor, 'schemastery')
  assert.equal(typeof std.validate, 'function')
})

test('~standard.validate 是同步的（Cordis 明确不支持异步校验）', { skip }, () => {
  const std = (McpClient as { Config: any }).Config['~standard']
  const result = std.validate({ transport: 'stdio', serverName: 'alpha', command: 'node' })
  assert.equal(
    result?.then,
    undefined,
    'validate 必须同步返回；返回 thenable 时 Cordis 抛 TypeError（vendor/cordis/src/fiber.ts:54-56）',
  )
})

test('合法配置返回 { value }，且 value 已补齐默认值', { skip }, () => {
  const std = (McpClient as { Config: any }).Config['~standard']
  const result = std.validate({ transport: 'stdio', serverName: 'alpha', command: 'node' })
  assert.equal(result.issues, undefined)
  assert.ok(result.value, '合法配置必须返回 value')
  assert.deepEqual(result.value.args, [], '默认值已补齐（args 默认 []）')
  assert.equal(result.value.failOnStartupError, false)
})

test('非法配置返回 { issues }，且 issue.message 会回显整个 config（泄密源）', { skip }, () => {
  // 这条断言是整轮修复的存在理由。若上游改成不再回显配置，本用例会失败并提示我们
  // 重新评估泄漏面——届时可以放宽 `config-guard.ts` 的诊断口径，但不是现在。
  const std = (McpClient as { Config: any }).Config['~standard']
  const result = std.validate({
    transport: 'stdio',
    serverName: 'bad name!',
    command: 'node',
    env: { TOKEN: SECRET },
  })
  assert.ok(result.issues, '非法 serverName 必须产生 issues')
  assert.ok(
    result.issues.some((issue: { message: string }) => issue.message.includes(SECRET)),
    'issue.message 应回显整个 config（含展开后的 env 值）——这正是必须拦在 ctx.plugin() 之前的原因',
  )
})

test('validateMountConfig 在真实 schema 上：合法放行、非法拦下且不泄漏', { skip }, () => {
  const ok = validateMountConfig(McpClient, {
    transport: 'stdio',
    serverName: 'alpha',
    command: 'node',
    args: [],
    env: {},
    cwd: '/tmp',
    failOnStartupError: false,
  })
  assert.equal(ok.ok, true, '插件产出的合法配置必须被放行（否则挂载会全面失效）')

  const bad = validateMountConfig(McpClient, {
    transport: 'stdio',
    serverName: 'bad name!',
    command: 'node',
    args: [],
    env: { TOKEN: SECRET },
    cwd: '/tmp',
    failOnStartupError: false,
  })
  assert.equal(bad.ok, false, '非法 serverName 必须被拦下')
  const reason = bad.ok === false ? bad.reason : ''
  assert.match(reason, /serverName/, `诊断应指出字段：${reason}`)
  assert.equal(reason.includes(SECRET), false, `诊断不得回显配置值：${reason}`)
})

test('validateMountConfig 在真实 schema 上：缺失 command 被拦下且不泄漏', { skip }, () => {
  const bad = validateMountConfig(McpClient, {
    transport: 'stdio',
    serverName: 'alpha',
    args: [],
    env: { TOKEN: SECRET },
    cwd: '/tmp',
    failOnStartupError: false,
  } as never)
  assert.equal(bad.ok, false, '缺失 command 必须被拦下')
  const reason = bad.ok === false ? bad.reason : ''
  assert.equal(reason.includes(SECRET), false, `诊断不得回显配置值：${reason}`)
})
