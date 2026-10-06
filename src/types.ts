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
  /**
   * 命令接受自由输入的声明（`CommandInputDescriptor`）。
   *
   * **不是可选的形式装饰**：客户端只把带参数的行路由给声明了 `input` 的命令
   * （`packages/client/ui-commands/src/client/service.ts:340-344`：`desc.input !== undefined`
   * 才 `leadingClaim`，否则 `if (!bare) return undefined` → 该行作为普通消息发给模型）。
   * 漏声明时裸命令仍可用、带参数却变成对话，症状极具误导性。
   *
   * `hint` 必须是非空字符串，否则注册时抛 `TypeError`
   * （`packages/interaction/commands/src/index.ts:193-206`）。
   */
  input?: { hint: string; attachments?: boolean }
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

/**
 * 一条 HTTP 条目的**按需拉起服务**元数据（`.mcp.json` 的 `serve` 字段）。
 *
 * 这是**本插件自己的**字段，不是 `mcp-client` 的：真实 `Config` 的 union
 * （`packages/mcp/mcp-client/src/index.ts:119-142`）里没有 `serve`，因此它必须在
 * `ctx.plugin()` 之前被剥离（`serve.ts` 的 `splitServe`）。
 *
 * 全部字段都已在翻译层展开/校验完毕：这里的 `env` 是**展开后的值**，只允许交给
 * `spawn`，绝不允许进入日志、错误或会话记录（红线 3）。
 */
export interface ServeMetadata {
  /** 可执行文件（已展开 `${VAR}`）。 */
  command: string
  /** 参数数组（已展开）。 */
  args: string[]
  /** 追加到宿主环境之上的环境变量（已展开，值敏感）。 */
  env: Record<string, string>
  /** 就绪检查 URL；`undefined` 表示无从等待（`url` 的 origin 推导失败）。 */
  health?: string
  /** 等待就绪的上限（毫秒）。 */
  readyTimeoutMs: number
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
      /**
       * 按需拉起服务的元数据；**不得**随 config 一起交给 `ctx.plugin()`。
       *
       * 为什么挂在 config 上而不是单独一条旁路：`planSessionMount` 只产出
       * `McpClientConfig[]`，`serve` 属于"这个条目怎么挂"的一部分，与它同源同行最不容易
       * 走散（分开存放会让两者在去重/撞名过滤后对不上号）。代价是每个消费点都必须
       * 记得剥离——因此剥离集中在 `splitServe`，且 `mountInto` 是唯一的调用点。
       */
      serve?: ServeMetadata
    }
