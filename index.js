/**
 * DeepSeek 2027 Plan — Host half.
 *
 * Owns the ten-level thinking control that the composer exposes and every model
 * step honours. Five pieces, in dependency order:
 *
 *  1. A session projection (`deepseek2027`) folding `/think` command runs, so
 *     the chosen level is durable: resume, fork and replay all restore it from
 *     the log rather than from plugin memory.
 *  2. An `agent/request` waterfall that does the mechanical half of the boost:
 *     maps the level onto the exact reasoning efforts the target route
 *     advertises and multiplies the route's output budget, capped at that
 *     route's own ceiling so the provider cannot reject the call.
 *  3. A prompt section carrying the level's thinking protocol.
 *  4. Two write paths the composer and the model share: `/think` sets the
 *     level, and `/deepseek2027` re-injects the current system prompt and
 *     session context as a fresh message — the "give the model its instructions
 *     again" button.
 *
 * This plugin never sends a message on its own. It has no turn-stopping hook,
 * no review loop and no automatic continuation: a turn ends when the model ends
 * it, and the next thing in the log is whatever the human typed.
 *
 * The plugin registers globally (not inside an agent preset) because a thinking
 * level is a property of the session, not of the developer preset: every preset
 * in this profile gets the control, and only the developer preset adds the
 * administrator/desktop/SSH tools.
 *
 * @module @local/dsh-deepseek-2027
 */
import { randomUUID } from 'node:crypto'

import {
  DEFAULT_LEVEL,
  MAX_LEVEL,
  MIN_LEVEL,
  clampLevel,
  describeLevel,
  effortFor,
  intensityOf,
  levelOf,
  maxTokensFor,
} from './levels.js'
import {
  LOCAL_TARGET,
  deleteServer,
  loadDefaults,
  loadServers,
  saveDefaults,
  upsertServer,
} from './servers.js'
import { forgetRemote, probeTarget } from './targets.js'

export const name = 'deepseek-2027'

/** Services this plugin can use; the plugin stays active without the optional ones. */
export const inject = ['systemPrompt']

/** Projection key carrying the durable level and the budget consumed at that level. */
export const PROJECTION_KEY = 'deepseek2027'

/** Prompt section carrying the level's thinking protocol. */
export const PROMPT_SECTION = 'deepseek2027:thinking'

/** Command that sets the level. */
export const THINK_COMMAND = 'think'

/** Command that re-injects the current system prompt and session context. */
export const REINJECT_COMMAND = 'deepseek2027'

/** Command that manages the remote servers the tools execute against. */
export const SERVERS_COMMAND = 'servers'

/**
 * A minimal `parse`-only schema.
 *
 * `sessionProjections.register()` calls `stateSchema.parse()` and
 * `viewSchema.parse()` on every read and never touches Zod-specific helpers, so
 * the projection seam only needs those two methods. Declaring them by hand keeps
 * this bundle free of a runtime schema dependency while still failing loud on
 * corrupt state — which is the property the seam actually relies on.
 *
 * @param {(value: unknown) => object} check - returns the normalized value or throws.
 * @returns {{ parse(value: unknown): object }} the schema object.
 */
function schema(check) {
  return {
    parse(value) {
      return check(value)
    },
  }
}

/** Projection state schema: the level, plus the turn it was last used in. */
const stateSchema = schema((value) => {
  if (typeof value !== 'object' || value === null) throw new TypeError('deepseek2027 state must be an object')
  const level = value.level
  if (level !== null && (!Number.isInteger(level) || level < MIN_LEVEL || level > MAX_LEVEL)) {
    throw new TypeError(`deepseek2027 state.level must be null or an integer in [${MIN_LEVEL}, ${MAX_LEVEL}], got ${JSON.stringify(level)}`)
  }
  const turn = value.turn
  if (!Number.isInteger(turn) || turn < 0) throw new TypeError('deepseek2027 state.turn must be a non-negative integer')
  return { level, turn }
})

/** Client-facing view schema. */
const viewSchema = schema((value) => {
  if (typeof value !== 'object' || value === null) throw new TypeError('deepseek2027 view must be an object')
  const level = value.level
  if (level !== null && !Number.isInteger(level)) throw new TypeError('deepseek2027 view.level must be null or an integer')
  return {
    level,
    label: typeof value.label === 'string' ? value.label : '',
    boost: typeof value.boost === 'string' ? value.boost : '',
  }
})

/**
 * Read the level a `/think` invocation asked for.
 * @param {string | undefined} raw - command arguments.
 * @returns {number | null | undefined} a level, `null` for auto, `undefined` when unparsable.
 */
function parseLevel(raw) {
  if (raw === undefined) return undefined
  const text = String(raw).trim().toLowerCase()
  if (text === '' || text === 'auto' || text === 'default' || text === 'off') return null
  if (text === 'max' || text === '巅峰') return MAX_LEVEL
  if (text === 'min') return MIN_LEVEL
  const numeric = Number(text)
  if (!Number.isFinite(numeric)) return undefined
  return clampLevel(numeric)
}

/**
 * Install the thinking-level projection, the request override, the prompt
 * section, the review loop, and the two commands.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {{ defaultLevel?: number, maxTokensCeiling?: number }} [config] - deployment defaults.
 */
export function apply(ctx, config = {}) {
  const defaultLevel = config.defaultLevel === undefined || config.defaultLevel === null
    ? DEFAULT_LEVEL
    : clampLevel(config.defaultLevel)
  const ceiling = Number.isFinite(config.maxTokensCeiling) && config.maxTokensCeiling > 0
    ? Math.trunc(config.maxTokensCeiling)
    : 65_536

  /** Level to use when the session log carries no selection at all. */
  const fallback = defaultLevel

  /**
   * Read the session's full projection state.
   * @param {object | undefined} session - live Session.
   * @returns {{ level: number | null, turn: number }} the state.
   */
  const stateOfSession = (session) => {
    if (session === undefined) return { level: config.defaultLevel === null ? null : fallback, turn: -1 }
    const projections = ctx.get('sessionProjections')
    if (projections === undefined) return { level: fallback, turn: -1 }
    const state = projections.stateOf(session, PROJECTION_KEY)
    if (state === undefined) return { level: fallback, turn: -1 }
    return {
      level: state.level === null ? null : clampLevel(state.level),
      turn: Number.isInteger(state.turn) ? state.turn : -1,
    }
  }

  /**
   * Read the session's level only.
   * @param {object | undefined} session - live Session.
   * @returns {number | null} the level; null means "leave the model's own default".
   */
  const levelOfSession = (session) => stateOfSession(session).level

  // ---- Projection ---------------------------------------------------------

  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register({
      key: PROJECTION_KEY,
      stateVersion: 3,
      stateSchema,
      init: () => ({ level: config.defaultLevel === null ? null : fallback, turn: -1 }),
      apply: (state, event) => {
        if (event.type === 'command/run' && event.data.name === THINK_COMMAND) {
          const wanted = parseLevel(event.data.args)
          if (wanted === undefined) return state
          if (state.level === wanted) return state
          return { level: wanted, turn: state.turn }
        }
        if (event.type === 'turn/start') return { ...state, turn: event.data.turn }
        return state
      },
      wire: {
        viewSchema,
        view: (state) => ({
          level: state.level,
          label: state.level === null ? '自动' : describeLevel(state.level),
          boost: state.level === null ? '' : intensityOf(state.level).label,
        }),
      },
    })
  })

  // ---- Prompt section -----------------------------------------------------

  ctx.effect(() => ctx.systemPrompt.section({
    name: PROMPT_SECTION,
    order: ctx.systemPrompt.getSectionOrder('PLAN_POLICY') + 1,
    text: (context) => {
      const level = levelOfSession(context?.agent?.session)
      if (level === null) return ''
      const found = levelOf(level)
      if (found.protocol === '') return ''
      return [
        `## 思考等级 L${found.level} · ${found.title}（DeepSeek 2027 计划）`,
        '',
        `当前会话的思考等级为 L${found.level}，本段是该等级强制执行的推理纪律。它伴随每一次模型调用，直到用户切换等级。`,
        `本级的机械增强：${found.intensity.label}`,
        '',
        found.protocol,
      ].join('\n')
    },
  }), 'deepseek-2027: thinking protocol section')

  // ---- Request override: effort + output budget ---------------------------

  ctx.effect(() => ctx.on('agent/request', async ({ agent, signal }, next) => {
    const resolved = await next()
    const state = stateOfSession(agent?.session)
    if (state.level === null) return resolved
    const level = state.level

    const llm = ctx.get('llm')
    if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return resolved
    let info
    try {
      info = await llm.resolveModelInfo(resolved.provider, resolved.model, signal)
    } catch {
      return resolved
    }

    // Map the level onto the efforts this exact route advertises. A route with no
    // reasoning support, or one whose advertised list cannot be read, keeps its
    // own default: `resolveCallConfig` rejects unsupported explicit efforts
    // rather than clamping them, so guessing here would fail the call.
    const efforts = info?.reasoning?.efforts?.map((entry) => String(entry.id))
    const nextConfig = { ...resolved }

    if (Array.isArray(efforts) && efforts.length > 0) {
      const effort = effortFor(level, efforts)
      if (effort !== undefined && nextConfig.reasoningEffort !== effort) nextConfig.reasoningEffort = effort
    }

    // The mechanical half of the boost: a high level gets more room to finish the
    // passes its protocol names. `maxTokens` is only raised, never lowered, so a
    // lower level cannot take away what the route itself decided to allow.
    const scaled = maxTokensFor(level, info?.defaultMaxTokens, ceiling)
    if (scaled !== undefined && (nextConfig.maxTokens === undefined || nextConfig.maxTokens < scaled)) {
      nextConfig.maxTokens = scaled
    }

    return nextConfig
  }), 'deepseek-2027: request effort and budget')

  // ---- Commands -----------------------------------------------------------

  // Deliberately absent: any hook on `agent/turn-stopping`. A level describes how
  // the model should think, not how many extra rounds the plugin may force. The
  // boost is spent on the thinking prompt and the output budget; nothing here
  // injects a message the human did not type, so a finished answer stays
  // finished and a turn never re-enters itself.

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: THINK_COMMAND,
      description: 'Set this session\'s thinking level (1-10, or auto)',
      input: { hint: `[${MIN_LEVEL}-${MAX_LEVEL}|auto]` },
      handler: ({ agent, rawInput }) => {
        const wanted = parseLevel(rawInput)
        if (wanted === undefined) {
          return {
            kind: 'error',
            text: `未知思考等级 "${rawInput.trim()}"，可用 /think 1 … /think ${MAX_LEVEL}，或 /think auto 交还给模型默认值。`,
          }
        }
        const level = wanted === null ? null : wanted
        const current = levelOfSession(agent?.session)
        if (current === level) {
          return {
            kind: 'success',
            text: level === null ? '思考等级已是 auto（模型默认）。' : `思考等级已是 ${describeLevel(level)}。`,
          }
        }
        // The projection folds `command/run`, so this append is the write: the
        // receipt is a consequence of the same event every later step reads.
        return {
          kind: 'success',
          text: level === null
            ? '思考等级已设为 auto：由模型自身默认强度决定，不再施加等级纪律。'
            : `思考等级已设为 ${describeLevel(level)}（${intensityOf(level).label}）。下一轮请求开始生效。`,
        }
      },
    })

    commandCtx.commands.register({
      name: REINJECT_COMMAND,
      description: 'Rebuild the system prompt through the host assembly pipeline and re-anchor the model on it',
      input: { hint: '[optional note]', attachments: false },
      handler: async ({ agent, rawInput }) => {
        const session = agent?.session
        const systemPrompt = ctx.get('systemPrompt')
        if (session === undefined || systemPrompt === undefined) {
          return { kind: 'error', text: '/deepseek2027 需要一个活动的会话与系统提示词注册表。' }
        }

        // Re-run the pipeline, not a copy of its last output. `assemble` is the
        // same entry the machine itself calls before a step, so the sections,
        // runtime contexts, tool schemas and interpolation variables produced
        // here are the deployment's current answer — including every other
        // plugin's contribution and any section this level adds. Reading a
        // cached assembly would re-send yesterday's prompt.
        let assembly
        try {
          assembly = await systemPrompt.assemble({ agent, scope: agent })
        } catch (error) {
          return { kind: 'error', text: `重新组装系统提示词失败：${error?.message ?? error}` }
        }

        const sections = Array.isArray(assembly?.sections) ? assembly.sections : []
        const contexts = Array.isArray(assembly?.contexts) ? assembly.contexts : []
        const tools = Array.isArray(assembly?.tools) ? assembly.tools : []
        const note = String(rawInput ?? '').trim()
        const level = levelOfSession(session)
        const body = renderReinjection({
          sections,
          contexts,
          tools,
          level,
          session,
          note,
        })

        let message
        try {
          message = createUserTextMessage(body)
        } catch (error) {
          return { kind: 'error', text: `无法构造注入消息：${error?.message ?? error}` }
        }
        // `steer` wakes the loop, so the rebuilt instructions are acted on in
        // this turn rather than waiting for the next human message.
        agent.steer(message)
        return {
          kind: 'success',
          text: `已重新装配并注入：系统提示词 ${sections.length} 段、运行时上下文 ${contexts.length} 条、工具 ${tools.length} 个。`,
        }
      },
    })

    // The Settings page's only write path. It speaks JSON in the reply so the
    // page can render a list without a second round trip, and it never returns
    // the stored password: the page only needs to know that one exists.
    commandCtx.commands.register({
      name: SERVERS_COMMAND,
      description: 'Manage the remote servers the file and command tools use',
      input: { hint: 'list | add <json> | remove <id> | default <id|local> | test <id>' },
      handler: async ({ rawInput }) => {
        const text = String(rawInput ?? '').trim()
        const split = text.indexOf(' ')
        const verb = split < 0 ? text : text.slice(0, split)
        const arg = split < 0 ? '' : text.slice(split + 1).trim()
        const profileDir = profileDirectory(ctx)
        try {
          if (verb === '' || verb === 'list') {
            const servers = (await loadServers(profileDir)).map(publicServer)
            const defaults = await loadDefaults(profileDir)
            return {
              kind: 'success',
              text: JSON.stringify({ servers, defaultTarget: defaults.defaultTarget }),
            }
          }
          if (verb === 'add') {
            const stored = await upsertServer(profileDir, JSON.parse(arg))
            // A changed address must not keep talking over the old connection.
            await forgetRemote(stored.id)
            return { kind: 'success', text: `已保存 ${stored.name}` }
          }
          if (verb === 'remove') {
            const removed = await deleteServer(profileDir, arg)
            await forgetRemote(arg)
            return removed
              ? { kind: 'success', text: '已删除' }
              : { kind: 'error', text: '找不到该服务器' }
          }
          if (verb === 'default') {
            const saved = await saveDefaults(profileDir, { defaultTarget: arg || LOCAL_TARGET })
            return { kind: 'success', text: `默认目标：${saved.defaultTarget === LOCAL_TARGET ? '本机' : saved.defaultTarget}` }
          }
          if (verb === 'test') {
            const servers = await loadServers(profileDir)
            const found = servers.find((server) => server.id === arg || server.name === arg)
            if (found === undefined) return { kind: 'error', text: '找不到该服务器' }
            const probe = await probeTarget({ ...found, kind: 'ssh' })
            return probe.ok
              ? { kind: 'success', text: `连接成功：${probe.detail}` }
              : { kind: 'error', text: `连接失败：${probe.detail}` }
          }
          return { kind: 'error', text: `未知子命令 "${verb}"` }
        } catch (error) {
          return { kind: 'error', text: error?.message ?? String(error) }
        }
      },
    })
  })
}

/**
 * The profile directory the registry lives in.
 *
 * The Host knows its profile root; a plugin that guessed one would write
 * credentials somewhere the user never looks. `ctx.baseDir` is the loader's own
 * answer, and the fallback keeps a bare test harness working without inventing a
 * path.
 *
 * @param {object} ctx - the plugin context.
 * @returns {string} the directory holding the registry.
 */
function profileDirectory(ctx) {
  for (const candidate of [ctx?.baseDir, ctx?.root?.baseDir, ctx?.get?.('baseDir')]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
  }
  return process.cwd()
}

/**
 * Strip the credential a page has no business reading back.
 * @param {object} server - the stored record.
 * @returns {object} the record without its password.
 */
function publicServer(server) {
  const { password, ...rest } = server
  return { ...rest, hasPassword: typeof password === 'string' && password !== '' }
}

/**
 * Build the user-role message that carries a fresh copy of the instructions.
 *
 * It is a *user* message, not a system prompt mutation: the system prompt is
 * frozen per request, so the only model-visible channel available to a command is
 * a logged message. Rendering the assembled sections here means the model sees
 * exactly the text this deployment builds, including the level protocol and every
 * other plugin's contribution.
 *
 * @param {object} input - the parts.
 * @param {readonly { name: string, text: string }[]} input.sections - assembled prompt sections.
 * @param {readonly { name: string, text: string }[]} input.contexts - assembled runtime contexts.
 * @param {readonly { name: string, description: string, parameters: object }[]} input.tools - assembled tool schemas.
 * @param {number | null} input.level - the session's thinking level.
 * @param {object} input.session - the live session.
 * @param {string} input.note - an optional human note.
 * @returns {string} the message text.
 */
function renderReinjection({ sections, contexts, tools, level, session, note }) {
  const lines = [
    '## 系统提示词重新注入（DeepSeek 2027 计划）',
    '',
    '用户点击了「重新注入系统提示词」。这不是一次提醒，而是一次完整的重新初始化：DSH 刚刚重跑了它的系统提示词装配流程，下面就是这次的产出——全部提示词段、全部运行时上下文、全部工具签名，以及当前的思考等级。把它当作本会话的权威指令集：凡与之前收到的内容冲突，以本段为准。读完先确认关键约束，再继续手上的工作；不要复述本段。',
    '',
  ]
  if (note !== '') lines.push(`用户附言：${note}`, '')

  lines.push(`### 思考等级`, '')
  lines.push(level === null
    ? '当前为 auto：由模型自身的默认推理强度决定。'
    : `${describeLevel(level)}；机械增强：${intensityOf(level).label}`)
  lines.push('')

  const header = session?.header
  if (header !== undefined && header !== null) {
    lines.push('### 会话事实', '')
    lines.push(`- 会话：${String(header.id)}`)
    if (typeof header.cwd === 'string') lines.push(`- 工作目录：${header.cwd}`)
    if (typeof header.agentPreset === 'string') lines.push(`- 预设：${header.agentPreset}`)
    lines.push('')
  }

  lines.push('### 运行时上下文', '')
  if (contexts.length === 0) lines.push('(无)')
  else for (const entry of contexts) lines.push(`- ${entry.name}: ${entry.text}`)
  lines.push('')

  lines.push('### 系统提示词', '')
  if (sections.length === 0) lines.push('(无)')
  else {
    for (const entry of sections) {
      const text = typeof entry.text === 'string' ? entry.text : String(entry.text ?? '')
      if (text.trim() === '') continue
      lines.push(`#### ${entry.name}`, '', text, '')
    }
  }

  // The tools are part of the assembled prompt, not a sidebar to it. Re-anchoring
  // on the sections alone would re-send the prose that *describes* the tool calls
  // while omitting the call signatures themselves, which is exactly the part a
  // model gets wrong after a long turn. Each tool is therefore rendered in full:
  // name, description, and its parameter schema verbatim.
  lines.push('### 当前可调用的工具', '')
  if (tools.length === 0) {
    lines.push('(无)')
  } else {
    lines.push(`本步共 ${tools.length} 个工具可按下列签名直接调用。参数 schema 照抄自装配结果，未作删改。`, '')
    for (const entry of tools) {
      lines.push(`#### \`${entry.name}\``, '')
      const description = typeof entry.description === 'string' ? entry.description.trim() : ''
      if (description !== '') lines.push(description, '')
      const parameters = entry.parameters
      if (parameters !== undefined && parameters !== null) {
        let rendered
        try {
          rendered = JSON.stringify(parameters, null, 2)
        } catch {
          rendered = String(parameters)
        }
        lines.push('参数：', '```json', rendered, '```', '')
      } else {
        lines.push('参数：(无，空对象即可)')
        lines.push('')
      }
    }
  }
  return lines.join('\n')
}

/**
 * Create one user-role text message in the shape the Host's inbox projection
 * validates.
 *
 * This bundle owns no `@deepseek-ai/*` dependency on purpose: a profile-linked
 * plugin resolves bare specifiers from its own directory, where the Harness
 * packages are absent, so importing the Host's message factory by name fails at
 * call time with `Cannot find package '@deepseek-ai/dsh-llm'`. The factory is
 * trivial — `createMessage` clones the input, adds `id: randomUUID()` and freezes
 * the result, then `createUserMessage` fixes `role: 'user'` — so the canonical
 * shape is reproduced here from `node:crypto`.
 *
 * What the inbox reader needs: a unique `id`, `role: 'user'`, a `content` array of
 * text blocks, and a `source` tag.
 *
 * @param {string} text - the message body.
 * @returns {object} a canonical, frozen user message.
 */
function createUserTextMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'system-prompt' }),
  })
}
