/**
 * MCP 连接的惰性回收决策（纯函数、零 I/O）。
 *
 * 为什么需要回收：DSH 的 WebUI **没有"关闭会话"**——左侧列表点开任意会话就触发
 * `promote` → `resume` → `agent/created`，本插件随之挂上一份项目级 MCP 连接
 * （实测每个 stdio 子进程约 73 MB）。而 DSH **没有空闲回收机制**：agent 只在 owner
 * unload 时才销毁。于是"浏览几个会话"就会积累数个进程与数百 MB 内存。
 *
 * 本模块只回答一个问题：**现在该回收哪几个会话的连接**。执行（`fiber.dispose()`）、
 * 记账、重挂都在 `index.ts`，因此这里的判定可以被穷尽单测。
 *
 * ## 规则（用户明确指定，不得改动）
 *
 * 1. 上限默认 8 个连接（`DEFAULT_CONNECTION_LIMIT`，可经 `Config` 配置）。
 * 2. 超限时回收**最后活跃时间最早**的 **`status === 'idle'`** 会话。
 * 3. **若全部会话都在 `running`，忽略上限**——绝不打断正在工作的会话。
 * 4. 排序按**最后活跃时间**：最近有活动的靠后，优先回收最久没动的。
 *
 * ## 边界行为（全部有测试守护，刻意定义而不是留给实现偶然）
 *
 * | 输入 | 行为 | 理由 |
 * | --- | --- | --- |
 * | `entries.length <= limit` | `[]` | 没超限 |
 * | `limit <= 0` / 非有限数 / 非数字 | 按 **0** 处理（回收全部 idle） | 上限的算术定义；配置层的兜底在 `normalizeConnectionLimit`，见下 |
 * | `entries` 为空 | `[]` | 无候选 |
 * | 没有任何 `idle` | `[]` | 规则 3：全部在跑就忽略上限 |
 * | idle 数 < 需回收数 | 只回收全部 idle | 不碰 `running`（规则 3 的部分情形） |
 * | `lastActiveAt` 相同 | 按 `sessionId` **升序**作稳定决胜 | 结果只由输入内容决定，**不依赖数组/Map 迭代顺序** |
 * | `status` 非预期值（含 `undefined`） | 视为 `running`，永不回收 | 安全侧：判不出"空闲"就不动它 |
 * | `lastActiveAt` 非有限数 | 视为 `+∞`（最不活跃的反面：最新活跃） | 时间戳损坏时**不得**让该会话被优先回收 |
 * | 同一 `sessionId` 重复出现 | 只按**首次出现**的条目计 | 调用方按 Map 记账不会重复；重复时取确定语义 |
 *
 * ## 为什么不按"进程数"而按"会话数"
 *
 * 一个会话可能挂多个服务器（多个连接）。回收以**会话**为粒度，因为重挂也必须整会话
 * 重建——`mcp-client` 的同作用域重名守卫按 scope 对象隔离，逐服务器回收会与重挂逻辑
 * 交叉出难以推理的中间态。
 */

/**
 * 连接上限的默认值：8。
 *
 * 依据：实测每个 stdio MCP 子进程约 73 MB，8 个约 0.6 GB——在"浏览会话不积累数百 MB"
 * 与"常用会话的工具不必反复重挂"之间取平衡。经 `Config.connectionLimit` 可配置。
 */
export const DEFAULT_CONNECTION_LIMIT = 8

/** 参与回收判定的一条会话记录。 */
export interface ReclaimEntry {
  /** 会话 id（`agent.id`，即 `SessionId`）。 */
  sessionId: string
  /** 最后活跃时间（毫秒时间戳）；越大越近。 */
  lastActiveAt: number
  /** 该会话当前是否空闲。只有 `'idle'` 可被回收。 */
  status: 'idle' | 'running'
}

/**
 * 把配置值归一为可用上限。
 *
 * 与 `selectReclaimTargets` 分开：本函数负责"配置不可信"的兜底（缺失、`null`、
 * 字符串、`NaN`、负数都退回默认值），而 `selectReclaimTargets` 的 `limit <= 0`
 * 是**显式的"上限为 0"**语义。两者混在一起会让"配置写错"与"故意设成 0"无法区分。
 */
export function normalizeConnectionLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CONNECTION_LIMIT
  return Math.max(0, Math.floor(value))
}

/**
 * 选出要回收的会话 id，按回收顺序（最久未活跃的在前）返回。
 *
 * 纯函数：不读时间、不碰 ctx、不改入参（`entries` 只读，内部排序的是副本）。
 */
export function selectReclaimTargets(
  entries: readonly ReclaimEntry[],
  options: { limit: number },
): string[] {
  const rawLimit: unknown = options?.limit
  const limit =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? Math.max(0, Math.floor(rawLimit)) : 0

  // 先归一候选：按 `sessionId` 去重（首次出现者胜），并丢掉无法定位的条目（id 不是
  // 非空字符串）。**必须在算 `excess` 之前**——上限限制的是"连接数"，即会话数，
  // 因此重复条目与非法条目都不得让候选数虚高（否则同一个会话会被选两次，或凭一个
  // 无 id 的脏条目回收掉一个合法会话）。
  const firstById = new Map<string, ReclaimEntry>()
  for (const entry of entries) {
    if (entry === null || entry === undefined) continue
    const id: unknown = entry.sessionId
    if (typeof id !== 'string' || id === '') continue
    if (!firstById.has(id)) firstById.set(id, entry)
  }

  // 需回收数。上限为 0 时等于全部候选，负数同样按 0 处理。
  const excess = firstById.size - limit
  if (excess <= 0) return []

  // 只有 `idle` 可回收；非预期值（含 `undefined`、`null`）一律视为 `running`。
  const idle = [...firstById.values()].filter(entry => entry.status === 'idle')
  if (idle.length === 0) return []

  idle.sort(compareByLastActive)
  return idle.slice(0, excess).map(entry => entry.sessionId)
}

/**
 * 回收优先级：`lastActiveAt` 升序（最久没动的在前），相同则按 `sessionId` 升序。
 *
 * 决胜规则必须是**全序**：只比时间戳时结果取决于 `Array.prototype.sort` 的稳定性与
 * 入参顺序，而"哪几个会话被回收"会因此在不同会话数下抖动——那会让用户看到随机消失
 * 的工具。`sessionId` 是稳定字符串，用它决胜后结果只由输入内容决定。
 *
 * `lastActiveAt` 非有限数时视为 `+∞`：时间戳损坏的会话排到最后（最不可能被回收），
 * 方向是安全侧——宁可留着连接，也不能因为记账损坏而回收一个可能正在工作的会话。
 */
function compareByLastActive(a: ReclaimEntry, b: ReclaimEntry): number {
  const left = Number.isFinite(a.lastActiveAt) ? a.lastActiveAt : Number.POSITIVE_INFINITY
  const right = Number.isFinite(b.lastActiveAt) ? b.lastActiveAt : Number.POSITIVE_INFINITY
  // 两侧同为 `+∞` 时 `left - right` 是 NaN，因此必须先判不等。
  if (left !== right) return left - right
  if (a.sessionId === b.sessionId) return 0
  return a.sessionId < b.sessionId ? -1 : 1
}
