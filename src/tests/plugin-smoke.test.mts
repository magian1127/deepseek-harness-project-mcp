import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'
import { renderNotice } from '../notice.js'
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

test('apply 注册命令与提示段，清理可逆', () => {
  const mock = createMockContext()
  apply(mock.ctx, {})
  assert.ok(mock.live.has('command:mcp-project'))
  mock.runDisposers()
  assert.equal(mock.live.size, 0)
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

test('renderNotice 对未信任计划列出待批准服务器', () => {
  const text = renderNotice(
    { kind: 'untrusted', projectRoot: '/repo', fingerprint: 'sha256:x', pending: ['gh', 'mem'] },
    '/repo',
  )
  assert.match(text, /\/repo/)
  assert.match(text, /gh/)
  assert.match(text, /mem/)
})

test('renderNotice 对挂载计划为空', () => {
  const text = renderNotice(
    { kind: 'mount', projectRoot: '/repo', fingerprint: 'sha256:x', configs: [], skipped: [] },
    '/repo',
  )
  assert.equal(text, '')
})

test('renderNotice 对跳过计划为空', () => {
  assert.equal(renderNotice({ kind: 'skip', reason: 'no cwd' }, '/repo'), '')
})

test('renderNotice 对无法解析的文件给出诊断', () => {
  const text = renderNotice({ kind: 'invalid', reason: 'not valid JSON' }, '/repo')
  assert.match(text, /\/repo/)
  assert.notEqual(text, '')
})
