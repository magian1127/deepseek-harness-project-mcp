/**
 * 宿主服务的最小鸭子类型。
 *
 * 刻意不 import 任何 @deepseek-ai 包：bundle 加载时 link 包运行在宿主自己的
 * Node 进程里，@deepseek-ai 运行时类不保证对工作区包可见（同
 * deepseek-harness-zhipu_plan_tools/src/types.ts 的取舍，规格 §4.2）。
 * 这里只声明本插件实际调用的成员，多一个都不加。
 */

/** Cordis disposer：注销注册项（本插件只使用同步返回的 () => void）。 */
export type Disposer = () => void

/** 宿主日志服务的最小子集；真实 `ctx.logger` 满足它，测试夹具可以不给。 */
export interface LoggerShape {
  warn?(message: string): void
  error?(message: string): void
}

/** 本插件用到的宿主上下文：只用 get / on / effect 三个成员（外加可选 logger）。 */
export interface HostContext {
  get(name: string): any
  on(event: string, listener: (...args: any[]) => void): () => void
  effect(dispose: () => void | (() => void), label?: string): () => void
  /** 真实 Cordis 上下文的日志服务。可选：测试夹具与最小宿主可以没有。 */
  logger?: LoggerShape
}

/**
 * `ctx.plugin()` 返回的 fiber：可等待（启动失败时拒绝），也可 dispose。
 *
 * 真实 Cordis 的 `Fiber` 同时是 `PromiseLike<Fiber>`，这里只声明本插件用到的两个能力。
 */
export interface PluginFiberShape extends PromiseLike<unknown> {
  dispose(): Promise<void>
}

/**
 * 会话 agent 的上下文：宿主上下文 + 挂载子插件的能力。
 *
 * 与 `HostContext` 分开是因为挂载只发生在 agent scope 上（`agent.ctx.plugin(...)`），
 * 而全局 `apply` 拿到的宿主上下文不需要 `plugin`。
 */
export interface AgentContext extends HostContext {
  plugin(plugin: unknown, config?: unknown): PluginFiberShape
}

/** commands 服务：斜杠命令注册。 */
export interface CommandsService {
  register(definition: CommandDefinitionShape): Disposer
}

export interface CommandDefinitionShape {
  name: string
  description: string
  handler: (invocation: { agent?: AgentShape; rawInput?: string }) => unknown
}

/**
 * systemPrompt 服务：系统提示段注册。
 *
 * `order` 是**必填**且必须是有限数：真实实现在缺失或非有限时会抛 `TypeError`
 * （`packages/core/system-prompt/src/index.ts` 的 `PromptSection`），声明成可选会让
 * 调用方写出运行期才炸的代码。
 *
 * `interpolate: false` 关掉默认的严格 `{{变量}}` 插值：默认插值在渲染期遇到未知引用
 * 会**抛错**，而本插件的文本含用户路径，任何字面 `{{` 都会让整个会话的提示渲染失败。
 */
export interface SystemPromptService {
  section(section: {
    name: string
    order: number
    text: string | ((context: unknown) => string)
    interpolate?: boolean
  }): Disposer
}

/**
 * loader 服务：只读遍历 Loader 图，用于收集全局 MCP 行的 serverName。
 *
 * `entries()` 在 Loader 本体上（vendor/loader 的 `Loader extends EntryTree`，
 * 递归产出含子树条目），**不在 `loader.root` 上**——`root` 是 `EntryGroup`，
 * 只有 create/update/remove，没有 `entries`。
 * 每个条目是 `{ options: { id, name, config } }`，模块名与配置在 `options` 下。
 */
export interface LoaderService {
  entries(): Iterable<unknown>
}

/** 会话 agent 的最小形状：定位工作区、取 session header、挂载 MCP 都够用。 */
export interface AgentShape {
  id: unknown
  ctx: AgentContext
  session: { header: { cwd?: string; parentSession?: unknown; origin?: string } }
}

/** `@deepseek-ai/dsh-mcp-client` 的 Config 形状（挂载时逐字传给 ctx.plugin）。 */
export type McpClientConfig =
  | {
      transport: 'stdio'
      serverName: string
      command: string
      args: string[]
      env: Record<string, string>
      cwd: string
      failOnStartupError: boolean
    }
  | {
      transport: 'streamable-http'
      serverName: string
      url: string
      headers: Record<string, string>
      failOnStartupError: boolean
    }
