/**
 * 会话挂载决策（规格 §5）。
 *
 * 纯函数、零 I/O：`projectExists` / `readFile` / `trust` / `globalServers` / `env`
 * 全部由调用方注入，本模块不 import `node:fs`。因此决策可被彻底单测，且"未批准时
 * 不挂载任何服务器"这条安全断言能被确定性验证（规格 §13.4）。
 *
 * 本模块只产出**计划**，不产生副作用：真实读盘、写信任存储、`ctx.plugin()` 挂载
 * 都由任务 7 的装配层执行。
 */
import { findProjectRoot, readProjectMcpFile } from './discovery.js'
import { translateServer } from './translate.js'
import { fingerprint, isApproved } from './trust.js'
import type { TrustStore } from './trust.js'
import type { McpClientConfig } from './types.js'

export interface SessionMountInput {
  /**
   * 会话 header 的最小投影。
   *
   * `parentSession` 只作为**形状**保留（真实 header 里存在该字段，测试夹具也用它构造
   * 分叉会话），**不是**判据——见 `planSessionMount` 第 2 步。
   */
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

/** 翻译成功、进入后续过滤的条目：保留原名用于诊断（规格 §6.2 要求显示原名与规范名）。 */
interface Candidate {
  originalName: string
  serverName: string
  config: McpClientConfig
}

/** 被跳过的服务器及原因，供 `/mcp-project` 展示。 */
type SkipNote = { name: string; reason: string }

export function planSessionMount(input: SessionMountInput): SessionMountPlan {
  const { cwd, origin } = input.header

  // 1. 没有工作区就无从定位项目（规格 §5）。
  if (cwd === undefined) return { kind: 'skip', reason: '会话没有工作区（header.cwd 缺失）' }

  // 2. 子代理与父会话共享工作区，重复建连接与子进程没有意义（规格 §9）。
  //
  //    判据是 `origin === 'subagent'` **单条**，`parentSession` 不参与。原因：分叉会话
  //    （fork）也会写 `parentSession`，但它**不带** `origin`，是独立会话——DSH 注释
  //    "A fork shares the lineage field without the origin and is an independent
  //    conversation"（`packages/subagent/subagent/src/archive-admission.ts:45-46`），
  //    fork 的创建路径只写 `parentSession: source.header.id`
  //    （`packages/api/session-controller/src/commands.ts:274-281`）。仓库既有的正确判据
  //    同样是"两者都要"：`archive-admission.ts:53` 写
  //    `if (parentSession === undefined || origin !== 'subagent') continue`。
  //
  //    旧实现用 `parentSession !== undefined || origin === 'subagent'`，把用户可见的
  //    分叉会话误判成子代理：既不挂载项目 MCP，也不注入提示（skip 是静默的），
  //    `/mcp-project` 还会给出错误理由。
  if (origin === 'subagent') {
    return { kind: 'skip', reason: '子代理会话（origin=subagent）不挂载项目 MCP' }
  }

  // 3. 从工作区向上找项目根；走到根都没有则用 cwd 本身。
  const projectRoot = findProjectRoot(cwd, input.projectExists)

  // 4. 读并解析 `<projectRoot>/.mcp.json`。
  const parsed = readProjectMcpFile(projectRoot, input.readFile)
  if (parsed.kind === 'absent') {
    // 规格 §12：没有 .mcp.json 是正常情形，静默跳过，不打扰用户。
    return { kind: 'skip', reason: `${projectRoot} 下没有 .mcp.json`, silent: true }
  }
  if (parsed.kind === 'invalid') return { kind: 'invalid', reason: parsed.reason }

  // 5. 指纹绑定文件的确切内容，`git pull` 带来的任何改动都会改变它（规格 §7.2）。
  const fp = fingerprint(parsed.raw)

  // 6. 逐条翻译。诊断只含原因与变量名，绝不含展开后的值（规格 §10）。
  //    `cwd` 传会话工作区而不是项目根：与规格 §6 的 stdio 行一致，服务器以用户
  //    实际所在目录为工作目录。
  const candidates: Candidate[] = []
  const skipped: SkipNote[] = []
  for (const [name, entry] of Object.entries(parsed.servers)) {
    const result = translateServer(name, entry, { cwd, env: input.env })
    if (result.kind === 'ok') {
      candidates.push({ originalName: name, serverName: result.serverName, config: result.config })
    } else {
      skipped.push({ name, reason: result.reason })
    }
  }

  // 7. 按规范化名去重（规格 §6.2 规则 4）。必须先于撞名过滤：碰撞是规范化的产物，
  //    不消除就会让两条同名配置进入 `configs`，第二个 mcp-client 实例会在 apply 内
  //    抛"serverName ... is already in use"，实例不生效且 /mcp-project 与实际不符。
  //    先到者胜，后者记入 skipped。
  const claimedBy = new Map<string, string>()
  const unique: Candidate[] = []
  for (const candidate of candidates) {
    const first = claimedBy.get(candidate.serverName)
    if (first !== undefined) {
      skipped.push({
        name: candidate.originalName,
        reason: `规范化后与「${first}」重名（同为 ${candidate.serverName}），跳过`,
      })
      continue
    }
    claimedBy.set(candidate.serverName, candidate.originalName)
    unique.push(candidate)
  }

  // 8. 剔除与全局 MCP 行撞名的条目（规格 §8.2）。agent 作用域的同名服务器会静默
  //    遮蔽全局的，还会多 spawn 一个子进程；"全局有的本地就不要启动"更符合预期。
  const mountable: Candidate[] = []
  for (const candidate of unique) {
    if (input.globalServers.has(candidate.serverName)) {
      skipped.push({
        name: candidate.originalName,
        reason: `与全局 MCP 行同名（${candidate.serverName}），已被全局配置提供，跳过`,
      })
      continue
    }
    mountable.push(candidate)
  }

  // 9. 翻译出过候选、但全部被去重/撞名过滤掉 → 这些服务器本身是可挂载的，只是被
  //    全局行遮蔽或彼此重名，本会话无可挂载项。此时**不得**返回 `untrusted`：要求
  //    用户批准一批永远不会挂载的服务器名毫无意义（规格 §8.2 / §6.2 规则 4 的结果
  //    已由 `skipped` 逐条说明，用户不需要为此做任何事）。
  //
  //    注意区分下面第 12 步的情形：**翻译阶段一条候选都没产出**（传输不支持、变量
  //    缺失、条目非法）时同样没有可挂载项，但那种情形不是"被过滤掉"，而是"这份文件
  //    根本没有可用服务器"——按同一原则同样不要求批准，只是计划形状是 `mount`
  //    加空 `configs`（规格 §12「单条非法 → 跳过该条，其余照常」；没有"其余"时就是
  //    挂载零条），而不是 `skip`。
  if (mountable.length === 0 && candidates.length > 0) {
    return {
      kind: 'skip',
      reason: `${projectRoot} 的服务器全部被跳过（与全局行撞名或彼此重名），本会话不挂载项目 MCP`,
      skipped,
    }
  }

  // 10. 信任判定用**规范化后**的名字，与信任存储里记录的一致（规格 §7.1）。
  const approved = mountable.filter(candidate =>
    isApproved(input.trust, projectRoot, fp, candidate.serverName),
  )

  // 11. 有可挂载项、但一条都没被批准 → 要求批准。`pending` 列真正需要批准的名字。
  if (approved.length === 0 && mountable.length > 0) {
    return {
      kind: 'untrusted',
      projectRoot,
      fingerprint: fp,
      pending: mountable.map(candidate => candidate.serverName),
    }
  }

  // 12. 挂载（真正挂载由任务 7 执行，本函数只产出配置）。`configs` 为空且
  //     `mountable` 为空时，代表这份文件没有任何可挂载项，原因见 `skipped`。
  return {
    kind: 'mount',
    projectRoot,
    fingerprint: fp,
    configs: approved.map(candidate => candidate.config),
    skipped,
  }
}
