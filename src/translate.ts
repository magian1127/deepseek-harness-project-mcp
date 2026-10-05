/**
 * `.mcp.json` 条目翻译与 serverName 规范化（规格 §6）。
 *
 * 纯函数、无 I/O：文件读取与解析在 `discovery.ts`，本模块只把单个 `mcpServers`
 * 条目翻译成 `@deepseek-ai/dsh-mcp-client` 的 Config。
 *
 * 安全：`reason` 诊断只描述"哪里不对"与**变量名**，绝不包含展开后的值——
 * `.mcp.json` 可能含凭据（规格 §10）。
 */
import { createHash } from 'node:crypto'
import type { McpClientConfig } from './types.js'

/** 翻译结果：`ok` 携带可直接传给 `ctx.plugin()` 的配置，`skip` 携带可读原因。 */
export type TranslateResult =
  | { kind: 'ok'; serverName: string; config: McpClientConfig }
  | { kind: 'skip'; reason: string }

/** `@deepseek-ai/dsh-mcp-client` 对 `Config.serverName` 的硬约束。 */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** 规范化时 slug 部分的长度上限，为 `_` 与 8 位哈希留出余量（规格 §6.2）。 */
const SLUG_LIMIT = 20

/** 诊断里回显的类型名上限：文件不可信，不把超长内容带进日志与会话记录。 */
const TYPE_ECHO_LIMIT = 32

/**
 * `${VAR}` 与 `${VAR:-default}`；变量名沿用 POSIX 形状，其余原样保留。
 *
 * 模块级 `g` 正则只喂给 `String.replace`（每次调用自行重置 `lastIndex`），
 * 不用于 `exec` / `test`，因此不跨调用残留状态。
 */
const VARIABLE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

/**
 * 把 `.mcp.json` 的键规范成合法的 `serverName`。
 *
 * 已合法则原样返回（既有工具名不变）；否则 NFKD 规范化 → 非法字符转 `_` →
 * 去首尾 `_` → 截断 20 字符 → 追加 `_` + 哈希前 8 位。
 *
 * 哈希取**原始 `name`** 而不是 slug：否则 `a b` 与 `a  b` 会得到同一结果，
 * 两个服务器会在同一 scope 内撞名。同一输入始终得到同一结果，工具名稳定。
 */
export function normalizeServerName(name: string): string {
  if (SERVER_NAME_PATTERN.test(name)) return name
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, SLUG_LIMIT)
  const slug = cleaned === '' ? 'server' : cleaned
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 8)
  return `${slug}_${digest}`.slice(0, 32)
}

/**
 * 展开 `${VAR}` 与 `${VAR:-default}`。
 *
 * 未定义且无默认值时返回 `{ missing: 变量名 }`——只回变量名，绝不回值：调用方
 * 会把结果写进诊断。值为空串也算"已定义"，此时优先于默认值。
 *
 * 多处缺变量时只报**第一个**：诊断要短，且多变量名对排查没有增量信息。
 */
export function expandVariables(
  text: string,
  env: Record<string, string | undefined>,
): { value: string } | { missing: string } {
  let missing: string | null = null
  const value = text.replace(VARIABLE_PATTERN, (match, name: string, fallback: string | undefined) => {
    const defined = env[name]
    if (defined !== undefined) return defined
    if (fallback !== undefined) return fallback
    missing ??= name
    return match
  })
  return missing === null ? { value } : { missing }
}

/** 非 null 的普通对象（排除数组与原始值）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 校验并复制字符串数组；形状不对返回 null。 */
function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const items: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return null
    items.push(item)
  }
  return items
}

/** 校验并复制字符串记录（`env` / `headers`）；形状不对返回 null。 */
function asStringRecord(value: unknown): Record<string, string> | null {
  if (!isPlainObject(value)) return null
  const record: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') return null
    record[key] = item
  }
  return record
}

/** 展开字符串记录（`env` / `headers`）的键与值；任一变量缺失即返回其名字。 */
function expandRecord(
  record: Record<string, string>,
  env: Record<string, string | undefined>,
): { value: Record<string, string> } | { missing: string } {
  const expanded: Record<string, string> = {}
  for (const [key, raw] of Object.entries(record)) {
    const expandedKey = expandVariables(key, env)
    if ('missing' in expandedKey) return expandedKey
    const expandedValue = expandVariables(raw, env)
    if ('missing' in expandedValue) return expandedValue
    expanded[expandedKey.value] = expandedValue.value
  }
  return { value: expanded }
}

/** 展开字符串列表（`args`）；任一变量缺失即返回其名字。 */
function expandList(
  items: string[],
  env: Record<string, string | undefined>,
): { value: string[] } | { missing: string } {
  const expanded: string[] = []
  for (const item of items) {
    const result = expandVariables(item, env)
    if ('missing' in result) return result
    expanded.push(result.value)
  }
  return { value: expanded }
}

/** 缺失变量的统一诊断：只回变量名，不回值（规格 §10）。 */
function missingVariable(variable: string): TranslateResult {
  return { kind: 'skip', reason: `变量 ${variable} 未定义且无默认值` }
}

/** 翻译 stdio 分支：`command` 必填，`args` / `env` 可选，`cwd` 取会话工作区。 */
function translateStdio(
  entry: Record<string, unknown>,
  name: string,
  options: { cwd: string; env: Record<string, string | undefined> },
): TranslateResult {
  const command = entry.command
  if (typeof command !== 'string' || command === '') {
    return { kind: 'skip', reason: 'stdio 条目缺少非空的 command' }
  }

  let rawArgs: string[] = []
  if (entry.args !== undefined) {
    const parsed = asStringArray(entry.args)
    if (parsed === null) return { kind: 'skip', reason: 'args 必须是字符串数组' }
    rawArgs = parsed
  }

  let rawEnv: Record<string, string> = {}
  if (entry.env !== undefined) {
    const parsed = asStringRecord(entry.env)
    if (parsed === null) return { kind: 'skip', reason: 'env 必须是字符串到字符串的对象' }
    rawEnv = parsed
  }

  const expandedCommand = expandVariables(command, options.env)
  if ('missing' in expandedCommand) return missingVariable(expandedCommand.missing)
  const expandedArgs = expandList(rawArgs, options.env)
  if ('missing' in expandedArgs) return missingVariable(expandedArgs.missing)
  const expandedEnv = expandRecord(rawEnv, options.env)
  if ('missing' in expandedEnv) return missingVariable(expandedEnv.missing)

  const serverName = normalizeServerName(name)
  return {
    kind: 'ok',
    serverName,
    config: {
      transport: 'stdio',
      serverName,
      command: expandedCommand.value,
      args: expandedArgs.value,
      env: expandedEnv.value,
      cwd: options.cwd,
      failOnStartupError: false,
    },
  }
}

/** 翻译 http 分支：`url` 必填，`headers` 可选。 */
function translateHttp(
  entry: Record<string, unknown>,
  name: string,
  options: { cwd: string; env: Record<string, string | undefined> },
): TranslateResult {
  const url = entry.url
  if (typeof url !== 'string' || url === '') {
    return { kind: 'skip', reason: 'http 条目缺少非空的 url' }
  }

  let rawHeaders: Record<string, string> = {}
  if (entry.headers !== undefined) {
    const parsed = asStringRecord(entry.headers)
    if (parsed === null) return { kind: 'skip', reason: 'headers 必须是字符串到字符串的对象' }
    rawHeaders = parsed
  }

  const expandedUrl = expandVariables(url, options.env)
  if ('missing' in expandedUrl) return missingVariable(expandedUrl.missing)
  const expandedHeaders = expandRecord(rawHeaders, options.env)
  if ('missing' in expandedHeaders) return missingVariable(expandedHeaders.missing)

  const serverName = normalizeServerName(name)
  return {
    kind: 'ok',
    serverName,
    config: {
      transport: 'streamable-http',
      serverName,
      url: expandedUrl.value,
      headers: expandedHeaders.value,
      failOnStartupError: false,
    },
  }
}

/**
 * 翻译单个 `.mcp.json` 服务器条目（规格 §6）。
 *
 * 传输判定：`type` 为 `stdio`（或缺省）走 stdio；`http` / `streamable-http` 走
 * HTTP；其余（`sse` / `ws` / `sdk` / 非字符串）跳过并说明。**无 `type` 却带
 * `url`** 的条目也跳过：它会被当成 stdio 处理，因缺 `command` 而失败，且失败
 * 原因难以理解。
 *
 * `failOnStartupError` 恒为 `false`：坏服务器只记日志，不影响会话创建
 * （规格 §5.1，与 ACP 相反）。
 */
export function translateServer(
  name: string,
  entry: unknown,
  options: { cwd: string; env: Record<string, string | undefined> },
): TranslateResult {
  if (!isPlainObject(entry)) return { kind: 'skip', reason: '条目必须是 JSON 对象' }

  const rawType = entry.type
  if (rawType !== undefined && typeof rawType !== 'string') {
    return { kind: 'skip', reason: 'type 必须是字符串' }
  }
  const type = typeof rawType === 'string' ? rawType : undefined

  if (type === undefined) {
    if (entry.url !== undefined) {
      return { kind: 'skip', reason: '条目含 url 但没有 type：无法判断传输类型' }
    }
    return translateStdio(entry, name, options)
  }
  if (type === 'stdio') return translateStdio(entry, name, options)
  if (type === 'http' || type === 'streamable-http') return translateHttp(entry, name, options)

  return {
    kind: 'skip',
    reason: `不支持的传输类型「${type.slice(0, TYPE_ECHO_LIMIT)}」：只支持 stdio 与 streamable-http`,
  }
}
