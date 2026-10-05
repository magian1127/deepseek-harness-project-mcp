/**
 * 项目根发现与 `.mcp.json` 读取解析（规格 §5）。
 *
 * 纯函数 + 注入 I/O：`exists` 与 `readFile` 由调用方注入，本模块不 import
 * `node:fs`，因此可被彻底单测，也不绑定真实文件系统。
 */
import { dirname, posix } from 'node:path'

/** `.mcp.json` 的读取解析结果。 */
export type ParseResult =
  | { kind: 'absent' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'ok'; raw: string; servers: Record<string, unknown> }

/**
 * 从 cwd 起逐级向上，返回第一个含 `.git` 的目录；走到根都没有则返回 cwd 本身
 * （与 DSH skill-filesystem 的 findProjectRoot 同语义）。
 *
 * 路径拼接用 `posix.join` 固定正斜杠：断言与信任存储键跨平台确定，Windows 的
 * fs 同样接受正斜杠。但向上回溯必须用平台感知的 `dirname`——`posix.dirname`
 * 对 `D:\a\b` 会返回 `.`，会让 Windows 上的回溯静默止步于 cwd。
 */
export function findProjectRoot(cwd: string, exists: (p: string) => boolean): string {
  let current = cwd
  while (true) {
    if (exists(posix.join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return cwd
    current = parent
  }
}

/** 非 null 的普通对象（排除数组与原始值）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 读取 `<projectRoot>/.mcp.json` 并解析。
 *
 * 本函数运行在会话创建路径上，**任何失败都返回结果对象而不抛异常**——抛异常会
 * 中断会话。诊断文本只说明"哪里不对"，**绝不含文件内容**：JSON.parse 的错误
 * 消息会回显原文片段（如 `Unexpected token '}', "{"k":"v"}" ...`），直接透传
 * 会把可能存在的凭据带进日志与会话提示。
 */
export function readProjectMcpFile(projectRoot: string, readFile: (p: string) => string): ParseResult {
  const path = posix.join(projectRoot, '.mcp.json')
  let raw: string
  try {
    raw = readFile(path)
  } catch {
    return { kind: 'absent' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'invalid', reason: `${path} 不是合法 JSON` }
  }

  if (!isPlainObject(parsed)) {
    return { kind: 'invalid', reason: `${path} 顶层必须是 JSON 对象` }
  }

  const servers = parsed.mcpServers
  if (servers === undefined) return { kind: 'ok', raw, servers: {} }
  if (!isPlainObject(servers)) {
    return { kind: 'invalid', reason: `${path} 的 mcpServers 必须是 JSON 对象` }
  }

  return { kind: 'ok', raw, servers }
}
