/**
 * 项目级 MCP 控制台的 Client 半边（plain-JS bundle，格式见 cordis-plugin-development 模板）。
 *
 * - 按钮注册进 `conversation.input.left`（composer 工具行，compact controls）：图标 + 状态文字，
 *   文案进 tooltip；工作区没有 `.mcp.json` 计划时不渲染（保持"不打扰"）。会话级槽位渲染时
 *   传空 props（InputBar 给 `{}`），当前 SessionId 必须经注册项的 `inject(sessionId)` 注入
 *   （同 ui-plan / ui-permission-presets 的官方用法）；
 * - 弹层由按钮组件**内联渲染**（fixed，锚定在按钮上方）：点击弹层外、按 Esc、窗口缩放都会
 *   关闭——与权限菜单的 dismiss 行为一致。刻意不用 `shell.overlay`（root 作用域拿不到会话，
 *   且跨组件共享开关状态正是上一版"关不掉"的根源）；
 * - 状态经同源 `fetch('/project-mcp/status')` 轮询（1.5s），nonce 从 tapIndex 注入的 meta 读；
 * - 只渲染 Host 算好的视图，本模块**不**折叠任何会话数据（practices.md 第 38 条）；
 * - 刻意不 require `@deepseek-ai/dsh-client-ui-primitives` 的 Menu：那需要在 package.json 声明
 *   external，而 dsh.client 元数据按包名缓存到进程重启才失效——为一个关闭行为让用户再重启一次不值。
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
      },
    }
  },
})
