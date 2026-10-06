// DSH 运行时模块的 profile 解析加载（移植自 deepseek-harness-hashline 的
// profile-modules，对齐 deepseek-harness-zh_pro 的 loadSchemastery 模式）：
// 从当前 profile 的模块解析上下文加载 DSH 提供的运行时模块，避免本包显式
// 依赖（@deepseek-ai/* 一律不写入 dependencies/peerDependencies），同时与
// 主进程拿到同一模块实例。加载失败降级返回 null，不抛异常。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

interface ModuleState {
  cache: unknown
  failed: boolean
}

const mcpClientState: ModuleState = { cache: undefined, failed: false }
const atomicWriteState: ModuleState = { cache: undefined, failed: false }
const schemasteryState: ModuleState = { cache: undefined, failed: false }

/** 桌面版 Host（Electron RunAsNode）argv 不带 --profile，profile 固定为 desktop
 * （apps/desktop/src/paths.ts）；此时不能落回 web 默认，否则 createRequire 会
 * 锚到 web profile，拿不到与桌面运行时（asar 内）同实例的 DSH 模块。 */
export function profileNameFrom(argv: readonly string[], electronVersion: string | undefined): string {
  const flag = argv.indexOf('--profile')
  if (flag !== -1 && flag + 1 < argv.length && !argv[flag + 1].startsWith('-')) {
    return argv[flag + 1]
  }
  if (electronVersion !== undefined) return 'desktop'
  return 'web'
}

export function profileName(): string {
  return profileNameFrom(process.argv, process.versions.electron)
}

// 与 hashline 蓝本的差异：这里用 posix.join 固定 POSIX 分隔符拼接，而不是平台
// path.join——profile 路径的输出需跨平台确定（测试断言 `/tmp/.../profiles/web`
// 逐字固定）；Windows 的 fs/createRequire 同样接受正斜杠，行为不受影响。
export function profileDir(): string {
  const home = process.env.DSH_HOME || posix.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
  return posix.join(home, 'profiles', profileName())
}

// DSH 0.1.7-rc 的组合批次经模块 hooks 管线并行动态 import 官方插件的 ESM；
// 同步 require(esm)（包括目标包 CJS 入口内部的 require）会撞 Node 的
// 「not yet fully loaded」：管线被当前同步栈阻塞，重试永远等不到加载完成。
// 因此用 require.resolve 系只做解析（不求值、无竞态），并优先取 exports 的
// import 条目做异步 import：整条依赖链都排进同一条管线串行交付，天然无竞态；
// 顶层 await 保证调用方模块求值前就绪。
function profileEntryPath(requireFromProfile: NodeRequire, name: string): string {
  const requireEntry: string = requireFromProfile.resolve(name)
  try {
    const manifestPath: string = requireFromProfile.resolve(`${name}/package.json`)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      exports?: Record<string, unknown>
      main?: unknown
    }
    const selfExport: unknown = manifest?.exports?.['.']
    const entry = typeof selfExport === 'string'
      ? selfExport
      : typeof selfExport === 'object' && selfExport !== null
        ? (selfExport as { import?: unknown; default?: unknown }).import ?? (selfExport as { default?: unknown }).default
        : undefined
    if (typeof entry === 'string') return resolve(dirname(manifestPath), entry)
    if (typeof manifest?.main === 'string') return resolve(dirname(manifestPath), manifest.main)
  } catch {
    // exports 不可读时退回 require 条目。
  }
  return requireEntry
}

async function importFromProfile(name: string, state: ModuleState): Promise<void> {
  try {
    const requireFromProfile = createRequire(join(profileDir(), 'package.json'))
    const entry = profileEntryPath(requireFromProfile, name)
    const mod = (await import(pathToFileURL(entry).href)) as { default?: unknown } | null | undefined
    state.cache = mod !== null && mod !== undefined && mod.default !== undefined ? mod.default : mod
  } catch {
    state.cache = undefined
  }
}

// 串行预载：失败保持 cache undefined，由 loadFromProfile 的同步兜底兜住。
await importFromProfile('@deepseek-ai/dsh-mcp-client', mcpClientState)
await importFromProfile('@deepseek-ai/dsh-atomic-write', atomicWriteState)
await importFromProfile('@deepseek-ai/schemastery', schemasteryState)

function loadFromProfile(name: string, state: ModuleState): unknown {
  if (state.cache !== undefined) return state.cache
  if (state.failed) return null
  // 同步兜底：仅预载失败后（如脱离 profile 的测试/CLI 环境）首次调用时尝试；
  // 引擎环境再次拒绝即永久标记，避免每次调用都抛错。
  try {
    const mod = createRequire(join(profileDir(), 'package.json'))(name)
    state.cache = mod !== null && mod !== undefined && mod.default !== undefined ? mod.default : mod
  } catch {
    state.failed = true
    return null
  }
  return state.cache
}

export function loadMcpClient(): unknown {
  return loadFromProfile('@deepseek-ai/dsh-mcp-client', mcpClientState)
}

export function loadAtomicWrite(): unknown {
  return loadFromProfile('@deepseek-ai/dsh-atomic-write', atomicWriteState)
}

/**
 * 解析 `@deepseek-ai/schemastery`（DSH 的 schema 库，即 profile 里 `z` 的来源）。
 *
 * 用途：为插件的 `Config` 提供字段声明，使上限可在插件页配置。**必须**从 profile 解析
 * 而不是 import——本包不得把 `@deepseek-ai/*` 写进 `dependencies` / `peerDependencies`
 * （红线 1），且必须与宿主拿到同一模块实例（`instanceof` / 类型同一性）。
 *
 * 解析不到时返回 `null`（与 `loadMcpClient` 同约定）：调用方据此降级为
 * `export const Config = undefined`，绝不能让 `Config` 变成 `null`——宿主设置页对
 * schema 做 `'toJSON' in Config` 检查（`packages/settings/settings/src/index.ts:427`），
 * `null` 会让 `in` 抛错并带崩整页，而 `undefined` 被当作"无 Config"安全降级。
 */
export function loadSchemastery(): unknown {
  return loadFromProfile('@deepseek-ai/schemastery', schemasteryState)
}
