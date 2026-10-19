import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'
import type { HostContext } from '../types.js'

interface MockCall { kind: string; idOrName: string }

function createMockContext(options?: { loader?: unknown; agents?: unknown }) {
  const calls: MockCall[] = []
  const live = new Set<string>()
  const disposers: Array<() => void> = []
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const registeredCommands = new Map<string, unknown>()
  const registeredSections: Array<{ name: string; text: unknown }> = []

  const track = (kind: string, idOrName: string, dispose: () => void) => {
    calls.push({ kind, idOrName })
    live.add(`${kind}:${idOrName}`)
    return () => { live.delete(`${kind}:${idOrName}`); dispose() }
  }

  const ctx: HostContext = {
    get(name: string): any {
      if (name === 'commands') {
        return {
          register: (def: { name: string }) => {
            registeredCommands.set(def.name, def)
            return track('command', def.name, () => { registeredCommands.delete(def.name) })
          },
        }
      }
      if (name === 'systemPrompt') {
        return {
          section: (s: { name: string; text: unknown }) => {
            registeredSections.push(s)
            return track('promptSection', s.name, () => {})
          },
        }
      }
      if (name === 'loader') return options?.loader
      if (name === 'agents') return options?.agents
      return undefined
    },
    on(name, callback) {
      const set = listeners.get(name) ?? new Set()
      listeners.set(name, set)
      set.add(callback)
      return () => { set.delete(callback) }
    },
    effect(dispose) {
      const inner = dispose() ?? (() => {})
      disposers.push(inner)
      return () => {}
    },
  }

  return {
    ctx, calls, live, registeredCommands, registeredSections,
    runDisposers: () => { for (const d of disposers.splice(0)) d() },
    /** 某事件当前的监听者数量：用来断言监听**确实**注册了，而不是"触发没抛错"。 */
    listenerCount: (name: string) => listeners.get(name)?.size ?? 0,
    /**
     * 派发事件。
     *
     * **无监听者时抛错**而不是空遍历：调用方用 `fire` 来证明监听器已注册，而
     * "什么都没发生"与"监听器不存在"在空遍历下无法区分——这正是本文件原来那条
     * `assert.ok(true)` 变成恒真断言的原因。注册表本身是这段测试的观测面。
     */
    fire: (name: string, payload: unknown) => {
      const set = listeners.get(name)
      if (set === undefined || set.size === 0) {
        throw new Error(`没有监听者的事件被派发：${name}`)
      }
      for (const cb of set) cb(payload)
    },
  }
}

test('apply 不再注册命令，也不注册任何提示段（命令面与 G4）', () => {
  // 命令族与系统提示注入随控制台化一起删除。这里在**装配面**上钉住"不再注册"：
  // 把 `registerCommands` 或 `injectNotice` 加回来，本用例立刻变红。
  // 端到端的"未批准时提示词里什么都没有"由 `mount.test.mts` 的 G4 用例守护。
  const mock = createMockContext()
  apply(mock.ctx, {})
  assert.equal(mock.registeredCommands.size, 0, '插件不得再注册 /mcp-project 命令')
  assert.deepEqual(mock.registeredSections, [], '插件不得再注册系统提示段')
  mock.runDisposers()
  assert.equal(mock.live.size, 0, '插件卸载后不留任何注册')
})

test('apply 注册 agent/created 监听，且随插件卸载注销', () => {
  const mock = createMockContext()
  apply(mock.ctx, {})

  // 可观测事实一：监听器确实挂上了（原来的 `assert.ok(true)` 在这里恒真）。
  assert.equal(mock.listenerCount('agent/created'), 1, 'apply 未注册 agent/created 监听')
  // 可观测事实二：插件侧还注册了 agent/disposed 清理钩子。
  assert.equal(mock.listenerCount('agent/disposed'), 1, 'apply 未注册 agent/disposed 清理')

  // `fire` 在无监听者时抛错，因此这一行本身就是断言；这里只验证不抛异常
  // （无 loader 时全局名单为空集，假 agent 无 ctx/工作区 → 计划 skip）。
  mock.fire('agent/created', { agent: { session: { header: {} } } })

  mock.runDisposers()
  assert.equal(mock.listenerCount('agent/created'), 0, '插件卸载后监听器未注销')
  assert.equal(mock.listenerCount('agent/disposed'), 0, '插件卸载后清理钩子未注销')
})

// 提示注入（`renderNotice` / `injectNotice`）已随控制台化删除：未批准时系统提示词里
// 不得出现任何项目级 MCP 内容（G4）。"什么都不注入"这条由 `mount.test.mts` 的 G4 用例
// 在穿过 `apply` 的端到端面上守护，比单测一个纯文本函数更有意义。
