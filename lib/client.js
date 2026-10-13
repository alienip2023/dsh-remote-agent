/**
 * dsh-remote-agent 的浏览器半边（零依赖纯 JS，无 JSX/TS/import）。
 *
 * 两个插槽配对使用，这是 DSH 的标准"点侧栏图标打开面板"模式：
 *   - `sidebar.panellist`（list）：注册一个图标，id = 'dsh-remote-agent'
 *   - `main`（keyed）：注册面板，**key 必须等于那个 id** —— 点图标时 owner
 *     用该 id 去 main 里找对应面板。两边对不上就是"点了没反应"。
 *
 * 数据来源：fetch 本包 Host 半边注册的 `/api/remote-agent/ui/*` 路由。
 * 为什么不用别的通道：静态 bundle 的 client 半能拿到的 Client 服务只有
 * layout/sessions/slots/theme/timer/workspaces，**没有任何一个能读到远程节点或任务**；
 * 而 `host.call()` 属于动态包（cordis_run）机制。同 profile 的 dsh-context 与
 * dsh-better-sidebar 都是用 fetch 自己的路由，这是本机已验证可行的模式。
 *
 * 约束（来自 references/practices.md 与 ui-plugin.md）：
 *   - 不 import 任何 @deepseek-ai/* 客户端包（会随版本变，且无类型检查）
 *   - 只用 --dsw-alias-* 主题 token，不写死颜色（除图标本身的艺术色）
 *   - 不在组件外写 DOM；样式用 styles.insert 并随 apply 一起释放
 *   - 文本走 ctx.locale（此处未注册字典，直接给中文，避免引入未声明依赖）
 */
window.__ModuleLoader__.load({
  id: 'dsh-remote-agent',
  factory(require) {
    var React = require('react')
    var h = React.createElement

    var API = '/api/remote-agent/ui'
    var PANEL_KEY = 'dsh-remote-agent'

    /* ───────────────────────── 样式 ───────────────────────── */

    var CSS = [
      '.dra-root{display:flex;flex-direction:column;height:100%;min-height:0;',
      'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);',
      'font-size:13px;line-height:1.5}',
      '.dra-head{display:flex;align-items:center;gap:8px;padding:10px 14px;',
      'border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto}',
      '.dra-title{font-weight:600;font-size:14px}',
      '.dra-spacer{flex:1}',
      '.dra-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);',
      'background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);',
      'border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer;line-height:1.6}',
      '.dra-btn:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dra-btn[disabled]{opacity:.5;cursor:not-allowed}',
      '.dra-body{flex:1;min-height:0;overflow:auto;padding:12px 14px}',
      '.dra-cards{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}',
      '.dra-card{flex:1;min-width:88px;border:1px solid var(--dsw-alias-border-l1);',
      'background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:8px 10px}',
      '.dra-card-n{font-size:18px;font-weight:600}',
      '.dra-card-l{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dra-sec{margin:14px 0 6px;font-size:11px;letter-spacing:.04em;',
      'text-transform:uppercase;color:var(--dsw-alias-label-secondary)}',
      '.dra-row{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:6px;',
      'border:1px solid transparent}',
      '.dra-row:hover{background:var(--dsw-alias-bg-layer-1)}',
      '.dra-row.sel{border-color:var(--dsw-alias-brand-primary);',
      'background:var(--dsw-alias-bg-layer-1)}',
      '.dra-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;',
      // 兜底 currentColor：token 万一被改名，圆点退化成继承文字色而不是"隐形"。
      // （t11 曾报此 token 不存在，属误报 —— 宿主主题 CSS 里确有定义：
      //   --dsw-alias-state-idle-primary: var(--dsw-static-neutral-300/600)，
      //   且宿主自己的 idle 圆点就用它：._dot[data-state=idle]{color:var(...)}。
      //   采纳的是"缺兜底"这半条，不采纳"换成 label-tertiary" —— 那是文字色，
      //   语义不对，且宿主自身的选择才是权威。）
      'background:var(--dsw-alias-state-idle-primary,currentColor)}',
      '.dra-dot.on{background:var(--dsw-alias-state-success-primary,currentColor)}',
      '.dra-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}',
      '.dra-dim{color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.dra-ell{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dra-badge{font-size:10px;padding:1px 6px;border-radius:999px;',
      'border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
      '.dra-badge.run{color:var(--dsw-alias-brand-primary);',
      'border-color:var(--dsw-alias-brand-primary)}',
      '.dra-badge.ok{color:var(--dsw-alias-state-success-primary);',
      'border-color:var(--dsw-alias-state-success-primary)}',
      '.dra-badge.err{color:var(--dsw-alias-state-error-primary);',
      'border-color:var(--dsw-alias-state-error-primary)}',
      '.dra-pre{margin:6px 0 0;padding:8px;border-radius:6px;overflow:auto;max-height:220px;',
      'background:var(--dsw-alias-bg-layer-2);font-size:11.5px;white-space:pre-wrap;',
      'word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
      '.dra-err{margin:8px 0;padding:8px 10px;border-radius:6px;font-size:12px;',
      'border:1px solid var(--dsw-alias-state-error-primary);',
      'color:var(--dsw-alias-state-error-primary)}',
      '.dra-form{display:flex;flex-direction:column;gap:6px;margin:8px 0 4px}',
      '.dra-in,.dra-ta,.dra-sel{width:100%;box-sizing:border-box;border-radius:6px;',
      'border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);',
      'color:var(--dsw-alias-label-primary);padding:6px 8px;font-size:12.5px;',
      'font-family:inherit}',
      '.dra-ta{min-height:64px;resize:vertical}',
      '.dra-actions{display:flex;gap:8px;align-items:center;margin-top:2px}',
      '.dra-empty{color:var(--dsw-alias-label-secondary);padding:14px 2px;font-size:12px}',
      '.dra-file{display:flex;align-items:center;gap:6px;padding:3px 0;font-size:12px}',
    ].join('')

    /* ───────────────────────── 数据层 ───────────────────────── */

    function apiGet(p) {
      return fetch(API + p, { cache: 'no-store' }).then(function (r) {
        if (!r.ok) return r.json().catch(function () { return {} }).then(function (b) {
          throw new Error((b && (b.message || b.error)) || ('HTTP ' + r.status))
        })
        return r.json()
      })
    }

    function apiPost(p, body) {
      return fetch(API + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify(body || {}),
      }).then(function (r) {
        return r.json().catch(function () { return {} }).then(function (b) {
          if (!r.ok) throw new Error((b && (b.message || b.error)) || ('HTTP ' + r.status))
          return b
        })
      })
    }

    /* ───────────────────────── 小组件 ───────────────────────── */

    /**
     * 样式标签：**静态 bundle 的唯一正确注入方式**。
     *
     * 为什么不能只靠 ctx.get('styles').insert()：
     *   `styles` 是 **dynamic lane**（cordis-client-runner 闭包）的 builtin，
     *   静态 bundle（window.__ModuleLoader__ factory 形式）的 ctx 上没有这个服务 ——
     *   实测 ctx.get('styles') 返回 undefined，CSS 永远不会被注入，
     *   面板退化成无样式（.dra-root 拿不到 display:flex，字号回落 16px）。
     *
     * 官方给静态 bundle 的指引是"Component-local styles can render as React
     * elements so unmounting removes them"（references/practices.md）。所以这里把
     * <style> 作为 React 元素渲染：随组件挂载生效、随卸载自动移除，
     * 既不在组件外写 DOM，也不需要手动释放。
     *
     * 两处都保留：动态 lane 走 styles.insert（apply 里），静态 lane 走本组件。
     * 同时存在时只是多一份同内容样式，选择器相同，无副作用。
     */
    function StyleTag() {
      return h('style', { key: 'dra-css' }, CSS)
    }

    function Dot(props) {
      return h('span', { className: 'dra-dot' + (props.on ? ' on' : ''), title: props.on ? '在线' : '离线' })
    }

    function StatusBadge(props) {
      var s = props.status || 'unknown'
      var cls = 'dra-badge'
      if (s === 'running' || s === 'queued') cls += ' run'
      else if (s === 'completed') cls += ' ok'
      else if (s === 'failed') cls += ' err'
      return h('span', { className: cls }, s)
    }

    function fmtTime(ms) {
      if (!ms) return ''
      try { return new Date(ms).toLocaleTimeString() } catch (e) { return '' }
    }

    function fmtDur(ms) {
      if (typeof ms !== 'number' || ms < 0) return ''
      if (ms < 1000) return ms + 'ms'
      if (ms < 60000) return (ms / 1000).toFixed(1) + 's'
      return Math.floor(ms / 60000) + 'm' + Math.round((ms % 60000) / 1000) + 's'
    }

    /* ───────────────────────── 侧栏图标 ───────────────────────── */

    function PanelIcon(props) {
      var size = typeof props.size === 'number' ? props.size : 18
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
        // 两个屏幕 + 中间一条连线：远程同事的直白隐喻
        h('rect', { x: 2, y: 4, width: 8, height: 7, rx: 1.5 }),
        h('rect', { x: 14, y: 13, width: 8, height: 7, rx: 1.5 }),
        h('path', { d: 'M10 7.5h2.5a1.5 1.5 0 0 1 1.5 1.5v4' }),
      )
    }

    /* ───────────────────────── 主面板 ───────────────────────── */

    function Panel() {
      var st = React.useState({
        loading: true, error: '', nodes: [], tasks: [], counts: null, caps: null,
      })
      var state = st[0]
      var setState = st[1]

      var sel = React.useState(null)
      var selected = sel[0]
      var setSelected = sel[1]

      var det = React.useState(null)
      var detail = det[0]
      var setDetail = det[1]

      var form = React.useState({ goal: '', node: '', mode: 'agent', workspace: '', outputs: '' })
      var fv = form[0]
      var setForm = form[1]

      var busy = React.useState(false)
      var isBusy = busy[0]
      var setBusy = busy[1]

      var msg = React.useState('')
      var note = msg[0]
      var setNote = msg[1]

      var tick = React.useState(0)
      var setTick = tick[1]

      // 拉总览 + 任务列表。挂载后每 4 秒刷新一次（面板可见时才有意义，
      // 但 slots 不提供可见性回调，所以用固定间隔；间隔内不并发请求）。
      React.useEffect(function () {
        var disposed = false
        var inflight = false

        function load() {
          if (disposed || inflight) return
          inflight = true
          Promise.all([apiGet('/overview'), apiGet('/tasks')])
            .then(function (res) {
              if (disposed) return
              var ov = res[0] || {}
              var tk = res[1] || {}
              setState({
                loading: false, error: '',
                nodes: ov.nodes || [],
                counts: ov.counts || null,
                caps: ov.capabilities || null,
                tasks: tk.tasks || [],
              })
            })
            .catch(function (err) {
              if (disposed) return
              setState(function (s) {
                return {
                  loading: false,
                  error: String(err && err.message ? err.message : err),
                  nodes: s.nodes, tasks: s.tasks, counts: s.counts, caps: s.caps,
                }
              })
            })
            .then(function () { inflight = false })
        }

        load()
        var timer = setInterval(load, 4000)
        return function () { disposed = true; clearInterval(timer) }
      }, [setState])

      // 选中任务时拉详情（含 handoff）
      React.useEffect(function () {
        if (!selected) { setDetail(null); return }
        var disposed = false
        apiGet('/task?taskId=' + encodeURIComponent(selected))
          .then(function (d) { if (!disposed) setDetail(d) })
          .catch(function () { if (!disposed) setDetail(null) })
        return function () { disposed = true }
      }, [selected, tick, setDetail])

      function refresh() { setTick(function (n) { return n + 1 }) }

      function dispatch() {
        if (isBusy) return
        if (!fv.goal.trim()) { setNote('请填写任务目标'); return }
        setBusy(true); setNote('')
        var outputs = fv.outputs.split(/[,\n]/).map(function (s) { return s.trim() }).filter(Boolean)
        apiPost('/dispatch', {
          goal: fv.goal.trim(),
          node: fv.node || undefined,
          mode: fv.mode,
          workspace: fv.workspace.trim() || undefined,
          outputs: outputs.length ? outputs : undefined,
        })
          .then(function (r) {
            setNote('已派发：' + r.taskId)
            setForm(function (f) { var n = Object.assign({}, f); n.goal = ''; return n })
            refresh()
          })
          .catch(function (err) { setNote('派发失败：' + (err.message || err)) })
          .then(function () { setBusy(false) })
      }

      function cancel(taskId) {
        apiPost('/cancel', { taskId: taskId })
          .then(function (r) {
            setNote(r.requested ? '已发送取消请求' : '取消请求未送达（节点可能离线）')
            refresh()
          })
          .catch(function (err) { setNote('取消失败：' + (err.message || err)) })
      }

      function pull(taskId, paths) {
        apiPost('/pull', { taskId: taskId, paths: paths })
          .then(function (r) {
            var okN = (r.results || []).filter(function (x) { return x.ok }).length
            setNote('已拉取 ' + okN + '/' + (r.results || []).length + ' → ' + r.dest)
            refresh()
          })
          .catch(function (err) { setNote('拉取失败：' + (err.message || err)) })
      }

      if (state.loading) {
        return h('div', { className: 'dra-root' },
          h(StyleTag),
          h('div', { className: 'dra-body' }, '加载中…'),
        )
      }

      var counts = state.counts || {}
      var caps = state.caps || {}

      var head = h('div', { className: 'dra-head' },
        h('span', { className: 'dra-title' }, '远程同事'),
        // counts 可能为空对象（/overview 失败时）：直接相加会渲染 "undefined/undefined 在线"。
        h('span', { className: 'dra-dim' }, (counts.online || 0) + '/' + (counts.nodes || 0) + ' 在线'),
        h('span', { className: 'dra-spacer' }),
        h('button', { className: 'dra-btn', onClick: refresh }, '刷新'),
      )

      var errBox = state.error
        ? h('div', { className: 'dra-err' }, '读取失败：' + state.error)
        : null

      var cards = h('div', { className: 'dra-cards' },
        h('div', { className: 'dra-card' },
          h('div', { className: 'dra-card-n' }, String(counts.online || 0)),
          h('div', { className: 'dra-card-l' }, '在线节点')),
        h('div', { className: 'dra-card' },
          h('div', { className: 'dra-card-n' }, String(counts.running || 0)),
          h('div', { className: 'dra-card-l' }, '进行中')),
        h('div', { className: 'dra-card' },
          h('div', { className: 'dra-card-n' }, String(counts.tasks || 0)),
          h('div', { className: 'dra-card-l' }, '任务总数')),
      )

      // ── 节点 ──
      var nodeRows = state.nodes.length === 0
        ? h('div', { className: 'dra-empty' }, '还没有节点接入。在副电脑上装本插件并把 config.role 设为 worker。')
        : state.nodes.map(function (n) {
          return h('div', { key: n.nodeId, className: 'dra-row' },
            h(Dot, { on: n.online }),
            h('span', { className: 'dra-mono' }, n.nodeId),
            h('span', { className: 'dra-badge' }, n.os),
            n.agentMode ? h('span', { className: 'dra-badge' }, 'agent') : null,
            h('span', { className: 'dra-spacer' }),
            h('span', { className: 'dra-dim' }, '任务 ' + (n.taskCount || 0)),
            h('span', { className: 'dra-dim' }, fmtTime(n.lastSeen)),
          )
        })

      var nodeSection = h('div', null,
        h('div', { className: 'dra-sec' }, '节点'),
        nodeRows,
      )

      // ── 派任务表单 ──
      var nodeOptions = [{ id: '', label: state.nodes.length === 1 ? '（自动：唯一节点）' : '（请选择）' }]
        .concat(state.nodes.map(function (n) { return { id: n.nodeId, label: n.nodeId + (n.online ? '' : '（离线）') } }))

      var dispatchForm = h('div', null,
        h('div', { className: 'dra-sec' }, '派发任务'),
        h('div', { className: 'dra-form' },
          h('textarea', {
            className: 'dra-ta',
            placeholder: '任务目标，例如：在这个工作区里跑一遍测试并写出报告',
            value: fv.goal,
            onChange: function (e) { setForm(function (f) { var n = Object.assign({}, f); n.goal = e.target.value; return n }) },
          }),
          h('select', {
            className: 'dra-sel',
            value: fv.node,
            onChange: function (e) { setForm(function (f) { var n = Object.assign({}, f); n.node = e.target.value; return n }) },
          }, nodeOptions.map(function (o) { return h('option', { key: o.id, value: o.id }, o.label) })),
          h('select', {
            className: 'dra-sel',
            value: fv.mode,
            onChange: function (e) { setForm(function (f) { var n = Object.assign({}, f); n.mode = e.target.value; return n }) },
          },
            h('option', { value: 'agent' }, 'agent（副机起独立 agent 会话）'),
            h('option', { value: 'exec' }, 'exec（直接跑一段命令）'),
          ),
          h('input', {
            className: 'dra-in',
            placeholder: '工作区（留空用节点默认；须在副机 roots 内）',
            value: fv.workspace,
            onChange: function (e) { setForm(function (f) { var n = Object.assign({}, f); n.workspace = e.target.value; return n }) },
          }),
          h('input', {
            className: 'dra-in',
            placeholder: '期望产出 glob，逗号分隔（可选）',
            value: fv.outputs,
            onChange: function (e) { setForm(function (f) { var n = Object.assign({}, f); n.outputs = e.target.value; return n }) },
          }),
          h('div', { className: 'dra-actions' },
            h('button', {
              className: 'dra-btn',
              disabled: isBusy || !fv.goal.trim() || state.nodes.filter(function (n) { return n.online }).length === 0,
              onClick: dispatch,
            }, isBusy ? '派发中…' : '派发'),
            note ? h('span', { className: 'dra-dim' }, note) : null,
          ),
        ),
      )

      // ── 任务列表 ──
      var taskRows = state.tasks.length === 0
        ? h('div', { className: 'dra-empty' }, '还没有任务。')
        : state.tasks.map(function (t) {
          var isSel = t.taskId === selected
          return h('div', { key: t.taskId },
            h('div', {
              className: 'dra-row' + (isSel ? ' sel' : ''),
              onClick: function () { setSelected(isSel ? null : t.taskId) },
              style: { cursor: 'pointer' },
            },
              h(StatusBadge, { status: t.status }),
              h('span', { className: 'dra-ell', style: { flex: '1' }, title: t.goal }, t.goal || t.taskId),
              h('span', { className: 'dra-dim' }, t.nodeId),
              t.durationMs ? h('span', { className: 'dra-dim' }, fmtDur(t.durationMs)) : null,
            ),
            isSel ? h(TaskDetail, {
              task: t, detail: detail, caps: caps, onCancel: cancel, onPull: pull,
            }) : null,
          )
        })

      var taskSection = h('div', null,
        h('div', { className: 'dra-sec' }, '任务'),
        taskRows,
      )

      return h('div', { className: 'dra-root' },
        h(StyleTag),
        head,
        h('div', { className: 'dra-body' }, errBox, cards, nodeSection, dispatchForm, taskSection),
      )
    }

    /** 单任务展开区：结果卡 + 成品清单 + 操作。 */
    function TaskDetail(props) {
      var t = props.task || {}
      var d = props.detail || {}
      var handoff = d.handoff || null
      var manifest = (handoff && handoff.artifacts) || null
      var finals = (manifest && manifest.final) || []

      return h('div', { style: { padding: '4px 9px 12px' } },
        // 摘要
        t.summaryText ? h('div', null,
          h('div', { className: 'dra-sec' }, '结果摘要'),
          h('div', { className: 'dra-pre' }, t.summaryText),
        ) : null,

        // 失败原因
        t.error ? h('div', null,
          h('div', { className: 'dra-sec' }, '错误'),
          h('div', { className: 'dra-pre' }, (t.error.code || '') + ': ' + (t.error.message || '')),
        ) : null,

        // 变更
        //
        // 服务端已对 changed 做元素级投影（ui-routes.js 的 changedView），
        // 这里再挡一层：`c` 若非对象（null / 字符串 / 数字），直接解引用 `c.op`
        // 会抛 TypeError，而**渲染期抛错会让整个 slot entry 空白**（面板白屏）。
        // 纵深防御：不假设上游数据永远干净，因为上游数据源自副机上报。
        t.changedCount > 0 ? h('div', null,
          h('div', { className: 'dra-sec' }, '工作区变更（' + t.changedCount + '）'),
          (t.changed || []).slice(0, 12).map(function (c, i) {
            if (!c || typeof c !== 'object') return null
            return h('div', { key: i, className: 'dra-file' },
              h('span', { className: 'dra-badge' }, typeof c.op === 'string' ? c.op : 'unknown'),
              h('span', { className: 'dra-mono dra-ell' }, typeof c.path === 'string' ? c.path : ''),
              c.bytes ? h('span', { className: 'dra-dim' }, c.bytes + 'B') : null,
            )
          }),
        ) : null,

        // 成品清单 + 拉取
        h('div', null,
          h('div', { className: 'dra-sec' }, '成品（role:final）' +
            (manifest && manifest.counts ? '  ' + manifest.counts.final + ' 项' : '')),
          finals.length === 0
            ? h('div', { className: 'dra-dim' }, '本次没有可拉取的成品。中间产物只上报元数据，留在副机。')
            : h('div', null,
              finals.slice(0, 20).map(function (f, i) {
                return h('div', { key: i, className: 'dra-file' },
                  h('span', { className: 'dra-mono dra-ell', style: { flex: '1' }, title: f.path }, f.path),
                  h('span', { className: 'dra-badge' }, f.kind || 'file'),
                  h('span', { className: 'dra-dim' }, f.bytes + 'B'),
                )
              }),
              h('div', { className: 'dra-actions' },
                h('button', {
                  className: 'dra-btn',
                  disabled: !props.caps || !props.caps.pull,
                  title: props.caps && props.caps.pull
                    ? ('落地到 ' + props.caps.pullRoot)
                    : '未配置 uiPullRoot，拉取已禁用',
                  onClick: function () { props.onPull(t.taskId, finals.map(function (f) { return f.path })) },
                }, '拉取全部成品'),
              ),
            ),
        ),

        // 操作
        h('div', { className: 'dra-actions' },
          h('button', { className: 'dra-btn', onClick: function () { props.onCancel(t.taskId) } }, '取消任务'),
        ),

        // 日志尾部
        (t.logTail && t.logTail.length) ? h('div', null,
          h('div', { className: 'dra-sec' }, '日志尾部'),
          h('div', { className: 'dra-pre' }, t.logTail.join('\n')),
        ) : null,
      )
    }

    /* ───────────────────────── 插件导出 ───────────────────────── */

    return {
      // slots 是硬依赖（没有它整个插件没有意义）；locale 可选，本版未用字典。
      inject: ['slots'],
      apply: function (ctx) {
        var disposers = []

        // 样式随 apply 生命周期：卸载时自动摘掉 <style>
        var stylesSvc = ctx.get ? ctx.get('styles') : null
        if (stylesSvc && typeof stylesSvc.insert === 'function') {
          disposers.push(stylesSvc.insert(CSS))
        }

        // ① 侧栏图标
        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_KEY, order: 30, label: function () { return '远程同事' } },
            PanelIcon,
          )
        })

        // ② 主面板 —— key 必须与上面的 id 相同，否则点图标没有反应
        ctx.slots.inject('main', function () {
          return ctx.slots.register({ name: 'main', key: PANEL_KEY }, Panel)
        })

        return function () {
          for (var i = 0; i < disposers.length; i++) {
            try { disposers[i]() } catch (e) { /* 已释放 */ }
          }
        }
      },
    }
  },
})
