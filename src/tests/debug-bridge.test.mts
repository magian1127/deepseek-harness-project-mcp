/**
 * `debug-bridge.ts` 的路由契约：同源围栏、方法/路径分派、投影形状、错误降级。
 *
 * 断言的重点是**安全边界**而不是实现细节：
 * - 非回环 peer / 非本机 Host / 跨站请求一律 403（这是唯一的认证手段）；
 * - 浏览器同源请求**必须**放行（2026-10-24 真机：照抄 nonce 方案导致全部 403，
 *   工具面永远是 0；这里钉住"不带 nonce 的同源请求可用"这条回归）；
 * - 未知路径 404、方法不符 404（前缀路由内自己分派）；
 * - 意外抛出降级为 `{ ok: false, reason: <错误类型名> }`，**不**回显 message。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { DEBUG_ROUTE_PREFIX, installDebugBridge, projectGroups, projectSkills, projectTools, requestAllowed } from '../debug-bridge.js'
import type { DebugWebServerShape, PromptSectionsShape, SkillsShape } from '../debug-bridge.js'
import { DebugExecutor } from '../debug-executor.js'
import type { DebugToolsShape } from '../debug-executor.js'

interface Captured {
  path: string
  handler: (req: unknown, res: unknown) => void
}

function fakeWebServer(): { captured: Captured[]; webServer: DebugWebServerShape; unregistered: () => number } {
  const captured: Captured[] = []
  let disposed = 0
  const webServer: DebugWebServerShape = {
    register: route => {
      captured.push({ path: route.path, handler: route.handler as Captured['handler'] })
      return () => {
        disposed += 1
      }
    },
  }
  return { captured, webServer, unregistered: () => disposed }
}

/** 伪造一次请求：`EventEmitter` 提供 `on('data'|'end'|'error')`。 */
function fakeRequest(
  method: string,
  url: string,
  options: {
    body?: string
    /** peer 地址；默认回环。传非回环值可测围栏。 */
    remoteAddress?: string
    /** Host 头；默认本机 authority。传 `null` 表示不带该头。 */
    host?: string | null
    /** Origin 头；`undefined` 表示不带（同源 GET 的合法形态）。 */
    origin?: string
    /** sec-fetch-site 头；`undefined` 表示不带（非浏览器客户端）。 */
    fetchSite?: string
  } = {},
) {
  const emitter = new EventEmitter() as EventEmitter & {
    method: string
    url: string
    headers: Record<string, string>
    socket: { remoteAddress: string }
    destroy(): void
  }
  emitter.method = method
  emitter.url = url
  const host = 'host' in options ? options.host : '127.0.0.1:3080'
  emitter.headers = {
    ...(host === null ? {} : { host }),
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    ...(options.fetchSite === undefined ? {} : { 'sec-fetch-site': options.fetchSite }),
  }
  emitter.socket = { remoteAddress: options.remoteAddress ?? '127.0.0.1' }
  emitter.destroy = () => {}
  // 同步触发：处理器在同一个 tick 内注册监听器后立即拿到数据。
  setImmediate(() => {
    if (options.body !== undefined) emitter.emit('data', Buffer.from(options.body))
    emitter.emit('end')
  })
  return emitter
}

function fakeResponse() {
  let settle: () => void = () => {}
  const done = new Promise<void>(resolve => {
    settle = resolve
  })
  const response = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    done,
    writeHead(status: number, headers?: Record<string, string>) {
      response.statusCode = status
      if (headers !== undefined) response.headers = headers
      return response
    },
    end(payload?: string) {
      response.body = payload ?? ''
      settle()
    },
  }
  return response
}

function fakeTools(overrides: Partial<DebugToolsShape> = {}): DebugToolsShape {
  return {
    schemas: () => [],
    execute: async () => ({ isError: false, value: { content: [{ type: 'text', text: 'ok' }] } }),
    ...overrides,
  }
}

/** 装好路由并返回 `call(method, url, options)`：一次请求 → 解析后的 JSON。 */
function harness(deps: {
  tools?: DebugToolsShape
  systemPrompt?: PromptSectionsShape | null
  skills?: SkillsShape | null
  skillScopeOf?: (sessionId: string) => unknown
  executor?: DebugExecutor
  warn?: (message: string) => void
}) {
  const { captured, webServer, unregistered } = fakeWebServer()
  const executor = deps.executor ?? new DebugExecutor(() => 0)
  const dispose = installDebugBridge(webServer, {
    tools: deps.tools ?? fakeTools(),
    systemPrompt: deps.systemPrompt,
    skills: deps.skills,
    skillScopeOf: deps.skillScopeOf,
    executor,
    ...(deps.warn === undefined ? {} : { warn: deps.warn }),
  })
  assert.equal(captured.length, 1, '前缀路由只注册一条')
  const handler = captured[0]!.handler

  async function call(
    method: string,
    path: string,
    options: Parameters<typeof fakeRequest>[2] = {},
  ): Promise<{ status: number; body: any }> {
    const req = fakeRequest(method, DEBUG_ROUTE_PREFIX + path, options)
    const res = fakeResponse()
    handler(req, res)
    // 等响应真正 end：处理器内部有 promise 链（含被 hold 的调用），固定轮询会误判。
    await res.done
    return { status: res.statusCode, body: res.body === '' ? null : JSON.parse(res.body) }
  }

  return { call, captured, dispose, unregistered, executor, path: captured[0]!.path }
}

test('路由前缀是 /project-mcp/debug（与 MCP 控制台分开，便于诊断）', () => {
  const { path } = harness({})
  assert.equal(path, '/project-mcp/debug')
  assert.equal(DEBUG_ROUTE_PREFIX, '/project-mcp/debug')
})

test('认证：同源围栏放行浏览器同源请求（不带 nonce 也放行——这是真机修复点）', async () => {
  const { call } = harness({})
  // 浏览器同源 GET：带 Host + sec-fetch-site=same-origin，无 Origin。
  const allowed = await call('GET', '/api/tools', { fetchSite: 'same-origin' })
  assert.equal(allowed.status, 200, '同源请求必须放行，否则调试台永远拿不到工具面')
  // 地址栏直达：sec-fetch-site=none 同样合法。
  assert.equal((await call('GET', '/api/tools', { fetchSite: 'none' })).status, 200)
  // 同源 fetch 带 Origin 时，Origin 与 Host 一致即通过。
  assert.equal((await call('GET', '/api/tools', { origin: 'http://127.0.0.1:3080' })).status, 200)
  // 非浏览器客户端（无 sec-fetch-site、无 Origin）：Host 围栏已约束目标，放行。
  assert.equal((await call('GET', '/api/tools')).status, 200)
  // localhost 也是本机 authority。
  assert.equal((await call('GET', '/api/tools', { host: 'localhost:3080' })).status, 200)
  // IPv6 回环带方括号与端口。
  assert.equal(
    (await call('GET', '/api/tools', { host: '[::1]:3080', remoteAddress: '::1' })).status,
    200,
  )
})

test('认证：非回环 peer / 非本机 Host / 跨站一律 403，且不触发任何能力', async () => {
  let executed = 0
  const { call } = harness({
    tools: fakeTools({
      execute: async () => {
        executed += 1
        return { isError: false, value: { content: [] } }
      },
    }),
  })
  // 非回环 peer（外部地址连进来）。
  assert.equal((await call('GET', '/api/tools', { remoteAddress: '10.0.0.5' })).status, 403)
  // 非本机 Host（DNS rebinding）。
  assert.equal((await call('GET', '/api/tools', { host: 'evil.example.com' })).status, 403)
  // 缺 Host 头。
  assert.equal((await call('GET', '/api/tools', { host: null })).status, 403)
  // 跨站 sec-fetch-site。
  assert.equal((await call('GET', '/api/tools', { fetchSite: 'cross-site' })).status, 403)
  // Origin 与 Host 不一致。
  assert.equal((await call('GET', '/api/tools', { origin: 'http://evil.example.com' })).status, 403)
  // 畸形 Origin。
  assert.equal((await call('GET', '/api/tools', { origin: 'not a url' })).status, 403)
  // 拒绝理由都要能区分"仅回环"与"仅同源"，便于诊断。
  assert.equal((await call('GET', '/api/tools', { remoteAddress: '10.0.0.5' })).body.reason, 'loopback-only')
  assert.equal((await call('GET', '/api/tools', { fetchSite: 'cross-site' })).body.reason, 'same-origin-only')

  // 被拒的请求绝不能真的执行工具。
  assert.equal((await call('POST', '/api/call', { remoteAddress: '10.0.0.5', body: JSON.stringify({ name: 'x' }) })).status, 403)
  assert.equal(executed, 0, '未通过围栏的请求绝不能真的执行工具')
})

test('GET /api/tools：投影工具面并附分组（组只带名字）', async () => {
  const { call } = harness({
    tools: fakeTools({
      schemas: () => [
        { name: 'mcp__srv__shot', description: '截图', parameters: { properties: { path: { type: 'string' } } } },
        { name: 'read' },
        { name: 'third_party_tool', description: 'x' },
      ],
    }),
  })
  const { status, body } = await call('GET', '/api/tools')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.deepEqual(body.tools.map((tool: any) => tool.name), ['mcp__srv__shot', 'read', 'third_party_tool'])
  // 表单字段由 Host 投影；description 缺失归一为空串。
  const shot = body.tools[0]
  assert.deepEqual(shot.fields.map((field: any) => [field.name, field.type]), [['path', 'string']])
  assert.equal(body.tools[1].description, '')
  assert.deepEqual(body.tools[1].fields, [])
  // 分组：MCP 服务器名 → 内置 → 其他；组里只有工具名。
  assert.deepEqual(body.groups.map((group: any) => [group.id, group.title, group.kind]), [
    ['mcp:srv', 'srv', 'mcp'],
    ['builtin', 'builtin', 'builtin'],
    ['plugin', 'plugin', 'plugin'],
  ])
  assert.deepEqual(body.groups[0].tools, ['mcp__srv__shot'])
})

test('GET /api/prompt-sections：正常返回 section；服务缺席/失败返回空数组（不报错）', async () => {
  const withService = harness({
    systemPrompt: {
      assemble: async () => ({ sections: [{ name: 'a', text: 'A' }, { name: 'b', text: 1 as unknown as string }] }),
    },
  })
  const ok = await withService.call('GET', '/api/prompt-sections')
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.body.sections, [{ name: 'a', text: 'A' }, { name: 'b', text: '1' }])

  // 服务缺席：空数组而不是 500（提示词面是只读辅助视图）。
  assert.deepEqual((await harness({}).call('GET', '/api/prompt-sections')).body.sections, [])

  // 服务抛错：同样降级为空数组。
  const failing = harness({ systemPrompt: { assemble: async () => { throw new Error('nope') } } })
  assert.deepEqual((await failing.call('GET', '/api/prompt-sections')).body.sections, [])

  // assemble 返回畸形形状：空数组。
  const malformed = harness({ systemPrompt: { assemble: async () => ({ sections: 'nope' as unknown as never }) } })
  assert.deepEqual((await malformed.call('GET', '/api/prompt-sections')).body.sections, [])
})

test('POST /api/call：成功返回 outcome；缺少 name 是 400；坏 JSON 是 400', async () => {
  const { call } = harness({})
  const ok = await call('POST', '/api/call', { body: JSON.stringify({ name: 'read', arguments: { a: 1 } }) })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.ok, true)
  assert.equal(ok.body.outcome.name, 'read')
  assert.deepEqual(ok.body.outcome.content, [{ type: 'text', text: 'ok' }])

  assert.equal((await call('POST', '/api/call', { body: JSON.stringify({}) })).status, 400)
  assert.equal((await call('POST', '/api/call', { body: JSON.stringify({ name: '' }) })).status, 400)
  assert.equal((await call('POST', '/api/call', { body: '{oops' })).status, 400)
  assert.equal((await call('POST', '/api/call', { body: JSON.stringify({ name: 'x' }) })).status, 200, 'arguments 可省略')
})

test('POST /api/call：callId 冲突返回 409', async () => {
  let release: (() => void) | undefined
  const hold = new Promise<void>(resolve => {
    release = resolve
  })
  const { call } = harness({
    tools: fakeTools({
      execute: async () => {
        await hold
        return { isError: false, value: { content: [] } }
      },
    }),
  })
  const first = call('POST', '/api/call', { body: JSON.stringify({ name: 'a', callId: 'dup' }) })
  await new Promise<void>(resolve => setImmediate(resolve))
  const second = await call('POST', '/api/call', { body: JSON.stringify({ name: 'b', callId: 'dup' }) })
  assert.equal(second.status, 409)
  assert.equal(second.body.reason, 'callid-conflict')
  release!()
  assert.equal((await first).status, 200)
})

test('POST /api/call：执行器抛错降级为 500 + 错误类型名（不回显 message）', async () => {
  const warnings: string[] = []
  const { call } = harness({
    tools: fakeTools({
      execute: async () => {
        const error = new Error('secret path C:/private/x')
        error.name = 'HostExploded'
        throw error
      },
    }),
    warn: message => warnings.push(message),
  })
  const { status, body } = await call('POST', '/api/call', { body: JSON.stringify({ name: 'a' }) })
  assert.equal(status, 500)
  assert.deepEqual(body, { ok: false, reason: 'HostExploded' })
  assert.ok(!JSON.stringify(body).includes('C:/private'), '响应体不得含底层 message')
  assert.ok(warnings.some(line => line.includes('HostExploded')), '原始错误进 host 日志')
})

test('POST /api/cancel：取消在途调用；缺 callId 是 400', async () => {
  const { call } = harness({
    tools: fakeTools({
      execute: async input => {
        await new Promise<void>(resolve => {
          input.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        return { isError: true, error: { message: 'aborted' } }
      },
    }),
  })
  const running = call('POST', '/api/call', { body: JSON.stringify({ name: 'a', callId: 'c1' }) })
  await new Promise<void>(resolve => setImmediate(resolve))
  const cancelled = await call('POST', '/api/cancel', { body: JSON.stringify({ callId: 'c1' }) })
  assert.equal(cancelled.status, 200)
  assert.equal(cancelled.body.cancelled, true)
  assert.equal((await running).status, 200)

  assert.equal((await call('POST', '/api/cancel', { body: JSON.stringify({}) })).status, 400)
  assert.equal((await call('POST', '/api/cancel', { body: '{oops' })).status, 400)
  // 未知 callId 不算错误：`cancelled: false` 就是答案。
  const unknown = await call('POST', '/api/cancel', { body: JSON.stringify({ callId: 'nope' }) })
  assert.equal(unknown.status, 200)
  assert.equal(unknown.body.cancelled, false)
})

test('未知路径与方法返回 404（前缀路由内自行分派）', async () => {
  const { call } = harness({})
  assert.equal((await call('GET', '/api/nope')).status, 404)
  assert.equal((await call('POST', '/api/tools')).status, 404, '方法不符不落到 GET 分支')
  assert.equal((await call('GET', '/api/call')).status, 404)
  assert.equal((await call('DELETE', '/api/tools')).status, 404)
})

test('disposer 注销路由', () => {
  const { dispose, unregistered } = harness({})
  assert.equal(unregistered(), 0)
  dispose()
  assert.equal(unregistered(), 1)
})

test('projectTools / projectGroups：纯投影函数可独立断言', () => {
  const tools = projectTools([
    { name: 'mcp__srv__t', description: 'd', parameters: { properties: { x: { type: 'integer' } } } },
    { name: 'read' },
  ])
  assert.deepEqual(tools.map(tool => tool.name), ['mcp__srv__t', 'read'])
  assert.deepEqual(tools[0]!.fields.map(field => [field.name, field.type]), [['x', 'number']])
  assert.equal(tools[1]!.description, '')

  const groups = projectGroups(tools)
  assert.deepEqual(groups.map(group => group.id), ['mcp:srv', 'builtin'])
  assert.deepEqual(groups[0]!.tools, ['mcp__srv__t'])
})

// ---------------------------------------------------------------------------
// 技能（`skills` 服务）
// ---------------------------------------------------------------------------

function fakeSkills(overrides: Partial<SkillsShape> = {}): SkillsShape {
  return {
    list: async () => [
      { name: 'godot-control', description: '控制编辑器', source: 'custom', provider: 'skill-filesystem' },
      { name: 'internal-only', description: '只给人工用', source: 'user-dsh', invocation: { modelInvocable: false } },
    ],
    get: async name =>
      name === 'godot-control'
        ? { name, description: '控制编辑器', content: '# Godot Control\n正文', source: 'custom', provider: 'skill-filesystem' }
        : undefined,
    ...overrides,
  }
}

test('GET /api/skills：返回技能摘要；服务缺席/失败/抛错都降级为空数组', async () => {
  const ok = await harness({ skills: fakeSkills() }).call('GET', '/api/skills')
  assert.equal(ok.status, 200)
  assert.equal(ok.body.skills.length, 2)
  assert.deepEqual(ok.body.skills.map(s => s.name), ['godot-control', 'internal-only'])
  // invocation 默认 true；显式 false 要保留。
  assert.equal(ok.body.skills[0].modelInvocable, true)
  assert.equal(ok.body.skills[1].modelInvocable, false)
  assert.equal(ok.body.skills[1].userInvocable, true, '未声明的 userInvocable 默认 true')

  // 服务缺席：空数组而不是 500。
  assert.deepEqual((await harness({}).call('GET', '/api/skills')).body.skills, [])
  // 服务抛错：同样降级。
  const failing = harness({ skills: fakeSkills({ list: async () => { throw new Error('boom') } }) })
  assert.deepEqual((await failing.call('GET', '/api/skills')).body.skills, [])
  // 返回畸形（非数组）：空数组。
  const malformed = harness({ skills: fakeSkills({ list: async () => 'nope' as never }) })
  assert.deepEqual((await malformed.call('GET', '/api/skills')).body.skills, [])
})

test('GET /api/skills：摘要不泄漏本机路径（红线 2 延伸到 HTTP 面）', async () => {
  const withPath = harness({
    skills: fakeSkills({
      list: async () => [
        // 真实 `SkillSummary` 带本机绝对路径；投影必须丢掉它。
        { name: 'a', description: 'x', source: 'custom', provider: 'p', path: 'D:/secret/skills/a/SKILL.md' } as never,
      ],
    }),
  })
  const { body } = await withPath.call('GET', '/api/skills')
  assert.equal(body.skills[0].path, undefined, 'path 不得出现在响应体里')
  assert.ok(!JSON.stringify(body).includes('secret'), '响应体不得含本机路径片段')
})

test('GET /api/skill：按名返回正文；未知技能 404；缺 name 400', async () => {
  const skills = harness({ skills: fakeSkills() })
  const ok = await skills.call('GET', '/api/skill?name=godot-control')
  assert.equal(ok.status, 200)
  assert.equal(ok.body.skill.name, 'godot-control')
  assert.ok(ok.body.skill.content.includes('Godot Control'))

  // 未知技能：404（前端据此区分"没有这个技能"与"技能是空的"）。
  const missing = await skills.call('GET', '/api/skill?name=nope')
  assert.equal(missing.status, 404)
  assert.equal(missing.body.reason, 'unknown-skill')

  // 缺 name：400。
  assert.equal((await skills.call('GET', '/api/skill')).status, 400)

  // 服务缺席：技能一律视为未知（404），而不是崩掉。
  assert.equal((await harness({}).call('GET', '/api/skill?name=godot-control')).status, 404)

  // get 抛错：同样 404，不冒到路由层。
  const failing = harness({ skills: fakeSkills({ get: async () => { throw new Error('boom') } }) })
  assert.equal((await failing.call('GET', '/api/skill?name=godot-control')).status, 404)
})

test('projectSkills：纯投影（默认 invocation、丢 path、描述缺失归一为空串）', () => {
  const projected = projectSkills([
    { name: 'a', source: 'custom', provider: 'p' },
    { name: 'b', description: 'd', whenToUse: 'w', invocation: { modelInvocable: false, userInvocable: false } },
  ])
  assert.equal(projected[0]!.description, '')
  assert.equal(projected[0]!.modelInvocable, true, 'invocation 缺失时默认 true')
  assert.equal(projected[0]!.userInvocable, true)
  assert.equal(projected[0]!.whenToUse, undefined)
  assert.equal(projected[1]!.whenToUse, 'w')
  assert.equal(projected[1]!.modelInvocable, false)
  assert.equal(projected[1]!.userInvocable, false)
})

test('技能按会话作用域列举：带 session 时把 agent 当 scope 传给 skills.list', async () => {
  const scope = { id: 'agent-object' }
  const seen: unknown[] = []
  let receivedSession: string | undefined
  const skills = harness({
    skills: fakeSkills({
      list: async (options: unknown) => {
        seen.push(options)
        return [{ name: 'godot-control', description: '只在 preset scope 里可见', source: 'custom', provider: 'p' }]
      },
    }),
    skillScopeOf: sessionId => {
      receivedSession = sessionId
      return scope
    },
  })

  const { status, body } = await skills.call('GET', '/api/skills?session=sess-1')
  assert.equal(status, 200)
  assert.equal(receivedSession, 'sess-1', 'session 参数要交给解析函数')
  assert.deepEqual(seen[0], { scope }, 'agent 作为 scope 传进 skills.list')
  assert.equal(body.skills[0].name, 'godot-control', '会话专属技能必须出现')

  // 不带 session：退回全局视角（传空对象而不是编造 scope）。
  await skills.call('GET', '/api/skills')
  assert.deepEqual(seen[1], {}, '无 session 时不得凭空造 scope')
})

test('技能按会话作用域：解析不到 agent 时退回全局视角', async () => {
  const seen: unknown[] = []
  const skills = harness({
    skills: fakeSkills({
      list: async (options: unknown) => {
        seen.push(options)
        return []
      },
    }),
    // 模拟 sessions 已销毁：解析不出 agent。
    skillScopeOf: () => undefined,
  })
  await skills.call('GET', '/api/skills?session=gone')
  assert.deepEqual(seen[0], {}, '解析失败时按全局视角列举，不传 undefined scope')
})

test('GET /api/skill 也带 scope：会话专属技能的正文能读到', async () => {
  const scope = { id: 'agent-object' }
  const seen: Array<{ name: string; options: unknown }> = []
  const skills = harness({
    skills: fakeSkills({
      get: async (name: string, options: unknown) => {
        seen.push({ name, options })
        return { name, description: 'd', content: '正文', source: 'custom', provider: 'p' }
      },
    }),
    skillScopeOf: () => scope,
  })
  const res = await skills.call('GET', '/api/skill?name=godot-control&session=sess-1')
  assert.equal(res.status, 200)
  assert.equal(res.body.skill.content, '正文')
  assert.deepEqual(seen[0], { name: 'godot-control', options: { scope } })
})
