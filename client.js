/**
 * 工具调试控制台的 Client 半边（plain-JS bundle，格式见 cordis-plugin-development 模板）。
 *
 * 这个文件同时承载两件事：
 * 1. `conversation.input.left` 的「项目 MCP」按钮 + 内联锚定弹层（原功能，未改）；
 * 2. `conversation.view` 的「工具调试」Tab —— 通用调试面：工具树 / 调用面板 /
 *    结果面板 / 提示词面。
 *
 * ## 为什么调试台在这里
 *
 * 调试台只依赖宿主全局 `tools` 服务，与项目级 MCP 无关。放在本包是因为它需要一个
 * 长期存活的 Host 半边来托管路由与执行器；本包恰好已经在装配 webServer 通道。
 * 换句话说：**功能上它是通用的，落点上是搭便车**。
 *
 * ## 与 Host 的契约（`src/debug-bridge.ts`）
 *
 * - `GET  /project-mcp/debug/api/tools?session=`   → `{ ok, tools, groups }`
 *   （`session` 解析成 agent 作用域——会话级 MCP 工具 `mcp__*` 才会出现）
 * - `POST /project-mcp/debug/api/call`             → `{ ok, outcome }`
 *   （body 带同一 `session`：列出与执行同视角，树里能看到的就一定能调）
 * - `POST /project-mcp/debug/api/cancel`           → `{ ok, cancelled }`
 * - `GET  /project-mcp/debug/api/prompt-sections`  → `{ ok, sections }`
 *
 * 所有请求都走**同源 fetch**；鉴权靠 Host / Origin / sec-fetch-site 三重同源围栏
 * （详见 `src/debug-bridge.ts` 模块头）。调试台**刻意不读 nonce meta**：那套
 * `tapIndex` 页面注入在真实组合里不生效，照抄会让每个请求都 403（2026-10-24 真机
 * 踩到过——Tab 能打开但工具面永远是 0）。MCP 控制台按钮那条链路仍用 nonce。
 *
 * ## 契约要点（不要在这里折叠业务语义）
 *
 * - 表单字段由 Host 预先投影（`fields`），本文件只负责渲染控件与拼参数；
 * - 分组由 Host 算好（`groups`），本文件只按 `name` 从顶层 `tools` 建索引；
 * - 因此本文件没有任何"按服务器名特判"的分支——它是通用调试面。
 *
 * ## 红线
 *
 * - 所有副作用（DOM、事件监听、style 节点、定时器）必须随插件 fiber 清理；
 * - 结果里的图片按 base64 直出（Host 已截断），不再二次处理。
 */
window.__ModuleLoader__.load({
  id: 'deepseek-harness-project-mcp',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'deepseek-harness-project-mcp'
    const NONCE_META = 'dsh-project-mcp-nonce'
    const NONCE_HEADER = 'x-project-mcp-nonce'
    const ROUTE = '/project-mcp'
    const DEBUG = '/project-mcp/debug'

    let cachedNonce
    function nonce() {
      if (cachedNonce === undefined) {
        const meta = document.querySelector('meta[name="' + NONCE_META + '"]')
        cachedNonce = meta ? meta.getAttribute('content') || '' : ''
      }
      return cachedNonce
    }

    const token = name => 'var(--dsw-alias-' + name + ')'
    const buttonStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      height: '24px',
      padding: '0 6px',
      border: '1px solid ' + token('border-l1'),
      borderRadius: '6px',
      background: 'transparent',
      color: token('label-secondary'),
      fontSize: '12px',
      lineHeight: '1',
      cursor: 'pointer',
    }
    const panelStyle = {
      position: 'fixed',
      right: '24px',
      bottom: '120px',
      width: '340px',
      maxHeight: '50vh',
      overflow: 'auto',
      padding: '12px',
      border: '1px solid ' + token('border-l1'),
      borderRadius: '10px',
      background: token('bg-overlay'),
      color: token('label-primary'),
      boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
      zIndex: 60,
    }
    const rowStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '8px',
      padding: '6px 0',
      borderBottom: '1px solid ' + token('border-l1'),
      fontSize: '12px',
    }
    const actionStyle = {
      ...buttonStyle,
      height: '22px',
      color: token('brand-primary'),
      borderColor: token('brand-primary'),
    }
    const spinStyle = {
      display: 'inline-block',
      width: '10px',
      height: '10px',
      border: '2px solid ' + token('border-l1'),
      borderTopColor: token('brand-primary'),
      borderRadius: '50%',
      animation: 'project-mcp-spin 0.8s linear infinite',
    }
    function ensureSpinKeyframes() {
      if (document.getElementById('project-mcp-spin-style') !== null) return
      const el = document.createElement('style')
      el.id = 'project-mcp-spin-style'
      el.textContent = '@keyframes project-mcp-spin{to{transform:rotate(360deg)}}'
      document.head.appendChild(el)
    }

    function PlugIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 },
        h('path', { d: 'M5 2v4M11 2v4M3 6h10v3a5 5 0 0 1-10 0V6ZM8 14v-2' }),
      )
    }

    function useView(sessionId) {
      const [state, setState] = React.useState({ view: null, loading: true })
      React.useEffect(() => {
        let stopped = false
        const tick = async () => {
          if (!sessionId) {
            if (!stopped) setState({ view: null, loading: false })
            return
          }
          try {
            const res = await fetch(ROUTE + '/status?session=' + encodeURIComponent(sessionId), {
              headers: { [NONCE_HEADER]: nonce() },
            })
            const data = await res.json()
            if (!stopped) setState({ view: data && data.ok ? data.view ?? null : null, loading: false })
          } catch {
            if (!stopped) setState(s => (s.loading ? { view: null, loading: false } : s))
          }
        }
        void tick()
        const timer = setInterval(() => void tick(), 1500)
        return () => {
          stopped = true
          clearInterval(timer)
        }
      }, [sessionId])
      return state
    }

    async function post(path, sessionId, serverName) {
      const res = await fetch(ROUTE + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [NONCE_HEADER]: nonce() },
        body: JSON.stringify({ session: sessionId, server: serverName }),
      })
      return res.json()
    }

    let translate = key => key
    const DICTS = {
      zh: {
        need_start: '个服务没启动，点击处理',
        ready: '项目 MCP 已就绪',
        btn_detecting: '检测中',
        btn_pending: '个未启动',
        btn_ready: 'MCP 就绪',
        detecting: '正在检测项目 MCP',
        popup_title: '项目级 MCP 服务器',
        state_unauthorized: '未授权',
        state_starting: '启动中',
        state_mounted: '已挂载',
        'state_not-mounted': '本会话未挂载',
        state_failed: '失败',
        state_skipped: '已跳过',
        action_start: '启动',
        action_retry: '重试',
        action_revoke: '撤销授权',
        empty: '没有需要处理的服务器',
        // —— 工具调试 ——
        debug_tab: '工具调试',
        debug_search: '搜索工具…',
        debug_refresh: '刷新',
        debug_loading: '加载中…',
        debug_no_tools: '当前没有可用工具',
        debug_tools_error: '工具面获取失败',
        debug_pick: '从左侧选择一个工具',
        debug_form: '表单',
        debug_raw: '原始 JSON',
        debug_execute: '执行',
        debug_cancel: '取消',
        debug_running: '执行中',
        debug_no_params: '（无参数）',
        debug_no_schema: '（无参数 schema，请用原始 JSON 模式）',
        debug_json_error: 'JSON 解析失败',
        debug_result: '结果',
        debug_history: '历史',
        debug_sections: '提示词面',
        debug_skills: '技能',
        debug_no_skills: '当前没有可用技能',
        debug_skill_no_model: '模型不可调用',
        debug_no_result: '尚无调用结果',
        debug_no_history: '尚无调用历史',
        debug_clear: '清空',
        debug_replay: '重放',
        debug_copy: '复制',
        debug_copied: '已复制',
        debug_copy_fail: '复制失败',
        debug_duration: '耗时',
        debug_close: '关闭',
        debug_truncated: '图片过大已截断',
        debug_confirm_title: '确认执行工具',
        debug_confirm_body: '即将执行工具调用，请确认参数：',
        debug_confirm_run: '确认执行',
        debug_skip_confirm: '本会话跳过确认',
        debug_group_mcp: 'MCP',
        debug_group_builtin: '内置工具',
        debug_group_plugin: '其他工具',
        debug_empty_group: '（空）',
      },
      en: {
        need_start: 'project MCP server(s) not started',
        ready: 'Project MCP ready',
        btn_detecting: 'Detecting',
        btn_pending: 'pending',
        btn_ready: 'MCP ready',
        detecting: 'Detecting project MCP',
        popup_title: 'Project MCP servers',
        state_unauthorized: 'Not approved',
        state_starting: 'Starting',
        state_mounted: 'Mounted',
        'state_not-mounted': 'Not mounted here',
        state_failed: 'Failed',
        state_skipped: 'Skipped',
        action_start: 'Start',
        action_retry: 'Retry',
        action_revoke: 'Revoke',
        empty: 'Nothing to handle',
        // —— tool debug ——
        debug_tab: 'Tool Debug',
        debug_search: 'Search tools…',
        debug_refresh: 'Refresh',
        debug_loading: 'Loading…',
        debug_no_tools: 'No tools available',
        debug_tools_error: 'Failed to load tools',
        debug_pick: 'Pick a tool on the left',
        debug_form: 'Form',
        debug_raw: 'Raw JSON',
        debug_execute: 'Run',
        debug_cancel: 'Cancel',
        debug_running: 'running',
        debug_no_params: '(no parameters)',
        debug_no_schema: '(no parameter schema; use raw JSON)',
        debug_json_error: 'Invalid JSON',
        debug_result: 'Result',
        debug_history: 'History',
        debug_sections: 'Prompt sections',
        debug_skills: 'Skills',
        debug_no_skills: 'No skills available',
        debug_skill_no_model: 'not model-invocable',
        debug_no_result: 'No call yet',
        debug_no_history: 'No history yet',
        debug_clear: 'Clear',
        debug_replay: 'Replay',
        debug_copy: 'Copy',
        debug_copied: 'Copied',
        debug_copy_fail: 'Copy failed',
        debug_duration: 'Duration',
        debug_close: 'Close',
        debug_truncated: 'image truncated (too large)',
        debug_confirm_title: 'Confirm tool run',
        debug_confirm_body: 'A tool call is about to run. Review the arguments:',
        debug_confirm_run: 'Run anyway',
        debug_skip_confirm: 'Skip confirms this session',
        debug_group_mcp: 'MCP',
        debug_group_builtin: 'Built-in',
        debug_group_plugin: 'Other tools',
        debug_empty_group: '(empty)',
      },
    }

    function McpConsoleButton(props) {
      const sessionId = props.sessionId
      const { view, loading } = useView(sessionId)
      const [open, setOpen] = React.useState(false)
      const [, force] = React.useState(0)
      const btnRef = React.useRef(null)
      const popRef = React.useRef(null)
      const [anchor, setAnchor] = React.useState(null)

      // 弹层打开期间：量取按钮位置锚定面板；点外部 / Esc / 窗口缩放都关闭（权限菜单同款 dismiss）。
      React.useEffect(() => {
        if (!open) return undefined
        const rect = btnRef.current !== null && btnRef.current.getBoundingClientRect !== undefined
          ? btnRef.current.getBoundingClientRect()
          : null
        if (rect !== null) {
          setAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + 6 })
        }
        const onPointer = event => {
          const target = event.target
          if (popRef.current !== null && popRef.current.contains(target)) return
          if (btnRef.current !== null && btnRef.current.contains(target)) return
          setOpen(false)
        }
        const onKey = event => {
          if (event.key === 'Escape') setOpen(false)
        }
        const onResize = () => setOpen(false)
        document.addEventListener('pointerdown', onPointer, true)
        document.addEventListener('keydown', onKey)
        window.addEventListener('resize', onResize)
        return () => {
          document.removeEventListener('pointerdown', onPointer, true)
          document.removeEventListener('keydown', onKey)
          window.removeEventListener('resize', onResize)
        }
      }, [open])

      // 检测中显示转圈（behavior §7.1）；检测完成且没有可用计划才隐藏。
      if (view === null && !loading) return null
      const count = view === null ? 0 : view.actionCount
      const label = loading ? translate('detecting') : count > 0 ? count + ' ' + translate('need_start') : translate('ready')
      const buttonLabel = loading
        ? translate('btn_detecting')
        : count > 0 ? count + ' ' + translate('btn_pending') : translate('btn_ready')
      ensureSpinKeyframes()

      const act = async (path, serverName) => {
        await post(path, sessionId, serverName)
        force(n => n + 1)
      }

      const rows = view === null ? [] : view.rows.map(row =>
        h(
          'div',
          { key: row.serverName, style: rowStyle },
          h(
            'div',
            null,
            h('div', null, row.serverName + '（' + translate('state_' + row.state) + '）'),
            row.detail ? h('div', { style: { color: token('label-secondary'), fontSize: '11px' } }, row.detail) : null,
          ),
          h(
            'div',
            { style: { display: 'flex', gap: '4px' } },
            row.state === 'unauthorized' || row.state === 'not-mounted'
              ? h('button', { type: 'button', style: actionStyle, onClick: () => void act('/start', row.serverName) }, translate('action_start'))
              : null,
            row.state === 'failed'
              ? h('button', { type: 'button', style: actionStyle, onClick: () => void act('/start', row.serverName) }, translate('action_retry'))
              : null,
            row.state === 'mounted' || row.state === 'starting'
              ? h('button', { type: 'button', style: actionStyle, onClick: () => void act('/revoke', row.serverName) }, translate('action_revoke'))
              : null,
          ),
        ),
      )
      const fileNote = view === null ? null : view.fileNote
      const projectRoot = view === null ? null : view.projectRoot

      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            ref: btnRef,
            type: 'button',
            style: buttonStyle,
            title: label,
            'aria-label': label,
            'aria-expanded': open,
            onClick: () => setOpen(o => !o),
          },
          h(PlugIcon),
          h('span', null, buttonLabel),
          loading ? h('span', { style: spinStyle, 'aria-hidden': true }) : null,
        ),
        open && view !== null
          ? h(
              'div',
              {
                ref: popRef,
                role: 'dialog',
                'aria-label': translate('popup_title'),
                style: {
                  ...panelStyle,
                  ...(anchor === null ? {} : { left: anchor.left + 'px', bottom: anchor.bottom + 'px' }),
                },
              },
              h('div', { style: { fontSize: '12px', fontWeight: 600, paddingBottom: '6px' } }, translate('popup_title')),
              fileNote ? h('div', { style: { ...rowStyle, color: token('label-secondary') } }, fileNote) : null,
              rows.length === 0 && !fileNote ? h('div', { style: rowStyle }, translate('empty')) : null,
              rows,
              projectRoot
                ? h('div', { style: { paddingTop: '6px', fontSize: '11px', color: token('label-secondary') } }, projectRoot)
                : null,
            )
          : null,
      )
    }

    // -----------------------------------------------------------------------
    // 工具调试 Tab
    // -----------------------------------------------------------------------

    /** 调试台样式：主题 token + 容器查询，随 fiber 清理（与 MCP 控制台同源风格）。 */
    const DEBUG_CSS = [
      '.twb{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-fg-default,inherit);font-size:13px;background:var(--dsw-alias-bg-layer-1,inherit)}',
      '.twb-bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border,rgba(128,128,128,.35));font-size:12px}',
      '.twb-badge{padding:1px 6px;border-radius:8px;border:1px solid var(--dsw-alias-border,rgba(128,128,128,.35))}',
      '.twb-badge.warn{color:var(--dsw-alias-warning,#b26a00)}',
      '.twb-main{display:grid;grid-template-columns:minmax(180px,260px) minmax(280px,1fr) minmax(300px,1.2fr);gap:8px;padding:8px;padding-bottom:calc(var(--dsh-composer-height,152px) + 16px);flex:1;min-height:0;container-type:inline-size}',
      '.twb-col{display:flex;flex-direction:column;min-height:0;border:1px solid var(--dsw-alias-border,rgba(128,128,128,.35));border-radius:6px;overflow:hidden}',
      '.twb-col-head{padding:6px 8px;font-weight:600;border-bottom:1px solid var(--dsw-alias-border,rgba(128,128,128,.35));display:flex;gap:6px;align-items:center;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.twb-tree{flex:1;overflow:auto;padding:4px}',
      '.twb-search{width:100%;padding:4px 6px;margin-bottom:4px;box-sizing:border-box;border:1px solid var(--dsw-alias-border,rgba(128,128,128,.35));border-radius:4px;background:transparent;color:inherit}',
      '.twb-group{margin:6px 0 2px;font-size:12px;opacity:.85;display:flex;gap:4px;align-items:center}',
      '.twb-item{display:block;width:100%;text-align:left;padding:4px 6px;border:0;background:none;color:inherit;border-radius:4px;cursor:pointer;font-size:12px;line-height:1.35}',
      '.twb-item:hover{background:rgba(128,128,128,.12)}',
      '.twb-item.on{background:rgba(128,128,128,.2);font-weight:600}',
      '.twb-item small{display:block;opacity:.7;font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.twb-call{flex:1;overflow:auto;padding:8px;display:flex;flex-direction:column;gap:8px}',
      '.twb-field{display:grid;grid-template-columns:110px 1fr;gap:6px;align-items:start}',
      '.twb-field label{font-size:12px;padding-top:4px}',
      '.twb-field input,.twb-field select,.twb-field textarea{width:100%;box-sizing:border-box;padding:4px 6px;border:1px solid var(--dsw-alias-border,rgba(128,128,128,.35));border-radius:4px;background:transparent;color:inherit;font:inherit}',
      '.twb-field textarea{min-height:52px;font-family:monospace}',
      '.twb-actions{display:flex;gap:8px;align-items:center;margin-top:auto;padding-top:8px}',
      '.twb-btn{padding:4px 12px;border-radius:4px;border:1px solid var(--dsw-alias-border,rgba(128,128,128,.35));background:transparent;color:inherit;cursor:pointer;font:inherit}',
      '.twb-btn.primary{background:var(--dsw-alias-accent,#478cbf);color:#fff;border-color:transparent}',
      '.twb-btn:disabled{opacity:.5;cursor:default}',
      '.twb-tabs{display:flex;gap:2px;padding:4px 6px 0;border-bottom:1px solid var(--dsw-alias-border,rgba(128,128,128,.35))}',
      '.twb-tab{padding:4px 10px;border:0;border-bottom:2px solid transparent;background:none;color:inherit;cursor:pointer;font:inherit;font-size:12px}',
      '.twb-tab.on{border-bottom-color:var(--dsw-alias-accent,#478cbf);font-weight:600}',
      '.twb-body{flex:1;overflow:auto;padding:8px}',
      '.twb-pre{white-space:pre-wrap;word-break:break-word;font-family:monospace;font-size:12px;margin:0;padding:6px;background:rgba(128,128,128,.08);border-radius:4px}',
      '.twb-err .twb-pre{color:var(--dsw-alias-danger,#c62828)}',
      '.twb-img{max-width:100%;border:1px solid var(--dsw-alias-border,rgba(128,128,128,.35));border-radius:4px;display:block;margin:6px 0}',
      '.twb-hist{display:flex;flex-direction:column;gap:4px}',
      '.twb-hist-row{display:flex;gap:6px;align-items:center;font-size:12px;padding:4px;border-radius:4px;border:1px solid transparent}',
      '.twb-hist-row:hover{border-color:var(--dsw-alias-border,rgba(128,128,128,.35))}',
      '.twb-hist-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:40%}',
      '.twb-hist-sum{opacity:.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}',
      '.twb-empty{opacity:.6;padding:16px;text-align:center}',
      '.twb-modal{position:fixed;inset:0;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.24));backdrop-filter:var(--dsw-mask-blur,none);display:flex;align-items:center;justify-content:center;z-index:9999}',
      '.twb-modal-box{max-width:520px;width:90%;background:var(--dsw-alias-bg-elevated,inherit);border:1px solid var(--dsw-alias-border,rgba(128,128,128,.35));border-radius:8px;padding:14px}',
      '.twb-section{margin-bottom:8px;border:1px solid var(--dsw-alias-border,rgba(128,128,128,.35));border-radius:6px}',
      '.twb-section>button{width:100%;text-align:left;padding:6px 8px;border:0;background:none;color:inherit;cursor:pointer;font:inherit;font-weight:600}',
      '.twb-section-body{padding:0 10px 10px;white-space:pre-wrap;font-size:12px;max-height:50vh;overflow:auto}',
      '@container (max-width: 900px){.twb-main{grid-template-columns:1fr;grid-template-rows:auto auto 1fr;overflow:auto}}',
      '@container (max-width: 560px){.twb-field{grid-template-columns:1fr}.twb-bar{font-size:11px}}',
    ].join('\n')

    /** 注入调试台样式；返回清理函数（随 fiber 移除 style 节点）。 */
    function injectDebugCss() {
      if (typeof document === 'undefined') return () => {}
      const style = document.createElement('style')
      style.setAttribute('data-project-mcp-tool-debug', '1')
      style.textContent = DEBUG_CSS
      document.head.appendChild(style)
      return () => {
        style.remove()
      }
    }

    /** 历史存储键：与 MCP 控制台分开（两者条目形状不同）。 */
    const HISTORY_KEY = 'dsh-project-mcp-tool-debug-history'
    const HISTORY_MAX = 50
    const SUMMARY_MAX = 8 * 1024

    function loadHistory() {
      try {
        const parsed = JSON.parse(window.localStorage.getItem(HISTORY_KEY) || '[]')
        return Array.isArray(parsed) ? parsed.slice(0, HISTORY_MAX) : []
      } catch {
        return []
      }
    }
    function saveHistory(items) {
      try {
        window.localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, HISTORY_MAX)))
      } catch {
        // 配额满：放弃持久化，内存里的历史仍可用。
      }
    }
    function summarize(content) {
      const text = content.filter(b => b.type === 'text').map(b => b.text || '').join('\n')
      return text.length > SUMMARY_MAX ? text.slice(0, SUMMARY_MAX) + '…' : text
    }

    /**
     * 同源 GET；非 2xx 抛出带 reason 的错误。
     *
     * 不带头部鉴权：路由靠同源围栏（Host / Origin / sec-fetch-site）判定，
     * 浏览器的同源 fetch 天然满足三者。详见 `src/debug-bridge.ts` 模块头。
     */
    async function debugGet(path) {
      const res = await fetch(DEBUG + path)
      const body = await res.json()
      if (!res.ok || !body || body.ok !== true) {
        throw new Error((body && body.reason) || 'HTTP ' + res.status)
      }
      return body
    }

    /** 同源 POST（JSON 体）；非 2xx 抛出带 reason 的错误。鉴权同上，靠同源围栏。 */
    async function debugPost(path, payload) {
      const res = await fetch(DEBUG + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await res.json()
      if (!res.ok || !body || body.ok !== true) {
        throw new Error((body && body.reason) || 'HTTP ' + res.status)
      }
      return body
    }

    /** 列表行内截断：完整说明放 title，避免长描述把布局撑爆。 */
    function brief(text, max) {
      return text.length > max ? text.slice(0, max) + '…' : text
    }

    /** 结果文本美化：JSON 形状才重排，其他原样（避免破坏纯文本报告）。 */
    function pretty(text) {
      if (text === undefined) return ''
      const trimmed = text.trim()
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          return JSON.stringify(JSON.parse(trimmed), null, 2)
        } catch {
          return text
        }
      }
      return text
    }

    /** 工具树：按 Host 算好的 groups 渲染，工具对象按 name 从顶层索引。 */
    function ToolTree(props) {
      const t = props.t
      const keyword = props.search.trim().toLowerCase()
      const matches = name => {
        if (keyword === '') return true
        const tool = props.byName[name]
        if (tool === undefined) return false
        return name.toLowerCase().includes(keyword) || tool.description.toLowerCase().includes(keyword)
      }
      const groups = props.groups
        .map(group => ({ ...group, names: group.tools.filter(matches) }))
        .filter(group => group.names.length > 0)
      return h(
        'div',
        { className: 'twb-tree' },
        h('input', {
          className: 'twb-search',
          placeholder: t('debug_search'),
          value: props.search,
          onInput: event => {
            props.onSearch(event.currentTarget.value)
          },
        }),
        groups.length === 0 ? h('div', { className: 'twb-empty' }, t('debug_no_tools')) : null,
        groups.map(group =>
          h(
            React.Fragment,
            { key: group.id },
            h('div', { className: 'twb-group' }, group.title + ' (' + group.names.length + ')'),
            group.names.map(name =>
              h(
                'button',
                {
                  key: name,
                  className: props.selectedName === name ? 'twb-item on' : 'twb-item',
                  title: props.byName[name] ? props.byName[name].description : '',
                  onClick: () => {
                    props.onSelect(name)
                  },
                },
                name,
                h('small', null, brief(props.byName[name] ? props.byName[name].description : '', 100)),
              ),
            ),
          ),
        ),
      )
    }

    /** 调用面板：表单 / 原始 JSON 双模式 + 执行 / 取消。 */
    function CallPanel(props) {
      const t = props.t
      const tool = props.tool
      const [rawMode, setRawMode] = React.useState(false)
      const [values, setValues] = React.useState({})
      const [raw, setRaw] = React.useState('{}')
      const [errors, setErrors] = React.useState([])

      const fields = tool === null ? [] : tool.fields || []
      // 切换工具 → 重置表单（渲染期同步重置，React 官方认可的 lastKey 模式）。
      const resetKey = tool === null ? '' : tool.name
      const [lastKey, setLastKey] = React.useState(resetKey)
      if (lastKey !== resetKey) {
        setLastKey(resetKey)
        const next = {}
        for (const field of fields) {
          if (field.type === 'json') next[field.name] = field.placeholder || '{}'
        }
        setValues(next)
        setRaw('{}')
        setErrors([])
      }

      if (tool === null) return h('div', { className: 'twb-empty' }, t('debug_pick'))

      const run = () => {
        if (rawMode) {
          let parsed
          try {
            parsed = JSON.parse(raw)
          } catch (error) {
            setErrors([t('debug_json_error') + ': ' + (error && error.message ? error.message : String(error))])
            return
          }
          setErrors([])
          props.onExecute(parsed)
          return
        }
        // 与 Host 侧 buildArguments 同语义（空串=未填；布尔只在勾选时出现）。
        const args = {}
        const found = []
        for (const field of fields) {
          const value = values[field.name]
          if (field.type === 'boolean') {
            if (value === true) args[field.name] = true
            continue
          }
          const text = typeof value === 'string' ? value.trim() : ''
          if (text === '') {
            if (field.required) found.push(field.name + ' 为必填')
            continue
          }
          if (field.type === 'string' || field.type === 'enum') {
            args[field.name] = text
          } else if (field.type === 'number') {
            const parsedNumber = Number(text)
            if (!Number.isFinite(parsedNumber)) found.push(field.name + ' 不是有效数字')
            else args[field.name] = parsedNumber
          } else {
            try {
              args[field.name] = JSON.parse(text)
            } catch {
              found.push(field.name + ' 不是有效 JSON')
            }
          }
        }
        setErrors(found)
        if (found.length === 0) props.onExecute(args)
      }

      return h(
        'div',
        { className: 'twb-call' },
        h(
          'div',
          null,
          h('div', { style: { fontWeight: 600, wordBreak: 'break-all' } }, tool.name),
          h('div', { style: { fontSize: 12, opacity: 0.75, whiteSpace: 'pre-wrap' } }, tool.description),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 6 } },
          h('button', { className: 'twb-tab' + (rawMode ? '' : ' on'), onClick: () => setRawMode(false) }, t('debug_form')),
          h('button', { className: 'twb-tab' + (rawMode ? ' on' : ''), onClick: () => setRawMode(true) }, t('debug_raw')),
        ),
        rawMode
          ? h('textarea', {
              style: { width: '100%', minHeight: 160, boxSizing: 'border-box', fontFamily: 'monospace' },
              value: raw,
              onInput: event => {
                setRaw(event.currentTarget.value)
              },
            })
          : fields.map(field =>
              h(
                'div',
                { key: field.name, className: 'twb-field' },
                h('label', null, field.name + (field.required ? ' *' : '')),
                field.type === 'boolean'
                  ? h('input', {
                      type: 'checkbox',
                      checked: values[field.name] === true,
                      onChange: event => {
                        setValues({ ...values, [field.name]: event.currentTarget.checked })
                      },
                    })
                  : field.type === 'enum'
                    ? h(
                        'select',
                        {
                          value: String(values[field.name] || ''),
                          onChange: event => {
                            setValues({ ...values, [field.name]: event.currentTarget.value })
                          },
                        },
                        h('option', { value: '' }, '—'),
                        (field.enumValues || []).map(value => h('option', { key: value, value }, value)),
                      )
                    : field.type === 'json'
                      ? h('textarea', {
                          value: String(values[field.name] === undefined ? field.placeholder || '{}' : values[field.name]),
                          onInput: event => {
                            setValues({ ...values, [field.name]: event.currentTarget.value })
                          },
                        })
                      : h('input', {
                          type: field.type === 'number' ? 'number' : 'text',
                          value: String(values[field.name] === undefined ? '' : values[field.name]),
                          placeholder: field.description || '',
                          onInput: event => {
                            setValues({ ...values, [field.name]: event.currentTarget.value })
                          },
                        }),
              ),
            ),
        fields.length === 0 && !rawMode ? h('div', { className: 'twb-empty' }, t('debug_no_schema')) : null,
        errors.length > 0 ? h('div', { className: 'twb-err' }, h('pre', { className: 'twb-pre' }, errors.join('\n'))) : null,
        h(
          'div',
          { className: 'twb-actions' },
          props.running
            ? h('button', { className: 'twb-btn', onClick: props.onCancel }, t('debug_cancel') + ' ' + (props.runningName || ''))
            : h('button', { className: 'twb-btn primary', onClick: run }, t('debug_execute')),
        ),
      )
    }

    /** 结果面板：结果 / 历史两个子页。 */
    function ResultPanel(props) {
      const t = props.t
      const [tab, setTab] = React.useState('result')
      const [copied, setCopied] = React.useState(false)
      const [copyError, setCopyError] = React.useState(false)
      React.useEffect(() => {
        setTab('result')
      }, [props.result])
      const result = props.result

      const copyText = text => {
        setCopyError(false)
        const ok = () => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }
        const fallback = () => {
          try {
            const area = document.createElement('textarea')
            area.value = text
            area.setAttribute('readonly', '')
            area.style.position = 'fixed'
            area.style.opacity = '0'
            document.body.appendChild(area)
            area.select()
            const succeeded = document.execCommand('copy')
            document.body.removeChild(area)
            if (succeeded) ok()
            else {
              setCopyError(true)
              setTimeout(() => setCopyError(false), 2000)
            }
          } catch {
            setCopyError(true)
            setTimeout(() => setCopyError(false), 2000)
          }
        }
        if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(text).then(ok).catch(fallback)
        } else {
          fallback()
        }
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 } },
        h(
          'div',
          { className: 'twb-tabs' },
          h('button', { className: 'twb-tab' + (tab === 'result' ? ' on' : ''), onClick: () => setTab('result') }, t('debug_result')),
          h('button', { className: 'twb-tab' + (tab === 'history' ? ' on' : ''), onClick: () => setTab('history') }, t('debug_history') + ' (' + props.history.length + ')'),
        ),
        h(
          'div',
          { className: 'twb-body' },
          tab === 'history'
            ? h(
                'div',
                { className: 'twb-hist' },
                h('button', { className: 'twb-btn', style: { alignSelf: 'flex-start' }, onClick: props.onClearHistory }, t('debug_clear')),
                props.history.length === 0 ? h('div', { className: 'twb-empty' }, t('debug_no_history')) : null,
                props.history.map(item =>
                  h(
                    'div',
                    { key: item.id, className: 'twb-hist-row' },
                    h('span', { className: 'twb-hist-name', title: item.name }, item.name),
                    h('span', { className: 'twb-hist-sum', title: item.summary }, item.ok ? '✓' : '✕', ' ', item.summary.slice(0, 80)),
                    h('span', null, item.durationMs + 'ms'),
                    h('button', { className: 'twb-btn', disabled: props.replayDisabled, onClick: () => props.onReplay(item) }, t('debug_replay')),
                  ),
                ),
              )
            : result === null
              ? h('div', { className: 'twb-empty' }, t('debug_no_result'))
              : h(
                  'div',
                  { className: result.isError ? 'twb-err' : undefined },
                  h(
                    'div',
                    { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, fontSize: 12, flexWrap: 'wrap' } },
                    h('strong', null, result.name),
                    h('span', null, t('debug_duration') + ' ' + result.durationMs + 'ms'),
                    result.error !== undefined ? h('span', { style: { color: 'var(--dsw-alias-danger,#c62828)', wordBreak: 'break-all' } }, result.error) : null,
                    copyError ? h('span', { style: { color: 'var(--dsw-alias-danger,#c62828)' } }, t('debug_copy_fail')) : null,
                    h(
                      'button',
                      {
                        className: 'twb-btn',
                        style: { marginLeft: 'auto' },
                        onClick: () => {
                          const text = result.content
                            .map(block =>
                              block.text !== undefined
                                ? block.text
                                : block.type === 'image'
                                  ? '[' + (block.mimeType || 'image') + ' ' + (block.data ? block.data.length : 0) + 'B' + (block.truncated === true ? ' ' + t('debug_truncated') : '') + ']'
                                  : '[' + (block.summary || block.type) + ']',
                            )
                            .join('\n')
                          copyText(text)
                        },
                      },
                      copied ? t('debug_copied') : t('debug_copy'),
                    ),
                  ),
                  result.content.map((block, index) => {
                    if (block.type === 'image') {
                      return h(
                        React.Fragment,
                        { key: index },
                        h('img', { className: 'twb-img', src: 'data:' + (block.mimeType || 'image/png') + ';base64,' + (block.data || ''), alt: 'result' }),
                        block.truncated === true ? h('div', { style: { fontSize: 11, opacity: 0.7 } }, t('debug_truncated')) : null,
                      )
                    }
                    if (block.type === 'other') {
                      return h('div', { key: index, style: { opacity: 0.7, fontSize: 12 } }, block.summary || block.type)
                    }
                    return h('pre', { key: index, className: 'twb-pre' }, pretty(block.text))
                  }),
                ),
        ),
      )
    }

    /** 提示词面：只读列出当前装配出的 systemPrompt section。 */
    function SectionsPanel(props) {
      const t = props.t
      const [sections, setSections] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [open, setOpen] = React.useState(null)
      const load = () => {
        setError(null)
        debugGet('/api/prompt-sections')
          .then(body => setSections(body.sections || []))
          .catch(cause => {
            setSections([])
            setError(cause && cause.message ? cause.message : String(cause))
          })
      }
      React.useEffect(load, [])
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 } },
        h(
          'div',
          { className: 'twb-tabs' },
          h('button', { className: 'twb-tab on' }, t('debug_sections')),
          h('button', { className: 'twb-btn', style: { marginLeft: 'auto' }, onClick: load }, t('debug_refresh')),
        ),
        h(
          'div',
          { className: 'twb-body' },
          error !== null ? h('div', { className: 'twb-badge warn', title: error }, error) : null,
          sections === null
            ? h('div', { className: 'twb-empty' }, t('debug_loading'))
            : sections.length === 0
              ? h('div', { className: 'twb-empty' }, t('debug_empty_group'))
              : sections.map(section =>
                  h(
                    'div',
                    { key: section.name, className: 'twb-section' },
                    h('button', { onClick: () => setOpen(open === section.name ? null : section.name) }, (open === section.name ? '▾ ' : '▸ ') + section.name),
                    open === section.name ? h('div', { className: 'twb-section-body' }, section.text) : null,
                  ),
                ),
        ),
      )
    }

    /**
     * 技能：只读列出 `skills.list()` 的目录，展开时才按需 `skills.get(name)` 取正文。
     *
     * 为什么正文懒加载：一个技能正文可能几十 KB，全部预取会把首屏拖慢好几秒，
     * 而用户通常只看一两个。展开过的正文缓存在 `bodies` 里，再次展开不重复请求。
     */
    function SkillsPanel(props) {
      const t = props.t
      // 带上 `session` 让 Host 把会话解析成技能作用域（会话专属技能才会出现）。
      const session = props.sessionId ? '?session=' + encodeURIComponent(props.sessionId) : ''
      const [skills, setSkills] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [open, setOpen] = React.useState(null)
      // name → { content } | { error }；只缓存成功与失败两种终态。
      const [bodies, setBodies] = React.useState({})
      const [pending, setPending] = React.useState(null)

      const load = () => {
        setError(null)
        debugGet('/api/skills' + session)
          .then(body => setSkills(body.skills || []))
          .catch(cause => {
            setSkills([])
            setError(cause && cause.message ? cause.message : String(cause))
          })
      }
      React.useEffect(load, [props.sessionId])

      const toggle = name => {
        if (open === name) {
          setOpen(null)
          return
        }
        setOpen(name)
        if (bodies[name] !== undefined) return
        setPending(name)
        const query = 'name=' + encodeURIComponent(name) + (props.sessionId ? '&session=' + encodeURIComponent(props.sessionId) : '')
        debugGet('/api/skill?' + query)
          .then(body => {
            setBodies(current => ({ ...current, [name]: { content: body.skill.content, meta: body.skill } }))
          })
          .catch(cause => {
            setBodies(current => ({
              ...current,
              [name]: { error: cause && cause.message ? cause.message : String(cause) },
            }))
          })
          .finally(() => setPending(current => (current === name ? null : current)))
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 } },
        h(
          'div',
          { className: 'twb-tabs' },
          h('button', { className: 'twb-tab on' }, t('debug_skills') + (skills === null ? '' : ' (' + skills.length + ')')),
          h('button', { className: 'twb-btn', style: { marginLeft: 'auto' }, onClick: load }, t('debug_refresh')),
        ),
        h(
          'div',
          { className: 'twb-body' },
          error !== null ? h('div', { className: 'twb-badge warn', title: error }, error) : null,
          skills === null
            ? h('div', { className: 'twb-empty' }, t('debug_loading'))
            : skills.length === 0
              ? h('div', { className: 'twb-empty' }, t('debug_no_skills'))
              : skills.map(skill => {
                  const body = bodies[skill.name]
                  const isOpen = open === skill.name
                  return h(
                    'div',
                    { key: skill.name, className: 'twb-section' },
                    h(
                      'button',
                      { onClick: () => toggle(skill.name), title: skill.whenToUse || skill.description },
                      (isOpen ? '▾ ' : '▸ ') + skill.name,
                      skill.source ? h('small', { style: { opacity: 0.6, marginLeft: 6 } }, skill.source) : null,
                      skill.modelInvocable === false
                        ? h('small', { style: { opacity: 0.6, marginLeft: 6 } }, t('debug_skill_no_model'))
                        : null,
                    ),
                    skill.description
                      ? h('div', { style: { padding: '0 10px 6px', fontSize: 11, opacity: 0.7 } }, skill.description)
                      : null,
                    isOpen
                      ? pending === skill.name && body === undefined
                        ? h('div', { className: 'twb-empty' }, t('debug_loading'))
                        : body === undefined
                          ? null
                          : body.error !== undefined
                            ? h('div', { className: 'twb-section-body' }, body.error)
                            : h('div', { className: 'twb-section-body' }, body.content)
                      : null,
                  )
                }),
        ),
      )
    }

    /** 调试台主组件：三栏（工具树 / 调用 / 结果）+ 确认弹窗。 */
    function ToolDebugView(props) {
      const t = translate
      // 当前会话 id（`conversation.view` 的标准 props 直接给 `sessionId`）。
      // 技能是按 scope 分层的，必须带上它才能看见该会话专属的技能。
      const sessionId = props && props.sessionId ? props.sessionId : undefined
      const [tools, setTools] = React.useState([])
      const [groups, setGroups] = React.useState([])
      const [loading, setLoading] = React.useState(true)
      const [toolsError, setToolsError] = React.useState(null)
      const [search, setSearch] = React.useState('')
      const [selectedName, setSelectedName] = React.useState(null)
      const [running, setRunning] = React.useState(null)
      const [result, setResult] = React.useState(null)
      const [history, setHistory] = React.useState([])
      const [rightTab, setRightTab] = React.useState('run')
      const [skipConfirm, setSkipConfirm] = React.useState(false)
      const [confirming, setConfirming] = React.useState(null)

      const byName = React.useMemo(() => {
        const index = {}
        for (const tool of tools) index[tool.name] = tool
        return index
      }, [tools])

      const refresh = React.useCallback(() => {
        setLoading(true)
        // 带上 `session`：Host 按 agent 作用域列工具，挂在 agent.ctx 的会话级
        // MCP 工具（mcp__*）才会出现；无会话则退回全局视角。
        const session = sessionId ? '?session=' + encodeURIComponent(sessionId) : ''
        debugGet('/api/tools' + session)
          .then(body => {
            setTools(body.tools || [])
            setGroups(body.groups || [])
            setToolsError(null)
          })
          .catch(cause => {
            setTools([])
            setGroups([])
            setToolsError(cause && cause.message ? cause.message : String(cause))
          })
          .finally(() => setLoading(false))
      }, [sessionId])

      React.useEffect(() => {
        setHistory(loadHistory())
        refresh()
      }, [refresh])

      const runCall = (name, args) => {
        const callId = 'twb-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
        setRunning({ callId, name })
        // `session` 与工具列表同一个会话：列出与执行必须同视角（见 debug-bridge）。
        debugPost('/api/call', { name, arguments: args, callId, ...(sessionId ? { session: sessionId } : {}) })
          .then(body => {
            const outcome = body.outcome
            setResult(outcome)
            setHistory(previous => {
              const next = [
                {
                  id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
                  name,
                  argsJson: JSON.stringify(args),
                  ok: !outcome.isError,
                  durationMs: outcome.durationMs,
                  at: Date.now(),
                  summary: summarize(outcome.content || []),
                },
                ...previous,
              ].slice(0, HISTORY_MAX)
              saveHistory(next)
              return next
            })
          })
          .catch(cause => {
            setResult({ callId: '', name, isError: true, durationMs: 0, content: [], error: cause && cause.message ? cause.message : String(cause) })
          })
          .finally(() => setRunning(null))
      }

      // 危险操作二次确认：名称或参数里出现 unsafe 字样时**永远**确认（跳过开关对它无效）。
      const isUnsafeCall = (name, args) => {
        if (/unsafe/i.test(name)) return true
        try {
          return /unsafe/i.test(JSON.stringify(args))
        } catch {
          return false
        }
      }
      const requestRun = (name, args) => {
        if (!skipConfirm || isUnsafeCall(name, args)) setConfirming({ name, args })
        else runCall(name, args)
      }

      const selected = selectedName === null ? null : byName[selectedName] || null

      // data-conversation-composer-overlay：让 ConversationRoot 把本视图切成 overlay
      // 布局（滚动体自持、底部 composer 变浮动条），与轨迹 Tab 一致。
      return h(
        'div',
        { className: 'twb', 'data-conversation-composer-overlay': '' },
        h(
          'div',
          { className: 'twb-bar' },
          loading && tools.length === 0
            ? h('span', { className: 'twb-badge' }, t('debug_loading'))
            : h('span', { className: 'twb-badge' }, tools.length + ' tools'),
          toolsError !== null ? h('span', { className: 'twb-badge warn', title: toolsError }, t('debug_tools_error')) : null,
          h(
            'button',
            {
              className: 'twb-btn',
              style: { marginLeft: 'auto' },
              disabled: loading,
              onClick: refresh,
            },
            t('debug_refresh'),
          ),
        ),
        h(
          'div',
          { className: 'twb-main' },
          h(
            'div',
            { className: 'twb-col' },
            h('div', { className: 'twb-col-head' }, t('debug_tab') + ' · ' + tools.length),
            h(ToolTree, {
              t,
              groups,
              byName,
              search,
              selectedName,
              onSearch: setSearch,
              onSelect: name => setSelectedName(name),
            }),
          ),
          h(
            'div',
            { className: 'twb-col' },
            h('div', { className: 'twb-col-head' }, selected === null ? t('debug_pick') : selected.name),
            h(CallPanel, {
              t,
              tool: selected,
              running: running !== null,
              runningName: running === null ? null : running.name,
              onExecute: args => {
                if (selected !== null) requestRun(selected.name, args)
              },
              onCancel: () => {
                if (running !== null && running.callId !== '') {
                  void debugPost('/api/cancel', { callId: running.callId }).catch(() => {})
                }
              },
            }),
          ),
          h(
            'div',
            { className: 'twb-col' },
            h(
              'div',
              { className: 'twb-col-head' },
              h('button', { className: 'twb-tab' + (rightTab === 'run' ? ' on' : ''), onClick: () => setRightTab('run') }, t('debug_result')),
              h('button', { className: 'twb-tab' + (rightTab === 'sections' ? ' on' : ''), onClick: () => setRightTab('sections') }, t('debug_sections')),
              h('button', { className: 'twb-tab' + (rightTab === 'skills' ? ' on' : ''), onClick: () => setRightTab('skills') }, t('debug_skills')),
            ),
            rightTab === 'run'
              ? h(ResultPanel, {
                  t,
                  result,
                  history,
                  replayDisabled: running !== null,
                  onReplay: item => {
                    setSelectedName(item.name)
                    try {
                      requestRun(item.name, JSON.parse(item.argsJson))
                    } catch {
                      // 历史参数损坏：忽略这次重放。
                    }
                  },
                  onClearHistory: () => {
                    setHistory([])
                    saveHistory([])
                  },
                })
              : rightTab === 'skills'
                ? h(SkillsPanel, { t, sessionId })
                : h(SectionsPanel, { t }),
          ),
        ),
        confirming !== null
          ? h(
              'div',
              { className: 'twb-modal', onClick: () => setConfirming(null) },
              h(
                'div',
                { className: 'twb-modal-box', onClick: event => event.stopPropagation() },
                h('div', { style: { fontWeight: 600, marginBottom: 8 } }, t('debug_confirm_title')),
                h('div', { style: { fontSize: 12, marginBottom: 6 } }, t('debug_confirm_body')),
                h('pre', { className: 'twb-pre' }, confirming.name + '\n' + JSON.stringify(confirming.args, null, 2)),
                h(
                  'div',
                  { style: { display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' } },
                  h(
                    'button',
                    {
                      className: 'twb-btn primary',
                      onClick: () => {
                        const pending = confirming
                        setConfirming(null)
                        runCall(pending.name, pending.args)
                      },
                    },
                    t('debug_confirm_run'),
                  ),
                  h('button', { className: 'twb-btn', onClick: () => setConfirming(null) }, t('debug_close')),
                  h(
                    'label',
                    { style: { marginLeft: 'auto', fontSize: 12 } },
                    h('input', {
                      type: 'checkbox',
                      checked: skipConfirm,
                      onChange: event => setSkipConfirm(event.currentTarget.checked),
                    }),
                    ' ',
                    t('debug_skip_confirm'),
                  ),
                ),
              ),
            )
          : null,
      )
    }

    /** 渲染异常防御：任一子面板崩溃时降级为占位，而不是把整树卸载成白屏。 */
    class DebugErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { hasError: false, message: '' }
      }

      static getDerivedStateFromError(error) {
        return { hasError: true, message: error && error.message ? error.message : String(error) }
      }

      componentDidCatch(error, info) {
        console.error('[tool-debug] 渲染崩溃，已降级:', error, info)
      }

      render() {
        if (this.state.hasError) {
          return h(
            'div',
            { style: { padding: 16, fontSize: 13, color: 'var(--dsw-alias-danger,#c62828)' } },
            h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '调试台渲染异常'),
            h('p', { style: { opacity: 0.75, margin: '0 0 10px' } }, '某个面板渲染失败，已降级为占位以避免整树空白（可刷新重试）。'),
            h('pre', { className: 'twb-pre' }, this.state.message),
          )
        }
        return this.props.children || null
      }
    }

    function ToolDebugRoot(props) {
      return h(DebugErrorBoundary, null, h(ToolDebugView, props || {}))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          ctx.locale.register(NS, DICTS)
          translate = ctx.locale.bind(NS)
        } catch {
          // locale 服务缺席时退回内置字典：按钮仍可用，只是文案走本地回退。
          const lang = (navigator.language || 'en').toLowerCase().startsWith('zh') ? 'zh' : 'en'
          const table = DICTS[lang] || DICTS.en
          translate = key => (table[key] !== undefined ? table[key] : key)
        }
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: 'project-mcp',
              order: 50,
              label: () => translate('popup_title'),
              // 会话级槽位：SlotCore 把当前 SessionId 交给 inject，返回值并入组件 props
              // （InputBar 渲染本槽位时只传 {}，不注入会话；官方 ui-plan / ui-permission-presets 同此用法）。
              inject: sessionId => ({ sessionId }),
            },
            McpConsoleButton,
          ),
        )
        // 「工具调试」Tab：conversation.view 是会话级 list 槽位，label 即 Tab 标题。
        // 回调必须**返回注册清理句柄**——声明 epoch 变化（HMR/插件重挂）时会先撤销
        // 旧注册再重跑回调；缺失会让旧注册泄漏，而 Tab 列表按全部条目渲染 → 重复 Tab。
        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register(
            {
              name: 'conversation.view',
              id: 'tool-debug',
              order: 16,
              label: () => translate('debug_tab'),
            },
            ToolDebugRoot,
          ),
        )
        // 样式随 fiber 清理：Cordis 的 effect 会在插件卸载/HMR 时执行返回的 disposer。
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => injectDebugCss(), 'project-mcp:tool-debug-css')
        } else {
          injectDebugCss()
        }
      },
    }
  },
})
