/**
 * The analyst team: L12's delegation layer.
 *
 * At L12 the model stops being a single mind and becomes a lead with a staff.
 * Analysts run as real subagents — independent sessions, independent context
 * windows, their own model calls — and report back as text. The lead keeps the
 * two things a delegate must never own: the writes, and the decision.
 *
 * That division is enforced here rather than merely instructed, because an
 * instruction is a suggestion and this is a boundary:
 *
 *  - A delegated analyst is spawned under the preset named in the config, which
 *    is a *read-only* analyst preset: no file tools, no command tools. It cannot
 *    mutate the workspace even if it decides it should.
 *  - The tools themselves refuse to accept a mutating task. `dev_delegate`
 *    classifies the brief and rejects wording that asks for an edit or a command,
 *    so the failure is loud and immediate instead of a silent loss of authorship.
 *
 * The team is scoped to one level: below L12 the tools are absent, not merely
 * discouraged. A tool the model cannot see is a stronger guarantee than a rule it
 * was told to follow.
 *
 * @module @local/dsh-deepseek-2027/delegation
 */
import { randomUUID } from 'node:crypto'

/** Default number of analysts that may run at once. */
export const DEFAULT_MAX_DELEGATES = 6

/**
 * Words that reveal a brief is asking for a mutating action.
 *
 * Classified rather than regex-matched alone, because "write a summary" is
 * legitimate analysis while "write the file" is not. The distinguishing feature
 * is a *target*: a path, a filename, a command, or an explicit verb about
 * changing state.
 */
const MUTATION_PATTERNS = [
  /\b(write|save|create|delete|remove|edit|patch|modify|rename|move|overwrite)\b[^.]{0,40}?\b(file|path|folder|directory|\.\w{1,6}\b)/i,
  /\b(\.\/|\.\.\/|[a-z]:\\|\/[\w.-]+\/)[\w\\/. -]{2,}/i,
  /\b(run|execute|exec|install|uninstall|start|stop|restart|kill)\b\s+(the\s+)?(command|script|process|service|server|job)\b/i,
  /\b(git\s+(commit|push|merge|rebase|reset|checkout)|npm\s+(install|run)|pnpm\s+(add|install)|pip\s+install)\b/i,
  /\b(chmod|chown|sudo|regedit|reg\s+add|sc\s+(create|delete))\b/i,
]

/**
 * Refuse a brief that asks an analyst to change state.
 *
 * The lead is told the rule, but a rule stated once in a long prompt is exactly
 * what a model drifts from under load. Failing the call returns the agent to the
 * rule at the moment it matters.
 *
 * @param {string} brief - the task text.
 * @returns {string | undefined} the refusal message, or undefined when allowed.
 */
export function classifyBrief(brief) {
  const text = String(brief ?? '')
  for (const pattern of MUTATION_PATTERNS) {
    if (pattern.test(text)) {
      return '这个任务看起来要改动文件或执行命令。委派只能做分析与检索；'
        + '写代码、改文件、跑命令必须由你自己完成（见 L12 协议的分工原则）。'
        + ' 请改写为纯分析任务，或自己做这部分。'
    }
  }
  return undefined
}

/**
 * Build the analyst prompt for one brief.
 *
 * The wrapper matters more than it looks: an analyst told only "investigate X"
 * returns prose of unknown shape, whereas an analyst given a form returns
 * something the lead can actually use. It also withholds the lead's hypothesis,
 * because an analyst told the expected answer finds it whether or not it is true.
 *
 * @param {object} input - the brief.
 * @param {string} input.question - the question to answer.
 * @param {string} [input.context] - background the analyst may rely on.
 * @param {string} [input.form] - the required shape of the answer.
 * @param {string} [input.forbid] - extra prohibitions.
 * @returns {string} the analyst's prompt.
 */
export function analystPrompt({ question, context, form, forbid }) {
  const lines = [
    '你是一名分析员，为一个正在处理任务的工程伙伴做调研与推理。你的产出会被直接用于决策，所以准确比完整重要。',
    '',
    '## 你要回答的问题',
    '',
    String(question ?? '').trim(),
    '',
  ]
  const background = String(context ?? '').trim()
  if (background !== '') {
    lines.push('## 你可以依赖的背景', '', background, '')
  }
  lines.push('## 回答的形式', '')
  lines.push(String(form ?? '').trim() || [
    '1. 结论：一句话直接回答上面的问题。',
    '2. 证据：你实际查到的依据，写清来源（文件路径、命令输出、搜索结果）。',
    '3. 不确定：哪些部分你没有验证，缺什么才能验证。',
    '4. 反例：什么观察会推翻你的结论。',
  ].join('\n'), '')
  lines.push('## 硬性限制', '')
  lines.push([
    '- 你**不能**改动任何文件，也不能执行会改变状态的命令。你只有读取与检索的能力。',
    '- 不要替我下决定：给出选项和各自的代价，不要替我选。',
    '- 不要编造你没能查到的细节。查不到就写「未验证」，这是可接受的结果。',
    '- 不要复述任务本身，直接给结论。',
  ].join('\n'))
  const extra = String(forbid ?? '').trim()
  if (extra !== '') lines.push(`- ${extra}`)
  lines.push('')
  return lines.join('\n')
}

/**
 * Render one analyst report for the lead.
 *
 * The report is deliberately framed as testimony. A plain dump invites the lead
 * to treat it as fact; the wrapper keeps the epistemic status visible at the point
 * of use, which is where it can still change the decision.
 *
 * @param {object} input - the report.
 * @param {string} input.label - the analyst's label.
 * @param {string} input.output - the report text.
 * @param {string} [input.stopReason] - how the analyst finished.
 * @returns {string} the framed report.
 */
export function frameReport({ label, output, stopReason }) {
  const body = String(output ?? '').trim()
  const head = `### 分析员「${label}」的报告`
  if (body === '') {
    return `${head}\n\n(该分析员没有产出内容${stopReason === undefined ? '' : `，结束原因：${stopReason}`}。)`
  }
  const truncated = stopReason === 'max-tokens'
  return [
    head,
    '',
    body,
    '',
    truncated
      ? '> 该报告因输出预算耗尽被截断，后半部分缺失。把它当作不完整证据，或重新派一个更窄的任务。'
      : '> 这是分析员的**证词**，不是已核实的事实。凡是你打算写进最终答复的结论，都要自己验证关键的那一步。',
  ].join('\n')
}

/**
 * Track the analysts spawned by one session.
 *
 * The cap exists because a lead under load will spawn a dozen analysts for a
 * question that needed none. Refusing at the boundary costs one tool error;
 * letting it run costs the user a minute and a large bill.
 */
export class TeamRegistry {
  /**
   * @param {number} [limit] - the maximum concurrent analysts.
   */
  constructor(limit = DEFAULT_MAX_DELEGATES) {
    this.limit = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_MAX_DELEGATES
    /** @type {Map<string, { id: string, label: string, childId: string | null, question: string, startedAt: number, activation: object | null }>} */
    this.members = new Map()
    /** @type {Map<string, string>} */
    this.children = new Map()
  }

  /**
   * Reserve one analyst slot.
   * @param {string} label - the analyst's label.
   * @param {string} question - the question it was asked.
   * @returns {{ ok: true, member: object } | { ok: false, reason: string }} the reservation.
   */
  reserve(label, question) {
    const active = [...this.members.values()].filter((member) => member.childId === null)
    if (this.members.size >= this.limit && active.length >= this.limit) {
      return {
        ok: false,
        reason: `已达上限：同时最多 ${this.limit} 个分析员。先收上一个的报告，或减少并发。`,
      }
    }
    const member = {
      id: randomUUID().slice(0, 8),
      label: String(label ?? '').trim() || `analyst-${this.members.size + 1}`,
      childId: null,
      question: String(question ?? '').trim(),
      startedAt: Date.now(),
      activation: null,
    }
    this.members.set(member.id, member)
    return { ok: true, member }
  }

  /**
   * Record the child session id an analyst was given.
   * @param {string} id - the member id.
   * @param {string} childId - the child session id.
   * @returns {void}
   */
  attach(id, childId) {
    const member = this.members.get(id)
    if (member !== undefined) {
      member.childId = childId
      this.children.set(childId, id)
    }
  }

  /**
   * Drop one analyst from the roster.
   * @param {string} id - the member id.
   * @returns {void}
   */
  release(id) {
    const member = this.members.get(id)
    if (member !== undefined && member.childId !== null) this.children.delete(member.childId)
    this.members.delete(id)
  }

  /**
   * List the roster for the model.
   * @returns {object[]} the roster rows.
   */
  roster() {
    return [...this.members.values()].map((member) => ({
      id: member.id,
      label: member.label,
      childId: member.childId,
      question: member.question,
      runningMs: Date.now() - member.startedAt,
    }))
  }

  /**
   * Drop every member, disposing the activations that are still held.
   * @returns {Promise<void>} resolves once all are released.
   */
  async drain() {
    const pending = [...this.members.values()]
    this.members.clear()
    this.children.clear()
    for (const member of pending) {
      const activation = member.activation
      if (activation !== null && typeof activation.dispose === 'function') {
        await activation.dispose().catch(() => {})
      }
    }
  }
}
