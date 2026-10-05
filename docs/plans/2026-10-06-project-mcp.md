# deepseek-harness-project-mcp 实施计划

> **面向 Agent 执行者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 按任务逐项实现本计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 让项目根目录的 `.mcp.json` 决定该项目下会话启用哪些 MCP 服务器，且未启用的服务器完全不建立连接、不启动子进程。

**架构：** 新独立 DSH 插件包。它不"拦截"而是"接管"——MCP 定义从 profile 补丁搬进 `.mcp.json`，由插件在 `agent/created` 时按项目根 + 信任状态决定是否 `agent.ctx.plugin(McpClient, cfg)`。因为 `mcp-client` 挂载即连接，所以"会话级挂载"是阻止进程启动的唯一途径。

**技术栈：** TypeScript 5.8（`tsc` 构建到 `lib/`）、Node 22.19+/24+、`node:test` + `node:assert/strict`、Cordis 插件模型。

**规格：** [`../deepseek-harness-project-mcp/docs/design.md`](../deepseek-harness-project-mcp/docs/design.md)

## 全局约束

- Node 引擎：`^22.19.0 || >=24.0.0`
- **不得**把 `@deepseek-ai/*` 写入 `dependencies`/`peerDependencies`；一律经 `src/profile-modules.ts` 运行时从 profile 解析，或使用 `src/types.ts` 的鸭子类型（规格 §4.2）
- 不写入本机绝对路径到受版本管理的文件；文档中本地路径用项目相对路径或 `${DSH_HOME:-~/.dsh}` 相对形式
- 展开后的环境变量值**永不**进入日志、错误消息、会话记录或持久化产物；只记变量名
- 命令名必须匹配 `/^[a-z][a-z0-9_-]*$/u`
- `serverName` 必须匹配 `/^[A-Za-z0-9_-]{1,32}$/`
- 信任文件权限 `0600`
- 构建产物 `lib/` 不得手改；`src/` 是唯一实现来源
- **相对导入一律写 `.js` 扩展名**（如 `from './discovery.js'`），即使源文件是 `.ts`——`tsc` 原样输出该说明符，运行时才解析得到。测试文件同理（`from '../trust.js'`）
- 提交标题以中文开头

## Review Focus

以下五类输入/失败模式规格未逐一钉死，但最可能坑到使用者，每类都必须有测试覆盖：

1. **`.mcp.json` 是合法 JSON 但结构错误**（顶层是数组、`mcpServers` 是字符串、条目是 `null`）——必须跳过并给出可读诊断，绝不抛异常中断会话创建。
2. **`${VAR}` 引用未定义变量**——必须跳过该服务器且**不泄漏**任何值到日志；错误消息只含变量名。
3. **同名服务器同时存在于全局 profile 行与 `.mcp.json`**——必须跳过项目侧（规格 §8.2），不得静默遮蔽或重复 spawn。
4. **信任文件损坏或含未知版本号**——必须视为全部未信任（失败关闭），且不阻止 DSH 启动。
5. **`.mcp.json` 在批准后被修改**（含 `git pull` 拉入新条目）——指纹不匹配必须导致重新批准，不得沿用旧批准。

---

## 文件结构

```
deepseek-harness-project-mcp/
├── package.json              包清单（无 @deepseek-ai/* 依赖）
├── tsconfig.json             Host 构建配置（src → lib）
├── tsconfig.tests.json       测试构建配置（src → .tsbuild）
├── .gitignore
├── cordis.patch.yml          Loader 行声明（id: dsh-project-mcp）
├── src/
│   ├── index.ts              插件入口：装配命令、监听 agent/created、挂载 MCP
│   ├── types.ts              宿主服务最小鸭子类型（不 import @deepseek-ai/*）
│   ├── profile-modules.ts    从 profile 运行时解析并预载 DSH 模块
│   ├── discovery.ts          项目根发现 + .mcp.json 读取解析
│   ├── translate.ts          .mcp.json 条目 → McpClient.Config + serverName 规范化
│   ├── trust.ts              信任存储、规范化指纹、批准/撤销
│   ├── global-rows.ts        从 Loader 树收集全局 MCP serverName
│   ├── session.ts            纯函数：会话 → 挂载决策
│   ├── commands.ts           /mcp-project 命令族
│   ├── notice.ts             未信任/无法解析时的系统提示文本
│   └── tests/
│       ├── profile-modules.test.mts
│       ├── discovery.test.mts
│       ├── translate.test.mts
│       ├── trust.test.mts
│       ├── global-rows.test.mts
│       ├── session.test.mts
│       └── plugin-smoke.test.mts
├── docs/
│   ├── design.md             设计规格（已批准）
│   ├── plans/                本计划
│   ├── behavior.md           用户可见行为
│   ├── development.md        开发与验证
│   └── troubleshooting.md    排障
├── README.md / README.en.md
└── AGENTS.md
```

**职责边界**：`session.ts` 是纯函数（无 I/O），全部副作用经参数注入——这是它可被彻底单测的原因。`index.ts` 是唯一做真实 I/O 与 Cordis 交互的模块，因此它的测试是"假 ctx"冒烟而非穷尽单测。`discovery.ts` / `translate.ts` / `trust.ts` / `global-rows.ts` 各自只承担一件事，互不依赖，可并行实现。

**依赖方向**（单向，无环）：

```
index.ts ──> session.ts ──> discovery.ts, translate.ts, trust.ts, global-rows.ts
   │                              │
   └──> commands.ts, notice.ts    └──> types.ts
   └──> profile-modules.ts
```

任务 2–5 产出 `session.ts` 的全部输入；任务 6 只做组合；任务 7 只做装配。任务 2–5 之间**没有相互依赖**，可并行。

---

### Task 1：项目骨架与 profile 模块加载

**文件：**
- 新建：`package.json`、`tsconfig.json`、`tsconfig.tests.json`、`.gitignore`、`cordis.patch.yml`
- 新建：`src/profile-modules.ts`
- 新建：`src/tests/profile-modules.test.mts`

**接口：**
- 产出：`profileNameFrom(argv: readonly string[], electronVersion: string | undefined): string`
- 产出：`profileName(): string`
- 产出：`profileDir(): string`
- 产出：`loadMcpClient(): unknown`（返回 `@deepseek-ai/dsh-mcp-client` 模块或 `null`）
- 产出：`loadAtomicWrite(): unknown`（返回 `@deepseek-ai/dsh-atomic-write` 模块或 `null`）

- [ ] **步骤 1：创建 `package.json`**

字段对齐工作区既有插件（`deepseek-harness-zhipu_plan_tools` 为模板）。关键值：

```json
{
  "name": "deepseek-harness-project-mcp",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "engines": { "node": "^22.19.0 || >=24.0.0" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "scripts": {
    "build": "tsc -p tsconfig.json && tsc -p tsconfig.tests.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "npm run build && node --test \".tsbuild/tests/*.test.mjs\""
  },
  "devDependencies": {
    "@types/node": "^22.15.0",
    "typescript": "^5.8.3"
  }
}
```

**注意**：`dependencies` 与 `peerDependencies` 都必须省略（全局约束）。

- [ ] **步骤 2：创建 `tsconfig.json` 与 `tsconfig.tests.json`**

`tsconfig.json` 以 hashline 为模板（`target: ES2024`、`module: ESNext`、`moduleResolution: Bundler`、`rootDir: src`、`outDir: lib`、`strict: true`、`verbatimModuleSyntax: true`、`types: ["node"]`），`include` 列出全部 `src/*.ts`。

`tsconfig.tests.json` extends 前者，`outDir: .tsbuild`、`noCheck: true`、`declaration: false`，`include: ["src/*.ts", "src/tests/*.mts"]`。

- [ ] **步骤 3：创建 `.gitignore` 与 `cordis.patch.yml`**

`.gitignore` 至少含 `node_modules/`、`lib/`、`.tsbuild/`、`temp/`。

`cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-project-mcp
      name: deepseek-harness-project-mcp
```

- [ ] **步骤 4：编写失败的测试**

新建 `src/tests/profile-modules.test.mts`：

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { profileNameFrom, profileDir } from '../profile-modules.js'

test('profileNameFrom 读取 --profile 标志', () => {
  assert.equal(profileNameFrom(['node', 'dsh', '--profile', 'web'], undefined), 'web')
})

test('profileNameFrom 在 Electron 下默认 desktop', () => {
  assert.equal(profileNameFrom(['node', 'app'], '38.0.0'), 'desktop')
})

test('profileNameFrom 无标志非 Electron 时默认 web', () => {
  assert.equal(profileNameFrom(['node', 'dsh'], undefined), 'web')
})

test('profileNameFrom 忽略以 - 开头的伪值', () => {
  assert.equal(profileNameFrom(['node', 'dsh', '--profile', '--help'], undefined), 'web')
})

test('profileDir 落在 DSH_HOME/profiles/<name>', () => {
  const original = process.env.DSH_HOME
  process.env.DSH_HOME = '/tmp/dsh-test-home'
  try {
    assert.equal(profileDir(), '/tmp/dsh-test-home/profiles/web')
  } finally {
    if (original === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = original
  }
})
```

- [ ] **步骤 5：运行测试，确认其失败**

运行：`npm run build && node --test ".tsbuild/tests/profile-modules.test.mjs"`
预期：FAIL，报模块 `../profile-modules.js` 不存在或 `profileNameFrom is not a function`

- [ ] **步骤 6：实现 `src/profile-modules.ts`**

以 hashline 的 `src/profile-modules.ts` 为蓝本（该文件已在本工作区验证可用）。必须保留的结构：

- `profileEntryPath(requireFromProfile, name)`：`require.resolve` 只解析 → 读 `package.json` 的 `exports['.']` 取 `import` 条目 → 退回 `main` → 退回 require 条目
- `importFromProfile(name, state)`：`createRequire(join(profileDir(), 'package.json'))` + `pathToFileURL` + 异步 `import`，`mod.default ?? mod`，失败置 `cache = undefined`
- 模块顶层 `await importFromProfile(...)` 预载两个模块（顶层 await，TLA）
- `loadFromProfile(name, state)`：命中 cache 返回；`failed` 则返回 `null`；否则同步 require 兜底，再失败置 `failed = true` 并返回 `null`

导出 `loadMcpClient()` 与 `loadAtomicWrite()`，分别对应 `@deepseek-ai/dsh-mcp-client` 与 `@deepseek-ai/dsh-atomic-write`。

- [ ] **步骤 7：运行测试，确认其通过**

运行：`npm run build && node --test ".tsbuild/tests/profile-modules.test.mjs"`
预期：PASS，5 项测试全通过

- [ ] **步骤 8：提交**

```bash
git add package.json tsconfig.json tsconfig.tests.json .gitignore cordis.patch.yml src/profile-modules.ts src/tests/profile-modules.test.mts
git commit -m "搭建 project-mcp 插件骨架与 profile 模块加载"
```

---

### Task 2：宿主服务鸭子类型与项目根发现

**文件：**
- 新建：`src/types.ts`
- 新建：`src/discovery.ts`
- 新建：`src/tests/discovery.test.mts`

**接口：**
- 消费：无
- 产出：`src/types.ts` 导出 `Disposer`、`HostContext`、`CommandsService`、`CommandDefinitionShape`、`SystemPromptService`、`LoaderService`、`AgentShape`、`McpClientConfig`
- 产出：`findProjectRoot(cwd: string, exists: (p: string) => boolean): string`
- 产出：`readProjectMcpFile(projectRoot: string, readFile: (p: string) => string): ParseResult`
- 产出类型：`ParseResult = { kind: 'absent' } | { kind: 'invalid', reason: string } | { kind: 'ok', raw: string, servers: Record<string, unknown> }`

- [ ] **步骤 1：编写失败的测试**

新建 `src/tests/discovery.test.mts`：

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { findProjectRoot, readProjectMcpFile } from '../discovery.js'

/** 假文件系统：路径集合即"存在"。 */
function existsOf(...paths: string[]): (p: string) => boolean {
  const set = new Set(paths)
  return p => set.has(p)
}

test('findProjectRoot 向上找到最近的 .git', () => {
  const exists = existsOf('/repo/.git')
  assert.equal(findProjectRoot('/repo/a/b', exists), '/repo')
})

test('findProjectRoot 优先最近的一层', () => {
  const exists = existsOf('/outer/.git', '/outer/inner/.git')
  assert.equal(findProjectRoot('/outer/inner/deep', exists), '/outer/inner')
})

test('findProjectRoot 无 .git 时回退到 cwd 本身', () => {
  assert.equal(findProjectRoot('/no/git/here', existsOf()), '/no/git/here')
})

test('findProjectRoot 在 cwd 自身有 .git 时返回 cwd', () => {
  assert.equal(findProjectRoot('/repo', existsOf('/repo/.git')), '/repo')
})

test('readProjectMcpFile 文件不存在时返回 absent', () => {
  const result = readProjectMcpFile('/repo', () => { throw new Error('ENOENT') })
  assert.deepEqual(result, { kind: 'absent' })
})

test('readProjectMcpFile 非法 JSON 返回 invalid', () => {
  const result = readProjectMcpFile('/repo', () => '{ not json')
  assert.equal(result.kind, 'invalid')
})

test('readProjectMcpFile 顶层非对象返回 invalid', () => {
  const result = readProjectMcpFile('/repo', () => '[1,2,3]')
  assert.equal(result.kind, 'invalid')
})

test('readProjectMcpFile mcpServers 非对象返回 invalid', () => {
  const result = readProjectMcpFile('/repo', () => '{"mcpServers":"nope"}')
  assert.equal(result.kind, 'invalid')
})

test('readProjectMcpFile 缺少 mcpServers 时按空处理', () => {
  const result = readProjectMcpFile('/repo', () => '{}')
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') assert.deepEqual(result.servers, {})
})

test('readProjectMcpFile 返回原始文本用于指纹', () => {
  const text = '{"mcpServers":{"a":{"command":"x"}}}'
  const result = readProjectMcpFile('/repo', () => text)
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') assert.equal(result.raw, text)
})
```

- [ ] **步骤 2：运行测试，确认其失败**

运行：`npm run build && node --test ".tsbuild/tests/discovery.test.mjs"`
预期：FAIL，报 `../discovery.js` 不存在

- [ ] **步骤 3：实现 `src/types.ts`**

以 `deepseek-harness-zhipu_plan_tools/src/types.ts` 为模板（最小鸭子类型，不 import 任何 `@deepseek-ai` 包）。本插件需要的形状：

- `Disposer = () => void`
- `HostContext`：`get(name: string): any`、`on(event: string, listener: (...args: any[]) => void): () => void`、`effect(dispose: () => void | (() => void), label?: string): () => void`
- `CommandsService`：`register(definition: CommandDefinitionShape): Disposer`
- `CommandDefinitionShape`：`{ name: string; description: string; handler: (invocation: { agent?: AgentShape; rawInput?: string }) => unknown }`
- `SystemPromptService`：`section(section: { name: string; order?: number; text: string | ((context: unknown) => string) }): Disposer`
- `AgentShape`：`{ id: unknown; ctx: AgentContext; session: { header: { cwd?: string; parentSession?: unknown; origin?: string } } }`
- `AgentContext`：扩展 `HostContext`，**额外含 `plugin(module: unknown, config: unknown): unknown`** —— 这是任务 7 挂载 MCP 的唯一途径（`agent.ctx.plugin(McpClient, cfg)`），任务 2 按 brief 逐字实现时未加，任务 7 必须补上（见裁决）
- `McpClientConfig`：`{ transport: 'stdio'; serverName: string; command: string; args: string[]; env: Record<string, string>; cwd: string; failOnStartupError: boolean } | { transport: 'streamable-http'; serverName: string; url: string; headers: Record<string, string>; failOnStartupError: boolean }`

- [ ] **步骤 4：实现 `src/discovery.ts` 的 `findProjectRoot`**

签名：`findProjectRoot(cwd: string, exists: (p: string) => boolean): string`

算法：从 `cwd` 起逐级向上，检查 `join(current, '.git')`；命中即返回 `current`；走到父目录等于自身时返回原始 `cwd`。

用 `node:path` 的 `join`/`dirname`。`exists` 由调用方注入，便于测试且不绑定真实 fs。

- [ ] **步骤 5：实现 `src/discovery.ts` 的 `readProjectMcpFile`**

签名：`readProjectMcpFile(projectRoot: string, readFile: (p: string) => string): ParseResult`

算法：
1. `readFile(join(projectRoot, '.mcp.json'))`，抛错则返回 `{ kind: 'absent' }`
2. `JSON.parse`，抛错则返回 `{ kind: 'invalid', reason }`
3. 解析结果非普通对象（null、数组、原始值）→ `invalid`
4. `mcpServers` 缺失 → `{ kind: 'ok', raw, servers: {} }`
5. `mcpServers` 非普通对象 → `invalid`
6. 否则 `{ kind: 'ok', raw, servers }`

`reason` 必须是可读诊断，且**不得**包含文件内容（避免泄漏凭据）。

- [ ] **步骤 6：运行测试，确认其通过**

运行：`npm run build && node --test ".tsbuild/tests/discovery.test.mjs"`
预期：PASS，10 项测试全通过

- [ ] **步骤 7：提交**

```bash
git add src/types.ts src/discovery.ts src/tests/discovery.test.mts
git commit -m "添加宿主服务鸭子类型与项目根发现"
```

---

### Task 3：`.mcp.json` 条目翻译与 serverName 规范化

**文件：**
- 新建：`src/translate.ts`
- 新建：`src/tests/translate.test.mts`

**接口：**
- 消费：任务 2 的 `McpClientConfig`
- 产出：`normalizeServerName(name: string): string`
- 产出：`expandVariables(text: string, env: Record<string, string | undefined>): { value: string } | { missing: string }`
- 产出：`translateServer(name: string, entry: unknown, options: { cwd: string; env: Record<string, string | undefined> }): TranslateResult`
- 产出类型：`TranslateResult = { kind: 'ok', serverName: string, config: McpClientConfig } | { kind: 'skip', reason: string }`

- [ ] **步骤 1：编写失败的测试**

新建 `src/tests/translate.test.mts`：

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeServerName, expandVariables, translateServer } from '../translate.js'

test('normalizeServerName 保留合法名', () => {
  assert.equal(normalizeServerName('github'), 'github')
  assert.equal(normalizeServerName('my-server_2'), 'my-server_2')
})

test('normalizeServerName 把非法字符转下划线并加哈希后缀', () => {
  const result = normalizeServerName('my server!')
  assert.match(result, /^[A-Za-z0-9_-]{1,32}$/)
  assert.match(result, /^my_server_/)
})

test('normalizeServerName 结果不超 32 字符', () => {
  assert.ok(normalizeServerName('x'.repeat(80)).length <= 32)
})

test('normalizeServerName 对同一输入稳定', () => {
  assert.equal(normalizeServerName('a b'), normalizeServerName('a b'))
})

test('normalizeServerName 对不同输入产生不同结果', () => {
  assert.notEqual(normalizeServerName('a b'), normalizeServerName('a  b'))
})

test('normalizeServerName 全非法字符时回退到 server', () => {
  assert.match(normalizeServerName('!!!'), /^server_/)
})

test('expandVariables 替换已定义变量', () => {
  const result = expandVariables('${FOO}/bar', { FOO: 'baz' })
  assert.deepEqual(result, { value: 'baz/bar' })
})

test('expandVariables 使用默认值', () => {
  const result = expandVariables('${FOO:-fallback}', {})
  assert.deepEqual(result, { value: 'fallback' })
})

test('expandVariables 已定义时优先于默认值', () => {
  const result = expandVariables('${FOO:-fallback}', { FOO: 'real' })
  assert.deepEqual(result, { value: 'real' })
})

test('expandVariables 未定义且无默认值时报告变量名', () => {
  const result = expandVariables('${MISSING}', {})
  assert.deepEqual(result, { missing: 'MISSING' })
})

test('expandVariables 不把已定义值写进缺省报告', () => {
  const result = expandVariables('${SECRET}', {})
  assert.equal('value' in result, false)
  assert.equal(JSON.stringify(result).includes('SECRET'), true)
})

test('translateServer 翻译 stdio 条目', () => {
  const result = translateServer('gh', { command: 'npx', args: ['-y', 'srv'] }, { cwd: '/work', env: {} })
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.equal(result.config.transport, 'stdio')
    assert.equal(result.serverName, 'gh')
    assert.equal(result.config.cwd, '/work')
    assert.equal(result.config.failOnStartupError, false)
  }
})

test('translateServer 翻译 http 条目', () => {
  const result = translateServer('web', { type: 'http', url: 'https://x/mcp' }, { cwd: '/work', env: {} })
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') assert.equal(result.config.transport, 'streamable-http')
})

test('translateServer 接受 streamable-http 别名', () => {
  const result = translateServer('web', { type: 'streamable-http', url: 'https://x/mcp' }, { cwd: '/work', env: {} })
  assert.equal(result.kind, 'ok')
})

test('translateServer 跳过 sse 并说明原因', () => {
  const result = translateServer('s', { type: 'sse', url: 'https://x/sse' }, { cwd: '/work', env: {} })
  assert.equal(result.kind, 'skip')
  if (result.kind === 'skip') assert.match(result.reason, /sse/i)
})

test('translateServer 跳过 ws', () => {
  const result = translateServer('w', { type: 'ws', url: 'wss://x' }, { cwd: '/work', env: {} })
  assert.equal(result.kind, 'skip')
})

test('translateServer 跳过有 url 但无 type 的条目', () => {
  const result = translateServer('bad', { url: 'https://x/mcp' }, { cwd: '/work', env: {} })
  assert.equal(result.kind, 'skip')
  if (result.kind === 'skip') assert.match(result.reason, /type/)
})

test('translateServer 跳过非对象条目', () => {
  assert.equal(translateServer('n', null, { cwd: '/w', env: {} }).kind, 'skip')
  assert.equal(translateServer('n', 'str', { cwd: '/w', env: {} }).kind, 'skip')
})

test('translateServer 跳过缺 command 的 stdio 条目', () => {
  const result = translateServer('c', { args: ['x'] }, { cwd: '/w', env: {} })
  assert.equal(result.kind, 'skip')
})

test('translateServer 在变量缺失时跳过且只报变量名', () => {
  const result = translateServer('v', { command: 'npx', env: { TOKEN: '${SECRET_TOKEN}' } }, { cwd: '/w', env: {} })
  assert.equal(result.kind, 'skip')
  if (result.kind === 'skip') {
    assert.match(result.reason, /SECRET_TOKEN/)
    assert.equal(result.reason.includes('undefined'), false)
  }
})

test('translateServer 展开 env 中的变量', () => {
  const result = translateServer('e', { command: 'x', env: { K: '${V}' } }, { cwd: '/w', env: { V: 'val' } })
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok' && result.config.transport === 'stdio') assert.equal(result.config.env.K, 'val')
})

test('translateServer 使用规范化后的 serverName', () => {
  const result = translateServer('my server', { command: 'x' }, { cwd: '/w', env: {} })
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') assert.match(result.serverName, /^[A-Za-z0-9_-]{1,32}$/)
})
```

- [ ] **步骤 2：运行测试，确认其失败**

运行：`npm run build && node --test ".tsbuild/tests/translate.test.mjs"`
预期：FAIL，报 `../translate.js` 不存在

- [ ] **步骤 3：实现 `normalizeServerName`**

签名：`normalizeServerName(name: string): string`

规则（规格 §6.2）：已匹配 `/^[A-Za-z0-9_-]{1,32}$/` 则原样返回；否则 NFKD 规范化 → 非 `[A-Za-z0-9_-]` 替换 `_` → 去首尾 `_` → 截断 20 字符 → 空则用 `server` → 追加 `_` + `createHash('sha256').update(name).digest('hex').slice(0, 8)`，整体截断 32 字符。

哈希必须基于**原始 `name`**（不是 slug），保证不同原名不碰撞。

- [ ] **步骤 4：实现 `expandVariables`**

签名：`expandVariables(text: string, env: Record<string, string | undefined>): { value: string } | { missing: string }`

支持 `${VAR}` 与 `${VAR:-default}`。逐个匹配；遇到未定义且无默认值的变量立即返回 `{ missing: VAR }`（返回**变量名**，不是值）。

- [ ] **步骤 5：实现 `translateServer`**

签名见接口块。算法：

1. 条目非普通对象 → `skip`
2. 判定传输：
   - 有 `type`：`'stdio'`（或缺省时按 stdio）→ stdio 分支；`'http'`/`'streamable-http'` → http 分支；其他 → `skip` 并说明
   - 无 `type` 但有 `url` → `skip`（会被误读为 stdio）
   - 无 `type` 无 `url` → stdio 分支
3. stdio 分支：`command` 必须是非空字符串，否则 `skip`；`args` 必须是字符串数组（缺省 `[]`）；`env` 必须是字符串记录（缺省 `{}`）
4. http 分支：`url` 必须是非空字符串；`headers` 必须是字符串记录（缺省 `{}`）
5. 对 `command`、每个 `args` 元素、`env` 的键与值、`url`、`headers` 的键与值做 `expandVariables`；任一缺失 → `skip` 并只报变量名
6. 返回 `{ kind: 'ok', serverName: normalizeServerName(name), config }`，`config.failOnStartupError = false`（规格 §5.1）
7. stdio 的 `cwd` 用 `options.cwd`

`reason` 文本必须是可读诊断，且**不得**包含任何展开后的值。

- [ ] **步骤 6：运行测试，确认其通过**

运行：`npm run build && node --test ".tsbuild/tests/translate.test.mjs"`
预期：PASS，22 项测试全通过

- [ ] **步骤 7：提交**

```bash
git add src/translate.ts src/tests/translate.test.mts
git commit -m "添加 mcp.json 条目翻译与 serverName 规范化"
```

---

### Task 4：信任存储

**文件：**
- 新建：`src/trust.ts`
- 新建：`src/tests/trust.test.mts`

**接口：**
- 消费：任务 2 的 `HostContext`
- 产出：`canonicalize(raw: string): string`（规范化 JSON 文本）
- 产出：`fingerprint(raw: string): string`（返回 `sha256:<hex>`，基于规范化文本）
- 产出：`readTrustStore(readFile: (p: string) => string): TrustStore`
- 产出：`writeTrustStore(writeFile: (p: string, text: string) => void, store: TrustStore): void`
- 产出：`isApproved(store: TrustStore, projectRoot: string, fingerprint: string, serverName: string): boolean`
- 产出：`approve(store: TrustStore, projectRoot: string, fingerprint: string, servers: string[], now: string): TrustStore`
- 产出：`revoke(store: TrustStore, projectRoot: string): TrustStore`
- 产出：`trustStorePath(): string`
- 产出类型：`TrustStore = { version: 1; projects: Record<string, { approvedAt: string; fingerprint: string; servers: string[] }> }`

- [ ] **步骤 1：编写失败的测试**

新建 `src/tests/trust.test.mts`：

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { fingerprint, readTrustStore, writeTrustStore, isApproved, approve, revoke } from '../trust.js'

const EMPTY = { version: 1 as const, projects: {} }

test('fingerprint 对相同内容稳定', () => {
  assert.equal(fingerprint('{"a":1}'), fingerprint('{"a":1}'))
})

test('fingerprint 对不同内容不同', () => {
  assert.notEqual(fingerprint('{"a":1}'), fingerprint('{"a":2}'))
})

test('fingerprint 带 sha256: 前缀', () => {
  assert.match(fingerprint('x'), /^sha256:[0-9a-f]{64}$/)
})

test('fingerprint 忽略空白差异（规范化）', () => {
  assert.equal(fingerprint('{"a":1}'), fingerprint('{ "a" : 1 }'))
})

test('fingerprint 忽略键序差异（规范化）', () => {
  assert.equal(fingerprint('{"a":1,"b":2}'), fingerprint('{"b":2,"a":1}'))
})

test('fingerprint 对新增条目敏感（git pull 场景）', () => {
  const before = '{"mcpServers":{"a":{"command":"x"}}}'
  const after = '{"mcpServers":{"a":{"command":"x"},"evil":{"command":"rm -rf"}}}'
  assert.notEqual(fingerprint(before), fingerprint(after))
})

test('readTrustStore 文件缺失时返回空存储', () => {
  const store = readTrustStore(() => { throw new Error('ENOENT') })
  assert.deepEqual(store, EMPTY)
})

test('readTrustStore 损坏 JSON 时返回空存储（失败关闭）', () => {
  const store = readTrustStore(() => '{ broken')
  assert.deepEqual(store, EMPTY)
})

test('readTrustStore 未知版本号时返回空存储', () => {
  const store = readTrustStore(() => '{"version":99,"projects":{"/p":{"approvedAt":"t","fingerprint":"f","servers":["a"]}}}')
  assert.deepEqual(store, EMPTY)
})

test('readTrustStore 结构损坏时返回空存储', () => {
  assert.deepEqual(readTrustStore(() => '{"version":1,"projects":"nope"}'), EMPTY)
  assert.deepEqual(readTrustStore(() => '[1,2]'), EMPTY)
})

test('readTrustStore 读取合法存储', () => {
  const text = '{"version":1,"projects":{"/p":{"approvedAt":"t","fingerprint":"f","servers":["a"]}}}'
  const store = readTrustStore(() => text)
  assert.equal(store.projects['/p']?.servers[0], 'a')
})

test('writeTrustStore 输出可被 readTrustStore 读回', () => {
  let written = ''
  const next = approve(EMPTY, '/p', 'fp1', ['a', 'b'], '2026-01-01T00:00:00.000Z')
  writeTrustStore((_p, text) => { written = text }, next)
  const read = readTrustStore(() => written)
  assert.deepEqual(read, next)
})

test('isApproved 在指纹匹配且服务器在列时返回 true', () => {
  const store = approve(EMPTY, '/p', 'fp1', ['a'], 't')
  assert.equal(isApproved(store, '/p', 'fp1', 'a'), true)
})

test('isApproved 在指纹不匹配时返回 false', () => {
  const store = approve(EMPTY, '/p', 'fp1', ['a'], 't')
  assert.equal(isApproved(store, '/p', 'fp2', 'a'), false)
})

test('isApproved 在服务器未被批准时返回 false', () => {
  const store = approve(EMPTY, '/p', 'fp1', ['a'], 't')
  assert.equal(isApproved(store, '/p', 'fp1', 'b'), false)
})

test('isApproved 在项目未知时返回 false', () => {
  assert.equal(isApproved(EMPTY, '/p', 'fp1', 'a'), false)
})

test('approve 覆盖同项目的旧指纹', () => {
  const first = approve(EMPTY, '/p', 'fp1', ['a'], 't1')
  const second = approve(first, '/p', 'fp2', ['b'], 't2')
  assert.equal(second.projects['/p']?.fingerprint, 'fp2')
  assert.deepEqual(second.projects['/p']?.servers, ['b'])
  assert.equal(second.projects['/p']?.approvedAt, 't2')
})

test('approve 不改动其他项目', () => {
  const first = approve(EMPTY, '/a', 'fp', ['x'], 't')
  const second = approve(first, '/b', 'fp', ['y'], 't')
  assert.deepEqual(second.projects['/a'], first.projects['/a'])
})

test('approve 不修改入参对象', () => {
  const before = JSON.stringify(EMPTY)
  approve(EMPTY, '/p', 'fp', ['a'], 't')
  assert.equal(JSON.stringify(EMPTY), before)
})

test('revoke 移除项目条目', () => {
  const store = approve(EMPTY, '/p', 'fp', ['a'], 't')
  assert.deepEqual(revoke(store, '/p'), EMPTY)
})

test('revoke 对未知项目是空操作', () => {
  assert.deepEqual(revoke(EMPTY, '/nope'), EMPTY)
})
```

- [ ] **步骤 2：运行测试，确认其失败**

运行：`npm run build && node --test ".tsbuild/tests/trust.test.mjs"`
预期：FAIL，报 `../trust.js` 不存在

- [ ] **步骤 3：实现规范化与指纹**

`canonicalize(raw)`：`JSON.parse` 后递归序列化——对象键按字典序排序，数组保序，无多余空白。解析失败时返回 `raw` 本身（调用方已在 `readProjectMcpFile` 校验过合法性，此处只作防御）。

`fingerprint(raw)` 对 `canonicalize(raw)` 的结果做 `createHash('sha256').update(text, 'utf8').digest('hex')`，返回 `sha256:<hex>`。

**规范化是安全属性**（规格 §7.2）：剔除纯格式差异，避免"仅调整缩进"就要求重新批准；同时对内容变更（含新增条目）保持敏感。

`trustStorePath()` 返回 `${DSH_HOME}/project-mcp-trust.json`，其中 home 从 `process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')` 解析（与 `profile-modules.ts` 的 `profileDir` 同源逻辑）。

- [ ] **步骤 4：实现读写**

`readTrustStore(readFile)`：读取失败、JSON 解析失败、`version !== 1`、`projects` 非对象、任一项目条目结构不符 → 一律返回 `EMPTY`（失败关闭，规格 §7.4）。

`writeTrustStore(writeFile, store)`：`JSON.stringify(store, null, 2)`。写盘的实际实现（原子写 + `0600`）由调用方在任务 6 注入。

- [ ] **步骤 5：实现查询与变更**

`isApproved(store, projectRoot, fp, serverName)`：查 `store.projects[projectRoot]`，比对 `fingerprint === fp` 且 `servers.includes(serverName)`。

`approve(...)` / `revoke(...)`：返回**新对象**，不修改入参（浅拷贝 `projects`）。

- [ ] **步骤 6：运行测试，确认其通过**

运行：`npm run build && node --test ".tsbuild/tests/trust.test.mjs"`
预期：PASS，21 项测试全通过

- [ ] **步骤 7：提交**

```bash
git add src/trust.ts src/tests/trust.test.mts
git commit -m "添加信任存储与指纹绑定"
```

---

### Task 5：全局 MCP 行检测

**文件：**
- 新建：`src/global-rows.ts`
- 新建：`src/tests/global-rows.test.mts`

**接口：**
- 消费：任务 2 的 `HostContext`
- 产出：`collectGlobalServerNames(loader: unknown): Set<string>`

- [ ] **步骤 1：编写失败的测试**

新建 `src/tests/global-rows.test.mts`：

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { collectGlobalServerNames } from '../global-rows.js'

/**
 * 构造一个真实 Loader 形状：`entries()` 在 Loader 本体上（Loader extends
 * EntryTree），不在 `loader.root`（那是 EntryGroup，没有 entries）。
 * 条目形状是 `{ options: { name, config } }`，与 DSH 自身生产代码一致
 * （packages/extensions/tool-cordis/src/config.ts:102 用 `[...loader.entries()]`，
 * 同文件 :75 按 `entry.options.name` 取名）。
 */
function loaderOf(entries: Array<{ name: string; config?: unknown }>): unknown {
  return { entries: () => entries.map(options => ({ options })) }
}

test('收集 mcp-client 行的 serverName', () => {
  const loader = loaderOf([
    { name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'github' } },
    { name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'memory' } },
  ])
  assert.deepEqual([...collectGlobalServerNames(loader)].sort(), ['github', 'memory'])
})

test('忽略非 mcp-client 行', () => {
  const loader = loaderOf([
    { name: '@deepseek-ai/dsh-tools' },
    { name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'x' } },
  ])
  assert.deepEqual([...collectGlobalServerNames(loader)], ['x'])
})

test('忽略缺 serverName 的 mcp-client 行', () => {
  const loader = loaderOf([{ name: '@deepseek-ai/dsh-mcp-client', config: {} }])
  assert.deepEqual([...collectGlobalServerNames(loader)], [])
})

test('忽略 serverName 非字符串的行', () => {
  const loader = loaderOf([{ name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 42 } }])
  assert.deepEqual([...collectGlobalServerNames(loader)], [])
})

test('loader 为 undefined 时返回空集', () => {
  assert.deepEqual([...collectGlobalServerNames(undefined)], [])
})

test('loader 形状不符时返回空集，不抛异常', () => {
  assert.deepEqual([...collectGlobalServerNames({})], [])
  assert.deepEqual([...collectGlobalServerNames({ entries: 'nope' })], [])
})

test('entries() 抛错时返回空集，不抛异常', () => {
  const loader = { entries: () => { throw new Error('boom') } }
  assert.deepEqual([...collectGlobalServerNames(loader)], [])
})

test('条目缺 options 或 options 形状不符时被忽略，不抛异常', () => {
  const loader = { entries: () => [null, 42, {}, { options: null }, { options: {} }] }
  assert.deepEqual([...collectGlobalServerNames(loader)], [])
})

test('嵌套子树的条目也被收集', () => {
  const child = { options: { name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'nested' } } }
  const parent = { options: { name: 'group' }, subtree: { entries: () => [child] } }
  const loader = { entries: () => [parent] }
  assert.deepEqual([...collectGlobalServerNames(loader)].sort(), ['nested'])
})
```

- [ ] **步骤 2：运行测试，确认其失败**

运行：`npm run build && node --test ".tsbuild/tests/global-rows.test.mjs"`
预期：FAIL，报 `../global-rows.js` 不存在

- [ ] **步骤 3：实现 `collectGlobalServerNames`**

签名：`collectGlobalServerNames(loader: unknown): Set<string>`

算法：
1. 防御性取 `loader.entries`，非函数则返回空集
2. 调 `entries()`，抛错则返回空集
3. 遍历条目，取 `entry.options`；非对象则跳过
4. `options.name === '@deepseek-ai/dsh-mcp-client'` 且 `options.config.serverName` 是非空字符串 → 加入集合

**关于子树递归**（本节曾两次写错，以下为实测结论）：

- **夹具需要递归**：本任务的假 Loader 夹具是 `{ entries: () => [parent] }`，它**不**调用 `parent.subtree.entries()`——即夹具并未模拟真实 Loader 的摊平语义。因此"嵌套子树"用例要求实现侧下降 `entry.subtree`；只遍历一层会让该用例失败（实测 `[]` vs `['nested']`）。
- **真实 Loader 上这层下降是冗余的**：`EntryTree.entries()` 自身已递归嵌套子树（`vendor/loader/src/config/tree.ts:26-33`，第 31 行 `yield* entry.subtree.entries()`）。
- **但下降必须配 `visited` 去重**，否则在真实 Loader 上指数爆炸：祖先树已摊平一次、本函数再逐层下降，深度 d 的树被展开约 2^d 次（实测深度 5 → 32 次、深度 10 → 1024 次、深度 15 → 32768 次；深度 50 在 120 秒内不返回，会挂死会话创建路径）。加 `visited` 后每棵树最多展开一次，深度 1000 仅 1001 次。
- 设计理由：入参是 `unknown`，契约上不假设 `entries()` 一定返回摊平视图。多走一遍的代价可忽略，而漏掉嵌套子树里的全局行恰恰会导致规格 §8.2 要防的静默遮蔽。

**关于条目字段访问**：`options.config` 是**可选**的。若写成 `options.config.serverName`，一条只写 `name` 的 mcp-client 行就会抛 `TypeError`，被外层 catch 整体吞掉、**已收集的名字一并丢失**——撞名保护被整体关闭。必须逐行独立降级（`isPlainObject(config) ? config.serverName : undefined`）。

**必须按需调用，不缓存**（规格 §8.1：Loader 没有覆盖"已有条目改配置"的事件，缓存会在 HMR 后失效）。

**关键**：`entries()` 在 **Loader 本体**上，不在 `loader.root` 上。`Loader extends EntryTree`（`vendor/loader/src/index.ts:77`）故有 `entries()`；`loader.root` 是 `EntryGroup`（`vendor/loader/src/config/group.ts:6-72`），只有 create/unlink/remove/update/stop。条目形状是 `{ options: { name, config } }`。

`entries()` 是读 `this.store` 的生成器方法，必须以 `tree` 为接收者调用（`entries.call(tree)`）——脱开接收者会抛 `TypeError`。

- [ ] **步骤 4：运行测试，确认其通过**

运行：`npm run build && node --test ".tsbuild/tests/global-rows.test.mjs"`
预期：PASS，9 项测试全通过

- [ ] **步骤 5：提交**

```bash
git add src/global-rows.ts src/tests/global-rows.test.mts
git commit -m "添加全局 MCP 行检测"
```

---

### Task 6：会话挂载流程

**文件：**
- 新建：`src/session.ts`
- 新建：`src/tests/session.test.mts`

**接口：**
- 消费：任务 2 的 `findProjectRoot`/`readProjectMcpFile`、任务 3 的 `translateServer`、任务 4 的 `fingerprint`/`isApproved`、任务 5 的 `collectGlobalServerNames`
- 产出：`planSessionMount(input: SessionMountInput): SessionMountPlan`
- 产出类型：`SessionMountInput`、`SessionMountPlan`（见步骤 3）

- [ ] **步骤 1：编写失败的测试**

新建 `src/tests/session.test.mts`：

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { planSessionMount } from '../session.js'
import { approve, fingerprint } from '../trust.js'

const EMPTY_TRUST = { version: 1 as const, projects: {} }

function inputOf(overrides: Partial<Parameters<typeof planSessionMount>[0]> = {}) {
  return {
    header: { cwd: '/repo/sub' },
    projectExists: (p: string) => p === '/repo/.git',
    readFile: () => '{"mcpServers":{"gh":{"command":"npx","args":["-y","srv"]}}}',
    trust: EMPTY_TRUST,
    globalServers: new Set<string>(),
    env: {},
    ...overrides,
  }
}

test('无 cwd 时跳过', () => {
  const plan = planSessionMount(inputOf({ header: {} }))
  assert.equal(plan.kind, 'skip')
})

test('子代理被跳过', () => {
  const plan = planSessionMount(inputOf({ header: { cwd: '/repo', origin: 'subagent' } }))
  assert.equal(plan.kind, 'skip')
  if (plan.kind === 'skip') assert.match(plan.reason, /subagent/i)
})

test('有 parentSession 的会话被跳过', () => {
  const plan = planSessionMount(inputOf({ header: { cwd: '/repo', parentSession: 'p1' } }))
  assert.equal(plan.kind, 'skip')
})

test('无 .mcp.json 时静默跳过', () => {
  const plan = planSessionMount(inputOf({ readFile: () => { throw new Error('ENOENT') } }))
  assert.equal(plan.kind, 'skip')
  if (plan.kind === 'skip') assert.equal(plan.silent, true)
})

test('未信任时不挂载任何服务器', () => {
  const plan = planSessionMount(inputOf())
  assert.equal(plan.kind, 'untrusted')
  if (plan.kind === 'untrusted') assert.deepEqual(plan.pending, ['gh'])
})

test('已信任时产出挂载配置', () => {
  const raw = '{"mcpServers":{"gh":{"command":"npx","args":["-y","srv"]}}}'
  const trust = approve(EMPTY_TRUST, '/repo', fingerprint(raw), ['gh'], 't')
  const plan = planSessionMount(inputOf({ trust }))
  assert.equal(plan.kind, 'mount')
  if (plan.kind === 'mount') {
    assert.equal(plan.configs.length, 1)
    assert.equal(plan.configs[0]?.serverName, 'gh')
    assert.equal(plan.configs[0]?.failOnStartupError, false)
  }
})

test('指纹不匹配时回到未信任（文件被改）', () => {
  const trust = approve(EMPTY_TRUST, '/repo', 'sha256:deadbeef', ['gh'], 't')
  const plan = planSessionMount(inputOf({ trust }))
  assert.equal(plan.kind, 'untrusted')
})

test('与全局行撞名的服务器被跳过', () => {
  const raw = '{"mcpServers":{"gh":{"command":"npx"},"other":{"command":"x"}}}'
  const trust = approve(EMPTY_TRUST, '/repo', fingerprint(raw), ['gh', 'other'], 't')
  const plan = planSessionMount(inputOf({
    readFile: () => raw,
    trust,
    globalServers: new Set(['gh']),
  }))
  assert.equal(plan.kind, 'mount')
  if (plan.kind === 'mount') {
    assert.deepEqual(plan.configs.map(c => c.serverName), ['other'])
    assert.equal(plan.skipped.length, 1)
    assert.match(plan.skipped[0]?.reason ?? '', /全局|global/i)
  }
})

test('损坏的 .mcp.json 不挂载且给出诊断', () => {
  const plan = planSessionMount(inputOf({ readFile: () => '{ broken' }))
  assert.equal(plan.kind, 'invalid')
})

test('结构错误的 .mcp.json 不抛异常', () => {
  const plan = planSessionMount(inputOf({ readFile: () => '[1,2,3]' }))
  assert.equal(plan.kind, 'invalid')
})

test('全部候选被跳过时不要求批准', () => {
  const raw = '{"mcpServers":{"gh":{"command":"npx"}}}'
  const trust = approve(EMPTY_TRUST, '/repo', fingerprint(raw), ['gh'], 't')
  const plan = planSessionMount(inputOf({
    readFile: () => raw,
    trust,
    globalServers: new Set(['gh']),
  }))
  assert.equal(plan.kind, 'skip')
  if (plan.kind === 'skip') assert.equal(plan.skipped?.length, 1)
})

test('规范化后重名的条目被去重', () => {
  // normalizeServerName('a b') === normalizeServerName('a_b_c8687a08') === 'a_b_c8687a08'
  const raw = '{"mcpServers":{"a b":{"command":"x"},"a_b_c8687a08":{"command":"y"}}}'
  const trust = approve(EMPTY_TRUST, '/repo', fingerprint(raw), ['a_b_c8687a08'], 't')
  const plan = planSessionMount(inputOf({ readFile: () => raw, trust }))
  assert.equal(plan.kind, 'mount')
  if (plan.kind === 'mount') {
    assert.equal(plan.configs.length, 1)
    assert.equal(plan.skipped.length, 1)
    assert.match(plan.skipped[0]?.reason ?? '', /重名|duplicate/)
  }
})

test('未知传输的服务器被跳过，其余照常挂载', () => {
  const raw = '{"mcpServers":{"bad":{"type":"sse","url":"https://x"},"good":{"command":"x"}}}'
  const trust = approve(EMPTY_TRUST, '/repo', fingerprint(raw), ['bad', 'good'], 't')
  const plan = planSessionMount(inputOf({ readFile: () => raw, trust }))
  assert.equal(plan.kind, 'mount')
  if (plan.kind === 'mount') {
    assert.deepEqual(plan.configs.map(c => c.serverName), ['good'])
    assert.equal(plan.skipped.length, 1)
  }
})

test('变量缺失的服务器被跳过且诊断不含变量值', () => {
  const raw = '{"mcpServers":{"v":{"command":"x","env":{"T":"${MISSING_VAR}"}}}}'
  const trust = approve(EMPTY_TRUST, '/repo', fingerprint(raw), ['v'], 't')
  const plan = planSessionMount(inputOf({ readFile: () => raw, trust }))
  assert.equal(plan.kind, 'mount')
  if (plan.kind === 'mount') {
    assert.equal(plan.configs.length, 0)
    assert.match(plan.skipped[0]?.reason ?? '', /MISSING_VAR/)
  }
})
```

- [ ] **步骤 2：运行测试，确认其失败**

运行：`npm run build && node --test ".tsbuild/tests/session.test.mjs"`
预期：FAIL，报 `../session.js` 不存在

- [ ] **步骤 3：定义输入输出类型**

```ts
export interface SessionMountInput {
  header: { cwd?: string; parentSession?: unknown; origin?: string }
  projectExists: (p: string) => boolean
  readFile: (p: string) => string
  trust: TrustStore
  globalServers: Set<string>
  env: Record<string, string | undefined>
}

export type SessionMountPlan =
  | { kind: 'skip'; reason: string; silent?: boolean; skipped?: Array<{ name: string; reason: string }> }
  | { kind: 'invalid'; reason: string }
  | { kind: 'untrusted'; projectRoot: string; fingerprint: string; pending: string[] }
  | { kind: 'mount'; projectRoot: string; fingerprint: string; configs: McpClientConfig[]; skipped: Array<{ name: string; reason: string }> }
```

- [ ] **步骤 4：实现 `planSessionMount`**

纯函数，不做任何 I/O——所有副作用由调用方注入，便于测试。算法（规格 §5）：

1. `header.cwd` 缺失 → `skip`
2. `header.parentSession !== undefined || header.origin === 'subagent'` → `skip`（子代理，规格 §9）
3. `findProjectRoot(cwd, projectExists)`
4. `readProjectMcpFile(projectRoot, readFile)`：`absent` → `skip` 且 `silent: true`；`invalid` → `invalid`
5. `fp = fingerprint(raw)`
6. 遍历 `servers`，对每个名字：`translateServer` → 收集 `candidates`（翻译成功项）与 `skipped`（翻译失败项，含原因）
7. **对 `candidates` 按规范化后的 `serverName` 去重**：用一个 `Set<string>` 记录已用名，重复项记入 `skipped`，理由含"重名"/"duplicate"（规格 §6.2 规则 4）
8. 从 `candidates` 中剔除与 `globalServers` 撞名的条目，记入 `skipped`，理由含"全局"/"global"
9. **翻译出过候选、但全部被去重或撞名过滤掉** → 返回 `{ kind: 'skip', reason: ... }`（附 `skipped` 供诊断）。此时**不得**返回 `untrusted`——这些服务器本身可挂载，只是被全局行遮蔽或彼此重名，要求用户批准一批永远不会挂载的服务器名毫无意义。
10. 用 `isApproved(trust, projectRoot, fp, 规范化名)` 过滤 `mountable` 得到 `approved`
11. 若 `approved` 为空**且 `mountable` 非空** → `untrusted`，`pending` 列出**全部 `mountable` 的名字**（即真正需要批准的那些）
12. 否则 → `mount`，`configs` 只含 `approved`

**为什么第 7 步去重是必需的**：`normalizeServerName` 的哈希后缀只保证**不同原名**不碰撞，但一个**已经长得像规范化结果**的键会与规范化产物相同。实测：`normalizeServerName('a b') === 'a_b_c8687a08'` 且 `normalizeServerName('a_b_c8687a08') === 'a_b_c8687a08'`。若两条都进入 `configs`，`@deepseek-ai/dsh-mcp-client` 的第二个实例会在 `apply` 内抛错（`packages/mcp/mcp-client/src/index.ts:169-173`，"serverName ... is already in use"），导致该实例不生效、`/mcp-project` 展示与实际挂载结果不一致。去重让行为确定且可诊断。先到者胜。

**第 9 步与第 12 步的区分（本处曾自相矛盾，以下为澄清后的规则）**：

两种"零可挂载项"的情形必须区分，判据是**翻译阶段是否产出过候选**：

| 情形 | `candidates` | `mountable` | 结果 |
| --- | --- | --- | --- |
| 翻译全失败（传输不支持、变量缺失、条目非法） | 空 | 空 | **`mount` + `configs: []`** |
| 翻译有候选，但全被去重/撞名过滤 | 非空 | 空 | **`skip`** |
| 有候选、有 mountable，但一条都没批准 | 非空 | 非空 | **`untrusted`** |
| 有已批准项 | 非空 | 非空 | **`mount`** |

两者的共同原则是"没有可挂载项时不要求批准"；区别只在计划形状：翻译全失败时这份文件根本没有可用服务器（规格 §12「单条非法 → 跳过该条，其余照常」，没有"其余"时就是挂载零条），故仍是 `mount`。

**连带影响**：`kind === 'mount'` **可以携带空 `configs`**。任务 7 的 `renderNotice` 对 `mount` 返回 `''`，故"文件里一条可用服务器都没有"不会注入会话提示，只在 `/mcp-project` 里由 `skipped` 呈现。

**注意**：第 10 步的 `serverName` 必须是 `translateServer` 返回的**规范化名**，与信任存储中记录的一致。

`skip` 分支需携带 `skipped` 数组以便 `/mcp-project` 展示原因；为此扩展类型：

```ts
| { kind: 'skip'; reason: string; silent?: boolean; skipped?: Array<{ name: string; reason: string }> }
```

- [ ] **步骤 5：运行测试，确认其通过**

运行：`npm run build && node --test ".tsbuild/tests/session.test.mjs"`
预期：PASS，14 项测试全通过

- [ ] **步骤 6：提交**

```bash
git add src/session.ts src/tests/session.test.mts
git commit -m "添加会话挂载决策"
```

---

### Task 7：命令、提示与插件装配

**文件：**
- 新建：`src/commands.ts`
- 新建：`src/notice.ts`
- 新建：`src/index.ts`
- 新建：`src/tests/plugin-smoke.test.mts`

**接口：**
- 消费：任务 1 的 `loadMcpClient`/`loadAtomicWrite`、任务 4 的信任函数、任务 5、任务 6
- 产出：`apply(ctx: HostContext, config: unknown): void`（插件入口）
- 产出：`registerCommands(ctx: HostContext, deps: CommandDeps): Disposer`
- 产出：`renderNotice(plan: SessionMountPlan, projectRoot: string): string`

- [ ] **步骤 1：编写失败的测试**

新建 `src/tests/plugin-smoke.test.mts`。仿照 `deepseek-harness-zhipu_plan_tools/src/tests/plugin-smoke.test.mts` 的"假 ctx"手法：

```ts
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
```

- [ ] **步骤 2：运行测试，确认其失败**

运行：`npm run build && node --test ".tsbuild/tests/plugin-smoke.test.mjs"`
预期：FAIL，报 `../index.js` 不存在

- [ ] **步骤 3：实现 `src/notice.ts`**

`renderNotice(plan, projectRoot)`：只有 `kind === 'untrusted'` 与 `kind === 'invalid'` 返回非空文本；`skip` 与 `mount` 返回 `''`。

- `untrusted`：说明项目路径、待批准的服务器名、用 `/mcp-project trust` 批准。
- `invalid`：说明项目路径与该文件无法解析，本会话未启用任何项目级 MCP。

两者都**不得**包含任何 `.mcp.json` 内容或环境变量值。

`skip` 携带的 `skipped` 原因只由 `/mcp-project` 展示，不进入会话提示（`.mcp.json` 不存在时按规格 §12 静默）。

- [ ] **步骤 4：实现 `src/commands.ts`**

`registerCommands(ctx, deps)` 注册四个命令，名字均为 `mcp-project`（DSH 命令注册以 `name` 为键；子动作通过 `rawInput` 解析，与 Claude Code 的 `/cmd arg` 一致）：

- `/mcp-project` → 列出当前项目的服务器与状态
- `/mcp-project trust` → 批准整个文件并**立即挂载进当前会话**
- `/mcp-project trust <name>…` → 只批准指定服务器
- `/mcp-project untrust` → 撤销并卸载

命令名必须匹配 `/^[a-z][a-z0-9_-]*$/u`。

批准后立即生效的实现：调用 `deps.mountInto(agent, configs)`，由 `index.ts` 注入（内部执行 `agent.ctx.plugin(McpClient, cfg)`）。重复批准必须幂等——先检查该 `serverName` 是否已挂载。

- [ ] **步骤 5：实现 `src/index.ts`**

`apply(ctx, config)`：

1. `const McpClient = loadMcpClient()`；为 `null` 则记错误并注册命令以外的空装配（安全侧：宁可不挂）
2. 读信任存储（注入真实 fs 读）
3. `registerCommands(ctx, deps)`
4. `ctx.on('agent/created', async ({ agent }) => { ... })`：取 `agent.session.header`，`collectGlobalServerNames(ctx.get('loader'))`，`planSessionMount(...)`，按计划挂载或注入提示
5. 挂载用 `agent.ctx.plugin(McpClient, cfg)`，**不 await 连接**（规格 §5.1）
6. 所有注册走 `ctx.effect` 以便可逆清理

`config` 目前无需字段（`.mcp.json` 即配置源），但保留 `Config` schema 占位以符合 Loader 行约定。

- [ ] **步骤 6：运行测试，确认其通过**

运行：`npm run build && node --test ".tsbuild/tests/plugin-smoke.test.mjs"`
预期：PASS，6 项测试全通过

- [ ] **步骤 7：运行完整测试套件**

运行：`npm test`
预期：全部 7 个测试文件通过（profile-modules、discovery、translate、trust、global-rows、session、plugin-smoke）

- [ ] **步骤 8：提交**

```bash
git add src/commands.ts src/notice.ts src/index.ts src/tests/plugin-smoke.test.mts
git commit -m "装配 project-mcp 插件入口与命令"
```

---

### Task 8：文档

**文件：**
- 新建：`README.md`、`README.en.md`、`AGENTS.md`
- 新建：`docs/behavior.md`、`docs/development.md`、`docs/troubleshooting.md`
- 修改：工作区根 `AGENTS.md`（项目索引表加一行）、`docs/README.md`（项目专属文档索引加一行）

**接口：**
- 消费：全部前置任务
- 产出：无代码接口

- [ ] **步骤 1：写 `README.md` 与 `README.en.md`**

面向用户：功能、环境要求、安装（`dsh plugin --profile web add "link:<绝对路径>"`）、`.mcp.json` 格式、信任批准流程、卸载、数据边界（信任文件位置与内容）。

按工作区约定：不得写入本机绝对路径；用 `${DSH_HOME:-~/.dsh}` 形式。

- [ ] **步骤 2：写 `docs/behavior.md`**

用户可见行为：`.mcp.json` 各字段语义、传输支持矩阵（含 sse/ws 不支持）、serverName 规范化规则与工具名映射、信任模型与指纹语义、四个命令的确切行为、失败模式与跳过原因、与全局 MCP 行的关系。

- [ ] **步骤 3：写 `docs/development.md`**

源码地图（模块职责表）、依赖策略（§4.2 的完整说明）、构建与测试命令、Peer 解析契约、验证分层。

- [ ] **步骤 4：写 `docs/troubleshooting.md`**

按症状：工具没出现（未批准 / 指纹变了 / 撞名 / 传输不支持 / 变量缺失）、连接失败、信任文件损坏、想撤销批准。

- [ ] **步骤 5：写 `AGENTS.md`**

红线（不 import `@deepseek-ai/*`、不写本机绝对路径、展开值不入日志）、源码地图摘要、本地验证命令、文档职责表。**不超过 200 行。**

- [ ] **步骤 6：更新工作区索引**

在根 `AGENTS.md` 的项目导航表与 `docs/README.md` 的项目专属文档索引表中各加一行 `deepseek-harness-project-mcp`。按既有格式，保持表格列数一致。

- [ ] **步骤 7：验证链接与行数**

运行：
```powershell
(Get-Content AGENTS.md).Count
```
预期：≤ 200

逐一确认 `AGENTS.md` 与 `docs/*.md` 中的相对链接目标存在。

- [ ] **步骤 8：提交**

```bash
git add README.md README.en.md AGENTS.md docs/
git commit -m "添加 project-mcp 用户与开发文档"
```

---

## 完成标准

- [ ] `npm test` 全部通过（6 个测试文件）
- [ ] `npm run typecheck` 无错误
- [ ] `dependencies` 与 `peerDependencies` 中不含任何 `@deepseek-ai/*`
- [ ] `AGENTS.md` ≤ 200 行
- [ ] 文档中无本机绝对路径
- [ ] Review Focus 五项均有对应测试

## 未纳入本计划

规格 §15 列出的实现期实测项（`clear`/`compact` source 下的幂等性、非阻塞挂载的 fiber 清理、从 `agent.ctx` 遍历 Loader 树的完整性）需要在真实 DSH profile 中验证，无法在纯单元测试中覆盖。执行者在任务 7 完成后应单独在真实环境验证并记录结论。
