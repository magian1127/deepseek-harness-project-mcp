/**
 * 工具调试控制台：**纯函数**的视图/分组/表单投影（零 I/O，可彻底单测）。
 *
 * 这个控制台是**通用**调试面：它只看宿主全局 `tools` 服务暴露的工具面，
 * 不认识任何具体服务器（MCP、内置或第三方插件都一样）。因此这里刻意不出现
 * 任何按服务器名硬编码的分支——分组只按「命名空间前缀」这一条通用规则推导。
 *
 * 边界（为什么这些不在本文件里）：
 * - 真正执行工具调用需要 `AbortController`、`tools.execute` 与时间，放在
 *   `debug-executor.ts`（注入 I/O）；
 * - HTTP 装配与同源校验放在 `debug-bridge.ts`（真实 I/O）；
 * - 浏览器侧的渲染在 `client.js`（plain-JS bundle，不能 import 本模块）。
 */

/** 工具树的一项：只取渲染需要的三个字段（`schemas()` 的模型面投影）。 */
export interface DebugToolEntry {
  name: string
  description: string
  /** JSON Schema；缺省表示该工具没有参数面。 */
  parameters?: unknown
}

/**
 * 分组种类。
 *
 * - `mcp`：`mcp__<server>__<tool>` 形态的 MCP 工具（宿主约定，见
 *   `packages/mcp/mcp-client` 的 `mcp__<serverName>__<rawName>`）；
 * - `builtin`：内置工具（本清单是**保守白名单**，命中不了就落到 `plugin`，
 *   只是分组标题不同，不影响可调用性）；
 * - `plugin`：其余来源（第三方插件注册的工具）。
 *
 * 刻意不做「按注册者」分组：`schemas()` 不暴露注册者，猜错比不猜更糟。
 */
export type DebugGroupKind = 'mcp' | 'builtin' | 'plugin'

export interface DebugToolGroup {
  kind: DebugGroupKind
  /** 稳定 id（React key 与前端展开状态共用）。 */
  id: string
  title: string
  tools: DebugToolEntry[]
}

/**
 * 内置工具名白名单（**只影响分组标题**，不影响可见性）。
 *
 * 刻意保守：漏掉的内置工具会出现在「其他工具」组里，用户仍可搜索与调用；
 * 反过来把第三方工具误标成内置才会误导人。新增内置工具时这里可以滞后，
 * 不影响功能。
 */
const BUILTIN_NAMES = new Set([
  'read', 'write', 'edit', 'glob', 'grep', 'pwsh',
  'web_search', 'web_fetch', 'ask_user_question', 'todo_write',
  'job_list', 'job_output', 'job_kill',
  'send_message', 'skill',
  'get_goal', 'update_goal', 'create_goal',
  'subagent', 'subagent_fork', 'workflow', 'ralph',
  'present', 'read_image',
  'terminal_open', 'terminal_send', 'terminal_read', 'terminal_close',
  'terminal_list', 'terminal_signal',
  'session_search', 'session_trace', 'session_event_search',
  'session_event_read', 'session_event_trace',
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  'plugin_manager', 'plugin_market',
  'list_subagent_models',
])

/** `mcp__<server>__<tool>` 的解析结果。 */
export interface McpToolName {
  /** 服务器名（`serverName` 段，已规范化，见 `translate.ts` 的规则）。 */
  server: string
  /** 服务器内的原始工具名。 */
  tool: string
}

/**
 * 解析 `mcp__<server>__<tool>`；不是该形态返回 `undefined`。
 *
 * 为什么要求两段都非空：`mcp__x__` 或 `mcp____y` 这类畸形名不该被当成 MCP
 * 工具分组，否则会在树上出现空标题的组。解析失败一律落回 `plugin` 组。
 */
export function parseMcpToolName(name: string): McpToolName | undefined {
  if (!name.startsWith('mcp__')) return undefined
  const rest = name.slice('mcp__'.length)
  const separator = rest.indexOf('__')
  if (separator <= 0) return undefined
  const server = rest.slice(0, separator)
  const tool = rest.slice(separator + '__'.length)
  if (server === '' || tool === '') return undefined
  return { server, tool }
}

/** 按名称排序（稳定、与 locale 无关：调试面要的是可预期顺序）。 */
function byName(a: DebugToolEntry, b: DebugToolEntry): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/** 关键词过滤：名称或描述包含（大小写不敏感）。空关键词返回原数组。 */
export function filterTools(tools: DebugToolEntry[], keyword: string): DebugToolEntry[] {
  const needle = keyword.trim().toLowerCase()
  if (needle === '') return tools
  return tools.filter(
    tool => tool.name.toLowerCase().includes(needle) || tool.description.toLowerCase().includes(needle),
  )
}

/**
 * 分组：MCP 工具按服务器名归组（组标题是服务器名），内置与第三方各一组。
 *
 * 组的顺序固定为「MCP（服务器名字典序）→ 内置 → 其他工具」，这样同一个工具面
 * 每次渲染的树形完全一致（调试面最忌讳顺序抖动）。
 */
export function groupTools(tools: DebugToolEntry[]): DebugToolGroup[] {
  const mcpByServer = new Map<string, DebugToolEntry[]>()
  const builtin: DebugToolEntry[] = []
  const plugin: DebugToolEntry[] = []
  for (const tool of tools) {
    const parsed = parseMcpToolName(tool.name)
    if (parsed !== undefined) {
      const bucket = mcpByServer.get(parsed.server)
      if (bucket === undefined) mcpByServer.set(parsed.server, [tool])
      else bucket.push(tool)
      continue
    }
    if (BUILTIN_NAMES.has(tool.name)) builtin.push(tool)
    else plugin.push(tool)
  }
  const groups: DebugToolGroup[] = []
  for (const server of [...mcpByServer.keys()].sort()) {
    groups.push({
      kind: 'mcp',
      id: `mcp:${server}`,
      title: server,
      tools: mcpByServer.get(server)!.slice().sort(byName),
    })
  }
  if (builtin.length > 0) {
    groups.push({ kind: 'builtin', id: 'builtin', title: 'builtin', tools: builtin.slice().sort(byName) })
  }
  if (plugin.length > 0) {
    groups.push({ kind: 'plugin', id: 'plugin', title: 'plugin', tools: plugin.slice().sort(byName) })
  }
  return groups
}

/** 工具名 → 分组 id（前端用它实现「按组折叠」与组计数）。 */
export function groupIdOf(name: string): string {
  const parsed = parseMcpToolName(name)
  if (parsed !== undefined) return `mcp:${parsed.server}`
  return BUILTIN_NAMES.has(name) ? 'builtin' : 'plugin'
}

// ---------------------------------------------------------------------------
// 参数表单投影（JSON Schema → 控件）
// ---------------------------------------------------------------------------

export interface DebugField {
  name: string
  type: 'string' | 'number' | 'boolean' | 'enum' | 'json'
  enumValues?: string[]
  required: boolean
  description?: string
  placeholder?: string
}

/**
 * 把工具的 `parameters`（JSON Schema 顶层）投影成表单字段。
 *
 * 只处理顶层标量/枚举：嵌套对象与数组一律落到 `json` 编辑域（用原始 JSON
 * 编辑比给任意 schema 生成嵌套表单可靠得多）。schema 不是对象或没有
 * `properties` 时返回空数组——调用方据此退化为「只有原始 JSON 模式」。
 */
export function formFields(parameters: unknown): DebugField[] {
  if (parameters === null || typeof parameters !== 'object') return []
  const schema = parameters as { properties?: unknown; required?: unknown }
  const properties = schema.properties
  if (properties === null || typeof properties !== 'object') return []
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : [])
  const fields: DebugField[] = []
  for (const [name, raw] of Object.entries(properties as Record<string, unknown>)) {
    const property = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const declared = typeof property.type === 'string' ? property.type : 'object'
    const base = {
      name,
      required: required.has(name),
      description: typeof property.description === 'string' ? property.description : undefined,
    }
    if (Array.isArray(property.enum)) {
      fields.push({ ...base, type: 'enum', enumValues: property.enum.map(String) })
    } else if (declared === 'string') {
      fields.push({ ...base, type: 'string' })
    } else if (declared === 'number' || declared === 'integer') {
      fields.push({ ...base, type: 'number' })
    } else if (declared === 'boolean') {
      fields.push({ ...base, type: 'boolean' })
    } else {
      fields.push({ ...base, type: 'json', placeholder: declared === 'array' ? '[]' : '{}' })
    }
  }
  return fields
}

/**
 * 表单值 → 工具参数对象；返回收集到的错误（**不抛**，错误交给 UI 显示）。
 *
 * 语义：空字符串视为「未填」——必填项记一条错误，可选项直接省略（不发送空串）。
 * 布尔字段只在勾选时出现，避免给不需要的参数塞 `false`。
 */
export function buildArguments(
  fields: DebugField[],
  values: Record<string, string | boolean>,
): { args: Record<string, unknown>; errors: string[] } {
  const args: Record<string, unknown> = {}
  const errors: string[] = []
  for (const field of fields) {
    const raw = values[field.name]
    if (field.type === 'boolean') {
      if (raw === true) args[field.name] = true
      continue
    }
    const text = typeof raw === 'string' ? raw.trim() : ''
    if (text === '') {
      if (field.required) errors.push(`${field.name} 为必填`)
      continue
    }
    if (field.type === 'string' || field.type === 'enum') {
      args[field.name] = text
    } else if (field.type === 'number') {
      const parsed = Number(text)
      if (!Number.isFinite(parsed)) errors.push(`${field.name} 不是有效数字`)
      else args[field.name] = parsed
    } else {
      try {
        args[field.name] = JSON.parse(text)
      } catch {
        errors.push(`${field.name} 不是有效 JSON`)
      }
    }
  }
  return { args, errors }
}
