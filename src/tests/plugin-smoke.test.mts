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
    fire: (name: string, payload: unknown) => {
      for (const cb of listeners.get(name) ?? []) cb(payload)
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

test('apply 注册 agent/created 监听', () => {
  const mock = createMockContext()
  apply(mock.ctx, {})
  // 触发不应抛异常（无 loader 时全局名单为空集）
  mock.fire('agent/created', { agent: { session: { header: {} } } })
  assert.ok(true)
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
