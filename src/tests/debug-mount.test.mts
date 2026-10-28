/**
 * 调试台的**装配层**契约：`apply` 是否真的把路由挂到了 `webServer` 上。
 *
 * 为什么单独一个文件：`debug-bridge.test.mts` 测的是路由**内部**行为（给一个
 * 现成的 webServer 装上处理器）；这里测的是"装配条件"——缺 tools 服务时不挂、
 * 缺 webServer 时不挂、服务晚到时靠重试补上、插件卸载后路由必须消失。
 *
 * 这些条件错一个，症状都是"Tab 打开了但永远空着"，而那种缺陷在单元层完全看不见。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../index.js'
import type { HostContext } from '../types.js'

interface RouteRecord {
  kind: string
  path: string
  handler: (req: unknown, res: unknown) => void
}

interface MockOptions {
  tools?: unknown
  /** `null` 表示"webServer 暂时缺席"（模拟服务晚到）；缺省表示在场。 */
  webServer?: unknown
  systemPrompt?: unknown
}

function createMockContext(options: MockOptions = {}) {
  const routes: RouteRecord[] = []
  const taps: Array<(html: string) => string> = []
  const disposers: Array<() => void> = []
  // 缺省在场；显式 `webServer: null` 才是缺席（用于模拟服务晚到）。
  const state: { webServer: unknown } = {
    webServer: 'webServer' in options ? options.webServer : {},
  }

  const webServer = {
    register(route: RouteRecord) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
    tapIndex(transform: (html: string) => string) {
      taps.push(transform)
      return () => {
        const index = taps.indexOf(transform)
        if (index >= 0) taps.splice(index, 1)
      }
    },
  }

  const ctx: HostContext = {
    get(name: string): any {
      if (name === 'tools') return options.tools
      if (name === 'systemPrompt') return options.systemPrompt
      if (name === 'webServer') return state.webServer === null || state.webServer === undefined ? undefined : webServer
      return undefined
    },
    on() {
      return () => {}
    },
    effect(dispose) {
      const inner = dispose() ?? (() => {})
      disposers.push(inner)
      return () => {}
    },
  }

  return {
    ctx,
    routes,
    taps,
    state,
    runDisposers: () => {
      for (const dispose of disposers.splice(0)) dispose()
    },
    paths: () => routes.map(route => route.path),
  }
}

function fakeTools() {
  return {
    schemas: () => [{ name: 'read' }, { name: 'mcp__srv__t' }],
    execute: async () => ({ isError: false, value: { content: [] } }),
  }
}

test('apply：tools 与 webServer 都在场时挂上 MCP 控制台与调试台两座桥', () => {
  const mock = createMockContext({ tools: fakeTools() })
  apply(mock.ctx, {})

  const paths = mock.paths()
  assert.ok(paths.includes('/project-mcp'), `缺 MCP 控制台路由，实际：${paths.join(', ')}`)
  assert.ok(paths.includes('/project-mcp/debug'), `缺调试台路由，实际：${paths.join(', ')}`)
  // 两座桥都不做页面注入：准入是同源围栏，客户端不需要任何 meta/凭据头。
  // 这是桌面版（Electron 直读打包 dist，tapIndex 永不执行）修复后的回归守护：
  // 一旦有人把 tapIndex 注入加回来，这里立刻变红。
  assert.equal(mock.taps.length, 0, '两座桥都不得注册 tapIndex 注入')

  mock.runDisposers()
  assert.deepEqual(mock.paths(), [], '插件卸载后路由必须全部注销')
  assert.equal(mock.taps.length, 0, '卸载后仍不得有任何注入残留')
})

test('apply：tools 服务缺席时不挂调试台（没有工具面可调试）', () => {
  const mock = createMockContext({})
  apply(mock.ctx, {})
  const paths = mock.paths()
  assert.ok(!paths.includes('/project-mcp/debug'), '无 tools 时不应挂调试台')
  // MCP 控制台不依赖 tools，仍应挂上。
  assert.ok(paths.includes('/project-mcp'))
  mock.runDisposers()
})

test('apply：webServer 晚到时由秒级重试补挂，且只挂一次', async () => {
  const mock = createMockContext({ tools: fakeTools(), webServer: null })
  apply(mock.ctx, {})
  assert.deepEqual(mock.paths(), [], 'webServer 未就绪时不挂任何路由')

  // webServer 出现后由重试定时器补上（真实间隔 1s，这里直接等一轮）。
  mock.state.webServer = {}
  await new Promise<void>(resolve => setTimeout(resolve, 1300))

  const paths = mock.paths()
  assert.ok(paths.includes('/project-mcp'), `重试后应挂上 MCP 控制台，实际：${paths.join(', ')}`)
  assert.ok(paths.includes('/project-mcp/debug'), `重试后应挂上调试台，实际：${paths.join(', ')}`)
  assert.equal(paths.filter(path => path === '/project-mcp/debug').length, 1, '不得重复挂载')

  mock.runDisposers()
  assert.deepEqual(mock.paths(), [])
})
