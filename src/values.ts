/**
 * `.mcp.json` 值的展开与形状校验：`${VAR}` 展开 + 不受信 JSON 的最小形状守卫。
 *
 * 为什么单独成模块：`translate.ts`（条目 → `McpClientConfig`）与 `serve.ts`（`serve`
 * 字段 → 拉起计划）需要**同一套**展开语义与同一套形状守卫。展开语义分叉会让"同一个
 * `${TOKEN}` 在 `env` 里能展开、在 `serve.env` 里报缺失"这类缺陷无法解释；而形状守卫
 * 分叉更危险——`asStringRecord` 用 `Object.fromEntries` 而非朴素赋值，正是为了保住
 * 键名 `__proto__`（见该函数注释），复制一份出来就迟早会有一份退化成朴素赋值。
 *
 * 纯函数、无 I/O。安全：本模块的任何返回值都可能被调用方写进诊断，因此**只回变量名、
 * 绝不回值**（红线 3）。
 */

/**
 * `${VAR}` 与 `${VAR:-default}`；变量名沿用 POSIX 形状，其余原样保留。
 *
 * 模块级 `g` 正则只喂给 `String.replace`（每次调用自行重置 `lastIndex`），
 * 不用于 `exec` / `test`，因此不跨调用残留状态。
 */
const VARIABLE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

/**
 * 展开 `${VAR}` 与 `${VAR:-default}`。
 *
 * 未定义且无默认值时返回 `{ missing: 变量名 }`——只回变量名，绝不回值：调用方
 * 会把结果写进诊断。值为空串也算"已定义"，此时优先于默认值。
 *
 * 只认 `env` 的**自有属性**（`Object.hasOwn`）：`env` 是普通对象，直接 `env[name]`
 * 会命中原型链，把 `Object.prototype` 的成员（`toString` / `constructor` / `valueOf`
 * 等）当成"已定义值"，从而把一段 JS 源码展开进 `command` / `url` / `env`，而不是
 * 按契约报告变量缺失。`.mcp.json` 是外部输入，字面写 `${toString}` 即可触发。
 *
 * 多处缺变量时只报**第一个**：诊断要短，且多变量名对排查没有增量信息。
 */
export function expandVariables(
  text: string,
  env: Record<string, string | undefined>,
): { value: string } | { missing: string } {
  let missing: string | null = null
  const value = text.replace(VARIABLE_PATTERN, (match, name: string, fallback: string | undefined) => {
    // 只认自有属性：`env[name]` 会命中原型链（见函数注释）。
    const defined = Object.hasOwn(env, name) ? env[name] : undefined
    if (defined !== undefined) return defined
    if (fallback !== undefined) return fallback
    missing ??= name
    return match
  })
  return missing === null ? { value } : { missing }
}

/** 非 null 的普通对象（排除数组与原始值）。 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 校验并复制字符串数组；形状不对返回 null。 */
export function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const items: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return null
    items.push(item)
  }
  return items
}

/**
 * 校验并复制字符串记录（`env` / `headers`）；形状不对返回 null。
 *
 * 用 `Object.fromEntries` 而不是 `record[key] = item`：键来自**不受信**的 `.mcp.json`，
 * 字面写 `"__proto__": "X"` 时，朴素赋值会命中原型 setter 而被静默丢弃（字符串值
 * 不满足 setter 的对象要求 → no-op），服务器拿到缺一个变量的环境，认证失败却没有任何
 * 诊断；而指纹把该键算在内，用户批准的内容与实际生效的内容不一致。`trust.ts` 的
 * `canonicalValue` 出于同一原因用 `fromEntries`（见该处注释与 `trust.test.mts` 的
 * `__proto__` 用例）。
 */
export function asStringRecord(value: unknown): Record<string, string> | null {
  if (!isPlainObject(value)) return null
  const pairs: [string, string][] = []
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') return null
    pairs.push([key, item])
  }
  return Object.fromEntries(pairs)
}

/**
 * 展开字符串记录（`env` / `headers`）的键与值；任一变量缺失即返回其名字。
 *
 * 展开后的**键**同样可能撞上 `__proto__`（`"${K}"` 在 `K='__proto__'` 时展开出该名字），
 * 因此落盘同样走 `Object.fromEntries`，理由与 `asStringRecord` 相同。
 */
export function expandRecord(
  record: Record<string, string>,
  env: Record<string, string | undefined>,
): { value: Record<string, string> } | { missing: string } {
  const pairs: [string, string][] = []
  for (const [key, raw] of Object.entries(record)) {
    const expandedKey = expandVariables(key, env)
    if ('missing' in expandedKey) return expandedKey
    const expandedValue = expandVariables(raw, env)
    if ('missing' in expandedValue) return expandedValue
    pairs.push([expandedKey.value, expandedValue.value])
  }
  return { value: Object.fromEntries(pairs) }
}

/** 展开字符串列表（`args`）；任一变量缺失即返回其名字。 */
export function expandList(
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
