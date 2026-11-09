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

    const zh = {
      'menu.section': 'Flow',
      'cmd.label': 'Flow',
      'cmd.desc': '选择本会话使用的 hmz flow（只选择，不启动）',
      'cmd.search': '搜索 flow',
      'cmd.empty': '当前目录没有可用的 hmz flow',
      'cmd.noResults': '没有匹配的 flow',
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
      'observer.toggle': '流程提醒',
      'observer.toggle.desc': 'flow 运行时，偶尔查看它的工作记录：你值得知道的知识或设计取舍，以及有记录为证的执行问题（反复出错、与最新要求不符），会在输入框上方提示一条。只给你看，不会发消息给 flow 或改变任务。按新的工作进展触发查看，失败会退避重试；使用秘书当前的模型，费用另计，不计入 flow 预算。',
      'observer.aria': '流程提醒',
      'observer.tag.know': '值得知道',
      'observer.tag.heads': '请注意',
      'observer.expand': '展开说明',
      'observer.collapse': '收起',
      'observer.known': '知道了',
      'observer.dismiss': '忽略',
      'observer.off': '关闭提醒',
      'observer.evidence': '依据（来自 flow 的工作记录）：',
      'observer.source': '{session} · 第 {record} 条记录 · {kind}',
      'observer.kind.tool': '工具 {tool}',
      'observer.kind.toolError': '工具 {tool}（报错）',
      'observer.kind.instruction': '收到的指令',
      'observer.kind.message': '消息',
      'observer.status.off': '提醒已关闭。',
      'observer.status.idle': '已开启；启动 flow 后才会查看。',
      'observer.status.count': '（成功观察 {successes} 次，调用 {n} 次）',
      'observer.status.retry': '将在 {at} 后重试。',
      'observer.source.live': '{session} · 实时记录 {record} · {kind}',
      'observer.status.checking': '正在查看最新的工作记录…',
      'observer.status.notRunning': '这个任务没有在运行，不再查看。',
      'observer.status.noModel': '秘书当前没有可用的模型，暂时无法查看。',
      'observer.status.timeout': '上一次查看超时。',
      'observer.status.failed': '上一次查看没有成功。',
      'observer.status.watching': '已开启：有新的工作记录时才查看，没有值得说的就不打扰。',
      'observer.partial': '这条提醒只基于最近的一部分记录。',
      'panel.modelNotInDsh': '提示：{model} 不在当前 DSH 官方目录（deepseek-official）中，已按原样保留；该目录现有：{models}。hmz 自带的模型列表可能过时；若这个账号用的是自定义 endpoint，这个模型仍可能可用。',
      'stop.button': '停止 flow',
      'stop.stopping': '正在停止…',
      'stop.confirm': '停止这个 flow 任务？（这会停止 hmz 里正在运行的任务，不同于停止 leader 的回复）',
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
      'view.label': 'Flow',
      'view.scope': '本页只显示这个 DSH 会话启动的 hmz 任务。',
      'view.empty': '这个会话还没有 flow 任务。',
      'view.emptySelected': '已选 flow：{flow}。消息先交给秘书（leader），由它判断是直接回答、澄清，还是用这个 flow 启动任务或转发给运行中的 flow。',
      'view.emptyHint': '在输入框键入 / ，在 Flow 分组选择一个 flow。',
      'view.runs': '本会话的任务',
      'view.current': '当前',
      'view.history': '正在查看历史任务；leader 的发送、回答和停止仍作用于当前任务{current}。',
      'view.refresh': '刷新',
      'view.loading': '读取中…',
      'view.noEpic': 'hmz 还没有为这个任务写出 epic。',
      'view.agents': 'AGENT → SESSION',
      'view.noSessions': '还没有打开会话',
      'view.pickSession': '选择一个会话查看输出。',
      'view.noOutput': '这个会话还没有记录到输出。',
      'view.older': '加载更早的 {n} 条',
      'view.cut': '（已截断 {n} 字）',
      'view.toolNoOutput': '（hmz 记录中无输出）',
      'view.waiting': '等待你回答：{text}（请在下方输入框告诉 leader）',
      'view.task': '任务',
      'view.readonly': '在 DSH 里请通过 leader 发送、回答或停止',
      'view.outOfScope': '不属于这个 DSH 会话的这个任务',
      'phase.starting': '启动中',
      'phase.running': '运行中',
      'phase.waitingAnswer': '等待回答（{n}）',
      'phase.stopping': '停止中',
      'phase.unknown': '结果未知',
      'phase.ended': '已结束',
      'phase.released': '已解除保护',
      'cat.turn': '轮次',
      'cat.llm': '思考',
      'cat.message': '消息',
      'cat.tool': '工具',
    }
    const en = {
      'menu.section': 'Flow',
      'cmd.label': 'Flow',
      'cmd.desc': 'Choose the hmz flow for this session (select only, does not start)',
      'cmd.search': 'Search flows',
      'cmd.empty': 'No hmz flows are available here',
      'cmd.noResults': 'No matching flow',
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
      'observer.toggle': 'Flow reminders',
      'observer.toggle.desc': 'While a flow runs, its work record is looked at now and then: knowledge or design tradeoffs worth knowing, and execution problems the record shows (repeated errors, not matching the latest request) appear as one short reminder above the composer. Only you see it; nothing is sent to the flow and the task is not changed. New work triggers a look; failed checks retry with backoff. Uses the secretary\'s current model; the cost is separate from the flow budget.',
      'observer.aria': 'Flow reminder',
      'observer.tag.know': 'Worth knowing',
      'observer.tag.heads': 'Heads up',
      'observer.expand': 'Explain',
      'observer.collapse': 'Collapse',
      'observer.known': 'Got it',
      'observer.dismiss': 'Dismiss',
      'observer.off': 'Turn reminders off',
      'observer.evidence': 'Based on (from the flow\'s work record):',
      'observer.source': '{session} · record {record} · {kind}',
      'observer.kind.tool': 'tool {tool}',
      'observer.kind.toolError': 'tool {tool} (error)',
      'observer.kind.instruction': 'instruction received',
      'observer.kind.message': 'message',
      'observer.status.off': 'Reminders are off.',
      'observer.status.idle': 'On; looks once a flow has started.',
      'observer.status.count': '({successes} successful checks, {n} calls)',
      'observer.status.retry': 'Retries after {at}.',
      'observer.source.live': '{session} · live record {record} · {kind}',
      'observer.status.checking': 'Looking at the latest work record…',
      'observer.status.notRunning': 'This run is not running; no more looking.',
      'observer.status.noModel': 'The secretary has no model available right now, so nothing can be looked at.',
      'observer.status.timeout': 'The last look timed out.',
      'observer.status.failed': 'The last look did not succeed.',
      'observer.status.watching': 'On: looks only when there is new work, and stays quiet unless something matters.',
      'observer.partial': 'This reminder is based on only the latest part of the record.',
      'panel.modelNotInDsh': 'Note: {model} is not in the current DSH official catalog (deepseek-official); kept as entered. That catalog has: {models}. hmz\'s own model list may be outdated; with a custom endpoint on this account the model may still work.',
      'stop.button': 'Stop flow',
      'stop.stopping': 'Stopping…',
      'stop.confirm': 'Stop this flow run? (This stops the run in hmz, not the leader\'s reply.)',
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
      'view.label': 'Flow',
      'view.scope': 'This page shows only the hmz runs this DSH session started.',
      'view.empty': 'This session has no flow runs yet.',
      'view.emptySelected': 'Selected flow: {flow}. Messages go to the secretary (leader) first; it decides whether to answer, ask, start a run with this flow, or pass a message to a running flow.',
      'view.emptyHint': 'Type / in the composer and pick a flow in the Flow group.',
      'view.runs': 'Runs of this session',
      'view.current': 'current',
      'view.history': 'Viewing an earlier run; the leader\'s send, answer and stop still act on the current run{current}.',
      'view.refresh': 'Refresh',
      'view.loading': 'Loading…',
      'view.noEpic': 'hmz has not written an epic for this run yet.',
      'view.agents': 'AGENT → SESSION',
      'view.noSessions': 'no sessions opened yet',
      'view.pickSession': 'Pick a session to read its output.',
      'view.noOutput': 'Nothing recorded for this session yet.',
      'view.older': 'Load {n} earlier',
      'view.cut': '(cut, {n} more chars)',
      'view.toolNoOutput': '(no output recorded by hmz)',
      'view.waiting': 'Waiting for your answer: {text} (tell the leader in the composer below)',
      'view.task': 'Task',
      'view.readonly': 'In DSH, send, answer or stop through the leader',
      'view.outOfScope': 'Not part of this DSH session\'s run',
      'phase.starting': 'starting',
      'phase.running': 'running',
      'phase.waitingAnswer': 'waiting for your answer ({n})',
      'phase.stopping': 'stopping',
      'phase.unknown': 'outcome unknown',
      'phase.ended': 'ended',
      'phase.released': 'protection released',
      'cat.turn': 'turn',
      'cat.llm': 'thinking',
      'cat.message': 'message',
      'cat.tool': 'tool',
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
    /** Save a selection and report failure to the caller (the popup shows it). */
    async function saveOrThrow(sessionId, patch) {
      const one = entry(sessionId)
      one.saving = true
      emit(one)
      try {
        one.selection = { ...one.selection, ...(await rpc('setSelection', sessionId, { selection: patch })) }
        one.error = null
      } catch (error) {
        one.error = error.message
        throw error
      } finally {
        one.saving = false
        emit(one)
      }
    }
    /** The one way a flow is chosen (from `/` or from +): select only, never start. */
    async function chooseFlow(sessionId, flow) {
      await saveOrThrow(sessionId, { flow })
      setOpen(sessionId, !!flow)
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
.hmzf-runbar{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:0.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}
.hmzf-chip{border:0.5px solid var(--dsw-alias-border-l2);background:none;color:inherit;font:inherit;font-size:12px;padding:2px 8px;border-radius:12px;cursor:pointer}
.hmzf-grow{flex:1}
.hmzf-native{flex:1;width:100%;min-height:520px;border:0;background:var(--dsw-alias-bg-module-platform)}
.hmzf-view.hmzf-split{flex-direction:row;gap:0;overflow:hidden}
.hmzf-nav{width:260px;flex:none;overflow:auto;padding:8px 10px;border-right:0.5px solid var(--dsw-alias-border-l2);font-size:13px}
.hmzf-main{flex:1;min-width:0;overflow:auto;padding:10px 16px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.hmzf-run,.hmzf-session,.hmzf-agent-head{display:block;width:100%;text-align:left;border:none;background:none;color:inherit;font:inherit;padding:4px 6px;border-radius:6px;cursor:pointer}
.hmzf-run:hover,.hmzf-session:hover,.hmzf-agent-head:hover{background:var(--dsw-alias-interactive-bg-hover)}
.hmzf-sel{background:var(--dsw-alias-bg-module-platform);outline:0.5px solid var(--dsw-alias-border-l2)}
.hmzf-session{padding-left:20px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.hmzf-indent{padding-left:20px}
.hmzf-empty{margin:48px auto;max-width:520px;text-align:center;display:flex;flex-direction:column;gap:8px}
.hmzf-empty-title{font-size:15px;color:var(--dsw-alias-label-primary)}
.hmzf-pad{padding:16px}
.hmzf-note{margin:0 0 8px;padding:6px 10px;border-radius:8px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:12px}
.hmzf-runhead{display:flex;align-items:baseline;gap:4px;margin-bottom:8px}
.hmzf-runhead .hmzf-link{margin-left:auto}
.hmzf-task pre,.hmzf-act pre{white-space:pre-wrap;word-break:break-word;margin:4px 0 0;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-module-platform);font-family:var(--dsw-font-mono,monospace);font-size:12px;max-height:360px;overflow:auto}
.hmzf-act{padding:4px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2)}
.hmzf-act summary{cursor:pointer}
.hmzf-tag{display:inline-block;min-width:34px;padding:0 6px;border-radius:4px;font-size:11px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.hmzf-act-error .hmzf-tag{color:var(--dsw-alias-label-danger,#c33)}
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
.hmzf-stop{height:26px;margin-left:8px;padding:0 10px;border-radius:6px;border:0.5px solid var(--dsw-alias-label-danger,#c33);background:transparent;color:var(--dsw-alias-label-danger,#c33);font:inherit;font-size:12px;cursor:pointer}
.hmzf-stop:disabled{opacity:.6;cursor:default}
.hmzf-observer{border-color:var(--dsw-alias-border-l2)}
.hmzf-obs-head{display:flex;align-items:baseline;gap:8px}
.hmzf-obs-title{flex:1;min-width:0;color:var(--dsw-alias-label-primary)}
.hmzf-obs-detail{margin:6px 0;white-space:pre-wrap;word-break:break-word}
.hmzf-obs-ev pre{white-space:pre-wrap;word-break:break-word;margin:2px 0 6px;padding:4px 8px;border-radius:6px;background:var(--dsw-alias-bg-module-platform);font-family:var(--dsw-font-mono,monospace);font-size:12px;max-height:160px;overflow:auto}
.hmzf-bound{padding:6px 8px;margin-bottom:6px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l2)}
.hmzf-active{border-color:var(--dsw-alias-label-secondary)}
.hmzf-view{display:flex;flex-direction:column;height:100%;min-height:0;flex:1}
.hmzf-bar{display:flex;align-items:center;gap:8px;padding:4px 8px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
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
      // hmz budget.duration is seconds; this input displays minutes.
      const seconds = typeof budget.duration === 'number' ? budget.duration : null
      return {
        agents,
        envs,
        cost: budget.cost === undefined || budget.cost === 'Infinity' ? '' : String(budget.cost),
        minutes: seconds === null ? '' : String(seconds / 60),
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
      const Panel = makePanelBody(t)
      // One panel per DSH session: nothing (state or a late reply) carries over.
      return function HmzFlowOptionsPanel(props) {
        return props.sessionId ? h(Panel, { key: props.sessionId, sessionId: props.sessionId }) : null
      }
    }

    function makePanelBody(t) {
      return function HmzFlowOptionsPanelBody(props) {
        const sessionId = props.sessionId
        const one = useSessionEntry(sessionId)
        const [declared, setDeclared] = React.useState(null)
        const [backends, setBackends] = React.useState(null)
        const [dshModels, setDshModels] = React.useState(null)
        const [flows, setFlows] = React.useState(null)
        const [form, setForm] = React.useState(null)
        const [problem, setProblem] = React.useState(null)
        const [note, setNote] = React.useState('')
        const [observing, setObserving] = React.useState(null) // observer view, or null until read
        // Observer reads are numbered: only the newest reply is applied, and
        // nothing after this panel is gone (each session has its own panel).
        const obsSeq = React.useRef(0)
        const obsAlive = React.useRef(true)
        React.useEffect(() => { obsAlive.current = true; return () => { obsAlive.current = false; obsSeq.current += 1 } }, [])
        const loadObserver = React.useCallback(async () => {
          const seq = ++obsSeq.current
          try {
            const v = await rpc('observerGet', sessionId)
            if (obsAlive.current && seq === obsSeq.current) setObserving(v)
          } catch { /* the status line keeps the last known state */ }
        }, [sessionId])
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
          // The models DSH itself serves: what an hmz `dsh` agent actually runs.
          rpc('dshModels', sessionId).then((d) => { if (live) setDshModels(d.models || []) }, () => { if (live) setDshModels([]) })
          rpc('flows', sessionId).then((d) => { if (live) setFlows(d.flows) }, () => {})
          void loadObserver()
          return () => { live = false; obsSeq.current += 1 }
        }, [one.open, flow, sessionId])
        React.useEffect(() => {
          if (!form || !dshModels || !dshModels.length) return
          const empty = Object.entries(form.agents).filter(([, p]) => p.cli === 'dsh' && !p.model)
          if (!empty.length) return
          setForm((f) => ({ ...f, agents: Object.fromEntries(Object.entries(f.agents).map(([r, p]) => [r, p.cli === 'dsh' && !p.model ? { ...p, model: dshModels[0].id } : p])) }))
        }, [form, dshModels])
        React.useEffect(() => {
          if (!one.open || !sessionId) return undefined
          const timer = setInterval(() => { void refresh(sessionId); void loadObserver() }, 5000)
          return () => clearInterval(timer)
        }, [one.open, sessionId, loadObserver])
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
          try {
            await rpc('setOptions', sessionId, { flow, options })
          } catch (e) {
            // A failed save keeps the panel open with the reason.
            setNote(`${t('panel.error')}: ${e.message}`)
            return
          }
          // Saved: the panel folds away; flow选项 opens it again with the saved values.
          setNote(t('panel.saved'))
          setOpen(sessionId, false)
        }
        async function stopRun() {
          if (!binding || !window.confirm(t('stop.confirm'))) return
          setNote('')
          try {
            await rpc('stopRun', sessionId, { runId: binding.requestId, identity: { hostPid: binding.hostPid, hostStarted: binding.hostStarted, run: binding.run, epic: binding.epic } })
            await refresh(sessionId)
          } catch (e) { setNote(`${t('panel.error')}: ${e.message}`) }
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
            binding.phase === 'running' ? h('button', { type: 'button', className: 'hmzf-stop', 'data-hmz-flow': 'stop', onClick: stopRun }, t('stop.button')) : null,
            binding.phase === 'stopping' ? h('button', { type: 'button', className: 'hmzf-stop', disabled: true, 'data-hmz-flow': 'stop' }, t('stop.stopping')) : null,
          ) : null,
          note ? h('div', { className: note.startsWith(t('panel.error')) ? 'hmzf-error' : 'hmzf-desc', 'data-hmz-flow': 'panel-note' }, note) : null,
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
          h('div', { className: 'hmzf-row' },
            h('label', { id: `hmzf-obs-${sessionId}` },
              h('div', null, t('observer.toggle')),
              h('div', { className: 'hmzf-desc' }, t('observer.toggle.desc')),
              observing ? h('div', { className: observerStatusIsProblem(observing) ? 'hmzf-error' : 'hmzf-desc', 'data-hmz-flow': 'observer-status' }, observerStatusText(t, observing)) : null),
            h('button', {
              type: 'button', role: 'switch', className: 'hmzf-switch', 'aria-checked': String(!!observing && observing.enabled !== false),
              'aria-labelledby': `hmzf-obs-${sessionId}`, 'data-hmz-flow': 'observer-switch', disabled: observing === null,
              onClick: () => {
                const next = observing.enabled === false
                // Shown at once; any read still on its way is now stale.
                const seq = ++obsSeq.current
                setObserving((v) => ({ ...v, enabled: next, checking: next && v.checking }))
                rpc('observerSet', sessionId, { enabled: next }).then(
                  () => { if (obsAlive.current) void loadObserver() },
                  (e) => {
                    if (!obsAlive.current) return
                    if (seq === obsSeq.current) setNote(`${t('panel.error')}: ${e.message}`)
                    void loadObserver()
                  })
              },
            }),
          ),
          declared && form ? h('div', { 'data-hmz-flow': 'form' },
            h('div', { className: 'hmzf-desc' }, declared.description),
            h('div', { className: 'hmzf-sec' }, t('panel.agents')),
            declared.agents.filter((a) => !a.auto).map((role) => {
              const p = form.agents[role.name] || { cli: '', account: '', model: '', effort: '' }
              const hmzModels = modelsOf(p.cli, p.account)
              const fromDsh = p.cli === 'dsh' && dshModels ? dshModels.map((m) => ({ name: m.id, efforts: [] })) : []
              const models = [...fromDsh, ...hmzModels.filter((m) => !fromDsh.some((d) => d.name === m.name))]
              const model = hmzModels.find((m) => m.name === p.model)
              const outdated = p.cli === 'dsh' && dshModels && dshModels.length && p.model && !dshModels.some((m) => m.id === p.model)
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
                outdated ? h('div', { className: 'hmzf-error', 'data-hmz-flow': 'model-warning' }, fmt(t('panel.modelNotInDsh'), { model: p.model, models: dshModels.map((m) => m.id).join(', ') })) : null,
                h('div', { className: 'hmzf-desc' }, `${role.permission ? Object.entries(role.permission).map(([k, v]) => `${k}:${v}`).join(' · ') : ''}`))
            }),
            h('div', { className: 'hmzf-sec' }, t('panel.budget')),
            h('div', { className: 'hmzf-grid' },
              input(t('panel.cost'), form.cost, (v) => setForm((f) => ({ ...f, cost: v })), 'cost', { type: 'number', min: '0', step: '0.01', placeholder: 'dollars' }),
              input(t('panel.time'), form.minutes, (v) => setForm((f) => ({ ...f, minutes: v })), 'minutes', { type: 'number', min: '0', step: 'any', placeholder: 'minutes' }),
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
              h('span', { className: 'hmzf-desc', 'data-hmz-flow': 'save-note' }, t('panel.later'))),
          ) : h('div', { className: 'hmzf-desc' }, problem ? `${t('panel.error')}: ${problem}` : t('panel.loading')),
          one.error ? h('div', { className: 'hmzf-error' }, `${t('panel.error')}: ${one.error}`) : null,
        )
      }
    }
    // ------------------------------------------------------------ Flow view
    function fmt(text, vars) {
      return String(text).replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] !== undefined ? String(vars[k]) : ''))
    }
    function phaseLabel(t, run, pending) {
      const base = t(`phase.${run.phase}`) || run.phase
      if (run.phase === 'ended') return `${base}${run.endedHow ? ` · ${run.endedHow}` : ''}`
      if (run.phase === 'running' && pending && pending.length) return `${base} · ${fmt(t('phase.waitingAnswer'), { n: pending.length })}`
      return base
    }
    const ACTIVE = new Set(['starting', 'running', 'stopping', 'unknown'])

    /**
     * hmz's own epic view of one run, in a sandboxed iframe. The viewer cannot
     * reach any server; it asks this page, which answers only this run's two
     * reads (hmz's own detail and trace), for this session, and refuses the rest.
     */
    function NativeFrame({ t, sessionId, run }) {
      const frame = React.useRef(null)
      React.useEffect(() => {
        const epic = run.epicName
        const answer = async (said) => {
          const path = String(said.path || '')
          const url = new URL(path, 'http://viewer')
          const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
          if (said.method !== 'GET') return { status: 403, body: { error: t('view.readonly') } }
          if (parts[0] === 'api' && parts[1] === 'runs' && parts[2] === epic && parts.length === 3) {
            return { status: 200, body: await rpc('viewDetail', sessionId, { runId: run.runId }) }
          }
          if (parts[0] === 'api' && parts[1] === 'runs' && parts[2] === epic && parts[3] === 'trace' && parts.length === 4) {
            return { status: 200, body: await rpc('viewTrace', sessionId, { runId: run.runId }) }
          }
          if (parts[0] === 'api' && parts[1] === 'btw') return { status: 200, body: { asides: [], default: '' } }
          return { status: 404, body: { error: t('view.outOfScope') } }
        }
        const onMessage = (event) => {
          if (!frame.current || event.source !== frame.current.contentWindow) return
          const said = event.data
          if (!said || said.hmzf !== 'fetch' || typeof said.id !== 'number') return
          answer(said).then(
            (reply) => frame.current && frame.current.contentWindow.postMessage({ hmzf: 'reply', id: said.id, ...reply }, '*'),
            (error) => frame.current && frame.current.contentWindow.postMessage({ hmzf: 'reply', id: said.id, status: 502, body: { error: error.message } }, '*'),
          )
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [sessionId, run.runId, run.epicName])
      if (!run.epicName) return h('div', { className: 'hmzf-pad hmzf-desc' }, t('view.noEpic'))
      return h('iframe', {
        ref: frame,
        className: 'hmzf-native',
        title: `hmz · ${run.flow} #${run.run ?? '?'}`,
        sandbox: 'allow-scripts',
        referrerPolicy: 'no-referrer',
        'data-hmz-flow': 'native',
        'data-hmz-run': run.runId,
        src: `hmzf-viewer/index.html#/epics/${encodeURIComponent(run.epicName)}`,
      })
    }

    /**
     * One session's Flow page: this session's runs, and hmz's own view of the
     * one selected. Mounted per DSH session (keyed by sessionId); each run's
     * viewer is its own iframe (keyed by run id), so nothing of one run or
     * session can be drawn into another.
     */
    function SessionFlow({ t, sessionId }) {
      const one = useSessionEntry(sessionId)
      const [list, setList] = React.useState(null)
      const [listError, setListError] = React.useState(null)
      const [runId, setRunId] = React.useState(null)
      const [note, setNote] = React.useState('')
      const busy = React.useRef(false)
      const load = React.useCallback(async () => {
        if (busy.current) return
        busy.current = true
        try {
          const got = await rpc('runs', sessionId)
          setList(got); setListError(null)
          setRunId((cur) => cur && got.runs.some((r) => r.runId === cur) ? cur
            : (got.currentRunId && got.runs.some((r) => r.runId === got.currentRunId) ? got.currentRunId : (got.runs[0] ? got.runs[0].runId : null)))
        } catch (error) { setListError(error.message) } finally { busy.current = false }
      }, [sessionId])
      React.useEffect(() => {
        void load()
        const timer = setInterval(() => { void load() }, 4000)
        return () => clearInterval(timer)
      }, [load])
      const flow = one.selection && one.selection.flow
      if (list === null) {
        return h('div', { className: 'hmzf-view', 'data-hmz-flow': 'view' }, h(Style),
          h('div', { className: 'hmzf-pad hmzf-desc' }, listError ? h('span', { className: 'hmzf-error' }, listError) : t('view.loading')))
      }
      if (!list.runs.length) {
        return h('div', { className: 'hmzf-view', 'data-hmz-flow': 'view', 'data-hmz-state': 'empty' }, h(Style),
          h('div', { className: 'hmzf-empty' },
            h('div', { className: 'hmzf-empty-title' }, t('view.empty')),
            h('div', { className: 'hmzf-desc' }, flow ? fmt(t('view.emptySelected'), { flow }) : t('view.emptyHint')),
            h('div', { className: 'hmzf-desc' }, t('view.scope'))))
      }
      const selected = list.runs.find((r) => r.runId === runId) || list.runs[0]
      const current = list.runs.find((r) => r.current)
      const pending = list.pending || []
      async function stop(run) {
        if (!window.confirm(t('stop.confirm'))) return
        setNote('')
        try { await rpc('stopRun', sessionId, { runId: run.runId, identity: run.identity }); await load() } catch (e) { setNote(`${t('panel.error')}: ${e.message}`) }
      }
      return h('div', { className: 'hmzf-view', 'data-hmz-flow': 'view', 'data-hmz-state': 'runs' }, h(Style),
        h('div', { className: 'hmzf-runbar', 'data-hmz-flow': 'runbar' },
          list.runs.map((r) => h('button', {
            key: r.runId, type: 'button', className: `hmzf-chip${r.runId === selected.runId ? ' hmzf-sel' : ''}`,
            'data-hmz-run': r.runId, 'data-hmz-phase': r.phase, onClick: () => setRunId(r.runId),
          }, `${r.flow} #${r.run ?? '?'} · ${phaseLabel(t, r, r.current ? pending : [])}${r.current ? ` · ${t('view.current')}` : ''}`)),
          h('span', { className: 'hmzf-grow' }),
          selected.current && selected.phase === 'running'
            ? h('button', { type: 'button', className: 'hmzf-stop', 'data-hmz-flow': 'stop', onClick: () => { void stop(selected) } }, t('stop.button')) : null,
          selected.current && selected.phase === 'stopping'
            ? h('button', { type: 'button', className: 'hmzf-stop', disabled: true, 'data-hmz-flow': 'stop' }, t('stop.stopping')) : null),
        note ? h('div', { className: 'hmzf-error hmzf-pad' }, note) : null,
        current && selected.runId !== current.runId
          ? h('div', { className: 'hmzf-note', 'data-hmz-flow': 'history-note' }, fmt(t('view.history'), { current: ` #${current.run ?? '?'}` })) : null,
        selected.current && pending.length
          ? pending.map((q) => h('div', { key: q.question, className: 'hmzf-note', 'data-hmz-flow': 'pending' }, fmt(t('view.waiting'), { text: q.text }))) : null,
        h(NativeFrame, { key: selected.runId, t, sessionId, run: selected }))
    }

    /** One plain line saying what the reminders are doing for this session. */
    function observerStatusText(t, v) {
      if (v.enabled === false) return t('observer.status.off')
      if (!v.runId) return t('observer.status.idle')
      const counted = fmt(t('observer.status.count'), { n: v.attempts, successes: v.successes || 0 })
      if (v.checking) return `${t('observer.status.checking')} ${counted}`
      if (!v.current || v.phase !== 'running') return `${t('observer.status.notRunning')} ${counted}`
      const kind = v.status && v.status.kind
      const retry = v.retryAt ? fmt(t('observer.status.retry'), { at: new Date(v.retryAt).toLocaleTimeString() }) : ''
      if (kind === 'no-model') return `${t('observer.status.noModel')} ${retry}`
      if (kind === 'timeout') return `${t('observer.status.timeout')} ${retry} ${counted}`
      if (kind === 'error') return `${t('observer.status.failed')} ${retry} ${counted}`
      return `${t('observer.status.watching')} ${counted}`
    }
    function observerStatusIsProblem(v) {
      const kind = v.status && v.status.kind
      return v.enabled !== false && !v.checking && (kind === 'no-model' || kind === 'timeout' || kind === 'error')
    }

    /**
     * The flow observer's note for the current run, above the composer: a short
     * reminder that can be expanded, marked known, dismissed, or turned off.
     * One card per DSH session (keyed); replies are applied only if they are the
     * newest asked for this session, so a late reply never shows another
     * session's or an older run's note. Text is rendered as text; nothing here
     * talks to the flow.
     */
    function makeObserverCard(t) {
      const Card = makeObserverCardBody(t)
      return function HmzFlowObserverCard(props) {
        return props.sessionId ? h(Card, { key: props.sessionId, sessionId: props.sessionId }) : null
      }
    }

    function makeObserverCardBody(t) {
      return function HmzFlowObserverCardBody({ sessionId }) {
        const [view, setView] = React.useState(null)
        const [expanded, setExpanded] = React.useState(false)
        const [problem, setProblem] = React.useState('')
        const seq = React.useRef(0)
        const alive = React.useRef(true)
        const load = React.useCallback(async () => {
          const mine = ++seq.current
          try {
            const got = await rpc('observerGet', sessionId)
            if (!alive.current || mine !== seq.current) return
            setView(got); setProblem('')
          } catch (e) {
            if (alive.current && mine === seq.current) setProblem(e.message)
          }
        }, [sessionId])
        React.useEffect(() => {
          alive.current = true
          void load()
          const timer = setInterval(() => { void load() }, 8000)
          return () => { alive.current = false; seq.current += 1; clearInterval(timer) }
        }, [load])
        const open = view && view.current && view.enabled ? view.notes.filter((x) => x.status === 'open') : []
        const n = open.length ? open[open.length - 1] : null
        const noteKey = n ? `${view.runId}|${n.id}` : ''
        React.useEffect(() => { setExpanded(false) }, [noteKey])
        if (!n) return null
        const act = async (action) => {
          const mine = ++seq.current
          try {
            await rpc('observerAct', sessionId, { runId: view.runId, noteId: n.id, action })
            if (alive.current && mine === seq.current) { setExpanded(false); await load() }
          } catch (e) { if (alive.current && mine === seq.current) setProblem(e.message) }
        }
        const off = async () => {
          const mine = ++seq.current
          try {
            await rpc('observerSet', sessionId, { enabled: false })
            if (alive.current && mine === seq.current) await load()
          } catch (e) { if (alive.current && mine === seq.current) setProblem(e.message) }
        }
        const where = (ev) => fmt(t(ev.source === 'live' ? 'observer.source.live' : 'observer.source'), {
          session: ev.session, record: ev.source === 'live' ? ev.index : ev.index + 1,
          kind: ev.category === 'tool' ? fmt(t(ev.error ? 'observer.kind.toolError' : 'observer.kind.tool'), { tool: ev.tool || '?' })
            : ev.category === 'instruction' ? t('observer.kind.instruction') : t('observer.kind.message'),
        })
        return h('section', { className: 'hmzf-panel hmzf-observer', 'data-hmz-flow': 'observer', 'data-hmz-note': n.id, 'data-hmz-run': view.runId, 'aria-label': t('observer.aria') },
          h(Style),
          h('div', { className: 'hmzf-obs-head' },
            h('span', { className: 'hmzf-tag' }, n.tag === 'heads_up' ? t('observer.tag.heads') : t('observer.tag.know')),
            h('span', { className: 'hmzf-obs-title', 'data-hmz-flow': 'observer-title' }, n.title)),
          expanded ? h('div', { 'data-hmz-flow': 'observer-detail' },
            h('p', { className: 'hmzf-obs-detail' }, n.detail),
            n.partial ? h('div', { className: 'hmzf-desc' }, t('observer.partial')) : null,
            h('div', { className: 'hmzf-desc' }, t('observer.evidence')),
            n.evidence.map((ev, i) => h('div', { key: i, className: 'hmzf-obs-ev', 'data-hmz-flow': 'observer-evidence' },
              h('div', { className: 'hmzf-desc' }, where(ev)),
              h('pre', null, ev.excerpt)))) : null,
          h('div', { className: 'hmzf-row' },
            h('button', { type: 'button', className: 'hmzf-link', 'data-hmz-flow': 'observer-expand', onClick: () => setExpanded((x) => !x) }, expanded ? t('observer.collapse') : t('observer.expand')),
            h('button', { type: 'button', className: 'hmzf-link', 'data-hmz-flow': 'observer-known', onClick: () => { void act('known') } }, t('observer.known')),
            h('button', { type: 'button', className: 'hmzf-link', 'data-hmz-flow': 'observer-dismiss', onClick: () => { void act('dismissed') } }, t('observer.dismiss')),
            h('span', { className: 'hmzf-grow' }),
            h('button', { type: 'button', className: 'hmzf-link', 'data-hmz-flow': 'observer-off', onClick: () => { void off() } }, t('observer.off'))),
          problem ? h('div', { className: 'hmzf-error' }, problem) : null)
      }
    }

    function makeView(t) {
      return function HmzFlowView(props) {
        if (!props.sessionId) return null
        return h(SessionFlow, { key: props.sessionId, t, sessionId: props.sessionId })
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
          // A failure is kept in the session entry and shown in the composer controls.
          void chooseFlow(sessionId, pick.candidate.value || null).catch(() => {})
          return 'handled'
        },
      }
    }

    /** Value of the "leave flow mode" row; never a flow name (flow names have no spaces). */
    const OFF = ' off'

    /**
     * The composer's + menu lists only `command` entries, so the flow choice is
     * also a client command contribution (`/flow`): its popup lists this
     * workspace's hmz flows through the shared popupSelect shell, which owns
     * the trigger token and leaves any draft text alone.
     */
    /** Row glyph in the shared icon style: currentColor strokes on a 16px grid. */
    function FlowIcon(props) {
      const size = (props && props.size) || 16
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, className: props && props.className },
        h('circle', { cx: 4, cy: 4, r: 1.6, stroke: 'currentColor' }),
        h('circle', { cx: 12, cy: 4, r: 1.6, stroke: 'currentColor' }),
        h('circle', { cx: 8, cy: 12, r: 1.6, stroke: 'currentColor' }),
        h('path', { d: 'M5.2 5.2 7.2 10.6M10.8 5.2 8.8 10.6', stroke: 'currentColor' }))
    }

    function flowCommand(ctx, t) {
      return {
        name: 'flow',
        icon: FlowIcon,
        label: () => t('cmd.label'),
        description: () => t('cmd.desc'),
        available: (session) => !(ctx.sessions && typeof ctx.sessions.subagentAddress === 'function' && ctx.sessions.subagentAddress(session.sessionId) !== undefined),
        ui: {
          kind: 'popupSelect',
          searchMode: 'fuzzy-label',
          searchLabels: () => ({ placeholder: t('cmd.search'), empty: t('cmd.empty'), noResults: t('cmd.noResults') }),
          async options(session) {
            const sessionId = session.sessionId
            const one = entry(sessionId)
            if (!one.selection) await load(sessionId)
            const listed = await rpc('flows', sessionId)
            const selected = one.selection && one.selection.flow
            const group = { name: 'hmz-flows', label: t('menu.section') }
            const rows = listed.flows.map((f) => ({ id: f.name, label: f.name, detail: f.about || '', active: f.name === selected, group }))
            if (selected) rows.push({ id: OFF, label: t('menu.cancel'), detail: t('menu.cancel.desc') })
            return rows
          },
          async onSelect(option, session) {
            await chooseFlow(session.sessionId, option.id === OFF ? null : option.id)
            // Choosing a flow edits nothing in the draft. The shell would consume the
            // span it captured at open, which from ＋ is the user's selection; closing
            // the popup ourselves (public dismiss) revokes that, so the draft stays.
            const commandUi = ctx.get('commandUi')
            if (commandUi && typeof commandUi.dismiss === 'function') commandUi.dismiss('flow')
            // A typed `/flow` (or `/fl…` picked from the menu) that is the whole draft is
            // removed with the public bare-token guard, which touches nothing else.
            const actx = ctx.sessions && ctx.sessions.scope ? ctx.sessions.scope(session.sessionId) : undefined
            const conversation = actx && actx.get('conversation')
            const draft = conversation && conversation.input && typeof conversation.input.for === 'function'
              ? conversation.input.for(actx).state.getSnapshot().draft : ''
            const token = String(draft || '').trim()
            if (actx && /^\/[A-Za-z_-]*$/.test(token) && 'flow'.startsWith(token.slice(1))) {
              actx.bail(actx, 'slash/input-consume-token', { guard: { kind: 'bare-token', token } })
            }
          },
        },
      }
    }

    return {
      inject: ['slots', 'locale', 'inputTriggers', 'sessions'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'hmz-flow: dictionaries')
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.inputTriggers.registerSource(makeSource(ctx, t)), 'hmz-flow: / source')
        // The + menu entry, through the public command contribution API.
        ctx.inject(['commandUi'], (scope) => {
          scope.effect(() => scope.get('commandUi').register(flowCommand(ctx, t)), 'hmz-flow: /flow command')
        })
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left', id: 'hmz-flow-options', order: 50, locale: NS,
        }, makeOptionsButton(t)))
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock', id: 'hmz-flow-observer', order: 49, locale: NS,
        }, makeObserverCard(t)))
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
