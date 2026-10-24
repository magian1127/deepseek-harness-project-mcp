/**
 * `debug-view.ts` 的纯函数契约：MCP 名解析、分组稳定性、关键词过滤、
 * schema → 表单投影、表单值 → 参数。
 *
 * 这些函数是"调试台说什么"的唯一来源，因此断言写的是**语义**（顺序、省略规则、
 * 错误归属），不是实现细节。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildArguments,
  filterTools,
  formFields,
  groupIdOf,
  groupTools,
  parseMcpToolName,
  type DebugToolEntry,
} from '../debug-view.js'

const tool = (name: string, description = ''): DebugToolEntry => ({ name, description })

test('parseMcpToolName:只认 mcp__<server>__<tool> 三段形态', () => {
  assert.deepEqual(parseMcpToolName('mcp__godot__scene_get_tree'), {
    server: 'godot',
    tool: 'scene_get_tree',
  })
  // 服务器名与工具名里都允许出现单个下划线。
  assert.deepEqual(parseMcpToolName('mcp__my_srv__my_tool'), { server: 'my_srv', tool: 'my_tool' })
  // 工具名里含 __ 时，第一段分隔之后整体都是工具名（服务器名不允许含 __）。
  assert.deepEqual(parseMcpToolName('mcp__srv__a__b'), { server: 'srv', tool: 'a__b' })

  // 非 MCP 形态 / 畸形：一律 undefined（调用方落回 plugin 组）。
  assert.equal(parseMcpToolName('read'), undefined)
  assert.equal(parseMcpToolName('mcp__'), undefined)
  assert.equal(parseMcpToolName('mcp__srv'), undefined)
  assert.equal(parseMcpToolName('mcp__srv__'), undefined)
  assert.equal(parseMcpToolName('mcp____tool'), undefined)
  assert.equal(parseMcpToolName('MCP__srv__tool'), undefined, '前缀大小写敏感')
})

test('groupTools:组顺序固定为 MCP(服务器名字典序) → 内置 → 其他，组内按名排序', () => {
  const groups = groupTools([
    tool('read'),
    tool('mcp__zeta__b_tool'),
    tool('custom_plugin_tool'),
    tool('mcp__alpha__z_tool'),
    tool('mcp__alpha__a_tool'),
    tool('pwsh'),
  ])
  assert.deepEqual(
    groups.map(group => group.id),
    ['mcp:alpha', 'mcp:zeta', 'builtin', 'plugin'],
  )
  // 组内按名字排序：输入顺序故意打乱。
  assert.deepEqual(groups[0]!.tools.map(item => item.name), ['mcp__alpha__a_tool', 'mcp__alpha__z_tool'])
  assert.deepEqual(groups[2]!.tools.map(item => item.name), ['pwsh', 'read'])
  assert.deepEqual(groups[3]!.tools.map(item => item.name), ['custom_plugin_tool'])
  // kind 与 title：MCP 组标题是服务器名（不带 mcp__ 前缀），内置/其他是固定 id。
  assert.equal(groups[0]!.kind, 'mcp')
  assert.equal(groups[0]!.title, 'alpha')
  assert.equal(groups[2]!.title, 'builtin')
  assert.equal(groups[3]!.title, 'plugin')
})

test('groupTools:空输入产出空数组；只有一类时只出那一组', () => {
  assert.deepEqual(groupTools([]), [])
  const onlyBuiltin = groupTools([tool('read')])
  assert.deepEqual(onlyBuiltin.map(group => group.id), ['builtin'])
})

test('groupTools:同一份工具面多次分组结果完全一致（调试面不允许顺序抖动）', () => {
  const tools = [
    tool('mcp__b__t2'),
    tool('read'),
    tool('mcp__a__t1'),
    tool('third_party'),
    tool('mcp__b__t1'),
  ]
  const first = JSON.stringify(groupTools(tools))
  const second = JSON.stringify(groupTools(tools.slice().reverse()))
  assert.equal(first, second)
})

test('groupIdOf:与 groupTools 的分组结果一致', () => {
  const tools = [
    tool('mcp__srv__t'),
    tool('read'),
    tool('third_party'),
    tool('mcp____bad'),
  ]
  for (const group of groupTools(tools)) {
    for (const item of group.tools) {
      assert.equal(groupIdOf(item.name), group.id, `${item.name} 应属于 ${group.id}`)
    }
  }
})

test('filterTools:按名或描述匹配、大小写不敏感、空关键词原样返回', () => {
  const tools = [tool('mcp__srv__Scene_Get_Tree', '读取场景树'), tool('read', 'Read a file')]
  assert.equal(filterTools(tools, '   '), tools, '空关键词返回同一引用（不复制）')
  assert.deepEqual(filterTools(tools, 'scene').map(item => item.name), ['mcp__srv__Scene_Get_Tree'])
  assert.deepEqual(filterTools(tools, '场景').map(item => item.name), ['mcp__srv__Scene_Get_Tree'], '描述命中')
  assert.deepEqual(filterTools(tools, 'READ').map(item => item.name), ['read'])
  assert.deepEqual(filterTools(tools, 'nope'), [])
})

test('formFields:顶层标量/枚举成控件，复杂类型落 JSON 编辑域', () => {
  const fields = formFields({
    type: 'object',
    properties: {
      name: { type: 'string', description: '名称' },
      count: { type: 'integer' },
      ratio: { type: 'number' },
      flag: { type: 'boolean' },
      mode: { type: 'string', enum: ['a', 'b'] },
      nested: { type: 'object' },
      list: { type: 'array' },
    },
    required: ['name', 'mode'],
  })
  assert.deepEqual(fields.map(field => [field.name, field.type]), [
    ['name', 'string'],
    ['count', 'number'],
    ['ratio', 'number'],
    ['flag', 'boolean'],
    ['mode', 'enum'],
    ['nested', 'json'],
    ['list', 'json'],
  ])
  assert.equal(fields[0]!.required, true)
  assert.equal(fields[0]!.description, '名称')
  assert.equal(fields[1]!.required, false)
  assert.deepEqual(fields[4]!.enumValues, ['a', 'b'])
  assert.equal(fields[5]!.placeholder, '{}', '对象落 {}')
  assert.equal(fields[6]!.placeholder, '[]', '数组落 []')
})

test('formFields:畸形 schema 返回空数组（不抛）', () => {
  assert.deepEqual(formFields(undefined), [])
  assert.deepEqual(formFields(null), [])
  assert.deepEqual(formFields('nope'), [])
  assert.deepEqual(formFields({ type: 'object' }), [], '无 properties')
  assert.deepEqual(formFields({ properties: [] }), [], 'properties 不是对象')
  // 属性本身畸形时按 object 处理，落 JSON 域而不是崩掉。
  const fields = formFields({ properties: { weird: null } })
  assert.deepEqual(fields.map(field => [field.name, field.type]), [['weird', 'json']])
})

test('buildArguments:类型转换、空串省略、必填报错、非法值报错', () => {
  const fields = formFields({
    type: 'object',
    properties: {
      name: { type: 'string' },
      count: { type: 'integer' },
      flag: { type: 'boolean' },
      mode: { type: 'string', enum: ['a', 'b'] },
      nested: { type: 'object' },
      optional: { type: 'string' },
    },
    required: ['name'],
  })
  const good = buildArguments(fields, { name: '  x  ', count: '3', flag: true, mode: 'a', nested: '{"k":1}' })
  assert.deepEqual(good.errors, [])
  assert.deepEqual(good.args, { name: 'x', count: 3, flag: true, mode: 'a', nested: { k: 1 } })

  // 布尔只在勾选时出现：未勾选不塞 false。
  assert.deepEqual(buildArguments(fields, { name: 'x' }).args, { name: 'x' })

  const missing = buildArguments(fields, {})
  assert.deepEqual(missing.errors, ['name 为必填'])
  assert.deepEqual(missing.args, {})

  const bad = buildArguments(fields, { name: 'x', count: 'NaN', nested: '{oops' })
  assert.equal(bad.errors.length, 2)
  assert.ok(bad.errors.some(error => error.includes('count')))
  assert.ok(bad.errors.some(error => error.includes('nested')))
  // 出错字段不写进参数，合法的照常写。
  assert.deepEqual(bad.args, { name: 'x' })

  // 可选字段留空不报错也不发送。
  assert.deepEqual(buildArguments(fields, { name: 'x', optional: '   ' }).args, { name: 'x' })
})
