/**
 * 工具调试控制台：调用执行器（`callId` 序列 + 进行中调用的取消表）。
 *
 * 这是本控制台**唯一真实执行工具**的模块。它与宿主 `tools.execute` 的契约
 * 逐条对齐（`packages/core/tools/src/index.ts` 的 `ToolExecutionInput`）：
 * `callId` / `name` / `arguments` / `signal` 四项必填，`agent` 可选。
 *
 * ## scope：列出与执行必须同传
 *
 * 宿主 `tools` 服务按 **scope 分层**：`schemas()` 无参只返回全局层，挂在
 * `agent.ctx` 的工具（会话级 MCP——如 Godot 接入层挂载的 `mcp-client`——注册的
 * `mcp__*` 工具正是这一类）在全局视角里不可见、也不可执行。调试台是**会话视图**，
 * 能拿到 `sessionId`，因此列出（`schemas(scope)`）与执行（`execute({ agent })`）
 * 传**同一个** scope——"树里能看到的就一定能调"这一不变量因此保持成立，只是
 * 视角从全局换成了该会话。
 *
 * 代价是：agent 作用域内的 deny 补丁**不**作用于调试台（scope 传的是 agent 本身，
 * 不是模型的 restrict 视角）。这是有意取舍——调试台的全部价值就是看见并触碰
 * 真实的工具面，绕过会话级限制由用户自己承担（它是本机回环 + 同源围栏后的
 * 手动入口，不是模型可自主触发的路径）。
 *
 * ## 安全边界
 *
 * 响应体只含**投影后的结果块**（文本 / 图片 / 不支持的块占位）与错误消息。
 * 错误消息来自 `tools.execute` 的 `error.message` 或结果文本——那是工具自己
 * 产生的文本，与模型看到的一致，因此可以回显；但 `debug-bridge.ts` 仍会把
 * **意外抛出**的异常统一降级为固定文案（只记类型名），不让底层堆栈或路径
 * 经 HTTP 泄漏。
 */

/** 工具结果的一个投影块。图片以 base64 直通（超限截断）。 */
export interface DebugOutBlock {
  type: 'text' | 'image' | 'other'
  text?: string
  mimeType?: string
  data?: string
  truncated?: boolean
  summary?: string
}

export interface DebugCallOutcome {
  callId: string
  name: string
  isError: boolean
  durationMs: number
  content: DebugOutBlock[]
  error?: string
}

/**
 * 图片 base64 上限（4 MiB 字符）。
 *
 * 超过就截断并标记 `truncated`：一张超大截图足以让浏览器渲染卡死，而调试面
 * 的价值在于"看见了什么"，不在于像素完整。截断后前端会显示提示。
 */
export const MAX_IMAGE_DATA_CHARS = 4 * 1024 * 1024

/** 同一个 `callId` 已被占用（前端重复提交 / 并发重放）。 */
export class CallIdConflictError extends Error {}

/** 宿主 `tools` 服务的最小鸭子类型（不 import `@deepseek-ai/*`，红线 1）。 */
export interface DebugToolsShape {
  /** `scope` 是查看作用域（agent 对象）；缺省 = 全局视角。 */
  schemas(scope?: unknown): Array<{ name: string; description?: string; parameters?: unknown }>
  execute(input: {
    callId: string
    name: string
    arguments: unknown
    signal: AbortSignal
    /** 执行作用域（agent 对象）；缺省 = 全局视角。必须与列出时的 scope 一致。 */
    agent?: unknown
  }): Promise<{
    isError: boolean
    value?: unknown
    content?: Array<Record<string, unknown>>
    error?: { message?: string }
  }>
}

/**
 * 从结果 `.value`（MCP 形状的 `{ content: [...] }`）投影原始内容块。
 *
 * 为什么优先读 `.value` 而不是 `.content`：`content` 是**模型面**的最终投影
 * （可能已被 post-execute 策略改写或合并成纯文本），而调试台要看的正是原始块
 * （尤其是图片——模型面往往已把它降级成占位文本）。`.value` 缺席时调用方回退
 * 到 `content` 的文本。
 */
export function projectValueBlocks(value: unknown): DebugOutBlock[] {
  const content = (value as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return []
  const blocks: DebugOutBlock[] = []
  for (const raw of content) {
    if (raw === null || typeof raw !== 'object') continue
    const block = raw as Record<string, unknown>
    if (block.type === 'text' && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'image' && typeof block.data === 'string') {
      const data = block.data
      const mimeType = typeof block.mimeType === 'string' ? block.mimeType : 'image/png'
      blocks.push(
        data.length > MAX_IMAGE_DATA_CHARS
          ? { type: 'image', mimeType, data: data.slice(0, MAX_IMAGE_DATA_CHARS), truncated: true }
          : { type: 'image', mimeType, data },
      )
      continue
    }
    blocks.push({ type: 'other', summary: `未支持块类型 ${String(block.type)}` })
  }
  return blocks
}

/** 把结果 `content`（模型面块数组）里的文本拼起来，作为错误消息/兜底文本。 */
export function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      if (block === null || typeof block !== 'object') return ''
      const record = block as Record<string, unknown>
      return record.type === 'text' ? String(record.text ?? '') : ''
    })
    .filter(part => part !== '')
    .join('\n')
}

/** 注入的时钟（测试用；生产直接给 `Date.now`）。 */
export type Clock = () => number

/**
 * 执行器：维护进行中调用的取消表。
 *
 * `callId` 由前端生成（同一次点击的重试要能取消同一次调用），因此必须做**冲突
 * 检测**：同一个 id 在途时再提交，直接拒绝而不是覆盖取消表——覆盖会让前一次
 * 调用永远取消不掉（它的 controller 已经丢了），而那次调用可能正在跑一个长任务。
 */
export class DebugExecutor {
  private sequence = 0
  private readonly active = new Map<string, AbortController>()

  constructor(private readonly now: Clock = () => Date.now()) {}

  /** 生成一个不与在途调用冲突的 `callId`（前端没给时用）。 */
  private nextCallId(): string {
    let callId: string
    do {
      callId = `tool-debug-${++this.sequence}`
    } while (this.active.has(callId))
    return callId
  }

  async call(
    tools: DebugToolsShape,
    name: string,
    args: unknown,
    clientCallId?: string,
    scope?: unknown,
  ): Promise<DebugCallOutcome> {
    let callId: string
    if (typeof clientCallId === 'string' && clientCallId !== '') {
      if (this.active.has(clientCallId)) {
        throw new CallIdConflictError(`callId 已在使用: ${clientCallId}`)
      }
      callId = clientCallId
    } else {
      callId = this.nextCallId()
    }
    const controller = new AbortController()
    this.active.set(callId, controller)
    const started = this.now()
    try {
      const result = await tools.execute({ callId, name, arguments: args, signal: controller.signal, ...scope === undefined ? {} : { agent: scope } })
      const durationMs = this.now() - started
      if (result.isError) {
        const text = contentText(result.content)
        const message = result.error?.message ?? text
        return {
          callId,
          name,
          isError: true,
          durationMs,
          content: projectValueBlocks(result.value),
          error: message !== '' ? message : '工具执行失败',
        }
      }
      const projected = projectValueBlocks(result.value)
      return {
        callId,
        name,
        isError: false,
        durationMs,
        content: projected.length > 0 ? projected : [{ type: 'text', text: contentText(result.content) }],
      }
    } finally {
      this.active.delete(callId)
    }
  }

  /** 取消在途调用；`false` 表示该 id 不在途（已结束或从未开始）。 */
  cancel(callId: string): boolean {
    const controller = this.active.get(callId)
    if (controller === undefined) return false
    controller.abort()
    return true
  }

  /** 在途调用数（诊断与测试用）。 */
  get activeCount(): number {
    return this.active.size
  }
}
