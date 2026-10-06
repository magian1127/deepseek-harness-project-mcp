import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * `config-guard.ts` 的单元测试：分支矩阵。
 *
 * 这里用**手写的 `~standard` 桩**而不是真实 schemastery，原因：本文件要覆盖的是本模块
 * 自己的分支（thenable、抛错、path 收敛、schema 缺失），这些分支用真实 schema 无法
 * 构造。**真实契约**由 `profile-config-contract.test.mts` 对已安装的 profile 模块断言，
 * 挂载路径的集成行为由 `mount-guard.test.mts` 守护——三者分工，互不代言。
 *
 * 桩刻意复刻 schemastery 的**危险语义**：`issues[].message` 里回显整个配置
 * （`vendor/schemastery/src/index.ts:834`）。这样"诊断不得含配置值"的断言才有意义。
 */
const { validateMountConfig, errorName } = await import('../config-guard.js')

const SECRET = 'placeholder-token-not-a-real-credential'

/** 复刻 schemastery 的 `~standard` 形状（含把配置回显进 message 的坏习惯）。 */
function stubSchema(
  decide: (value: any) => { ok: true; value?: any } | { ok: false; path?: unknown },
  members?: unknown[],
) {
  return {
    // `list` 是 schemastery 存 union 成员的标准位置（`Schema.list?: Schema[]`）。
    ...(members === undefined ? {} : { list: members }),
    '~standard': {
      version: 1,
      vendor: 'schemastery',
      validate(value: any) {
        const verdict = decide(value)
        if (verdict.ok) return 'value' in verdict ? { value: verdict.value } : { value }
        return {
          issues: [{
            message: `expected Config but got ${JSON.stringify(value)}`,
            path: verdict.path,
          }],
        }
      },
    },
  }
}

/** 只产出带 path 的 issues 的成员 schema，用于验证 union 成员下钻。 */
function memberSchema(path: unknown[]) {
  return {
    '~standard': {
      version: 1,
      vendor: 'schemastery',
      validate: () => ({ issues: [{ message: 'member issue', path }] }),
    },
  }
}

const CONFIG = {
  transport: 'stdio' as const,
  serverName: 'alpha',
  command: 'node',
  args: [],
  env: { TOKEN: SECRET },
  cwd: '/tmp',
  failOnStartupError: false,
}

test('合法配置放行，且返回的是**原 config**（守卫只作准入闸，不做规范化）', () => {
  // 刻意断言"不是 `value`"：`value` 是 schemastery 重建的对象，其 dict resolver 用朴素
  // 赋值落盘（`vendor/schemastery/src/index.ts:790-792`），`__proto__` 键会被静默丢弃。
  // 规范化交给 Cordis 自己的 `_resolveConfig`（`vendor/cordis/src/fiber.ts:641-644`）。
  const normalized = { ...CONFIG, args: ['--normalized'] }
  const McpClient = { Config: stubSchema(() => ({ ok: true, value: normalized })) }
  const result = validateMountConfig(McpClient, CONFIG)
  assert.equal(result.ok, true)
  assert.equal(result.ok === true && result.config, CONFIG, '必须返回原 config 的同一引用')
  assert.notDeepEqual(result.ok === true && result.config, normalized, '不得回传 schema 规范化后的值')
})

test('schema 未产出 value 时同样返回原配置（新契约下与上一条同一条路径）', () => {
  const McpClient = { Config: stubSchema(() => ({ ok: true })) }
  const result = validateMountConfig(McpClient, CONFIG)
  assert.equal(result.ok, true)
  assert.equal(result.ok === true && result.config, CONFIG, '不会把 undefined 挂进去')
})

test('非法 serverName 被拦下，诊断只含字段路径', () => {
  const McpClient = { Config: stubSchema(() => ({ ok: false, path: ['serverName'] })) }
  const result = validateMountConfig(McpClient, CONFIG)
  assert.equal(result.ok, false)
  const reason = result.ok === false ? result.reason : ''
  assert.match(reason, /serverName/)
  assert.equal(reason.includes(SECRET), false, `诊断不得回显配置值：${reason}`)
})

test('缺失 command 被拦下，诊断只含字段路径', () => {
  const McpClient = { Config: stubSchema(() => ({ ok: false, path: ['command'] })) }
  const result = validateMountConfig(McpClient, CONFIG)
  assert.equal(result.ok, false)
  const reason = result.ok === false ? result.reason : ''
  assert.match(reason, /command/)
  assert.equal(reason.includes(SECRET), false, `诊断不得回显配置值：${reason}`)
})

test('根级 union 错误没有 path 时给出不含字段的通用摘要', () => {
  const McpClient = { Config: stubSchema(() => ({ ok: false })) }
  const result = validateMountConfig(McpClient, CONFIG)
  assert.equal(result.ok, false)
  const reason = result.ok === false ? result.reason : ''
  assert.match(reason, /未提供字段路径/)
  assert.equal(reason.includes(SECRET), false, `诊断不得回显配置值：${reason}`)
})

test('env 的键名可以进诊断（红线 3 只禁值，键名是排查必需）', () => {
  const McpClient = { Config: stubSchema(() => ({ ok: false, path: ['env', 'TOKEN'] })) }
  const result = validateMountConfig(McpClient, CONFIG)
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.reason : '', /env\.TOKEN/)
})

test('不可信的 path 段使整条路径作废，绝不把值当路径记下', () => {
  // `.mcp.json` 是外部输入：schema 的 path 理论上只含键名，但仍按不可信处理。
  const cases: unknown[][] = [
    ['env', `${SECRET}=x`],          // 含 `=`
    ['env', SECRET],                 // 含 `-` 且超长
    ['env', 'TOKEN\ninjected'],      // 含换行（日志注入）
    ['env', { toString: () => SECRET }], // 非原始值
    ['env', Symbol('x')],            // symbol
  ]
  for (const path of cases) {
    const McpClient = { Config: stubSchema(() => ({ ok: false, path })) }
    const result = validateMountConfig(McpClient, CONFIG)
    assert.equal(result.ok, false)
    const reason = result.ok === false ? result.reason : ''
    assert.equal(reason.includes(SECRET), false, `path=${String(path[1])} 泄漏了值：${reason}`)
    assert.match(reason, /未提供字段路径/, `path=${String(path[1])} 应退化为通用摘要`)
  }
})

test('数组下标是合法的 path 段（不因含数字而作废整条路径）', () => {
  const McpClient = { Config: stubSchema(() => ({ ok: false, path: ['args', 0] })) }
  const result = validateMountConfig(McpClient, CONFIG)
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.reason : '', /args\.0/)
})

test('path 段数超限时截断，不无界增长', () => {
  // 用不会出现在诊断模板固定文本里的段名，避免断言被"schema"/"字段"等词干扰。
  const deep = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']
  const McpClient = { Config: stubSchema(() => ({ ok: false, path: deep })) }
  const result = validateMountConfig(McpClient, CONFIG)
  assert.equal(result.ok, false)
  const reason = result.ok === false ? result.reason : ''
  assert.match(reason, /p1\.p2\.p3\.p4/)
  assert.equal(reason.includes('p5'), false, `超出上限的段不应出现：${reason}`)
})

test('根级 union 错误没有 path 时，下钻 union 成员取字段路径', () => {
  // 实测真实 mcp-client 的 Config：根级 union 错误**不带 path**，只记"未提供字段路径"
  // 对运维毫无价值。成员校验能给出精确路径（serverName / command）。
  const McpClient = {
    Config: stubSchema(
      () => ({ ok: false }), // 根级：无 path
      [memberSchema(['serverName']), memberSchema(['transport'])],
    ),
  }
  const result = validateMountConfig(McpClient, CONFIG)
  assert.equal(result.ok, false)
  const reason = result.ok === false ? result.reason : ''
  assert.match(reason, /serverName/, `应下钻取到字段路径：${reason}`)
  assert.match(reason, /transport/, `应汇总全部成员的字段：${reason}`)
  assert.equal(reason.includes(SECRET), false, `诊断不得回显配置值：${reason}`)
})

test('union 成员校验抛错/返回 thenable 时不影响主判定，也不泄密', () => {
  const throwing = {
    '~standard': {
      version: 1,
      vendor: 'x',
      validate: () => { throw new Error(`got ${JSON.stringify(CONFIG)}`) },
    },
  }
  const thenable = {
    '~standard': { version: 1, vendor: 'x', validate: async () => ({ issues: [{ path: ['x'] }] }) },
  }
  const noStandard = {}
  for (const member of [throwing, thenable, noStandard]) {
    const McpClient = { Config: stubSchema(() => ({ ok: false }), [member]) }
    const result = validateMountConfig(McpClient, CONFIG)
    assert.equal(result.ok, false, '主判定仍必须是"不通过"')
    const reason = result.ok === false ? result.reason : ''
    assert.equal(reason.includes(SECRET), false, `成员失败不得泄密：${reason}`)
    assert.match(reason, /未提供字段路径/)
  }
})

test('成员自带的 path 不可信时同样被丢弃', () => {
  const McpClient = {
    Config: stubSchema(() => ({ ok: false }), [memberSchema(['env', SECRET])]),
  }
  const result = validateMountConfig(McpClient, CONFIG)
  assert.equal(result.ok, false)
  const reason = result.ok === false ? result.reason : ''
  assert.equal(reason.includes(SECRET), false, `成员 path 也不得回显值：${reason}`)
})

test('非 union（无 list）时不做下钻，降级为通用摘要', () => {
  const McpClient = { Config: stubSchema(() => ({ ok: false })) }
  const result = validateMountConfig(McpClient, CONFIG)
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.reason : '', /未提供字段路径/)
})

test('issues 为空数组同样视为失败（与 Cordis 的 `if (result.issues)` 一致）', () => {
  const McpClient = { Config: { '~standard': { version: 1, vendor: 'x', validate: () => ({ issues: [] }) } } }
  const result = validateMountConfig(McpClient, CONFIG)
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.reason : '', /未提供具体问题/)
})

test('异步校验被拦下（同步挂载路径无法 await）', () => {
  const McpClient = { Config: { '~standard': { version: 1, vendor: 'x', validate: async () => ({ value: {} }) } } }
  const result = validateMountConfig(McpClient, CONFIG)
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.reason : '', /异步/)
})

test('校验抛错时只记错误类型，绝不透传消息体', () => {
  const McpClient = {
    Config: {
      '~standard': {
        version: 1,
        vendor: 'x',
        validate: () => {
          const error = new Error(`expected Config but got ${JSON.stringify(CONFIG)}`)
          error.name = 'ValidationError'
          throw error
        },
      },
    },
  }
  const result = validateMountConfig(McpClient, CONFIG)
  assert.equal(result.ok, false)
  const reason = result.ok === false ? result.reason : ''
  assert.match(reason, /ValidationError/)
  assert.equal(reason.includes(SECRET), false, `不得透传消息体：${reason}`)
})

test('非对象校验结果被拦下', () => {
  for (const bad of [undefined, null, 'x', 42]) {
    const McpClient = { Config: { '~standard': { version: 1, vendor: 'x', validate: () => bad } } }
    const result = validateMountConfig(McpClient, CONFIG)
    assert.equal(result.ok, false, `validate 返回 ${JSON.stringify(bad)} 时应拦下`)
  }
})

test('schema 缺失时原样放行（对齐 Cordis 的 !runtime.Config 分支）', () => {
  assert.deepEqual(validateMountConfig(undefined, CONFIG), { ok: true, config: CONFIG })
  assert.deepEqual(validateMountConfig(null, CONFIG), { ok: true, config: CONFIG })
  assert.deepEqual(validateMountConfig({}, CONFIG), { ok: true, config: CONFIG })
  assert.deepEqual(validateMountConfig({ Config: {} }, CONFIG), { ok: true, config: CONFIG })
  assert.deepEqual(validateMountConfig({ Config: { '~standard': {} } }, CONFIG), { ok: true, config: CONFIG })
})

test('validate 以 ~standard 对象为接收者被调用', () => {
  // 标题刻意不写"依赖 this"：本用例用的是**数据属性桩**，只能证明接收者是 `~standard`
  // 对象本身。真实 schemastery 的 `validate` 是闭包捕获 `this` 的箭头函数
  // （`vendor/schemastery/src/index.ts:295` 的 `validate: (value) => { ... Schema.resolve(value, this, {}) }`），
  // 并不需要绑定——因此这里证明的只是"接收者是谁"，不是"绑定是必需的"。
  let seenThis: unknown
  const schema = {
    '~standard': {
      version: 1,
      vendor: 'x',
      validate(this: unknown, _value: unknown) {
        seenThis = this
        return { value: CONFIG }
      },
    },
  }
  validateMountConfig({ Config: schema }, CONFIG)
  assert.equal(seenThis, schema['~standard'], 'validate 必须绑定到 ~standard 对象上调用')
})

test('errorName 只回类型名，绝不回消息体', () => {
  assert.equal(errorName(new Error(`got ${SECRET}`)), 'Error')
  assert.equal(errorName(new TypeError('x')), 'TypeError')
  assert.equal(errorName('placeholder-secret'), 'string')
  assert.equal(errorName(null), 'object')
  assert.equal(errorName(undefined), 'undefined')
})
