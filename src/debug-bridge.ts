/**
 * 工具调试控制台：`webServer` 前缀路由（**本模块是调试面的真实 HTTP I/O**）。
 *
 * ## 通道选择：`webServer` 前缀路由 + 同源 fetch
 *
 * 同仓库的 `console-bridge.ts` 用这条通道跑通"Client 触发 Host 动作"，这里沿用：
 * `webServer.register({ kind: 'prefix', path, handler })` 拿到原生
 * `IncomingMessage` / `ServerResponse`，Client 侧同源 `fetch` 即可。
 *
 * ## 认证：同源三重围栏，**刻意不用 nonce**
 *
 * 这一点与 `console-bridge.ts` **不同**，是踩过坑后的结论（2026-10-24 真机）：
 *
 * `console-bridge.ts` 依赖 `webServer.tapIndex` 把 nonce `<meta>` 注入 GUI 页面。
 * 调试台最初照抄了这套机制，结果**整个工具面拿不到任何工具**——`tapIndex` 在真实
 * 组合里没有生效（DSH 仓库内 `tapIndex` 只有测试使用者，没有任何 shipped 插件依赖
 * 它做鉴权），页面里没有那个 meta，Client 读到空串，于是每个请求都被判 403。
 *
 * 因此这里改用**与会话视图本身同级的同源围栏**，也是被迁移的 Godot 工作台原本
 * 采用的模型（`src/workbench/routes.ts` 的 `requestAllowed`）：
 *
 * 1. peer 必须是回环地址（`127/8`、`::1`、`v4-mapped`）；
 * 2. `Host` 头必须是本机 authority；
 * 3. `sec-fetch-site` 只允许 `same-origin` / `none`（跨站一律拒）；
 * 4. 浏览器带了 `Origin` 时，其 authority 必须与 `Host` 逐字相同。
 *
 * 为什么这个级别足够：调试台与它所在的会话视图**同源同权限**——能打开这个页面的人
 * 本来就能在这个页面里驱动整个 Agent 会话。nonce 并不会额外挡住谁，反而在 tapIndex
 * 失效时把唯一合法入口也挡掉了。DNS-rebinding 由 Host 白名单挡住，跨站请求由
 * `sec-fetch-site` + Origin 挡住，非浏览器本机进程则是与页面同级的信任假设。
 *
 * ## 红线
 *
 * - 响应体只含投影后的结果块与固定文案；**意外抛出**的异常一律降级为
 *   `{ ok: false, reason: <错误类型名> }`，绝不回显堆栈、路径或配置值；
 * - 路由处理器内任何异常都转成 JSON 错误，**不抛**（辅助面不得影响宿主）；
 * - 请求体上限 8 MiB（图片/大参数经原始 JSON 提交时可能较大），超限直接 413。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { DebugCallOutcome, DebugToolsShape } from './debug-executor.js'
import { CallIdConflictError, DebugExecutor } from './debug-executor.js'
import type { DebugField, DebugToolEntry } from './debug-view.js'
import { formFields, groupTools } from './debug-view.js'

/** 路由前缀。与 `/project-mcp` 分开：两者的生命周期与用途不同，便于诊断。 */
export const DEBUG_ROUTE_PREFIX = '/project-mcp/debug'

const MAX_BODY_BYTES = 8 * 1024 * 1024

/** 允许的本机 authority（Host 头主体，不含端口）。 */
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** `webServer` 服务的最小鸭子类型（只声明本模块调用的成员，红线 1）。 */
export interface DebugWebServerShape {
  register(route: {
    kind: 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void
  }): () => void
}

/** `systemPrompt` 服务的最小形状（只读：取当前装配出的 section 列表）。 */
export interface PromptSectionsShape {
  assemble(input?: unknown): Promise<{ sections?: Array<{ name: string; text: string }> }>
}

/**
 * 技能摘要（`skills.list()` 的投影）。
 *
 * 只取渲染需要的字段：技能名、描述、何时使用、来源与调用策略。`path` 刻意**不下发**——
 * 它是本机绝对路径，而调试台是 HTTP 面（红线 2 的延伸：不让机器路径经网络出去）。
 */
export interface DebugSkillSummary {
  name: string
  description: string
  whenToUse?: string
  source: string
  provider: string
  /** 模型能否调用；false 的技能只对手动使用开放。 */
  modelInvocable: boolean
  userInvocable: boolean
}

/** `skills` 服务的最小鸭子类型（只声明本控制台调用的两个方法）。 */
export interface SkillsShape {
  list(options?: unknown): Promise<
    Array<{
      name: string
      description?: string
      whenToUse?: string
      source?: string
      provider?: string
      invocation?: { modelInvocable?: boolean; userInvocable?: boolean }
    }>
  >
  get(name: string, options?: unknown): Promise<
    | {
        name: string
        description?: string
        whenToUse?: string
        source?: string
        provider?: string
        content?: string
        invocation?: { modelInvocable?: boolean; userInvocable?: boolean }
      }
    | undefined
  >
}

/** 路由背后的能力，由装配层注入。 */
export interface DebugBridgeDeps {
  /** 宿主全局 `tools` 服务；缺席时路由不装配。 */
  tools: DebugToolsShape
  /** `systemPrompt` 服务；缺席时「提示词面」返回空列表而不是报错。 */
  systemPrompt?: PromptSectionsShape | null
  /** `skills` 服务；缺席时「技能」返回空列表而不是报错。 */
  skills?: SkillsShape | null
  /**
   * 把会话 id 解析成技能作用域（agent 对象）。
   *
   * 由装配层注入（它拿得到 `agents` 服务）。返回 `undefined` 表示该会话没有活 agent，
   * 此时技能按全局视角列举——**不要**编造一个 scope，那会让 `skills` 服务去查一条
   * 不存在的层链。
   */
  skillScopeOf?: (sessionId: string) => unknown
  /** 执行器（由装配层持有，取消表跨请求共享）。 */
  executor: DebugExecutor
  /** 500 原始错误的去向（host logger；缺省静默）。 */
  warn?: (message: string) => void
}

/**
 * 从 Host 头取 authority 主体（不含端口）。
 *
 * IPv6 用方括号包裹（`[::1]:3080`），必须先按 `]` 截断再比较，否则会被当成
 * 一个奇怪的字符串而误判为"非本机"。
 */
function hostAllowed(host: string): boolean {
  const authority = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : (host.split(':')[0] ?? '')
  return ALLOWED_HOSTS.has(authority)
}

/** peer 回环判定：IPv4 `127/8`、`::1`、v4-mapped（`::ffff:127.x`）。 */
function isLoopback(remote: string): boolean {
  const address = remote.startsWith('::ffff:') ? remote.slice(7) : remote
  return address === '::1' || /^127\./.test(address)
}

/**
 * `sec-fetch-site` 第三层围栏。
 *
 * 现代浏览器对所有请求都携带该头，跨站请求即使 Origin 缺失/伪造也在此拦截。
 * 非浏览器客户端不发送该头，不受影响（合法值只有 `same-origin` 与 `none`）。
 */
function fetchSiteAllowed(req: IncomingMessage): boolean {
  const header = req.headers['sec-fetch-site']
  const value = Array.isArray(header) ? header[0] : header
  if (typeof value !== 'string' || value === '') return true
  return value === 'same-origin' || value === 'none'
}

/** 同源三重围栏（peer 回环 + Host 白名单 + sec-fetch-site + Origin）。 */
export function requestAllowed(
  req: IncomingMessage,
): { ok: true } | { ok: false; reason: string } {
  const remote = (req.socket as { remoteAddress?: unknown } | undefined)?.remoteAddress
  if (typeof remote !== 'string' || remote === '' || !isLoopback(remote)) {
    return { ok: false, reason: 'loopback-only' }
  }
  const host = req.headers.host
  if (typeof host !== 'string' || host === '' || !hostAllowed(host)) {
    return { ok: false, reason: 'loopback-only' }
  }
  if (!fetchSiteAllowed(req)) return { ok: false, reason: 'same-origin-only' }
  const origin = req.headers.origin
  // 无 Origin 是合法形态：同源 GET 与 curl 都不带，Host 围栏已经约束了目标。
  if (typeof origin !== 'string' || origin === '') return { ok: true }
  try {
    return new URL(origin).host === host ? { ok: true } : { ok: false, reason: 'same-origin-only' }
  } catch {
    return { ok: false, reason: 'same-origin-only' }
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** 只记错误类型名（不记 message：可能带路径或配置值）。 */
function errorNameOf(error: unknown): string {
  if (error === null || typeof error !== 'object') return 'Unknown'
  const name = (error as { name?: unknown }).name
  return typeof name === 'string' && name !== '' ? name : 'Error'
}

function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string | null> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        finish(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => finish(null))
  })
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 工具面投影：只保留渲染需要的字段，并把参数 schema **预先**投影成表单字段。
 *
 * 为什么在 Host 侧投影表单而不是把 `parameters` 直发浏览器：
 *
 * 1. `formFields` 是纯函数，住在 `debug-view.ts` 里已有单测覆盖；让浏览器再实现
 *    一遍同一套规则，两处一定会分叉（分叉的表现是"表单字段和真实 schema 不符"，
 *    而那正是调试台最不该骗人的地方）；
 * 2. `parameters` 是模型面 JSON Schema，可能很大且含本控制台不消费的字段
 *    （`deferLoading` 等）。逐项重建对象顺带把 `description` 缺失归一为空串，
 *    前端因此不必写三处 `?? ''`。
 *
 * 代价是原始 schema 不再下发：调试台需要看原始 JSON 时用「原始 JSON」模式自己
 * 输入参数即可——它本来就不需要回读 schema 原文。
 */
export function projectTools(schemas: Array<{ name: string; description?: string; parameters?: unknown }>): Array<
  DebugToolEntry & { fields: DebugField[] }
> {
  return schemas.map(schema => ({
    name: schema.name,
    description: schema.description ?? '',
    fields: formFields(schema.parameters),
  }))
}

/**
 * 分组投影：组只带**工具名**，工具对象在顶层 `tools` 里只有一份。
 *
 * 为什么不在组里内联工具对象：`schemas()` 里同一条 description 可能上千字符，
 * 按组内联会让它在响应体里重复出现（MCP 工具名同时出现在顶层与组里）。前端按
 * `name` 从顶层索引即可——一次线性建表，比重复传输便宜。
 */
export function projectGroups(tools: DebugToolEntry[]): Array<{ id: string; title: string; kind: string; tools: string[] }> {
  return groupTools(tools).map(group => ({
    id: group.id,
    title: group.title,
    kind: group.kind,
    tools: group.tools.map(tool => tool.name),
  }))
}

/** 读当前装配出的提示词 section（服务缺席/失败 → 空数组，不抛）。 */
async function readPromptSections(service: PromptSectionsShape | null | undefined): Promise<Array<{ name: string; text: string }>> {
  if (service === null || service === undefined || typeof service.assemble !== 'function') return []
  try {
    const assembly = await service.assemble({})
    const sections = assembly?.sections
    if (!Array.isArray(sections)) return []
    return sections.map(section => ({ name: String(section.name), text: String(section.text ?? '') }))
  } catch {
    // 提示词面是只读辅助视图：装配失败不该让调试台整体不可用。
    return []
  }
}

/**
 * 技能摘要投影。
 *
 * **刻意丢掉 `path`**：`SkillSummary.path` 是本机绝对路径（红线 2 的延伸——文档禁止写
 * 机器路径，HTTP 响应同理）。技能名 + 描述足够回答"有哪些技能、来自哪里"。
 */
export function projectSkills(
  summaries: Array<{
    name: string
    description?: string
    whenToUse?: string
    source?: string
    provider?: string
    invocation?: { modelInvocable?: boolean; userInvocable?: boolean }
  }>,
): DebugSkillSummary[] {
  return summaries.map(summary => ({
    name: summary.name,
    description: summary.description ?? '',
    ...(summary.whenToUse === undefined ? {} : { whenToUse: summary.whenToUse }),
    source: summary.source ?? '',
    provider: summary.provider ?? '',
    // 默认值对齐 `SkillInvocationPolicy` 的真实默认（两项都为 true）。
    modelInvocable: summary.invocation?.modelInvocable !== false,
    userInvocable: summary.invocation?.userInvocable !== false,
  }))
}

/**
 * 读技能目录（服务缺席/失败 → 空数组，不抛）。
 *
 * ## 为什么要 `sessionId` → `scope`
 *
 * 技能是**按 scope 分层**的（`skills` 服务：全局层 + 查看作用域的链）。只按全局视角
 * 列举会漏掉一整类技能——典型的就是 agent preset 用 `customSkillDirs` 声明的那些：
 * 它们只存在于该 preset 的作用域层里，全局视角看不到（2026-10-24 实测：Godot preset
 * 的 6 个技能在无 scope 的 `list()` 里完全不出现）。
 *
 * 调试台是会话视图，能拿到 `sessionId`，因此把它解析成 agent 当 scope 传进去，
 * 并列的就是"**这个会话实际能用哪些技能**"——那也是用户点开技能页想看的东西。
 *
 * `sessionId` 缺失或解析不到 agent 时退回全局视角（有总比没有好，且不报错）。
 */
async function readSkills(
  service: SkillsShape | null | undefined,
  scope: unknown,
): Promise<DebugSkillSummary[]> {
  if (service === null || service === undefined || typeof service.list !== 'function') return []
  try {
    return projectSkills(await service.list(scope === undefined ? {} : { scope }))
  } catch {
    // 技能目录是只读辅助视图：发现失败不该让调试台整体不可用。
    return []
  }
}

/**
 * 读一个技能的正文（`skills.get`）。`scope` 语义同 `readSkills`。
 *
 * 返回 `undefined` 表示"该技能不存在或读取失败"——路由据此回 404，让前端能区分
 * "没有这个技能"与"技能是空的"。
 */
async function readSkillBody(
  service: SkillsShape | null | undefined,
  name: string,
  scope: unknown,
): Promise<{ name: string; description: string; content: string; source: string; provider: string } | undefined> {
  if (service === null || service === undefined || typeof service.get !== 'function') return undefined
  try {
    const skill = await service.get(name, scope === undefined ? {} : { scope })
    if (skill === null || skill === undefined) return undefined
    return {
      name: skill.name,
      description: skill.description ?? '',
      content: skill.content ?? '',
      source: skill.source ?? '',
      provider: skill.provider ?? '',
    }
  } catch {
    return undefined
  }
}

/**
 * 安装调试路由；返回 disposer（随 fiber 可逆清理，父工作区 AGENTS.md 第 6 条）。
 *
 * 路由清单：
 * - `GET  /project-mcp/debug/api/tools`   —— 工具面（全量，前端本地分组/搜索）
 * - `POST /project-mcp/debug/api/call`    —— 执行一次工具调用
 * - `POST /project-mcp/debug/api/cancel`  —— 取消在途调用
 * - `GET  /project-mcp/debug/api/prompt-sections` —— 当前提示词 section
 * - `GET  /project-mcp/debug/api/skills`  —— 技能目录（摘要，不含本机路径）
 * - `GET  /project-mcp/debug/api/skill?name=<技能名> —— 单个技能的正文
 */
export function installDebugBridge(webServer: DebugWebServerShape, deps: DebugBridgeDeps): () => void {
  const unregister = webServer.register({
    kind: 'prefix',
    path: DEBUG_ROUTE_PREFIX,
    handler: (req, res) => {
      try {
        const guard = requestAllowed(req)
        if (!guard.ok) {
          sendJson(res, 403, { ok: false, reason: guard.reason })
          return
        }
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const pathname = url.pathname

        if (req.method === 'GET' && pathname === `${DEBUG_ROUTE_PREFIX}/api/tools`) {
          const tools = projectTools(deps.tools.schemas())
          sendJson(res, 200, {
            ok: true,
            tools,
            groups: projectGroups(tools),
          })
          return
        }

        if (req.method === 'GET' && pathname === `${DEBUG_ROUTE_PREFIX}/api/prompt-sections`) {
          void readPromptSections(deps.systemPrompt).then(sections => {
            sendJson(res, 200, { ok: true, sections })
          })
          return
        }

        if (req.method === 'GET' && pathname === `${DEBUG_ROUTE_PREFIX}/api/skills`) {
          const sessionId = asString(url.searchParams.get('session'))
          const scope = sessionId === undefined ? undefined : deps.skillScopeOf?.(sessionId)
          void readSkills(deps.skills, scope).then(skills => {
            sendJson(res, 200, { ok: true, skills })
          })
          return
        }

        if (req.method === 'GET' && pathname === `${DEBUG_ROUTE_PREFIX}/api/skill`) {
          const name = asString(url.searchParams.get('name'))
          if (name === undefined) {
            sendJson(res, 400, { ok: false, reason: 'missing-name' })
            return
          }
          const sessionId = asString(url.searchParams.get('session'))
          const scope = sessionId === undefined ? undefined : deps.skillScopeOf?.(sessionId)
          void readSkillBody(deps.skills, name, scope).then(skill => {
            if (skill === undefined) {
              sendJson(res, 404, { ok: false, reason: 'unknown-skill' })
              return
            }
            sendJson(res, 200, { ok: true, skill })
          })
          return
        }

        if (req.method === 'POST' && pathname === `${DEBUG_ROUTE_PREFIX}/api/call`) {
          void readBody(req).then(raw => {
            if (raw === null) {
              sendJson(res, 413, { ok: false, reason: 'body-too-large' })
              return
            }
            let parsed: unknown
            try {
              parsed = JSON.parse(raw)
            } catch {
              sendJson(res, 400, { ok: false, reason: 'bad-json' })
              return
            }
            const body = parsed as { name?: unknown; arguments?: unknown; callId?: unknown }
            const name = asString(body.name)
            if (name === undefined) {
              sendJson(res, 400, { ok: false, reason: 'missing-name' })
              return
            }
            const callId = asString(body.callId)
            // `arguments` 允许省略（等价于 `{}`），但给了就必须是 JSON 值——它已经是
            // JSON.parse 的产物，因此形状天然合法，不需要额外校验。
            void deps.executor
              .call(deps.tools, name, body.arguments ?? {}, callId)
              .then(
                (outcome: DebugCallOutcome) => sendJson(res, 200, { ok: true, outcome }),
                (error: unknown) => {
                  if (error instanceof CallIdConflictError) {
                    sendJson(res, 409, { ok: false, reason: 'callid-conflict' })
                    return
                  }
                  deps.warn?.(`[tool-debug] 工具调用失败: ${errorNameOf(error)}`)
                  sendJson(res, 500, { ok: false, reason: errorNameOf(error) })
                },
              )
          })
          return
        }

        if (req.method === 'POST' && pathname === `${DEBUG_ROUTE_PREFIX}/api/cancel`) {
          void readBody(req).then(raw => {
            if (raw === null) {
              sendJson(res, 413, { ok: false, reason: 'body-too-large' })
              return
            }
            let parsed: unknown
            try {
              parsed = JSON.parse(raw)
            } catch {
              sendJson(res, 400, { ok: false, reason: 'bad-json' })
              return
            }
            const callId = asString((parsed as { callId?: unknown }).callId)
            if (callId === undefined) {
              sendJson(res, 400, { ok: false, reason: 'missing-callid' })
              return
            }
            sendJson(res, 200, { ok: true, cancelled: deps.executor.cancel(callId) })
          })
          return
        }

        sendJson(res, 404, { ok: false, reason: 'not-found' })
      } catch (error) {
        // 路由是辅助面：任何意外都降级，绝不让它冒到宿主。
        deps.warn?.(`[tool-debug] 路由处理失败: ${errorNameOf(error)}`)
        sendJson(res, 500, { ok: false, reason: errorNameOf(error) })
      }
    },
  })

  return () => {
    unregister()
  }
}
