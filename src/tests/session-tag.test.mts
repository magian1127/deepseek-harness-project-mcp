import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * `withSessionTag` 的纯函数守护（规格 §10 的会话标记）。
 *
 * 为什么单独成文件：`mount.test.mts` 只能观测**穿过 `apply` 之后**交给 `ctx.plugin()`
 * 的那一份 config，看不到"入参是否被就地修改"这类身份问题——而"不得修改原始 config"
 * 正是本功能最容易踩的坑：`plan.configs` 由 `planSessionMount` 产出，同一个计划对象既
 * 用于挂载也用于 `/mcp-project` 渲染，就地追加会让标记随调用次数**累积**。
 *
 * 不依赖任何 profile / 环境变量，因此可以直接 import 被测模块。
 */

const { SESSION_TAG_FLAG, withSessionTag } = await import('../session-tag.js')

/** 一条 stdio 配置；`args` 用可选字段描述，便于构造"缺 args"的输入。 */
function stdioConfig(args?: unknown, extra: Record<string, unknown> = {}) {
  return {
    transport: 'stdio',
    serverName: 'alpha',
    command: 'node',
    env: { TOKEN: 'x' },
    cwd: '/repo',
    failOnStartupError: false,
    ...(args === undefined ? {} : { args }),
    ...extra,
  } as never
}

test('标记追加在原有 args 之后，且不覆盖、不重排它们', () => {
  const config = stdioConfig(['--stdio', '--version', '9.10.0'])
  const tagged = withSessionTag(config, 'session-1f4830f2') as { args: string[] }
  assert.deepEqual(tagged.args, [
    '--stdio',
    '--version',
    '9.10.0',
    SESSION_TAG_FLAG,
    'session-1f4830f2',
  ])
})

test('标记参数名带 project-mcp 前缀，避免与服务器自己的参数撞名', () => {
  // 命令行是全局可见的命名空间：泛泛的 `--tag` 会在服务器将来启用同名参数时变成
  // "某个版本突然起不来"这类极难定位的故障。
  assert.equal(SESSION_TAG_FLAG, '--project-mcp-session')
})

test('不修改原始 config：入参的 args 与对象本身都不变', () => {
  // 就地追加会让复用同一份 `plan.configs` 的路径（挂载 + `/mcp-project` 渲染）反复累积
  // 标记。用**冻结**对象断言"任何就地写入都会抛错"，比只比对结果更早暴露问题。
  const config = stdioConfig(['--stdio'])
  const tagged = withSessionTag(config, 'session-1')
  assert.notEqual(tagged, config, '必须返回新对象')
  assert.deepEqual((config as { args: string[] }).args, ['--stdio'], '入参的 args 不得被改动')
  assert.deepEqual((tagged as { args: string[] }).args, ['--stdio', SESSION_TAG_FLAG, 'session-1'])
})

test('同一份 config 连续标记两次，结果相同（不累积）', () => {
  // 这是"不修改入参"的直接后果：标记数量与调用次数无关。
  const config = stdioConfig(['--stdio'])
  const once = withSessionTag(config, 'session-1') as { args: string[] }
  const twice = withSessionTag(config, 'session-1') as { args: string[] }
  assert.deepEqual(once.args, twice.args)
  assert.equal(once.args.filter(item => item === SESSION_TAG_FLAG).length, 1)
})

test('args 缺失时标记成为唯一参数', () => {
  // `args` 在 mcp-client 的 schema 里是可选字段（`z.array(String).default([])`），
  // `translate.ts` 也只在文件给出 args 时才产出它——追加时必须按"可能不存在"处理。
  const tagged = withSessionTag(stdioConfig(), 'session-1') as { args: string[] }
  assert.deepEqual(tagged.args, [SESSION_TAG_FLAG, 'session-1'])
})

test('args 不是数组时按缺失处理，不退化成字符串拼接', () => {
  // 类型上 `args` 必填，但类型只描述本插件自己产出的 config；这里要能承受任何来源。
  for (const bad of [null, 'x', 42, { 0: 'x' }]) {
    const tagged = withSessionTag(stdioConfig(bad), 'session-1') as { args: string[] }
    assert.deepEqual(
      tagged.args,
      [SESSION_TAG_FLAG, 'session-1'],
      `args=${JSON.stringify(bad)} 时应按缺失处理`,
    )
  }
})

test('args 里的非字符串项被剔除，标记不会把非法项带进命令行', () => {
  // `spawn` 的 args 必须是字符串数组，混入非字符串会在 `spawn` 层抛错——而那时服务器
  // 已经被 `/mcp-project` 列为"已挂载"。
  const tagged = withSessionTag(stdioConfig(['--stdio', 42, null]), 'session-1') as {
    args: string[]
  }
  assert.deepEqual(tagged.args, ['--stdio', SESSION_TAG_FLAG, 'session-1'])
})

test('streamable-http 原样返回：没有子进程命令行可标记', () => {
  const config = {
    transport: 'streamable-http',
    serverName: 'alpha',
    url: 'https://example.invalid/mcp',
    headers: { 'X-K': 'v' },
    failOnStartupError: false,
  } as never
  const tagged = withSessionTag(config, 'session-1')
  assert.equal(tagged, config, 'http 分支连对象都不重建')
  assert.equal((tagged as { args?: unknown }).args, undefined, '不得凭空多出 args 字段')
})

test('标记只含 SessionId：config 的其他字段不进入命令行', () => {
  // 红线 3 的新通道：进程命令行对本机所有用户可见。标记是插件唯一新增的命令行内容，
  // 因此它必须只由 SessionId 与固定参数名组成。
  const config = stdioConfig(['--stdio'], { env: { TOKEN: 'placeholder-secret' } })
  const tagged = withSessionTag(config, 'session-1') as { args: string[] }
  const joined = tagged.args.join(' ')
  assert.equal(joined.includes('placeholder-secret'), false, `命令行不得携带 env 值：${joined}`)
  assert.deepEqual(tagged.args, ['--stdio', SESSION_TAG_FLAG, 'session-1'])
})

test('保留 config 的其他字段（浅拷贝而不是重建）', () => {
  // 只该动 args：`env` / `cwd` / `serverName` 必须逐字保留，否则会变成"标记加了、
  // 服务器却拿不到环境变量"这类静默故障。
  const config = stdioConfig(['--stdio']) as Record<string, unknown>
  const tagged = withSessionTag(config as never, 'session-1') as Record<string, unknown>
  for (const key of ['transport', 'serverName', 'command', 'env', 'cwd', 'failOnStartupError']) {
    assert.deepEqual(tagged[key], config[key], `${key} 必须原样保留`)
  }
})
