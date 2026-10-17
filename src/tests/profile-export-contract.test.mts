import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * DSH profile 解析契约守护（0.2.1-rc.2 实测）。
 *
 * 本插件不把 `@deepseek-ai/*` 写进依赖，而是在运行时从当前 profile 解析
 * `@deepseek-ai/dsh-mcp-client` 与 `@deepseek-ai/dsh-atomic-write`。升级 DSH 后
 * 这两个包的导出路径或形状一旦变化，插件会**静默降级**（不挂载 / 退回非原子写），
 * 而不会报错——这类退化最难发现，因此在这里钉住实测到的形状。
 *
 * 断言的是本插件实际依赖的**最小面**，不是完整包内容：
 * - `dsh-mcp-client`：`name === 'mcp-client'`、`inject` 含 `tools`、`Config` 存在、
 *   `apply` 是函数；且**没有** default 导出（见 `profile-modules.ts` 的 default
 *   优先逻辑——有 default 时会改取 default，钉住这点让变化显式暴露）。
 * - `dsh-atomic-write`：`writeFileAtomic` 与 `withFileLock` 都是函数。
 *
 * 解析锚点按顺序尝试，全部不可用时**跳过**（脱离 DSH 环境的纯 CI 属预期）：
 * 1. `DSH_CHECKOUT` 环境变量指向的检出；
 * 2. 当前 DSH profile（`${DSH_HOME:-~/.dsh}/profiles/web`）。
 * 刻意不写任何本机绝对路径：锚点一律由环境变量或 profile 约定推出。
 */
function candidateAnchors(): string[] {
  const anchors: string[] = []
  const checkout = process.env.DSH_CHECKOUT
  if (checkout !== undefined && checkout !== '') {
    // 检出根清单的 devDependencies 覆盖 workspace 内的包，是最稳的锚点；
    // web-app bundle 声明的依赖集较小，只作次选。
    anchors.push(join(checkout, 'package.json'))
    anchors.push(join(checkout, 'packages', 'bundle', 'web-app', 'package.json'))
  }
  const home = process.env.DSH_HOME
    ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
  anchors.push(join(home, 'profiles', 'web', 'package.json'))
  return anchors
}

/**
 * 选一个能解析到**指定包**的锚点；都不行则返回 undefined（该用例跳过）。
 *
 * 逐包独立选择：`packages/bundle/web-app` 声明的依赖集不覆盖 atomic-write，
 * 用同一个锚点会得到「mcp-client 能解析、atomic-write 不能」的假失败。
 */
function resolveAnchorFor(name: string): string | undefined {
  for (const candidate of candidateAnchors()) {
    if (!existsSync(candidate)) continue
    try {
      createRequire(candidate).resolve(`${name}/package.json`)
      return candidate
    } catch {
      // 换下一个锚点
    }
  }
  return undefined
}

/** 复刻 profile-modules.ts 的入口解析：优先 exports["."].import/default，其次 main。 */
function entryOf(req: NodeRequire, name: string): { entry: string; version: string } {
  const manifestPath = req.resolve(`${name}/package.json`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    version?: string
    exports?: Record<string, unknown>
    main?: unknown
  }
  const selfExport: unknown = manifest.exports?.['.']
  const candidate = typeof selfExport === 'string'
    ? selfExport
    : typeof selfExport === 'object' && selfExport !== null
      ? (selfExport as { import?: unknown; default?: unknown }).import
        ?? (selfExport as { default?: unknown }).default
      : undefined
  const entry = typeof candidate === 'string'
    ? resolve(dirname(manifestPath), candidate)
    : typeof manifest.main === 'string'
      ? resolve(dirname(manifestPath), manifest.main)
      : req.resolve(name)
  return { entry, version: manifest.version ?? 'unknown' }
}

test('dsh-mcp-client 的导出形状满足本插件契约', async t => {
  const anchor = resolveAnchorFor('@deepseek-ai/dsh-mcp-client')
  if (anchor === undefined) {
    t.skip('当前环境解析不到 @deepseek-ai/dsh-mcp-client，跳过（纯 CI 预期）')
    return
  }
  const req = createRequire(anchor)
  const { entry, version } = entryOf(req, '@deepseek-ai/dsh-mcp-client')
  const mod = await import(pathToFileURL(entry).href) as Record<string, unknown>

  assert.equal(typeof mod.name, 'string', `mcp-client@${version} 必须导出插件名`)
  assert.equal(mod.name, 'mcp-client')
  assert.ok(Array.isArray(mod.inject), `mcp-client@${version} 必须导出 inject`)
  assert.ok((mod.inject as string[]).includes('tools'), `mcp-client@${version} 必须依赖 tools 服务`)
  assert.equal(typeof mod.apply, 'function', `mcp-client@${version} 必须导出 apply`)
  assert.ok(mod.Config !== undefined, `mcp-client@${version} 必须导出 Config schema（挂载前自校验依赖它）`)
  // 0.2.1-rc.2 实测：没有 default 导出，模块本身就是聚合面。
  assert.equal(mod.default, undefined, `mcp-client@${version} 当前应无 default 导出`)
})

test('dsh-atomic-write 的导出形状满足本插件契约', async t => {
  const anchor = resolveAnchorFor('@deepseek-ai/dsh-atomic-write')
  if (anchor === undefined) {
    t.skip('当前环境解析不到 @deepseek-ai/dsh-atomic-write，跳过（纯 CI 预期）')
    return
  }
  const req = createRequire(anchor)
  const { entry, version } = entryOf(req, '@deepseek-ai/dsh-atomic-write')
  const mod = await import(pathToFileURL(entry).href) as Record<string, unknown>

  // 信任存储的写入依赖这两个成员；缺任一都会静默退回非原子写（红线：不得静默降级）。
  assert.equal(typeof mod.writeFileAtomic, 'function', `atomic-write@${version} 必须导出 writeFileAtomic`)
  assert.equal(typeof mod.withFileLock, 'function', `atomic-write@${version} 必须导出 withFileLock`)
  assert.equal(mod.default, undefined, `atomic-write@${version} 当前应无 default 导出`)
})
