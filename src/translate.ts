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
import { asStringArray, asStringRecord, expandList, expandRecord, expandVariables, isPlainObject } from './values.js'
import { planServeStart } from './serve.js'
import type { McpClientConfig, ServeMetadata } from './types.js'

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
 * 展开语义与形状守卫（`expandVariables` / `expandRecord` / `asStringRecord` 等）搬到了
 * `values.ts`：`serve.ts` 需要**同一套**语义，复制一份出来迟早分叉。
 *
 * 这里重新导出 `expandVariables` 是**兼容性**考虑，不是新用法：它是本模块的既有公开
 * 出口（`translate.test.mts` 直接 import 它），下游也可能在用。新代码请从 `values.js`
 * 导入，本模块保留出口只为不破坏既有调用方。
 */
export { expandVariables }

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
 * 实现见 `values.ts`（本模块重新导出以保持既有出口）。
 */

/**
 * 校验并复制字符串数组；形状不对返回 null。
 *
 * 实现见 `values.ts` 的 `asStringArray`。
 */

/** 缺失变量的统一诊断：只回变量名，不回值（规格 §10）。 */
function missingVariable(variable: string): TranslateResult {
  return { kind: 'skip', reason: `变量 ${variable} 未定义且无默认值` }
}

/** 翻译 stdio 分支：`command` 必填，`args` / `env` 可选，`cwd` 取会话工作区。 */
function translateStdio(
  entry: Record<string, unknown>,
  name: string,
  options: { cwd: string; env: Record<string, string | undefined>; diagnostics: string[] },
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
  // 展开**之后**必须复查非空：`${CMD:-}`（或 `${CMD}` 且 `CMD=''`）会展开成空串，
  // 而 `command` 的 schema 是 `z.string().required()`，**不**校验非空——空串会一路
  // 走到 `spawn('')` 才抛 "The argument 'file' cannot be empty"，只落一条日志，
  // 而 `/mcp-project` 仍把它列为已挂载。此处按 §3 的承诺跳过并给出诊断。
  if (expandedCommand.value === '') {
    return { kind: 'skip', reason: 'command 展开后为空字符串' }
  }
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

/**
 * 解析可选的 `serve` 字段（按需拉起服务的配置）。
 *
 * ## 为什么 `serve` 畸形**不**跳过整个条目
 *
 * 与 `headers` / `args` 的处理刻意不同：那两者形状不对会让**连接本身**与用户的预期
 * 不符（少一个认证头、少一个参数），继续挂载只会带来更难诊断的故障。`serve` 是纯粹的
 * **锦上添花**——它的全部作用是"服务没在跑时帮忙拉一把"。畸形时正确行为是丢掉它、
 * 记一条诊断、照常挂载：用户若已手动启好服务，一切照常工作；若没启，症状就是
 * "服务不可达"，而这条诊断正好解释了原因。反过来让整条 HTTP 条目消失，会把"辅助功能
 * 的配置写错了"升级成"这个服务器完全用不了"（规格 §7 的用例要求"跳过 serve + 仍挂载"）。
 *
 * 诊断只回**字段名**（`command` / `args` / `env` / `health` / `readyTimeoutMs`）与变量名，
 * 绝不回值——`serve.env` 同样可能含凭据（红线 3）。
 */
function translateServe(
  entry: Record<string, unknown>,
  url: string,
  env: Record<string, string | undefined>,
  diagnostics: string[],
): ServeMetadata | undefined {
  if (entry.serve === undefined) return undefined

  const plan = planServeStart({ serve: entry.serve, url, env })
  if ('skip' in plan) {
    // 只记字段名与变量名（`plan.reason` 已保证），不记值。
    diagnostics.push(`serve 配置已被忽略：${plan.reason}`)
    return undefined
  }
  // `notes` 是非致命诊断（如 `readyTimeoutMs` 非法已退回默认）：计划仍然可用，但用户
  // 必须能看到自己的配置没被采纳。
  for (const note of plan.notes) diagnostics.push(`serve 配置已被修正：${note}`)
  return {
    command: plan.command,
    args: plan.args,
    env: plan.env,
    ...(plan.health === undefined ? {} : { health: plan.health }),
    readyTimeoutMs: plan.readyTimeoutMs,
  }
}

/**
 * 翻译 http 分支：`url` 必填，`headers` 与 `serve` 可选。
 *
 * `serve` 只作为 `config.serve` 的元数据保留：它**不是** `mcp-client` 的 Config 字段
 * （`packages/mcp/mcp-client/src/index.ts:119-142` 的 union 里没有它），必须由装配层在
 * `ctx.plugin()` 之前剥离（见 `serve.ts` 的 `splitServe`）。放在这里是因为翻译层才是
 * `.mcp.json` 形状的唯一真相来源，装配层只消费已翻译的结果。
 */
function translateHttp(
  entry: Record<string, unknown>,
  name: string,
  options: { cwd: string; env: Record<string, string | undefined>; diagnostics: string[] },
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
  // 同 `translateStdio`：`${URL:-}` 会展开成空串，而 `url` 的 schema 同样只要求
  // 是字符串，空串要到连接阶段才失败，且 `/mcp-project` 会误报已挂载。
  if (expandedUrl.value === '') {
    return { kind: 'skip', reason: 'url 展开后为空字符串' }
  }
  const expandedHeaders = expandRecord(rawHeaders, options.env)
  if ('missing' in expandedHeaders) return missingVariable(expandedHeaders.missing)

  const serve = translateServe(entry, expandedUrl.value, options.env, options.diagnostics)

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
      ...(serve === undefined ? {} : { serve }),
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
 *
 * `diagnostics` 是**可选的出参**：`serve` 字段畸形时条目仍然成功（见 `translateServe`），
 * 因此它的诊断无处安放——`skip` 变体专门承载"整个条目被跳过"的原因，而这不是那种情形。
 * 由调用方（装配层）决定这些文本去哪里：会话创建路径上必须**只记日志**，否则一条配置
 * 写错就会出现在用户的会话提示里（红线 4 的降级方向）。不传则不收集，条目照常产出。
 */
export function translateServer(
  name: string,
  entry: unknown,
  options: { cwd: string; env: Record<string, string | undefined>; diagnostics?: string[] },
): TranslateResult {
  const diagnostics = options.diagnostics ?? []
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
    return translateStdio(entry, name, { ...options, diagnostics })
  }
  if (type === 'stdio') return translateStdio(entry, name, { ...options, diagnostics })
  if (type === 'http' || type === 'streamable-http') {
    return translateHttp(entry, name, { ...options, diagnostics })
  }

  return {
    kind: 'skip',
    reason: `不支持的传输类型「${type.slice(0, TYPE_ECHO_LIMIT)}」：只支持 stdio 与 streamable-http`,
  }
}
