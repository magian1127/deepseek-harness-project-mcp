/**
 * `debug-executor.ts` 的执行契约：callId 生成/冲突、取消、结果投影、图片截断。
 *
 * 这里守护的是**安全与可诊断性**两条线：
 * - 投影必须优先 `.value`（原始块）而不是模型面 `.content`，否则图片会被降级成占位；
 * - 冲突的 callId 必须被拒绝，而不是静默覆盖取消表（覆盖会让前一次调用永远取消不掉）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CallIdConflictError,
  DebugExecutor,
  MAX_IMAGE_DATA_CHARS,
  contentText,
  projectValueBlocks,
} from '../debug-executor.js'
import type { DebugToolsShape } from '../debug-executor.js'

/** 可控时钟：每次读前进 1ms，让 durationMs 可断言而不依赖真实时间。 */
function steppedClock(): () => number {
  let value = 1000
  return () => {
    value += 1
    return value
  }
}

function fakeTools(overrides: Partial<DebugToolsShape> = {}): DebugToolsShape {
  return {
    schemas: () => [],
    execute: async () => ({ isError: false, value: { content: [{ type: 'text', text: 'ok' }] } }),
    ...overrides,
  }
}

test('projectValueBlocks:文本/图片/未支持块分别投影', () => {
  assert.deepEqual(projectValueBlocks({ content: [{ type: 'text', text: 'hi' }] }), [
    { type: 'text', text: 'hi' },
  ])
  assert.deepEqual(projectValueBlocks({ content: [{ type: 'image', data: 'AAA', mimeType: 'image/jpeg' }] }), [
    { type: 'image', mimeType: 'image/jpeg', data: 'AAA' },
  ])
  // mimeType 缺失回退 image/png。
  assert.deepEqual(projectValueBlocks({ content: [{ type: 'image', data: 'AAA' }] }), [
    { type: 'image', mimeType: 'image/png', data: 'AAA' },
  ])
  assert.deepEqual(projectValueBlocks({ content: [{ type: 'audio', data: 'x' }] }), [
    { type: 'other', summary: '未支持块类型 audio' },
  ])
})

test('projectValueBlocks:畸形输入返回空数组（不抛）', () => {
  assert.deepEqual(projectValueBlocks(undefined), [])
  assert.deepEqual(projectValueBlocks({}), [])
  assert.deepEqual(projectValueBlocks({ content: 'nope' }), [])
  // 元素级畸形：非对象跳过，缺 data 的 image 落 other。
  assert.deepEqual(projectValueBlocks({ content: [null, 3, { type: 'image' }] }), [
    { type: 'other', summary: '未支持块类型 image' },
  ])
})

test('projectValueBlocks:超大图片被截断并标记 truncated', () => {
  const huge = 'A'.repeat(MAX_IMAGE_DATA_CHARS + 10)
  const [block] = projectValueBlocks({ content: [{ type: 'image', data: huge }] })
  assert.equal(block!.type, 'image')
  assert.equal(block!.truncated, true)
  assert.equal(block!.data!.length, MAX_IMAGE_DATA_CHARS)
})

test('contentText:只拼文本块，忽略其它类型与畸形元素', () => {
  assert.equal(contentText([{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(contentText([null, 1, { type: 'text' }]), '')
  assert.equal(contentText('nope'), '')
})

test('DebugExecutor:成功调用投影 .value 原始块，并记录 durationMs', async () => {
  const executor = new DebugExecutor(steppedClock())
  const outcome = await executor.call(
    fakeTools({
      execute: async () => ({
        isError: false,
        value: { content: [{ type: 'image', data: 'IMG' }] },
        // 模型面 content 与 .value 不同：必须优先 .value，否则图片会变成占位文本。
        content: [{ type: 'text', text: '[image omitted]' }],
      }),
    }),
    'mcp__srv__shot',
    { a: 1 },
    'call-1',
  )
  assert.equal(outcome.callId, 'call-1')
  assert.equal(outcome.isError, false)
  assert.deepEqual(outcome.content, [{ type: 'image', mimeType: 'image/png', data: 'IMG' }])
  assert.equal(outcome.durationMs, 1)
  assert.equal(executor.activeCount, 0, '调用结束必须从取消表摘除')
})

test('DebugExecutor:.value 无块时回退模型面文本', async () => {
  const executor = new DebugExecutor(steppedClock())
  const outcome = await executor.call(
    fakeTools({
      execute: async () => ({ isError: false, content: [{ type: 'text', text: 'plain' }] }),
    }),
    'read',
    {},
  )
  assert.deepEqual(outcome.content, [{ type: 'text', text: 'plain' }])
})

test('DebugExecutor:失败调用带错误消息，消息为空时给固定文案', async () => {
  const executor = new DebugExecutor(steppedClock())
  const explicit = await executor.call(
    fakeTools({ execute: async () => ({ isError: true, error: { message: 'boom' } }) }),
    'read',
    {},
  )
  assert.equal(explicit.isError, true)
  assert.equal(explicit.error, 'boom')

  const fromContent = await executor.call(
    fakeTools({ execute: async () => ({ isError: true, content: [{ type: 'text', text: '从结果文本来' }] }) }),
    'read',
    {},
  )
  assert.equal(fromContent.error, '从结果文本来')

  const fallback = await executor.call(
    fakeTools({ execute: async () => ({ isError: true }) }),
    'read',
    {},
  )
  assert.equal(fallback.error, '工具执行失败')
})

test('DebugExecutor:自动生成的 callId 不与在途调用冲突', async () => {
  const executor = new DebugExecutor(steppedClock())
  let release: (() => void) | undefined
  const hold = new Promise<void>(resolve => {
    release = resolve
  })
  const tools = fakeTools({
    execute: async input => {
      // 第一个调用占住 tool-debug-1，等第二个调用被分配 id 后再放行。
      if (input.callId === 'tool-debug-1') await hold
      return { isError: false, value: { content: [] } }
    },
  })
  const first = executor.call(tools, 'a', {})
  await new Promise<void>(resolve => setImmediate(resolve))
  const second = await executor.call(tools, 'b', {})
  assert.equal(second.callId, 'tool-debug-2', '跳过已被占用的序号')
  release!()
  const settled = await first
  assert.equal(settled.callId, 'tool-debug-1')
})

test('DebugExecutor:同一个 callId 在途时再次提交被拒绝（不覆盖取消表）', async () => {
  const executor = new DebugExecutor(steppedClock())
  let release: (() => void) | undefined
  const hold = new Promise<void>(resolve => {
    release = resolve
  })
  const tools = fakeTools({
    execute: async () => {
      await hold
      return { isError: false, value: { content: [] } }
    },
  })
  const inFlight = executor.call(tools, 'a', {}, 'same-id')
  await new Promise<void>(resolve => setImmediate(resolve))
  await assert.rejects(
    () => executor.call(tools, 'b', {}, 'same-id'),
    (error: unknown) => error instanceof CallIdConflictError,
  )
  assert.equal(executor.activeCount, 1, '冲突不得影响在途那条')
  release!()
  await inFlight
})

test('DebugExecutor:cancel 中止在途调用；对未知 id 返回 false', async () => {
  const executor = new DebugExecutor(steppedClock())
  let observed: AbortSignal | undefined
  const tools = fakeTools({
    execute: async input => {
      observed = input.signal
      await new Promise<void>(resolve => {
        input.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      return { isError: true, error: { message: 'aborted' } }
    },
  })
  const running = executor.call(tools, 'a', {}, 'c1')
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(executor.cancel('c1'), true)
  await running
  assert.equal(observed!.aborted, true)
  assert.equal(executor.cancel('c1'), false, '已结束的调用取消返回 false')
  assert.equal(executor.cancel('never-started'), false)
})

test('DebugExecutor:execute 抛错时仍从取消表摘除（不泄漏）', async () => {
  const executor = new DebugExecutor(steppedClock())
  await assert.rejects(
    () =>
      executor.call(
        fakeTools({
          execute: async () => {
            throw new Error('host exploded')
          },
        }),
        'a',
        {},
        'c1',
      ),
    /host exploded/,
  )
  assert.equal(executor.activeCount, 0)
  // 摘除后可再次用同一个 callId 提交（不是永久占用）。
  assert.equal(executor.cancel('c1'), false)
})
