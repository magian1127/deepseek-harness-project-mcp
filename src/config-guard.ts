/**
 * 挂载前的 Config 自校验：把非法配置拦在 `ctx.plugin()` **之前**。
 *
 * 为什么必须有这一层（而不是只在日志点脱敏）：
 * `ctx.plugin()` 内部会先跑 `resolveConfig`（`vendor/cordis/src/fiber.ts:641-644`
 * 的 `_resolveConfig` → `resolveConfig(this.runtime, config)`），失败即抛
 * `ValidationError`；而 Cordis 自己在 `_reload` 的 catch 里把该异常整条记进日志
 * （`vendor/cordis/src/fiber.ts:659-663` 的 `this.ctx.logger.error(reason)`）。
 * 由于 schemastery 的 union 错误消息是
 * `` `expected ${toString()} but got ${JSON.stringify(data)}` ``
 * （`vendor/schemastery/src/index.ts:834`），那条被 Cordis 记录的消息会把**整个
 * config**——含展开后的 `env` / `headers` 凭据——写进日志。
 *
 * 插件侧的日志点改记 `errorName()` 只能堵住自己的记录点，堵不住 Cordis 那一处。
 * 唯一的根治办法是让非法 config **永远到不了** `ctx.plugin()`：本模块在挂载前用
 * 同一份 schema 先校验一次，不通过就跳过挂载并记一条不含配置内容的诊断。
 *
 * 校验接口（已按真实契约核实，非推测）：
 * schemastery 在 `Schema.prototype` 上挂了 `~standard`（`vendor/schemastery/src/index.ts:290-307`），
 * 形状为 StandardSchemaV1：
 * ```ts
 * { version: 1, vendor: 'schemastery', validate(value): { value } | { issues } }
 * ```
 * - `validate` **同步**返回（`Schema.resolve` 是同步的），但为防御仍判 thenable；
 * - 合法：`{ value: <规范化后的配置> }`（`value` 已补齐默认值，可直接交给 `plugin()`）；
 * - 非法：`{ issues: [{ message, path? }] }`，其中 `message` 就是上面那条**含全量
 *   config 的**文本，`path` 是字段路径（根级 union 错误没有 `path`）。
 * Cordis 的用法见 `vendor/cordis/src/fiber.ts:50-62`：无 `Config` 时原样返回，
 * thenable 抛 `TypeError`，`issues` 为真则抛 `ValidationError`，否则返回 `value`。
 *
 * 安全：本模块产出的 `reason` **绝不**使用 `issue.message`（那是泄密源），只用
 * `issue.path` 里的字段/变量名，并做字符集与长度收敛（红线 3）。
 */
import type { McpClientConfig } from './types.js'

/** 自校验结果：`ok` 携带可安全交给 `ctx.plugin()` 的配置，`fail` 携带安全诊断。 */
export type ConfigGuardResult =
  | { ok: true; config: McpClientConfig }
  | { ok: false; reason: string }

/** 诊断里回显的字段路径段数上限：路径只用于定位，不是内容通道。 */
const PATH_SEGMENT_LIMIT = 4

/** 单段路径允许的字符集与长度；不匹配则整条路径退化为"未提供字段路径"。 */
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/**
 * 取错误的**类型名**，绝不含消息体。
 *
 * schemastery 的 union 校验错误会把整个 config（含展开后的 `env` / `headers`
 * 凭据）拼进 `message`，因此凡是"错误对象可能携带 config"的位置都只能记类型名。
 * `String(error)` 对非 Error 抛出物可能回显构造时的入参，同样不用。
 */
export function errorName(error: unknown): string {
  if (error instanceof Error) return error.name
  return typeof error
}

/**
 * 把一个 issue 的 `path` 渲染成安全的字段路径。
 *
 * 路径段只可能是 schema 的键名（`serverName` / `command` / `env` 的键等）或数组下标，
 * 但仍按**不受信输入**处理：字符集不匹配或过长就放弃整条路径，宁少记不多记。
 * 根级 union 错误的 `path` 是 `undefined`（见 `vendor/schemastery/src/index.ts:300`），
 * 此时返回 `undefined`，调用方改用不含字段的通用摘要。
 */
function fieldPath(issue: unknown): string | undefined {
  if (issue === null || typeof issue !== 'object') return undefined
  const path: unknown = (issue as { path?: unknown }).path
  if (!Array.isArray(path) || path.length === 0) return undefined

  const parts: string[] = []
  for (const segment of path) {
    if (typeof segment === 'number') {
      parts.push(String(segment))
    } else if (typeof segment === 'string' && PATH_SEGMENT_PATTERN.test(segment)) {
      parts.push(segment)
    } else {
      // 段不可信时整条路径作废：部分路径会指向错误字段，比没有路径更糟。
      return undefined
    }
    if (parts.length >= PATH_SEGMENT_LIMIT) break
  }
  return parts.join('.')
}

/** 从一组 issue 里收集全部可安全回显的字段路径。 */
function collectFields(issues: unknown[]): Set<string> {
  const fields = new Set<string>()
  for (const issue of issues) {
    const path = fieldPath(issue)
    if (path !== undefined) fields.add(path)
  }
  return fields
}

/**
 * 用 union 的各个成员再校验一次，取带字段路径的 issue。
 *
 * 为什么需要这一步：**根级 union 错误不携带 `path`**（`vendor/schemastery/src/index.ts:300`
 * 传的是 `error.options.path`，而 union 的失败是在根上抛出的），实测真实 mcp-client 的
 * `Config` 对非法 `serverName` 只产出一条无路径的 issue。只记"未提供字段路径"对运维
 * 毫无价值——用户看不到是哪个字段不对。
 *
 * 成员校验能给出精确路径（实测：`serverName` 非法 → `path: ['serverName']`；
 * 缺 `command` → `path: ['command']`）。`list` 是 schemastery 存 union 成员的标准位置
 * （`Schema.list?: Schema[]`），非 union 或结构漂移时返回空集，调用方降级为通用摘要。
 *
 * 成员校验本身同样可能抛错或返回 thenable，一律当作"拿不到路径"，不影响主判定。
 */
function fieldsFromUnionMembers(schema: unknown, config: unknown): Set<string> {
  const members = (schema as { list?: unknown } | null | undefined)?.list
  if (!Array.isArray(members)) return new Set()

  const fields = new Set<string>()
  for (const member of members) {
    const validate = (member as { '~standard'?: { validate?: unknown } } | null | undefined)
      ?.['~standard']?.validate
    if (typeof validate !== 'function') continue
    let result: unknown
    try {
      result = (validate as (value: unknown) => unknown).call((member as any)['~standard'], config)
    } catch {
      continue
    }
    if (result === null || typeof result !== 'object') continue
    if (typeof (result as { then?: unknown }).then === 'function') continue
    const issues = (result as { issues?: unknown }).issues
    if (!Array.isArray(issues)) continue
    for (const field of collectFields(issues)) fields.add(field)
  }
  return fields
}

/**
 * 把 `issues` 收敛成一条**不含任何配置值**的摘要。
 *
 * 路径来源按可靠性排序：issue 自带的 `path` → union 成员的 `path` → 通用摘要。
 * 刻意**不**解析 `issue.message`：那段文本里嵌着 `JSON.stringify(config)`
 * （`vendor/schemastery/src/index.ts:834`），任何"从消息里截取一段"的手法都要靠格式
 * 约定来保证不越界，而格式漂移的后果是直接泄密。宁少记不多记（红线 3）。
 */
function describeIssues(schema: unknown, config: unknown, issues: unknown): string {
  if (!Array.isArray(issues) || issues.length === 0) {
    return 'schema 校验未通过（schema 未提供具体问题）'
  }
  const fields = collectFields(issues)
  if (fields.size === 0) {
    for (const field of fieldsFromUnionMembers(schema, config)) fields.add(field)
  }
  if (fields.size === 0) return 'schema 校验未通过（schema 未提供字段路径）'
  return `schema 校验未通过（字段：${[...fields].join('、')}）`
}

/**
 * 用 mcp-client 自己的 `Config` schema 校验一条待挂载配置。
 *
 * 契约与 Cordis 的 `resolveConfig`（`vendor/cordis/src/fiber.ts:50-62`）**逐条对齐**：
 * - 没有 `Config`（或没有 `~standard`）时无从校验，原样放行——对应 Cordis 的
 *   `if (!runtime.Config) return config`。真实 mcp-client 一定带 `Config`
 *   （`packages/mcp/mcp-client/src/index.ts:119` 的 `z.union([...])`），这条分支只
 *   为测试夹具与将来可能的无 schema 版本保留。
 * - 返回 thenable：Cordis 抛 `TypeError`，本层**跳过挂载**（同步挂载路径无法 await，
 *   放行等于把校验责任推回给 Cordis 的记录点）。
 * - `issues` 存在：跳过挂载，诊断只用字段路径。
 * - 否则取 `value`（已补齐默认值的规范化配置，与 Cordis 传给 `apply` 的是同一个值）。
 *
 * 本函数不抛异常：调用方在会话创建路径上（红线 4）。
 */
export function validateMountConfig(McpClient: unknown, config: McpClientConfig): ConfigGuardResult {
  const schema = (McpClient as { Config?: unknown } | null | undefined)?.Config
  const standard = (schema as { '~standard'?: unknown } | null | undefined)?.['~standard']
  const validate = (standard as { validate?: unknown } | null | undefined)?.validate
  if (typeof validate !== 'function') return { ok: true, config }

  let result: unknown
  try {
    result = (validate as (value: unknown) => unknown).call(standard, config)
  } catch (error) {
    // schemastery 的 `~standard` 只把 `ValidationError` 转成 `issues`，其余原样重抛
    // （`vendor/schemastery/src/index.ts:296-304`）。消息内容不可控，只记类型名。
    return { ok: false, reason: `校验抛错（错误类型：${errorName(error)}）` }
  }

  if (result === null || typeof result !== 'object') {
    return { ok: false, reason: 'schema 校验返回了非对象结果' }
  }
  if (typeof (result as { then?: unknown }).then === 'function') {
    return { ok: false, reason: 'schema 返回异步校验结果，本插件只支持同步校验' }
  }
  // 与 Cordis 一致：`issues` 存在（含空数组）即视为失败。
  if ((result as { issues?: unknown }).issues !== undefined) {
    return { ok: false, reason: describeIssues(schema, config, (result as { issues?: unknown }).issues) }
  }

  const value = (result as { value?: unknown }).value
  // `value ?? config`：schema 未产出规范化值（或产出 `undefined`）时退回原配置，
  // 保证不会把 `undefined` 挂进 `ctx.plugin()`。
  return { ok: true, config: (value ?? config) as McpClientConfig }
}
