window.__ModuleLoader__.load({
  id: '@local/dsh-deepseek-2027',
  factory: (require) => {
/**
 * DeepSeek 2027 Plan — Client half.
 *
 * Three pieces in one additive module:
 *
 *  1. The composer's thinking-level control: a slider whose colour tracks the
 *     level from cool to hot, plus a re-anchor button that rebuilds the system
 *     prompt through the Host's assembly pipeline.
 *  2. A Settings page for remote servers, where the tools' execution target is
 *     chosen once. Nothing configured means this machine.
 *  3. A stylesheet built only from the theme tokens this deployment guarantees.
 *
 * Three rules that this file must keep, each learned from a specific failure:
 *
 *  - Every colour comes from a documented theme token or a literal. An invented
 *    token name resolves to nothing, which is how a primary button ended up with
 *    white text on a white background.
 *  - Every async action settles its own pending flag in `finally`. A rejected
 *    promise once left the control reading "applying" forever.
 *  - Nothing reads a prop the slot may not pass. The translator arrives only for
 *    a registration that names a locale namespace, so all copy lives here as
 *    constants and `t` is never called.
 *
 * @module @local/dsh-deepseek-2027/client
 */

const NS = 'deepseek-2027'

/** Minimum and maximum selectable level, mirroring the Host half. */
const MIN_LEVEL = 1
const MAX_LEVEL = 12

/**
 * The levels, with the wording the composer shows.
 * Kept in step with `levels.js`: `title` mirrors the level's own title and
 * `brief` is a short paraphrase of its protocol.
 * @type {{ level: number, title: string, brief: string, colour: string }[]}
 */
const LEVELS = [
  { level: 1, title: 'L1 · 直答', brief: '不施加思考纪律，直接回答。' },
  { level: 2, title: 'L2 · 速思', brief: '先定一句：这题的关键是什么。' },
  { level: 3, title: 'L3 · 常思', brief: '先分辨问题类型，再选方法。' },
  { level: 4, title: 'L4 · 细想', brief: '写出关键假设与推导骨架。' },
  { level: 5, title: 'L5 · 深入', brief: '建立表征，再从另一角度交叉核对。' },
  { level: 6, title: 'L6 · 深虑', brief: '多假设并行，用证据淘汰。' },
  { level: 7, title: 'L7 · 极限', brief: '穷举边界与失败模式。' },
  { level: 8, title: 'L8 · 深核', brief: '形式化关键步骤，数字双向验算。' },
  { level: 9, title: 'L9 · 审查级', brief: '对抗性构造：找出能推翻自己的输入。' },
  { level: 10, title: 'L10 · 巅峰', brief: '多重表征、反事实推演、量化不确定度。' },
  { level: 11, title: 'L11 · 超算', brief: '先下注后推导，承重结论逐条派反方。' },
  { level: 12, title: 'L12 · 集群', brief: '多智能体：分析派给分析员，代码与决策自己写。' },
]

/**
 * Colour for one level: cold blue at L1 through hot red at L10.
 *
 * Hue runs 210° → 2° so the ramp stays inside the sRGB gamut at every stop.
 * Lightness stays high enough to read on the overlay surface in both themes,
 * which a literal token-free ramp gets for free.
 *
 * @param {number} level - level in [{@link MIN_LEVEL}, {@link MAX_LEVEL}].
 * @returns {string} a CSS colour.
 */
function levelColour(level) {
  const clamped = Math.min(Math.max(Number(level) || MIN_LEVEL, MIN_LEVEL), MAX_LEVEL)
  const t = (clamped - MIN_LEVEL) / (MAX_LEVEL - MIN_LEVEL)
  const hue = Math.round(210 - 208 * t)
  const light = Math.round(56 - 12 * t)
  return `hsl(${hue} 72% ${light}%)`
}

/** Copy for the composer control. */
const ZH = {
  chip: '思考等级',
  auto: '自动',
  title: '思考等级（DeepSeek 2027 计划）',
  hint: '拖动滑块选择 1 到 10 级。等级越高，思考提示越深，输出预算越大。',
  autoBrief: '交给模型自身的默认推理强度。',
  apply: '应用',
  pending: '应用中…',
  failed: '切换失败',
  reinject: '重新注入系统提示词',
  reinjectTitle: '重新走一遍系统提示词装配，并把结果重新交给模型',
  reinjectBusy: '注入中…',
  reinjectDone: '已注入',
  servers: '远程服务器',
}

const EN = {
  chip: 'Thinking level',
  auto: 'Auto',
  title: 'Thinking level (DeepSeek 2027 Plan)',
  hint: 'Drag from 1 to 10. Higher levels deepen the thinking prompt and raise the output budget.',
  autoBrief: 'Leave the effort to the model route.',
  apply: 'Apply',
  pending: 'Applying…',
  failed: 'Switch failed',
  reinject: 'Re-inject system prompt',
  reinjectTitle: 'Rebuild the system prompt through the assembly pipeline and hand it to the model again',
  reinjectBusy: 'Injecting…',
  reinjectDone: 'Injected',
  servers: 'Remote servers',
}

/**
 * Every colour below is a documented theme token, a token with a literal
 * fallback, or a literal. The `.ds27-*` class names are namespaced so they
 * cannot collide with a shipped plugin's styles.
 */
const CSS = `
.ds27-wrap{position:relative;display:inline-flex;align-items:center;gap:6px}
.ds27-chip{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap}
.ds27-chip:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary,#1f2328)}
.ds27-chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:2px}
.ds27-chip:disabled{opacity:.6;cursor:default}
.ds27-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:var(--dsw-alias-state-idle-primary,#9ca3af)}
.ds27-inject{padding:0 8px}
.ds27-inject svg{width:12px;height:12px;display:block}
.ds27-menu{position:absolute;bottom:calc(100% + 8px);left:0;z-index:60;width:308px;box-sizing:border-box;padding:12px 14px 14px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay,#ffffff);color:var(--dsw-alias-label-primary,#1f2328);box-shadow:0 12px 32px rgba(0,0,0,.22)}
.ds27-head{display:flex;flex-direction:column;gap:3px;margin-bottom:10px}
.ds27-head b{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2328)}
.ds27-head span{font-size:10px;line-height:15px;color:var(--dsw-alias-label-secondary,#6b7280)}
.ds27-slider{width:100%;margin:0 0 4px;height:20px;cursor:pointer;background:transparent;accent-color:var(--dsw-alias-brand-primary,#3b82f6)}
.ds27-ticks{display:flex;justify-content:space-between;font-size:9px;line-height:14px;color:var(--dsw-alias-label-secondary,#6b7280);font-variant-numeric:tabular-nums}
.ds27-cur{margin-top:10px;display:flex;flex-direction:column;gap:2px}
.ds27-cur b{font-size:13px;font-weight:600}
.ds27-cur span{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#6b7280)}
.ds27-actions{display:flex;gap:6px;margin-top:10px}
.ds27-btn{box-sizing:border-box;flex:1 1 auto;height:28px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:11px;cursor:pointer}
.ds27-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.ds27-btn:disabled{opacity:.6;cursor:default}
.ds27-btn.ds27-primary{background:var(--dsw-alias-brand-primary,#3b82f6);border-color:transparent;color:var(--dsw-alias-bg-base,#ffffff);font-weight:500}
.ds27-btn.ds27-primary:hover{filter:brightness(1.06)}
.ds27-note{margin-top:8px;font-size:10px;line-height:15px;color:var(--dsw-alias-label-secondary,#6b7280)}
.ds27-error{margin-top:8px;font-size:10px;line-height:15px;color:var(--dsw-alias-state-error-primary,#dc2626)}
.ds27-page{display:flex;flex-direction:column;gap:14px;padding:2px 2px 20px;color:var(--dsw-alias-label-primary,#1f2328)}
.ds27-page h2{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2328)}
.ds27-page h3{margin:4px 0 0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#6b7280)}
.ds27-page p{margin:0;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary,#6b7280)}
.ds27-target{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.ds27-target div{display:flex;flex-direction:column;gap:2px;min-width:0}
.ds27-target b{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2328)}
.ds27-target span{font-size:10px;line-height:15px;color:var(--dsw-alias-label-secondary,#6b7280);overflow:hidden;text-overflow:ellipsis}
.ds27-form{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.ds27-form input{box-sizing:border-box;height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:11px}
.ds27-form input::placeholder{color:var(--dsw-alias-label-secondary,#6b7280);opacity:.8}
.ds27-form input:focus{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:-1px}
.ds27-ops{grid-column:1 / -1;display:flex;flex-wrap:wrap;gap:14px;font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280)}
.ds27-ops label{display:inline-flex;align-items:center;gap:5px;cursor:pointer}
.ds27-ok{margin-top:2px;font-size:11px;line-height:16px;color:var(--dsw-alias-state-success-primary,#15803d)}
`

/**
 * The refresh glyph, drawn inline so no icon package is required.
 * @returns {object} the svg element.
 */
function glyph(h) {
  return h('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' },
    h('path', {
      d: 'M13.2 8a5.2 5.2 0 1 1-1.6-3.7',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: '1.6',
      strokeLinecap: 'round',
    }),
    h('path', {
      d: 'M12.4 1.9v3.2H9.2',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: '1.6',
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }))
}

return {
  // An undeclared service is absent from `ctx`, and `ctx.slots.inject` would
  // throw before either control could register. `remote.commands` is listed
  // separately from `remote` because the client proxy gates each property:
  // reading `.commands` on a service whose sub-path was never injected throws
  // 'cannot get property "remote.commands" without inject'.
  inject: ['slots', 'remote', 'remote.commands'],

  /**
   * Install the stylesheet and both registrations.
   * @param {object} ctx - the Client plugin context.
   */
  apply(ctx) {
    const React = require('react')
    const h = React.createElement

    ctx.effect(() => {
      const tag = document.createElement('style')
      tag.dataset.plugin = '@local/dsh-deepseek-2027'
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }, 'deepseek-2027: styles')

    /**
     * Send one command through the Host and normalise the outcome.
     * @param {string | null} sessionId - the session, or null for a global command.
     * @param {string} line - the command line.
     * @returns {Promise<{ ok: boolean, text: string }>} the outcome.
     */
    const runCommand = async (sessionId, line) => {
      const commands = ctx.get('remote')?.commands
      if (commands === undefined) return { ok: false, text: '命令服务不可用' }
      let result
      try {
        result = await commands.execute(sessionId, line, [])
      } catch (error) {
        return { ok: false, text: error?.message ?? String(error) }
      }
      if (!result || result.ok !== true) return { ok: false, text: result?.error?.message ?? '调用失败' }
      const outcome = result.value?.result
      if (outcome === undefined) return { ok: false, text: '无返回' }
      return { ok: outcome.kind !== 'error', text: String(outcome.text ?? '') }
    }

    /**
     * The composer control: the level slider plus the re-anchor button.
     * @param {object} props - slot props.
     * @returns {object | null} the element tree.
     */
    function ThinkingControl(props) {
      const useProjection = props.useProjection
      const setLevel = props.setLevel
      const reinject = props.reinject

      const [open, setOpen] = React.useState(false)
      const [pending, setPending] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [injecting, setInjecting] = React.useState(false)
      const [injected, setInjected] = React.useState(false)
      const wrap = React.useRef(null)

      const projection = typeof useProjection === 'function' ? useProjection('deepseek2027') : undefined
      const current = projection === undefined || projection === null ? null : (projection.level ?? null)

      React.useEffect(() => {
        if (!open) return undefined
        const away = (event) => {
          if (wrap.current !== null && !wrap.current.contains(event.target)) setOpen(false)
        }
        const escape = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', away)
        document.addEventListener('keydown', escape)
        return () => {
          document.removeEventListener('mousedown', away)
          document.removeEventListener('keydown', escape)
        }
      }, [open])

      // The accepted level changed, so any in-flight draft is obsolete.
      React.useEffect(() => {
        setDraft(null)
        setPending(false)
      }, [current])

      // The re-anchor confirmation is transient: it must not keep claiming a
      // state that stopped being recent.
      React.useEffect(() => {
        if (!injected) return undefined
        const timer = setTimeout(() => setInjected(false), 2400)
        return () => clearTimeout(timer)
      }, [injected])

      const shown = draft ?? current ?? 5
      const chosen = LEVELS[Math.min(Math.max(shown, MIN_LEVEL), MAX_LEVEL) - 1]

      /**
       * Commit one level. The pending flag is cleared in `finally`, so a rejected
       * or throwing command cannot leave the control stuck on "applying".
       * @param {number | null} level - the level, or null for auto.
       */
      const commit = async (level) => {
        if (pending || typeof setLevel !== 'function') return
        setPending(true)
        setError(null)
        try {
          const failure = await setLevel(level)
          if (typeof failure === 'string' && failure !== '') setError(failure)
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
        } finally {
          setPending(false)
        }
      }

      /**
       * Rebuild and re-inject the system prompt.
       */
      const runInject = async () => {
        if (injecting || typeof reinject !== 'function') return
        setInjecting(true)
        setError(null)
        try {
          const failure = await reinject()
          if (typeof failure === 'string' && failure !== '') setError(failure)
          else setInjected(true)
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason))
        } finally {
          setInjecting(false)
        }
      }

      const chipTitle = current === null
        ? `${ZH.title}：${ZH.autoBrief}`
        : `${ZH.title}：${chosen.brief}`

      return h('span', { className: 'ds27-wrap', ref: wrap },
        h('button', {
          type: 'button',
          className: 'ds27-chip',
          title: chipTitle,
          'aria-haspopup': 'dialog',
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen((value) => !value),
        },
        h('span', {
          className: 'ds27-dot',
          style: { background: current === null ? 'var(--dsw-alias-state-idle-primary,#9ca3af)' : levelColour(current) },
        }),
        h('span', null, current === null ? `${ZH.chip} · ${ZH.auto}` : `${ZH.chip} · L${current}`)),

        h('button', {
          type: 'button',
          className: 'ds27-chip ds27-inject',
          title: ZH.reinjectTitle,
          'aria-label': ZH.reinject,
          disabled: injecting,
          onClick: runInject,
        },
        glyph(h),
        h('span', null, injecting ? ZH.reinjectBusy : injected ? ZH.reinjectDone : ZH.reinject)),

        open
          ? h('div', { className: 'ds27-menu', role: 'dialog', 'aria-label': ZH.title },
            h('div', { className: 'ds27-head' },
              h('b', null, ZH.title),
              h('span', null, ZH.hint)),
            h('input', {
              className: 'ds27-slider',
              type: 'range',
              min: String(MIN_LEVEL),
              max: String(MAX_LEVEL),
              step: '1',
              value: String(shown),
              'aria-label': ZH.title,
              style: { accentColor: levelColour(shown) },
              onChange: (event) => setDraft(Number(event.target.value)),
            }),
            h('div', { className: 'ds27-ticks' },
              LEVELS.map((entry) => h('span', { key: entry.level }, String(entry.level)))),
            h('div', { className: 'ds27-cur' },
              h('b', { style: { color: levelColour(shown) } }, chosen.title),
              h('span', null, chosen.brief)),
            h('div', { className: 'ds27-actions' },
              h('button', {
                type: 'button',
                className: 'ds27-btn ds27-primary',
                disabled: pending || draft === null,
                onClick: () => { if (draft !== null) commit(draft) },
              }, pending ? ZH.pending : ZH.apply),
              h('button', {
                type: 'button',
                className: 'ds27-btn',
                disabled: pending,
                onClick: () => commit(null),
              }, ZH.auto)),
            pending ? h('div', { className: 'ds27-note' }, ZH.pending) : null,
            error === null ? null : h('div', { className: 'ds27-error' }, `${ZH.failed}：${error}`))
          : null)
    }

    /**
     * The Settings page for remote servers.
     * @returns {object} the element tree.
     */
    function ServersPage() {
      const [state, setState] = React.useState({ loading: true, error: '', notice: '', servers: [], defaultTarget: 'local' })
      const [draft, setDraft] = React.useState({ name: '', host: '', port: '22', username: '', password: '', operations: ['read', 'write', 'exec'] })
      const [busy, setBusy] = React.useState(false)

      const refresh = async () => {
        const result = await runCommand(null, '/servers list')
        if (!result.ok) {
          setState((prev) => ({ ...prev, loading: false, error: result.text }))
          return
        }
        try {
          const parsed = JSON.parse(result.text)
          setState({
            loading: false,
            error: '',
            notice: '',
            servers: Array.isArray(parsed.servers) ? parsed.servers : [],
            defaultTarget: typeof parsed.defaultTarget === 'string' ? parsed.defaultTarget : 'local',
          })
        } catch (cause) {
          setState((prev) => ({ ...prev, loading: false, error: `解析失败：${cause.message}` }))
        }
      }

      React.useEffect(() => { refresh() }, [])

      const save = async () => {
        if (busy) return
        if (draft.host.trim() === '' || draft.username.trim() === '') {
          setState((prev) => ({ ...prev, error: '地址和用户名是必填的。' }))
          return
        }
        setBusy(true)
        const payload = JSON.stringify({
          name: draft.name.trim(),
          host: draft.host.trim(),
          port: Number(draft.port) || 22,
          username: draft.username.trim(),
          password: draft.password,
          operations: draft.operations,
        })
        try {
          const result = await runCommand(null, `/servers add ${payload}`)
          if (!result.ok) {
            setState((prev) => ({ ...prev, error: result.text }))
            return
          }
          setDraft({ name: '', host: '', port: '22', username: '', password: '', operations: ['read', 'write', 'exec'] })
          await refresh()
        } finally {
          setBusy(false)
        }
      }

      const setDefault = async (target) => {
        const result = await runCommand(null, `/servers default ${target}`)
        setState((prev) => ({ ...prev, error: result.ok ? '' : result.text }))
        await refresh()
      }

      const rows = state.servers.map((server) => h('div', { key: server.id, className: 'ds27-target' },
        h('div', null,
          h('b', null, server.name),
          h('span', null, `${server.username}@${server.host}:${server.port}`),
          h('span', null, Array.isArray(server.operations) ? server.operations.join(' / ') : '')),
        h('div', { className: 'ds27-actions', style: { marginTop: '0' } },
          h('button', {
            type: 'button',
            className: 'ds27-btn',
            onClick: async () => {
              const result = await runCommand(null, `/servers test ${server.id}`)
              setState((prev) => ({ ...prev, error: result.ok ? '' : result.text, notice: result.ok ? result.text : '' }))
            },
          }, '测试'),
          h('button', {
            type: 'button',
            className: 'ds27-btn',
            onClick: () => setDefault(server.id),
          }, '设为默认'),
          h('button', {
            type: 'button',
            className: 'ds27-btn',
            onClick: async () => {
              await runCommand(null, `/servers remove ${server.id}`)
              await refresh()
            },
          }, '删除'))))

      return h('div', { className: 'ds27-page' },
        h('h2', null, '远程服务器'),
        h('p', null, '所有读取、写入与命令都发往这里选中的机器。没有配置任何服务器时，全部操作在本机执行。'),
        state.error === '' ? null : h('div', { className: 'ds27-error' }, state.error),
        state.notice === '' ? null : h('div', { className: 'ds27-ok' }, state.notice),

        h('div', { className: 'ds27-target' },
          h('div', null,
            h('b', null, '本机'),
            h('span', null, '当前这台 Windows 机器，永远可用')),
          h('button', {
            type: 'button',
            className: state.defaultTarget === 'local' ? 'ds27-btn ds27-primary' : 'ds27-btn',
            onClick: () => setDefault('local'),
          }, state.defaultTarget === 'local' ? '当前默认' : '设为默认')),

        rows,

        h('h3', null, '新增服务器'),
        h('div', { className: 'ds27-form' },
          h('input', { placeholder: '名称（可空）', value: draft.name, onChange: (event) => setDraft({ ...draft, name: event.target.value }) }),
          h('input', { placeholder: '地址，如 10.0.0.5', value: draft.host, onChange: (event) => setDraft({ ...draft, host: event.target.value }) }),
          h('input', { placeholder: '端口，默认 22', value: draft.port, onChange: (event) => setDraft({ ...draft, port: event.target.value }) }),
          h('input', { placeholder: '用户名', value: draft.username, onChange: (event) => setDraft({ ...draft, username: event.target.value }) }),
          h('input', { type: 'password', placeholder: '密码', value: draft.password, onChange: (event) => setDraft({ ...draft, password: event.target.value }) }),
          h('div', { className: 'ds27-ops' },
            [['read', '读取'], ['write', '写入'], ['exec', '执行命令']].map(([operation, label]) => h('label', { key: operation },
              h('input', {
                type: 'checkbox',
                checked: draft.operations.includes(operation),
                onChange: (event) => setDraft({
                  ...draft,
                  operations: event.target.checked
                    ? [...draft.operations, operation]
                    : draft.operations.filter((item) => item !== operation),
                }),
              }),
              label)))),

        h('div', { className: 'ds27-actions' },
          h('button', { type: 'button', className: 'ds27-btn ds27-primary', disabled: busy, onClick: save },
            busy ? '保存中…' : '保存服务器')))
    }

    ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
      name: 'conversation.input.left',
      id: `${NS}-thinking`,
      order: 5,
      label: ZH.chip,
      inject: (sessionId) => ({
        /**
         * Write the level through the one durable path: the `/think` command.
         * @param {number | null} level - the level, or null for auto.
         * @returns {Promise<string | null>} a failure message, or null.
         */
        setLevel: async (level) => {
          const result = await runCommand(sessionId, `/think ${level === null ? 'auto' : level}`)
          return result.ok ? null : result.text
        },
        /**
         * Rebuild the system prompt through the assembly pipeline.
         * @returns {Promise<string | null>} a failure message, or null.
         */
        reinject: async () => {
          const result = await runCommand(sessionId, '/deepseek2027')
          return result.ok ? null : result.text
        },
      }),
    }, ThinkingControl))

    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: `${NS}-servers`,
      order: 60,
      label: ZH.servers,
    }, ServersPage))
  },
}
  },
})
