/**
 * 全局 MCP 行检测（规格 §8）。
 *
 * 从 Loader 树收集所有 `@deepseek-ai/dsh-mcp-client` 行的 `config.serverName`，得到
 * "全局名单"。会话挂载决策（`session.ts`）用它做撞名保护：`.mcp.json` 里的服务器与
 * 全局名单撞名时不挂载（规格 §8.2）。
 *
 * 契约：
 * - 入参是 `unknown`：`ctx.get('loader')` 在未挂载 Loader 的 Host 上返回 `undefined`，
 *   树的内容也不受本插件控制。形状不符、`entries()` 抛错，一律返回空集，**不抛异常**
 *   ——本函数运行在会话创建路径上，抛异常会中断会话创建（规格 §12）。
 * - **必须按需调用，不缓存**（规格 §8.1）：Loader 没有覆盖"已有条目改配置"的事件
 *   （只有 `loader/entry-init` 与 `loader/partial-dispose`），缓存名单会在 HMR 改配置
 *   后失效。遍历的代价是条目数量级（几十），换来的是始终正确。
 * - 只读：不改动 Loader，也不注册监听器。
 */

/** 声明全局 MCP 服务器的 Loader 行模块说明符。 */
const MCP_CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client'

/** 非 null 的普通对象（排除数组与原始值）。与 discovery.ts / translate.ts 同判定。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 遍历一棵树（及其嵌套子树）里的条目，把全局 MCP 服务器名收进 `names`。
 *
 * `entries()` 在 **Loader 本体**上（`Loader extends EntryTree`），不在 `loader.root`
 * 上——`root` 是 `EntryGroup`，只有 create/unlink/remove/update/stop。条目形状是
 * `{ options: { name, config } }`，模块名与配置都在 `options` 下。
 *
 * **为什么要下降 `entry.subtree`**：真实 `EntryTree.entries()` 自身已递归嵌套子树
 * （`vendor/loader/src/config/tree.ts` 的 `yield* entry.subtree.entries()`），所以在
 * 真实 Loader 上这层下降是冗余的。但本函数的入参是 `unknown`，契约上不假设
 * `entries()` 一定返回摊平后的视图——只遍历一层会把嵌套子树里的全局行整个漏掉，
 * 而漏掉的后果恰恰是 §8.2 要防的静默遮蔽（同名项目服务器会遮蔽全局服务器并额外
 * spawn 一个子进程）。多走一遍的代价可忽略。
 *
 * `visited` 记录已展开过的树，保证每棵树最多展开一次：`entries()` 在真实 Loader 上
 * 已摊平子树，若不加这层去重，祖先树摊平一次、本函数再逐层下降，深度 d 的树会被
 * 展开约 2^d 次——实测深度 10 已展开 2047 次，深度 50 不再返回。加了之后展开次数
 * 与树的数量同阶（深度 1000 时 1001 次），代价是迭代产出的条目总数为 O(深度²)，
 * 而真实 profile 的嵌套深度只有个位数，可忽略。
 *
 * 去重同时挡掉环：`visited` 命中即返回，`entry.subtree` 若因异常形状指回祖先也不会
 * 无限递归——本函数运行在会话创建路径上，静默返回比抛栈溢出更可接受。
 */
function collectFrom(tree: unknown, names: Set<string>, visited: Set<unknown>): void {
  if (!isPlainObject(tree)) return
  if (visited.has(tree)) return
  visited.add(tree)

  const entries = tree.entries
  if (typeof entries !== 'function') return

  // 以 tree 为接收者调用：真实 Loader 的 entries() 是读 this.store 的生成器方法，
  // 脱开接收者会抛 TypeError。
  for (const entry of entries.call(tree) as Iterable<unknown>) {
    if (!isPlainObject(entry)) continue
    const options = entry.options
    if (isPlainObject(options) && options.name === MCP_CLIENT_MODULE) {
      const config = options.config
      const serverName = isPlainObject(config) ? config.serverName : undefined
      if (typeof serverName === 'string' && serverName !== '') names.add(serverName)
    }
    collectFrom(entry.subtree, names, visited)
  }
}

/**
 * 收集全局 `mcp-client` 行的 `serverName`（规格 §8.1）。
 *
 * 任何一步失败都降级为**空集**，而不是返回半份名单：本函数运行在会话创建路径上，
 * 抛异常会中断会话创建；而残缺名单会被调用方当成完整名单，让部分项目服务器静默
 * 遮蔽全局服务器。空集是"无法判定"的表达，调用方仍可正常挂载。
 */
export function collectGlobalServerNames(loader: unknown): Set<string> {
  const names = new Set<string>()
  try {
    collectFrom(loader, names, new Set())
  } catch {
    return new Set()
  }
  return names
}
