/**
 * The quality module: the mechanical half of thinking harder.
 *
 * A prompt cannot raise a model's capability. What it *can* do is remove the ways
 * a capable model produces an incapable answer, and those ways are few and
 * identifiable:
 *
 *  1. **Asserting instead of checking.** A model reasons that code works, that a
 *     file contains a line, that a command has a flag — and is wrong at a rate no
 *     amount of careful prose fixes. The only cure is execution: run it, read it,
 *     and compare against the claim.
 *  2. **One path, no cross-check.** A single derivation that goes wrong stays
 *     wrong, and it carries no internal signal of its own error. Independent
 *     re-derivation does: agreement raises confidence, disagreement localises the
 *     fault.
 *  3. **Unlabelled uncertainty.** When "I verified this" and "I assumed this" read
 *     the same in the output, the reader cannot tell where the answer is load
 *     bearing. Forcing a label per claim is cheap and changes what gets checked.
 *  4. **Uniform effort.** Answers fail at the two or three claims everything else
 *     rests on. Spreading attention evenly over a hundred details is the standard
 *     way to miss exactly those.
 *
 * So this module implements three things and no more:
 *
 *  - **A claim ledger.** Every load-bearing claim is registered with a channel
 *    (`observed` / `derived` / `assumed` / `guessed`) and, where checkable, an
 *    actual check. Unverified load-bearing claims are reported back with force.
 *  - **A verification harness.** A claim plus a command: the command runs, the
 *    output is compared, and the ledger entry is upgraded or downgraded by the
 *    result — not by the model's opinion of the result.
 *  - **A consensus harness.** The same question asked of several independent
 *    analysts with different framings. Where they agree, the answer is probably
 *    right; where they diverge, the divergence *is* the uncertainty, and it is
 *    reported as such instead of averaged into mush.
 *
 * None of this makes the model smarter. It makes the answer's errors findable.
 *
 * @module @local/dsh-deepseek-2027/enhance
 */
import { randomUUID } from 'node:crypto'

/** Evidence channels, weakest last. */
export const CHANNELS = ['observed', 'derived', 'assumed', 'guessed']

/** Channels that may not carry a conclusion without saying so. */
export const WEAK_CHANNELS = new Set(['assumed', 'guessed'])

/**
 * One session's claim ledger.
 *
 * Scoped per session because two conversations on the same machine must not audit
 * each other's claims, and because the ledger is cheap state that should die with
 * the conversation rather than with the process.
 */
export class ClaimLedger {
  constructor() {
    /** @type {Map<string, object>} */
    this.claims = new Map()
  }

  /**
   * Register one claim.
   *
   * A claim is a sentence the answer depends on. Registering forces the model to
   * name the channel — the act of choosing between "observed" and "assumed" is
   * itself the check that catches most overconfidence.
   *
   * @param {object} input - the claim.
   * @param {string} input.text - the claim as a checkable sentence.
   * @param {string} input.channel - one of {@link CHANNELS}.
   * @param {boolean} [input.loadBearing] - whether the answer collapses without it.
   * @param {string} [input.evidence] - what supports it.
   * @param {string} [input.check] - the command that would settle it.
   * @returns {object} the stored claim.
   */
  add({ text, channel, loadBearing, evidence, check }) {
    const body = String(text ?? '').trim()
    if (body === '') throw new Error('claim 需要 text：写成一句可以被验证真伪的话')
    const kind = String(channel ?? '').trim().toLowerCase()
    if (!CHANNELS.includes(kind)) {
      throw new Error(`channel 必须是 ${CHANNELS.join(' / ')} 之一，收到 "${channel}"`)
    }
    const claim = {
      id: randomUUID().slice(0, 8),
      text: body,
      channel: kind,
      loadBearing: loadBearing === true,
      evidence: String(evidence ?? '').trim(),
      check: String(check ?? '').trim(),
      verified: false,
      result: '',
      createdAt: Date.now(),
    }
    // A load-bearing claim with no evidence and no check is the single most
    // expensive kind of error, so it is refused at registration rather than
    // discovered at review.
    if (claim.loadBearing && claim.evidence === '' && claim.check === '') {
      throw new Error(
        `承重结论「${body.slice(0, 60)}」必须给出 evidence（依据）或 check（可执行验证），`
        + '否则它只是一个猜测，而猜测不该承重。',
      )
    }
    this.claims.set(claim.id, claim)
    return claim
  }

  /**
   * Record a verification result.
   * @param {string} id - the claim id.
   * @param {object} outcome - what happened.
   * @param {boolean} outcome.holds - whether the claim survived.
   * @param {string} outcome.result - the observed output.
   * @returns {object} the updated claim.
   */
  settle(id, { holds, result }) {
    const claim = this.claims.get(id)
    if (claim === undefined) throw new Error(`找不到结论 ${id}`)
    claim.verified = true
    claim.channel = holds ? 'observed' : 'assumed'
    claim.result = String(result ?? '').slice(0, 2000)
    if (!holds) {
      // A falsified claim stays in the ledger, marked. Deleting it would let the
      // model quietly forget the thing it just learned was wrong.
      claim.falsified = true
    }
    return claim
  }

  /**
   * Report the ledger's state, with the load-bearing holes first.
   * @returns {object} the audit.
   */
  audit() {
    const all = [...this.claims.values()]
    const loadBearing = all.filter((claim) => claim.loadBearing)
    const unverified = loadBearing.filter((claim) => !claim.verified && claim.check !== '')
    const unsupported = loadBearing.filter((claim) => WEAK_CHANNELS.has(claim.channel) && !claim.verified)
    const falsified = all.filter((claim) => claim.falsified === true)
    return {
      total: all.length,
      loadBearing: loadBearing.length,
      verified: all.filter((claim) => claim.verified).length,
      unverified,
      unsupported,
      falsified,
      clean: unverified.length === 0 && unsupported.length === 0 && falsified.length === 0,
    }
  }

  /**
   * Render the audit as instructions the model must act on.
   * @returns {string} the report.
   */
  render() {
    const audit = this.audit()
    if (audit.total === 0) return '结论台账为空：还没有登记任何承重结论。'
    const lines = [`已登记 ${audit.total} 条结论，其中承重结论 ${audit.loadBearing} 条，已验证 ${audit.verified} 条。`]
    if (audit.falsified.length > 0) {
      lines.push('', '### 已被证伪（必须改写受影响的结论）')
      for (const claim of audit.falsified) lines.push(`- ✗ ${claim.text}`, `  → ${claim.result.slice(0, 300)}`)
    }
    if (audit.unverified.length > 0) {
      lines.push('', '### 承重但未验证（有验证手段却没用）')
      for (const claim of audit.unverified) lines.push(`- ? ${claim.text}`, `  可执行：\`${claim.check}\``)
    }
    if (audit.unsupported.length > 0) {
      lines.push('', '### 承重但只是假设（必须标注给读者，或补证据）')
      for (const claim of audit.unsupported) lines.push(`- ~ ${claim.text}（${claim.channel}）`)
    }
    if (audit.clean) lines.push('', '台账干净：所有承重结论都有证据或已验证。')
    return lines.join('\n')
  }

  /** Drop the ledger. */
  clear() {
    this.claims.clear()
  }
}

/**
 * Build the question variants for a consensus run.
 *
 * Identical prompts return identical answers, so a naive resample measures nothing.
 * The variants differ in *stance*, which is what makes disagreement informative:
 * one derives forward, one backward from the expected shape, one argues the answer
 * is wrong. A conclusion that survives all three is worth far more than one
 * conclusion stated once.
 *
 * @param {string} question - the question to settle.
 * @returns {{ stance: string, prompt: string }[]} the variants.
 */
export function consensusVariants(question) {
  const body = String(question ?? '').trim()
  if (body === '') throw new Error('consensus 需要 question')
  return [
    {
      stance: '正向推导',
      prompt: `从已知条件正向推导，给出你的结论。逐步写清楚，最后用一句话给出答案。\n\n问题：${body}`,
    },
    {
      stance: '反向验证',
      prompt: `先假设答案的形式与量级，再反向检查已知条件是否与它一致。不一致就说明假设错在哪。最后用一句话给出答案。\n\n问题：${body}`,
    },
    {
      stance: '对立立场',
      prompt: `你的任务是指出一个最可能但错误的答案，并说明它为什么诱人。然后给出你认为正确的答案，以及什么证据会证明你错了。最后用一句话给出答案。\n\n问题：${body}`,
    },
  ]
}

/**
 * Summarize several independent answers.
 *
 * The summary is deliberately crude and mechanical: it extracts the final sentence
 * of each report and groups them. That crudeness is the point — a semantic merge
 * would smooth over exactly the disagreement worth seeing.
 *
 * @param {object[]} reports - one per variant.
 * @param {string} reports[].stance - the stance used.
 * @param {string} reports[].output - the report text.
 * @returns {object} the convergence summary.
 */
export function summarizeConsensus(reports) {
  const rows = reports.map((report) => {
    const text = String(report.output ?? '').trim()
    const sentences = text.split(/(?<=[。.!?！？\n])/).map((part) => part.trim()).filter((part) => part !== '')
    const last = sentences.length > 0 ? sentences[sentences.length - 1] : text.slice(-160)
    return { stance: report.stance, answer: last.slice(0, 400), full: text }
  })
  const empties = rows.filter((row) => row.answer === '').length
  return {
    rows,
    empty: empties,
    converged: empties === 0 && rows.length > 1
      ? agreementScore(rows.map((row) => row.answer))
      : 0,
  }
}

/**
 * Score how much several short answers agree, 0–1.
 *
 * Character-overlap is a rough proxy, chosen because it needs no model call and
 * cannot be gamed by a fluent paraphrase. It is reported as a signal to the lead,
 * never as a verdict: the lead reads the answers and decides.
 *
 * @param {string[]} answers - the final answers.
 * @returns {number} the mean pairwise similarity.
 */
function agreementScore(answers) {
  const tokens = answers.map((answer) => new Set(tokenize(answer)))
  let sum = 0
  let pairs = 0
  for (let i = 0; i < tokens.length; i += 1) {
    for (let j = i + 1; j < tokens.length; j += 1) {
      const a = tokens[i]
      const b = tokens[j]
      const union = new Set([...a, ...b])
      if (union.size === 0) continue
      let shared = 0
      for (const token of a) if (b.has(token)) shared += 1
      sum += shared / union.size
      pairs += 1
    }
  }
  return pairs === 0 ? 0 : Number((sum / pairs).toFixed(3))
}

/**
 * Split text into comparable tokens: latin words, digit runs, CJK bigrams.
 * @param {string} text - the text.
 * @returns {string[]} the tokens.
 */
function tokenize(text) {
  const tokens = []
  const latin = String(text).toLowerCase().match(/[a-z]+|\d+(?:\.\d+)?/g) ?? []
  tokens.push(...latin)
  for (const run of String(text).match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) tokens.push(run)
    for (let i = 0; i < run.length - 1; i += 1) tokens.push(run.slice(i, i + 2))
  }
  return tokens
}

/**
 * Render a consensus result for the lead.
 *
 * @param {object} summary - the output of {@link summarizeConsensus}.
 * @returns {string} the report.
 */
export function renderConsensus(summary) {
  const lines = [
    `## 独立多路采样（${summary.rows.length} 路，态度各不相同）`,
    '',
    `收敛度：${summary.converged}（0 = 完全分歧，1 = 完全一致）。`,
    summary.converged >= 0.55
      ? '多路给出接近的答案：结论较可能成立，但仍要你自己核对关键的一步。'
      : '多路明显分歧：分歧处就是这题真正的不确定性所在。不要揉成一个答案——找出哪一路的前提不同，并亲自判定。',
    '',
  ]
  for (const row of summary.rows) {
    lines.push(`### ${row.stance}`, '', row.answer === '' ? '(没有给出可用结论)' : row.answer, '')
  }
  lines.push('> 这是多路证词，不是投票结果。多数派也可能是同一个错误被重复了三次。')
  return lines.join('\n')
}
