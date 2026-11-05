/*
 * Browser half of the DSH x hmz flow integration. Plain JS lazy factory; React
 * comes from the page's module table. Talks to the Host only through the
 * authenticated exact route `api/hmz-flow/rpc` (document-relative, as DSH's
 * own RPC does).
 */
window.__ModuleLoader__.load({
  id: '@dsh-hmz/flow',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'hmz-flow'
    const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

    const zh = {
      'menu.section': 'Flow',
      'menu.cancel': '取消 flow 模式',
      'menu.cancel.desc': '回到普通 DSH 对话',
      'menu.selected': '已选',
      'button.options': 'flow选项',
      'panel.title': 'Flow 选项',
      'panel.flow': 'Flow',
      'panel.history': '附带前文',
      'panel.history.desc': '启动 flow 时附带本会话可见的用户/助手消息快照（不含系统提示、工具原始日志）。',
      'panel.cancel': '取消 flow 模式',
      'panel.close': '关闭',
      'panel.roles': '角色',
      'panel.loading': '读取中…',
      'panel.later': '角色与预算会在启动时冻结；leader 不能修改这些选项。',
      'panel.saved': '已保存',
      'panel.error': '错误',
      'panel.agents': 'AGENTS',
      'panel.cli': 'CLI',
      'panel.account': 'ACCOUNT',
      'panel.model': 'MODEL',
      'panel.effort': 'EFFORT',
      'panel.local': 'Local',
      'panel.default': 'Default',
      'panel.budget': 'BUDGET',
      'panel.cost': 'COST, $',
      'panel.time': 'TIME, MIN',
      'panel.tokens': 'OUTPUT TOKENS',
      'panel.costGraceful': 'Cost graceful',
      'panel.timeGraceful': 'Time graceful',
      'panel.tokensGraceful': 'Tokens graceful',
      'panel.limitHint': '至少设置一个限制（chat 除外）。',
      'panel.params': 'PARAMS',
      'panel.envs': 'ENVIRONMENTS',
      'panel.envAuto': 'auto',
      'panel.envAutoHint': '留空 = hmz 自动提供',
      'panel.envHint': '运行时（同 hmz -e）',
      'panel.profileFlow': 'Profile flow',
      'panel.profileEnv': 'Profile environment',
      'panel.save': '保存',
      'panel.optional': '（可选）',
      'panel.bound': '已绑定',
      'panel.protect': '写保护开启：flow 修改代码，leader 只读、沟通与调度',
      'panel.release': '解除保护',
      'panel.releaseConfirm': '这次启动的结果未知。只有在你确认 hmz 没有运行这个 flow 时才解除写保护。继续？',
      'view.readonly': '只读视图：这里显示原生 hmz 界面，但写操作已禁用。请在下方 DSH 输入框与 leader 沟通（发送、回答、停止）。',
      'view.bound': '本会话绑定的 run',
      'view.unbound': '同目录正在运行的 run（不属于本会话，仅查看）',
      'view.label': 'Flow',
      'view.loading': '正在连接 hmz…',
      'view.reload': '重新连接',
      'view.none': '当前目录没有 hmz 运行；显示 hmz 首页。',
    }
    const en = {
      'menu.section': 'Flow',
      'menu.cancel': 'Leave flow mode',
      'menu.cancel.desc': 'Back to ordinary DSH conversation',
      'menu.selected': 'selected',
      'button.options': 'Flow options',
      'panel.title': 'Flow options',
      'panel.flow': 'Flow',
      'panel.history': 'Include history',
      'panel.history.desc': 'When a flow starts, attach a snapshot of the visible user/assistant messages (no system prompt, no raw tool logs).',
      'panel.cancel': 'Leave flow mode',
      'panel.close': 'Close',
      'panel.roles': 'Roles',
      'panel.loading': 'Loading…',
      'panel.later': 'Roles and budget are frozen at start; the leader cannot change these options.',
      'panel.saved': 'Saved',
      'panel.error': 'Error',
      'panel.agents': 'AGENTS',
      'panel.cli': 'CLI',
      'panel.account': 'ACCOUNT',
      'panel.model': 'MODEL',
      'panel.effort': 'EFFORT',
      'panel.local': 'Local',
      'panel.default': 'Default',
      'panel.budget': 'BUDGET',
      'panel.cost': 'COST, $',
      'panel.time': 'TIME, MIN',
      'panel.tokens': 'OUTPUT TOKENS',
      'panel.costGraceful': 'Cost graceful',
      'panel.timeGraceful': 'Time graceful',
      'panel.tokensGraceful': 'Tokens graceful',
      'panel.limitHint': 'At least one limit (except chat).',
      'panel.params': 'PARAMS',
      'panel.envs': 'ENVIRONMENTS',
      'panel.envAuto': 'auto',
      'panel.envAutoHint': 'empty = provided by hmz',
      'panel.envHint': 'runtime (as hmz -e)',
      'panel.profileFlow': 'Profile flow',
      'panel.profileEnv': 'Profile environment',
      'panel.save': 'Save',
      'panel.optional': ' (optional)',
      'panel.bound': 'Bound',
      'panel.protect': 'Write protection ON: the flow edits code; the leader reads, talks and steers',
      'panel.release': 'Release protection',
      'panel.releaseConfirm': 'The outcome of this start is unknown. Release write protection only if you have confirmed hmz is not running this flow. Continue?',
      'view.readonly': 'Read-only view: native hmz is shown but writes are disabled. Talk to the leader in the DSH composer below (send, answer, stop).',
      'view.bound': 'Run bound to this session',
      'view.unbound': 'Run in this directory (not this session\'s; view only)',
      'view.label': 'Flow',
      'view.loading': 'Connecting to hmz…',
      'view.reload': 'Reconnect',
      'view.none': 'No hmz run in this directory; showing the hmz home.',
    }

    // ------------------------------------------------------------ Host RPC
    async function rpc(op, sessionId, extra) {
      const response = await fetch('api/hmz-flow/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op, sessionId, ...extra }),
      })
      let body = null
      try { body = await response.json() } catch { /* fallthrough */ }
      if (!response.ok || !body || body.ok !== true) {
        const why = body && body.error ? body.error : `HTTP ${response.status}`
        throw new Error(why)
      }
      return body.result
    }

    // ---------------------------------------------- per-session client cache
    /** sessionId -> { selection, open, flows, error, listeners:Set, loading } */
    const sessions = new Map()
    function entry(sessionId) {
      let one = sessions.get(sessionId)
      if (!one) {
        one = { selection: null, open: false, flows: null, error: null, saving: false, listeners: new Set(), version: 0, loading: null }
        sessions.set(sessionId, one)
      }
      return one
    }
    function emit(one) {
      one.version += 1
      for (const listener of [...one.listeners]) listener()
    }
    function load(sessionId) {
      const one = entry(sessionId)
      if (one.loading) return one.loading
      one.loading = rpc('getSelection', sessionId).then(
        (selection) => { one.selection = selection; one.error = null; emit(one) },
        (error) => { one.error = error.message; emit(one); one.loading = null },
      )
      return one.loading
    }
    async function refresh(sessionId) {
      const one = entry(sessionId)
      try {
        one.selection = await rpc('getSelection', sessionId)
        one.error = null
      } catch (error) { one.error = error.message }
      emit(one)
    }
    async function save(sessionId, patch) {
      const one = entry(sessionId)
      one.saving = true
      emit(one)
      try {
        one.selection = { ...one.selection, ...(await rpc('setSelection', sessionId, { selection: patch })) }
        one.error = null
      } catch (error) {
        one.error = error.message
      } finally {
        one.saving = false
        emit(one)
      }
    }
    function setOpen(sessionId, open) {
      const one = entry(sessionId)
      one.open = open
      emit(one)
    }
    function useSessionEntry(sessionId) {
      const one = entry(sessionId)
      React.useSyncExternalStore(
        (listener) => { one.listeners.add(listener); return () => one.listeners.delete(listener) },
        () => one.version,
      )
      React.useEffect(() => { if (sessionId) void load(sessionId) }, [sessionId])
      return one
    }

    // --------------------------------------------------------------- styles
    const css = `
.hmzf-btn{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 10px;border:none;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
.hmzf-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.hmzf-btn[aria-expanded="true"]{outline:1px solid var(--dsw-alias-border-l2)}
.hmzf-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-secondary)}
.hmzf-panel{margin:0 0 8px;padding:12px 14px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.hmzf-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;font-weight:500}
.hmzf-row{display:flex;align-items:center;gap:10px;padding:6px 0}
.hmzf-row label{flex:1}
.hmzf-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.hmzf-select{height:28px;border-radius:6px;border:0.5px solid var(--dsw-alias-border-l2);background:transparent;color:inherit;font:inherit}
.hmzf-switch{position:relative;width:34px;height:20px;border-radius:10px;border:none;cursor:pointer;background:var(--dsw-alias-border-l2);flex:none}
.hmzf-switch[aria-checked="true"]{background:var(--dsw-alias-label-primary)}
.hmzf-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-module-platform,#fff);transition:left .15s}
.hmzf-switch[aria-checked="true"]::after{left:16px}
.hmzf-roles{margin:4px 0 0;padding:0;list-style:none}
.hmzf-roles li{padding:2px 0;color:var(--dsw-alias-label-secondary)}
.hmzf-link{border:none;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;padding:0 4px}
.hmzf-error{color:var(--dsw-alias-label-danger,#c33)}
.hmzf-sec{margin:10px 0 4px;font-size:11px;letter-spacing:.06em;color:var(--dsw-alias-label-secondary)}
.hmzf-cap{display:block;font-size:11px;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary)}
.hmzf-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin:2px 0 4px}
.hmzf-field{display:flex;flex-direction:column;gap:2px}
.hmzf-field .hmzf-select{width:100%}
.hmzf-input{height:28px;border-radius:6px;border:0.5px solid var(--dsw-alias-border-l2);background:transparent;color:inherit;font:inherit;padding:0 6px}
textarea.hmzf-input{height:auto;padding:4px 6px;font-family:var(--dsw-font-mono,monospace);font-size:12px}
.hmzf-check{display:inline-flex;align-items:center;gap:4px;margin-right:12px}
.hmzf-role{padding:6px 0;border-top:0.5px solid var(--dsw-alias-border-l2)}
.hmzf-save{height:28px;padding:0 14px;border-radius:6px;border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-module-platform,#fff);cursor:pointer;font:inherit}
.hmzf-bound{padding:6px 8px;margin-bottom:6px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l2)}
.hmzf-active{border-color:var(--dsw-alias-label-secondary)}
.hmzf-readonly{padding:6px 10px;font-size:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform);border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.hmzf-view{display:flex;flex-direction:column;height:100%;min-height:0;flex:1}
.hmzf-bar{display:flex;align-items:center;gap:8px;padding:4px 8px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.hmzf-frame{flex:1;width:100%;min-height:480px;border:0;background:var(--dsw-alias-bg-module-platform)}
`
    function Style() { return h('style', null, css) }

    // ----------------------------------------------- composer: options button
    function makeOptionsButton(t) {
      return function HmzFlowOptionsButton(props) {
        const sessionId = props.sessionId
        const one = useSessionEntry(sessionId)
        const selection = one.selection
        if (!sessionId || !selection || !selection.flow) return null
        return h(React.Fragment, null,
          h(Style),
          h('button', {
            type: 'button',
            className: 'hmzf-btn',
            'data-hmz-flow': 'options',
            'aria-expanded': String(one.open),
            title: `${t('button.options')} · ${selection.flow}`,
            onClick: () => setOpen(sessionId, !one.open),
          }, h('span', { className: 'hmzf-dot', 'aria-hidden': true }), `${t('button.options')} · ${selection.flow}`),
        )
      }
    }

    // ------------------------------------------------- composer: options panel
    /** `cli@account/model:effort` -> parts; '' parts when absent. */
    function parseSpec(spec) {
      if (typeof spec !== 'string' || !spec.includes('/')) return { cli: '', account: '', model: '', effort: '' }
      const slash = spec.indexOf('/')
      const head = spec.slice(0, slash)
      let rest = spec.slice(slash + 1)
      const [cli, account = ''] = head.split('@')
      let effort = ''
      const colon = rest.lastIndexOf(':')
      if (colon > 0) { effort = rest.slice(colon + 1); rest = rest.slice(0, colon) }
      return { cli, account, model: rest, effort: effort === 'auto' ? '' : effort }
    }
    function buildSpec(p) {
      if (!p.cli || !p.model) return ''
      return `${p.cli}${p.account ? `@${p.account}` : ''}/${p.model}${p.effort ? `:${p.effort}` : ''}`
    }
    function initialForm(declared, saved) {
      // Saved DSH options are authoritative once present (even when cleared);
      // hmz's remembered workspace settings only seed a never-saved form.
      const source = saved || declared.remembered || {}
      const agents = {}
      for (const role of declared.agents.filter((a) => !a.auto)) {
        const parts = parseSpec((source.agents && source.agents[role.name]) || '')
        if (!parts.cli && !saved) parts.cli = role.clis[0] || ''
        agents[role.name] = parts
      }
      const envs = {}
      for (const role of declared.envs || []) envs[role.name] = (source.envs && source.envs[role.name]) || ''
      const budget = source.budget && typeof source.budget === 'object' ? source.budget : {}
      const g = budget.graceful
      const grace = (k) => (g && typeof g === 'object' ? g[k] !== false : g !== false)
      const seconds = typeof budget.duration === 'number' ? budget.duration : null
      return {
        agents,
        envs,
        cost: budget.cost === undefined || budget.cost === 'Infinity' ? '' : String(budget.cost),
        minutes: seconds === null ? '' : String(Math.round(seconds / 60)),
        tokens: budget.output_tokens === undefined ? '' : String(budget.output_tokens),
        graceful: { cost: grace('cost'), duration: grace('duration'), output_tokens: grace('output_tokens') },
        params: JSON.stringify(source.params || {}, null, 1),
        profile_flow: source.profile_flow === true,
        profile_environment: source.profile_environment === true,
      }
    }
    function formToOptions(form) {
      const agents = {}
      for (const [role, parts] of Object.entries(form.agents)) agents[role] = buildSpec(parts)
      const envs = {}
      for (const [role, spec] of Object.entries(form.envs || {})) if (spec.trim()) envs[role] = spec.trim()
      const budget = {}
      if (form.cost !== '') budget.cost = Number(form.cost)
      if (form.minutes !== '') budget.duration = Number(form.minutes) * 60
      if (form.tokens !== '') budget.output_tokens = Number(form.tokens)
      const flags = Object.values(form.graceful)
      if (Object.keys(budget).length) budget.graceful = flags.every((f) => f === flags[0]) ? flags[0] : { ...form.graceful }
      let params = {}
      const text = form.params.trim()
      if (text) params = JSON.parse(text)
      return { agents, envs, budget: Object.keys(budget).length ? budget : null, params, profile_flow: form.profile_flow, profile_environment: form.profile_environment }
    }

    function makePanel(t) {
      return function HmzFlowOptionsPanel(props) {
        const sessionId = props.sessionId
        const one = useSessionEntry(sessionId)
        const [declared, setDeclared] = React.useState(null)
        const [backends, setBackends] = React.useState(null)
        const [flows, setFlows] = React.useState(null)
        const [form, setForm] = React.useState(null)
        const [problem, setProblem] = React.useState(null)
        const [note, setNote] = React.useState('')
        const selection = one.selection
        const flow = selection && selection.flow
        React.useEffect(() => {
          if (!one.open || !flow) return undefined
          let live = true
          setDeclared(null); setForm(null); setProblem(null); setNote('')
          Promise.all([rpc('flow', sessionId, { name: flow }), rpc('getOptions', sessionId, { flow })]).then(
            ([d, saved]) => { if (live) { setDeclared(d); setForm(initialForm(d, saved)) } },
            (e) => { if (live) setProblem(e.message) },
          )
          rpc('backends', sessionId).then((b) => { if (live) setBackends(b) }, () => {})
          rpc('flows', sessionId).then((d) => { if (live) setFlows(d.flows) }, () => {})
          return () => { live = false }
        }, [one.open, flow, sessionId])
        React.useEffect(() => {
          if (!one.open || !sessionId) return undefined
          const timer = setInterval(() => { void refresh(sessionId) }, 5000)
          return () => clearInterval(timer)
        }, [one.open, sessionId])
        if (!sessionId || !one.open || !flow) return null
        const history = selection.includeHistory !== false
        const binding = selection.binding
        const active = binding && ['starting', 'running', 'stopping', 'unknown'].includes(binding.phase)
        const setAgent = (role, patch) => setForm((f) => ({ ...f, agents: { ...f.agents, [role]: { ...f.agents[role], ...patch } } }))
        const accountsOf = (cli) => (backends && backends.clis && backends.clis[cli] ? backends.clis[cli].accounts : [{ name: '', models: [] }])
        const modelsOf = (cli, account) => {
          const acct = accountsOf(cli).find((a) => a.name === account)
          return acct ? acct.models : []
        }
        const select = (label, value, choices, onChange, key) => h('label', { className: 'hmzf-field', key },
          h('span', { className: 'hmzf-cap' }, label),
          h('select', { className: 'hmzf-select', value, onChange: (e) => onChange(e.target.value), 'data-hmz-field': key }, choices.map(([v, l]) => h('option', { key: v, value: v }, l))))
        const input = (label, value, onChange, key, extra = {}) => h('label', { className: 'hmzf-field', key },
          h('span', { className: 'hmzf-cap' }, label),
          h('input', { className: 'hmzf-input', value, onChange: (e) => onChange(e.target.value), 'data-hmz-field': key, ...extra }))
        const check = (label, checked, onChange, key) => h('label', { className: 'hmzf-check', key },
          h('input', { type: 'checkbox', checked, onChange: (e) => onChange(e.target.checked), 'data-hmz-field': key }), label)
        async function saveForm() {
          setNote('')
          let options
          try { options = formToOptions(form) } catch (e) { setNote(`${t('panel.error')}: params JSON — ${e.message}`); return }
          try { await rpc('setOptions', sessionId, { flow, options }); setNote(t('panel.saved')) } catch (e) { setNote(`${t('panel.error')}: ${e.message}`) }
        }
        async function release() {
          if (!window.confirm(t('panel.releaseConfirm'))) return
          try { await rpc('releaseUnknown', sessionId); await refresh(sessionId) } catch (e) { setNote(`${t('panel.error')}: ${e.message}`) }
        }
        return h('section', { className: 'hmzf-panel', 'data-hmz-flow': 'panel', 'aria-label': t('panel.title') },
          h(Style),
          h('div', { className: 'hmzf-head' },
            h('span', null, t('panel.title')),
            h('span', null,
              one.saving ? h('span', { className: 'hmzf-desc' }, '…') : null,
              h('button', { type: 'button', className: 'hmzf-link', onClick: () => { void save(sessionId, { flow: null }); setOpen(sessionId, false) } }, t('panel.cancel')),
              h('button', { type: 'button', className: 'hmzf-link', onClick: () => setOpen(sessionId, false) }, t('panel.close')),
            ),
          ),
          binding ? h('div', { className: active ? 'hmzf-bound hmzf-active' : 'hmzf-bound', 'data-hmz-flow': 'binding' },
            `${t('panel.bound')}: run #${binding.run ?? '?'} · ${binding.flow || ''} · ${binding.phase}${binding.epicName ? ` · ${binding.epicName}` : ''}`,
            active ? h('div', { className: 'hmzf-desc' }, t('panel.protect')) : null,
            binding.phase === 'unknown' ? h('button', { type: 'button', className: 'hmzf-link', 'data-hmz-flow': 'release', onClick: release }, t('panel.release')) : null,
          ) : null,
          h('div', { className: 'hmzf-row' },
            h('label', { htmlFor: `hmzf-flow-${sessionId}` }, t('panel.flow')),
            h('select', {
              id: `hmzf-flow-${sessionId}`, className: 'hmzf-select', value: flow, 'data-hmz-flow': 'flow-select',
              onChange: (event) => { void save(sessionId, { flow: event.target.value }) },
            }, (flows || [{ name: flow }]).map((f) => h('option', { key: f.name, value: f.name }, f.name))),
          ),
          h('div', { className: 'hmzf-row' },
            h('label', { id: `hmzf-hist-${sessionId}` },
              h('div', null, t('panel.history')),
              h('div', { className: 'hmzf-desc' }, t('panel.history.desc'))),
            h('button', {
              type: 'button', role: 'switch', className: 'hmzf-switch', 'aria-checked': String(history),
              'aria-labelledby': `hmzf-hist-${sessionId}`, 'data-hmz-flow': 'history-switch',
              onClick: () => { void save(sessionId, { includeHistory: !history }) },
            }),
          ),
          declared && form ? h('div', { 'data-hmz-flow': 'form' },
            h('div', { className: 'hmzf-desc' }, declared.description),
            h('div', { className: 'hmzf-sec' }, t('panel.agents')),
            declared.agents.filter((a) => !a.auto).map((role) => {
              const p = form.agents[role.name] || { cli: '', account: '', model: '', effort: '' }
              const models = modelsOf(p.cli, p.account)
              const model = models.find((m) => m.name === p.model)
              const efforts = model ? model.efforts : (p.effort ? [p.effort] : [])
              return h('div', { className: 'hmzf-role', key: role.name, 'data-hmz-role': role.name },
                h('div', { className: 'hmzf-cap' }, `${role.name}${role.required ? '' : t('panel.optional')}`),
                h('div', { className: 'hmzf-grid' },
                  select(t('panel.cli'), p.cli, [['', '—'], ...role.clis.map((c) => [c, c])], (v) => setAgent(role.name, { cli: v, account: '', model: '', effort: '' }), `${role.name}.cli`),
                  select(t('panel.account'), p.account, accountsOf(p.cli).map((a) => [a.name, a.name || t('panel.local')]), (v) => setAgent(role.name, { account: v, model: '', effort: '' }), `${role.name}.account`),
                  // Free text with suggestions: hmz's cached model list can lag the
                  // backend's real catalog, so any model id may be typed.
                  input(t('panel.model'), p.model, (v) => setAgent(role.name, { model: v.trim() }), `${role.name}.model`,
                    { placeholder: 'model', list: `hmzf-models-${sessionId}-${role.name}` }),
                  h('datalist', { id: `hmzf-models-${sessionId}-${role.name}`, key: `${role.name}.models` }, models.map((m) => h('option', { key: m.name, value: m.name }))),
                  select(t('panel.effort'), p.effort, [['', t('panel.default')], ...efforts.map((e) => [e, e])], (v) => setAgent(role.name, { effort: v }), `${role.name}.effort`),
                ),
                h('div', { className: 'hmzf-desc' }, `${role.permission ? Object.entries(role.permission).map(([k, v]) => `${k}:${v}`).join(' · ') : ''}`))
            }),
            h('div', { className: 'hmzf-sec' }, t('panel.budget')),
            h('div', { className: 'hmzf-grid' },
              input(t('panel.cost'), form.cost, (v) => setForm((f) => ({ ...f, cost: v })), 'cost', { type: 'number', min: '0', step: '0.01', placeholder: 'dollars' }),
              input(t('panel.time'), form.minutes, (v) => setForm((f) => ({ ...f, minutes: v })), 'minutes', { type: 'number', min: '0', step: '1', placeholder: 'minutes' }),
              input(t('panel.tokens'), form.tokens, (v) => setForm((f) => ({ ...f, tokens: v })), 'tokens', { type: 'number', min: '0', step: '1000', placeholder: 'output tokens' }),
            ),
            h('div', { className: 'hmzf-row' },
              check(t('panel.costGraceful'), form.graceful.cost, (v) => setForm((f) => ({ ...f, graceful: { ...f.graceful, cost: v } })), 'g.cost'),
              check(t('panel.timeGraceful'), form.graceful.duration, (v) => setForm((f) => ({ ...f, graceful: { ...f.graceful, duration: v } })), 'g.duration'),
              check(t('panel.tokensGraceful'), form.graceful.output_tokens, (v) => setForm((f) => ({ ...f, graceful: { ...f.graceful, output_tokens: v } })), 'g.tokens'),
            ),
            h('div', { className: 'hmzf-desc' }, declared.name === 'chat' ? '' : t('panel.limitHint')),
            (declared.envs || []).length ? h('div', { 'data-hmz-flow': 'envs' },
              h('div', { className: 'hmzf-sec' }, t('panel.envs')),
              h('div', { className: 'hmzf-grid' }, declared.envs.map((role) => input(
                `${role.name}${role.auto ? ` (${t('panel.envAuto')})` : role.required ? '' : t('panel.optional')}`,
                form.envs[role.name] || '',
                (v) => setForm((f) => ({ ...f, envs: { ...f.envs, [role.name]: v } })),
                `env.${role.name}`,
                { placeholder: role.auto ? t('panel.envAutoHint') : t('panel.envHint') },
              )))) : null,
            Object.keys((declared.params && declared.params.properties) || {}).length
              ? h('label', { className: 'hmzf-field' }, h('span', { className: 'hmzf-cap' }, `${t('panel.params')} (JSON)`),
                h('textarea', { className: 'hmzf-input', rows: 3, value: form.params, onChange: (e) => setForm((f) => ({ ...f, params: e.target.value })), 'data-hmz-field': 'params' }))
              : null,
            h('div', { className: 'hmzf-row' },
              check(t('panel.profileFlow'), form.profile_flow, (v) => setForm((f) => ({ ...f, profile_flow: v })), 'profile_flow'),
              check(t('panel.profileEnv'), form.profile_environment, (v) => setForm((f) => ({ ...f, profile_environment: v })), 'profile_environment'),
            ),
            h('div', { className: 'hmzf-row' },
              h('button', { type: 'button', className: 'hmzf-save', onClick: saveForm, 'data-hmz-flow': 'save' }, t('panel.save')),
              h('span', { className: 'hmzf-desc', 'data-hmz-flow': 'save-note' }, note || t('panel.later'))),
          ) : h('div', { className: 'hmzf-desc' }, problem ? `${t('panel.error')}: ${problem}` : t('panel.loading')),
          one.error ? h('div', { className: 'hmzf-error' }, `${t('panel.error')}: ${one.error}`) : null,
        )
      }
    }
    // ------------------------------------------------------------ Flow view
    function makeView(t) {
      return function HmzFlowView(props) {
        const sessionId = props.sessionId
        const [embed, setEmbed] = React.useState(null)
        const [problem, setProblem] = React.useState(null)
        const [attempt, setAttempt] = React.useState(0)
        React.useEffect(() => {
          if (!sessionId) return undefined
          let live = true
          setEmbed(null)
          setProblem(null)
          rpc('embed', sessionId).then((e) => { if (live) setEmbed(e) }, (e) => { if (live) setProblem(e.message) })
          return () => { live = false }
        }, [sessionId, attempt])
        const host = LOOPBACK.has(location.hostname) ? location.hostname : '127.0.0.1'
        const src = embed ? `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${embed.port}${embed.path}` : null
        let note = ''
        if (embed) {
          const b = embed.binding
          if (embed.target === 'bound' && b) note = `${t('view.bound')}: #${b.run ?? '?'} · ${b.flow || ''} · ${b.phase} · ${b.epicName}`
          else if (embed.target === 'unbound-running' && embed.status) note = `${t('view.unbound')}: #${embed.status.run} · ${embed.status.flow} · ${embed.status.epicName}`
          else note = t('view.none')
        }
        return h('div', { className: 'hmzf-view', 'data-hmz-flow': 'view' },
          h(Style),
          embed && embed.readOnly ? h('div', { className: 'hmzf-readonly', role: 'note', 'data-hmz-flow': 'readonly' }, t('view.readonly')) : null,
          h('div', { className: 'hmzf-bar' },
            h('span', { style: { flex: 1 }, 'data-hmz-flow': 'view-note' }, problem ? h('span', { className: 'hmzf-error' }, problem) : (embed ? note : t('view.loading'))),
            h('button', { type: 'button', className: 'hmzf-link', onClick: () => setAttempt((n) => n + 1) }, t('view.reload'))),
          src ? h('iframe', { key: src, className: 'hmzf-frame', src, title: 'hmz', 'data-hmz-flow': 'frame', referrerPolicy: 'no-referrer' }) : null,
        )
      }
    }
    // ------------------------------------------------ '/' menu: Flow group
    function makeSource(ctx, t) {
      const cache = new Map() // sessionId -> { at, flows }
      async function flowsOf(sessionId) {
        const hit = cache.get(sessionId)
        if (hit && Date.now() - hit.at < 30000) return hit.flows
        const result = await rpc('flows', sessionId)
        cache.set(sessionId, { at: Date.now(), flows: result.flows })
        return result.flows
      }
      function consume(sessionId, span) {
        const actx = ctx.sessions && ctx.sessions.scope ? ctx.sessions.scope(sessionId) : undefined
        if (actx) actx.bail(actx, 'slash/input-consume-token', { guard: { kind: 'span', span } })
      }
      return {
        trigger: '/',
        name: 'hmz-flow',
        order: 50,
        async candidates(session, req) {
          if (req.position !== 'leading') return []
          let flows
          try { flows = await flowsOf(session.sessionId) } catch { return [] }
          const q = req.query.trim().toLowerCase()
          const selected = entry(session.sessionId).selection
          const rows = flows
            .filter((f) => !q || f.name.toLowerCase().includes(q) || 'flow'.startsWith(q) || (f.about || '').toLowerCase().includes(q))
            .map((f) => ({
              name: f.name,
              description: `${selected && selected.flow === f.name ? `[${t('menu.selected')}] ` : ''}${f.about || ''}`,
              section: t('menu.section'),
              value: f.name,
            }))
          if (selected && selected.flow && (!q || 'flow'.startsWith(q) || t('menu.cancel').toLowerCase().includes(q))) {
            rows.push({ name: 'flow-off', label: t('menu.cancel'), description: t('menu.cancel.desc'), section: t('menu.section'), value: '' })
          }
          return rows
        },
        onPick(pick) {
          if (pick.action !== 'pick') return undefined
          const sessionId = pick.session.sessionId
          consume(sessionId, pick.span)
          const flow = pick.candidate.value || null
          void save(sessionId, { flow }).then(() => { if (flow) setOpen(sessionId, true) })
          if (!flow) setOpen(sessionId, false)
          return 'handled'
        },
      }
    }

    return {
      inject: ['slots', 'locale', 'inputTriggers', 'sessions'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'hmz-flow: dictionaries')
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.inputTriggers.registerSource(makeSource(ctx, t)), 'hmz-flow: / source')
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left', id: 'hmz-flow-options', order: 50, locale: NS,
        }, makeOptionsButton(t)))
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock', id: 'hmz-flow-panel', order: 50, locale: NS,
        }, makePanel(t)))
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view', id: 'hmz-flow', order: 20, locale: NS,
          label: () => t('view.label'),
        }, makeView(t)))
      },
    }
  },
})
