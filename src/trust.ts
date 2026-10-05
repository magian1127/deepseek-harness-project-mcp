/**
 * 信任存储与指纹绑定（规格 §7）。
 *
 * 纯函数 + 注入 I/O：`readTrustStore` / `writeTrustStore` 的读写函数由调用方注入，
 * 本模块不 import `node:fs`，因此可被彻底单测。真实的原子写与 `0600` 权限由
 * 调用方（任务 7 的 apply）实现。
 *
 * 安全：
 * - 指纹绑定 `.mcp.json` 的**确切内容**（规范化 JSON 的 sha256）。规范化只剔除
 *   空白与键序这类纯格式差异，内容变更（含 `git pull` 拉进来的新增条目）必然
 *   改变指纹（规格 §7.2）——没有指纹，"批准一次"就会永久授权该路径下未来的任何
 *   内容。
 * - 失败关闭（规格 §7.4）：文件缺失、损坏、版本不认识、结构不符，一律视为全部
 *   未信任，且不抛异常——本模块运行在会话创建路径上，抛异常会中断会话。
 * - 本模块不产生日志，也不把文件内容放进返回值以外的任何地方：`.mcp.json` 与
 *   信任文件都可能含凭据（规格 §10）。
 */
import { createHash } from 'node:crypto'
import { posix } from 'node:path'

/** 单个项目的批准记录。 */
export interface TrustEntry {
  approvedAt: string
  fingerprint: string
  servers: string[]
}

/** 信任存储：`projects` 以项目根路径为键（规格 §7.1）。 */
export type TrustStore = {
  version: 1
  projects: Record<string, TrustEntry>
}

/**
 * 空存储。信任文件的缺失/损坏/未知版本都归一到它。
 *
 * 每次新建而非共享常量：返回值会交给调用方与 `approve` / `revoke`，共享一个可变
 * 对象会让某一处的改动泄漏到另一处。
 */
function emptyStore(): TrustStore {
  return { version: 1, projects: {} }
}

/** 非 null 的普通对象（排除数组与原始值）。与 discovery.ts 同判定。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/**
 * 递归把值换成键序确定的等价结构：对象键按字典序排序，数组保序。
 *
 * `JSON.parse` 的产物只含 null / 布尔 / 数字 / 字符串 / 数组 / 普通对象，递归只需
 * 处理这几种情形。
 */
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (isPlainObject(value)) {
    // 键来自不受信文件，用 fromEntries 落成普通自有属性：`__proto__` 这类键必须
    // 是数据属性，而不是改写结果对象的原型。
    const pairs = Object.keys(value)
      .sort()
      .map((key): [string, unknown] => [key, canonicalValue(value[key])])
    return Object.fromEntries(pairs)
  }
  return value
}

/**
 * 规范化 JSON 文本：解析后按 key 排序递归序列化，剔除空白与键序差异。
 *
 * 解析失败时返回 `raw` 本身——调用方 `readProjectMcpFile` 已校验过合法性，此处只
 * 作防御，不抛异常。
 */
export function canonicalize(raw: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw
  }
  return JSON.stringify(canonicalValue(parsed))
}

/** 内容指纹：`sha256:<hex>`，基于规范化文本（规格 §7.2）。 */
export function fingerprint(raw: string): string {
  const digest = createHash('sha256').update(canonicalize(raw), 'utf8').digest('hex')
  return `sha256:${digest}`
}

/**
 * 信任文件路径 `${DSH_HOME}/project-mcp-trust.json`（规格 §7.1）。
 *
 * home 的解析与 `profile-modules.ts` 的 `profileDir` 同源：`DSH_HOME` 优先，否则
 * `~/.dsh`。这里刻意重写该表达式而不 import `profileDir`：后者在模块顶层就会从
 * profile 目录动态加载 DSH 运行时模块，把那个副作用带进本模块会让纯函数的单测
 * 依赖真实 profile。两处需同步修改。
 *
 * 拼接用 `posix.join` 固定正斜杠，与 `profileDir` 一致：路径输出跨平台确定，
 * Windows 的 fs 同样接受正斜杠。
 */
export function trustStorePath(): string {
  const home =
    process.env.DSH_HOME || posix.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
  return posix.join(home, 'project-mcp-trust.json')
}

/** 校验单个项目条目；结构不符返回 null，由调用方据此失败关闭。 */
function validateEntry(value: unknown): TrustEntry | null {
  if (!isPlainObject(value)) return null
  const { approvedAt, fingerprint: fp, servers } = value
  if (typeof approvedAt !== 'string') return null
  if (typeof fp !== 'string') return null
  if (!isStringArray(servers)) return null
  return { approvedAt, fingerprint: fp, servers }
}

/**
 * 读取并校验信任存储；任何异常情形都返回空存储（失败关闭，规格 §7.4）。
 *
 * 逐字段重建而不直接返回解析结果：文件内容不受信，只保留已知字段。
 */
export function readTrustStore(readFile: (p: string) => string): TrustStore {
  let raw: string
  try {
    raw = readFile(trustStorePath())
  } catch {
    return emptyStore()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyStore()
  }

  if (!isPlainObject(parsed)) return emptyStore()
  if (parsed.version !== 1) return emptyStore()
  if (!isPlainObject(parsed.projects)) return emptyStore()

  const entries: [string, TrustEntry][] = []
  for (const [projectRoot, value] of Object.entries(parsed.projects)) {
    const entry = validateEntry(value)
    if (entry === null) return emptyStore()
    entries.push([projectRoot, entry])
  }
  return { version: 1, projects: Object.fromEntries(entries) }
}

/**
 * 序列化写入信任存储。
 *
 * 写失败**不吞**：静默失败会让"已批准"成为假象。原子写与 `0600` 权限由注入的
 * `writeFile` 负责（规格 §7.1）。
 */
export function writeTrustStore(
  writeFile: (p: string, text: string) => void,
  store: TrustStore
): void {
  writeFile(trustStorePath(), JSON.stringify(store, null, 2))
}

/**
 * 该项目的当前指纹下，指定服务器是否已被批准。
 *
 * 指纹不匹配或服务器不在批准列表内都返回 false：批准列表与当前文件列表的交集由
 * 调用方在挂载时计算（规格 §7.1）。
 */
export function isApproved(
  store: TrustStore,
  projectRoot: string,
  fingerprint: string,
  serverName: string
): boolean {
  const entry: TrustEntry | undefined = store.projects[projectRoot]
  if (entry === undefined) return false
  return entry.fingerprint === fingerprint && entry.servers.includes(serverName)
}

/**
 * 批准某项目在当前指纹下的服务器列表，返回**新存储**（不改动入参）。
 *
 * `servers` 记录批准时该指纹下实际存在且被批准的服务器名（规格 §7.1）。复制传入
 * 数组：调用方后续改动自己的数组不应静默改变存储。
 */
export function approve(
  store: TrustStore,
  projectRoot: string,
  fingerprint: string,
  servers: string[],
  now: string
): TrustStore {
  return {
    version: 1,
    projects: {
      ...store.projects,
      [projectRoot]: { approvedAt: now, fingerprint, servers: [...servers] },
    },
  }
}

/** 撤销某项目的批准，返回**新存储**（不改动入参）；未知项目为空操作。 */
export function revoke(store: TrustStore, projectRoot: string): TrustStore {
  const projects = { ...store.projects }
  delete projects[projectRoot]
  return { version: 1, projects }
}
