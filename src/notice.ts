/**
 * 会话提示文本（规格 §12）。
 *
 * **只有用户需要采取行动的情形才返回非空文本**：`untrusted`（有可挂载项但未批准）
 * 与 `invalid`（`.mcp.json` 无法解析）。两者都需要用户做一个决定或修一个文件。
 *
 * `mount` 与 `skip` 一律返回空串：诊断信息（每条服务器的跳过原因、`mcpServers`
 * 缺失、"文件里没有可用服务器"等）由 `/mcp-project` 命令输出承载。会话提示会占用
 * 模型上下文，只在值得打扰用户时才注入。
 *
 * 安全：返回的文本**不含**任何 `.mcp.json` 内容或展开后的环境变量值。`invalid` 的
 * `reason` 来自 `discovery.ts`，只可能是"路径 + 哪里不对"，绝不回显文件内容
 * （`JSON.parse` 的错误消息会回显原文片段，任务 2 已刻意丢弃）。
 */
import type { SessionMountPlan } from './session.js'

/**
 * 渲染该计划的会话提示；不需要用户行动时返回空串。
 *
 * @param plan - `planSessionMount` 产出的计划。
 * @param projectRoot - 项目根路径。`untrusted` 计划自带 `projectRoot`，此参数主要
 *   供 `invalid` 使用——该变体刻意不携带路径（计划只描述"文件不可用"）。
 */
export function renderNotice(plan: SessionMountPlan, projectRoot: string): string {
  if (plan.kind === 'untrusted') {
    return [
      `项目 ${plan.projectRoot} 的 .mcp.json 声明了项目级 MCP 服务器，但尚未批准，本会话未启用任何项目级 MCP。`,
      `待批准：${plan.pending.join('、')}`,
      '运行 /mcp-project trust 批准整个文件，或 /mcp-project trust <名称>… 只批准指定服务器。',
    ].join('\n')
  }

  if (plan.kind === 'invalid') {
    return [
      `项目 ${projectRoot} 的 .mcp.json 无法解析，本会话未启用任何项目级 MCP。`,
      `原因：${plan.reason}`,
      '修正该文件后运行 /mcp-project 查看状态。',
    ].join('\n')
  }

  return ''
}
