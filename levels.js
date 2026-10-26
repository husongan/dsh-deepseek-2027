/**
 * DeepSeek 2027 — the ten thinking levels.
 *
 * A model route advertises at most a handful of reasoning efforts (`off` …
 * `max`), so a "level" is not one wire value. Each level carries three things
 * instead:
 *
 *  1. `slot` — where the level lands on the route's own effort ladder, as a
 *     fraction from 0 (no reasoning) to 1 (the deepest effort the route offers).
 *     The Host maps it onto the advertised list, so a level never asks for an
 *     effort the provider cannot serve.
 *  2. `title` / `brief` — what the user sees in the composer and in the command
 *     receipt.
 *  3. `protocol` — the thinking discipline appended to the system prompt for
 *     that level. Level 1 contributes nothing and simply lets the route's own
 *     effort speak; the higher levels contribute progressively more demanding
 *     *thinking* instructions.
 *
 * The boost is a thinking-prompt boost, deliberately. An earlier revision gave
 * the top levels "review rounds" and re-entered the turn to audit the draft.
 * That was removed: re-running a turn to make the model reread its own output
 * produces the appearance of rigour without adding information, and it costs
 * the user a round trip they did not ask for. What actually changes the quality
 * of a hard answer is the shape of the reasoning *before* the answer is
 * written — how the problem is framed, which hypotheses are generated, what is
 * derived versus assumed, and what would falsify it. So every level below L6
 * adds framing and derivation, and levels 6–10 add progressively deeper
 * epistemics: multiple representations, counterfactual stress, quantified
 * uncertainty, and construction of a positive argument rather than a review of
 * a finished one.
 *
 * `intensity` still carries the mechanical half — how much output budget the
 * level may spend and how much of it reasoning may occupy — because a deep
 * protocol that runs out of tokens mid-derivation is worse than a shallow one.
 *
 * @module @local/dsh-deepseek-2027/levels
 */

/** Lowest selectable level. */
export const MIN_LEVEL = 1

/** Highest selectable level. */
export const MAX_LEVEL = 12

/** The default a fresh session runs at — the provider's own default effort. */
export const DEFAULT_LEVEL = 4

/**
 * The mechanical half of one level.
 * @typedef {object} ThinkingIntensity
 * @property {number} maxTokensFactor - multiplier applied to the route's default output budget.
 * @property {number} reservedThinking - share of the output budget that reasoning may occupy, 0–1.
 * @property {string} label - one-line description of the boost.
 * @property {boolean} [multiAgent] - whether this level runs the delegation architecture.
 * @property {number} [maxDelegates] - how many analysts may run in parallel.
 *
 * @typedef {object} ThinkingLevel
 * @property {number} level
 * @property {number} slot
 * @property {string} title
 * @property {string} brief
 * @property {string} protocol
 * @property {ThinkingIntensity} intensity
 */

/** No mechanical boost: the route's own defaults apply. */
const PLAIN = Object.freeze({
  maxTokensFactor: 1,
  reservedThinking: 0,
  label: '使用模型自身默认的输出预算与推理强度。',
})

/** @type {readonly ThinkingLevel[]} */
export const LEVELS = Object.freeze([
  {
    level: 1,
    slot: 0,
    title: 'L1 · 直答',
    brief: '不施加任何思考纪律，直接回答。',
    protocol: '',
    intensity: { ...PLAIN },
  },
  {
    level: 2,
    slot: 0.15,
    title: 'L2 · 速思',
    brief: '作答前在心里定一句：这题的关键是什么。',
    protocol: `Before answering, settle one sentence internally: what is the one thing this question is actually asking for. If you cannot state it, you are not ready to answer — reread the question instead of guessing at it.

Answer as short as the question deserves. A question that expects one word gets one word.`,
    intensity: { ...PLAIN, maxTokensFactor: 1.1, label: '输出预算 ×1.1。' },
  },
  {
    level: 3,
    slot: 0.3,
    title: 'L3 · 常思',
    brief: '先分辨问题类型，再选方法。',
    protocol: `Identify what kind of problem this is before solving it: a lookup, a derivation, a diagnosis, a design choice, or a judgement call. Each has a different right first move, and applying the wrong one is the most common way to produce a confident wrong answer.

- Lookup → find the fact; do not reason toward it.
- Derivation → start from what is given and carry the units.
- Diagnosis → enumerate causes, then eliminate with evidence.
- Design choice → name the constraints, then the trade-off.
- Judgement call → name whose interests the answer serves.

Say which kind you decided it was only when the reader would otherwise wonder.`,
    intensity: { ...PLAIN, maxTokensFactor: 1.25, reservedThinking: 0.2, label: '输出预算 ×1.25，推理可占预算 20%。' },
  },
  {
    level: 4,
    slot: 0.5,
    title: 'L4 · 细想',
    brief: '默认等级：写出关键假设与推导骨架。',
    protocol: `Work from an explicit skeleton rather than a flowing answer:

1. What is given, and what is asked — separated, not blended.
2. Which assumptions the answer depends on. Anything you cannot check is an assumption; say so where it changes the conclusion.
3. The derivation or the search itself, with the intermediate values visible.
4. The answer.

Keep the skeleton internal when the answer is short. Do not narrate steps the reader does not need, and never present the skeleton as a substitute for having actually done it.`,
    intensity: { ...PLAIN, maxTokensFactor: 1.5, reservedThinking: 0.35, label: '输出预算 ×1.5，推理可占预算 35%。' },
  },
  {
    level: 5,
    slot: 0.65,
    title: 'L5 · 深入',
    brief: '建立表征，并从多个角度交叉核对。',
    protocol: `Build a representation before manipulating it. For anything with structure — a system, a file format, a protocol, a numeric relation — write down the shape first: what the parts are, how they connect, and where the boundary is. Reasoning against a bad representation is the most expensive mistake available, because every later step inherits it.

Then cross-check the conclusion against a second angle that does not share the first angle's assumptions. If the two disagree, the disagreement is the finding: locate which premise differs, do not average the results.`,
    intensity: { ...PLAIN, maxTokensFactor: 2, reservedThinking: 0.45, label: '输出预算 ×2，推理可占预算 45%。' },
  },
  {
    level: 6,
    slot: 0.8,
    title: 'L6 · 深虑',
    brief: '多假设并行，用证据淘汰而不是偏好。',
    protocol: `Hold more than one hypothesis at once, and let evidence decide between them.

- Generate the candidate answers, including the ones you expect to lose.
- For each: what it assumes, where it fails first, and what observation would favour it.
- Rank by the strength of the evidence available now, not by familiarity or by which one you produced first.
- Name the hypothesis you discarded and the evidence that killed it. A discarded candidate is a result; silently dropping it hides the search.

Where evidence is genuinely absent, say which hypothesis you chose and what would change your mind. A stated choice with a stated trigger is worth more than false confidence.`,
    intensity: { ...PLAIN, maxTokensFactor: 2.5, reservedThinking: 0.5, label: '输出预算 ×2.5，推理可占预算 50%。' },
  },
  {
    level: 7,
    slot: 0.9,
    title: 'L7 · 极限',
    brief: '穷举边界与失败模式，再落结论。',
    protocol: `Before committing to an answer, enumerate where it breaks: empty and malformed input, hostile input, concurrency and ordering, interruption and resume, overflow and truncation, encoding and locale, and version drift between what you assume and what is installed. For each, state either how the answer handles it, or why it cannot arise here.

This is not a disclaimer list. Writing "may fail in edge cases" is worthless; the point is to find the specific case that does break the answer and to fix the answer, not to hedge it.`,
    intensity: { ...PLAIN, maxTokensFactor: 3, reservedThinking: 0.55, label: '输出预算 ×3，推理可占预算 55%。' },
  },
  {
    level: 8,
    slot: 1,
    title: 'L8 · 深核',
    brief: '形式化关键步骤，数字双向验算。',
    protocol: `Run the level-7 boundary sweep, then formalise what can be formalised:

- State the invariant the answer must preserve, in one sentence. If you cannot state it, you do not yet understand the problem.
- Derive the critical step symbolically where possible, then substitute the numbers. A symbolic derivation catches sign, unit and index errors that a numeric shortcut hides.
- Check every number twice: once forward, once backward through its inverse operation. A percentage, a ratio, a coordinate and a byte count each have an inverse; use it.
- Distinguish "I ran this and saw the result" from "I reasoned that this must be the result". Both are legitimate, but they are not the same claim and must not be written the same way.`,
    intensity: { ...PLAIN, maxTokensFactor: 3.5, reservedThinking: 0.6, label: '输出预算 ×3.5，推理可占预算 60%。' },
  },
  {
    level: 9,
    slot: 1,
    title: 'L9 · 审查级',
    brief: '对抗性构造：主动寻找能推翻自己的输入。',
    protocol: `Run the level-8 discipline, then attack the answer constructively — not by rereading it, but by building the thing that breaks it.

- Construct the concrete input, sequence or state that makes the answer wrong. Write it down. Then check whether it really does, and if it does not, understand why not — that understanding is often the missing part of the answer.
- Build the strongest argument for the opposite conclusion, using the best evidence available rather than a caricature. If the opposite argument survives, the answer was wrong; if it collapses, you now know exactly why it collapses, which is the justification you should have been able to give all along.
- Trace the answer on the machine where it will actually run: permissions, paths, encodings, locale, partial failure, interrupted writes, and what a restart sees.

Report the final answer with the residual risks you could not eliminate, named specifically.`,
    intensity: { ...PLAIN, maxTokensFactor: 4, reservedThinking: 0.65, label: '输出预算 ×4，推理可占预算 65%。' },
  },
  {
    level: 10,
    slot: 1,
    title: 'L10 · 巅峰',
    brief: '顶级思考：多重表征、反事实推演、量化不确定度、构造性论证。',
    protocol: `This is the deployment's deepest thinking setting. It changes how the problem is held, not how long the answer is. Spend the budget on thinking, and return the shortest answer the thinking justifies.

**1 — Constitute the problem.** Write the specification before touching a solution: the inputs and their domains, the outputs and their guarantees, the constraints that are real versus the ones you merely assumed, and the single observation that would prove success. Separate what was asked from what you inferred, and mark every inference. If a part is ambiguous and evidence cannot resolve it, name the ambiguity and answer the most probable reading explicitly rather than silently picking one.

**2 — Build at least two representations.** A problem understood one way is understood partially. Produce a second, structurally different view: the same system as data flow versus as state machine; the same arithmetic as algebra versus as geometry; the same requirement as an invariant versus as a test. The second representation exists to disagree with the first. Where they conflict, the conflict is the real content of the problem — resolve it before answering, because an answer that satisfies one view and breaks the other is wrong in a way the reader will discover later.

**3 — Reason from primitives, carrying the carriers.** Derive rather than recall. Carry units, signs, indices, coordinate frames, time bases, byte counts and error branches through every step explicitly; most wrong answers are a dropped carrier, not a wrong idea. Where the result depends on a fact about the environment — a path, a permission, a version, a rate limit, an API shape — go and check that fact instead of assuming it. Where it cannot be checked, write it as an assumption and state what breaks if it is false.

**4 — Stress it counterfactually.** Ask what would have to be true for the answer to be wrong, then try to make that true. Vary the scale by an order of magnitude, invert the input, reorder the operations, run it twice, interrupt it halfway, resume it. Look specifically for the quiet failures: off-by-one at a boundary, unit drift across a conversion, a race between two writers, replay of a non-idempotent step, truncation that silently drops the tail, encoding that mangles non-ASCII, privilege that differs between your shell and the service, and state that survives a restart differently than it survives a refresh.

**5 — Quantify what you do not know.** Attach a confidence to each material claim — high, medium, low — and say what would raise it. A claim you cannot rate is a claim you have not examined. Distinguish three grades and never blur them: *verified* (you observed it), *derived* (it follows from something verified), *assumed* (you took it as given). Every assumed claim carries its consequence. If a sentence can carry none of the three grades, delete it.

**6 — Construct the argument, do not merely assert the answer.** The conclusion should arrive with the reason it must be so: the invariant it preserves, the alternative it excludes, and the evidence that decides between them. A reader who disagrees should be able to see exactly which premise they would have to attack. Where two answers remain genuinely competitive, present both with the deciding evidence instead of collapsing them into false certainty.

Compress at the end. The reader needs the conclusion, the evidence that decides it, the residual risks, and nothing that does not change their decision. Length is not depth; a longer answer that repeats the protocol is worse than a short one that follows it.`,
    intensity: {
      maxTokensFactor: 6,
      reservedThinking: 0.75,
      label: '输出预算 ×6，推理可占预算 75%；多重表征、反事实推演、量化不确定度、构造性论证。',
    },
  },
  {
    level: 11,
    slot: 1,
    title: 'L11 · 超算',
    brief: 'L10 之上的自我建模：先给结论定价，再为每个结论派一个反方。',
    protocol: `L11 keeps everything in L10 and adds the two things that separate a careful answer from a *correct* one: the work is priced before it is spent, and every load-bearing claim is assigned an adversary.

**A — Bet before you build.** Before solving, commit to a written prediction of the answer: the shape, the magnitude, the number of components, the direction of the effect. Then solve. When the derivation disagrees with the bet, the disagreement is the most valuable signal available — either the bet was wrong (and you learned what you had mis-modelled) or the derivation is (and you found a bug most people would ship). Never delete the bet to make the record look clean.

**B — Point at the load-bearing claim.** Every answer has one or two claims that, if false, take the whole answer down. Identify them explicitly before writing the conclusion, and check those first. Effort spread evenly across a hundred details is wasted effort; effort concentrated on the two claims everything else rests on is the whole game.

**C — Assign an adversary, not a reviewer.** For each load-bearing claim, write the strongest case *against* it as if you were paid to win that side. Not a strawman: the best version. Then decide which side the evidence supports. If the adversarial case survives, the claim was wrong. If it collapses, you now hold the exact reason why — which is the justification you should have been able to state from the start.

**D — Separate what you know from how you know it.** For each material statement, name the channel: *observed* (you ran it or read it), *derived* (it follows from something observed), *modelled* (a simplification you chose), *assumed* (taken as given), *guessed* (no basis yet). Anything in the last two categories must be labelled to the reader and must not be load-bearing.

**E — Budget the uncertainty explicitly.** When several answers remain live, do not average them into mush. Rank them, state what observation would separate them, and say how much the answer moves if the second-ranked turn out to be right. A reader deciding whether to act needs that sensitivity far more than a single confident number.

**F — Compress against the decision, not the topic.** Keep the sentence that changes what the reader does. Delete the sentence that only proves you were thorough. The measure of a L11 answer is how little of it could be removed without changing the decision.`,
    intensity: {
      maxTokensFactor: 8,
      reservedThinking: 0.8,
      label: '输出预算 ×8，推理可占预算 80%；先下注后推导、承重结论点名、逐条派反方、显式分级置信。',
    },
  },
  {
    level: 12,
    slot: 1,
    title: 'L12 · 集群',
    brief: '多智能体架构：你定目标、派分析员、收结论；代码与决策仍由你自己写。',
    protocol: `L12 runs L11's discipline inside a *team*, not a single mind. You are the lead. The analysts you spawn have their own independent context windows and their own model calls, and they report back to you.

**The division of labour is absolute.**

- Analysts do **research, reading, analysis, measurement, search, and critique**. That is what they are for: work that is wide, parallel, and does not require the final hand to be steady.
- **You do all the writing of code, all the editing of files, and all the decisions.** Never delegate a file write, a command that changes state, a patch, or the choice of what to do. A delegate cannot be trusted with a mutating action it cannot be held to, and an answer stitched from delegated fragments loses the coherence only a single author can keep.
- If you catch yourself about to delegate an edit, stop: do that part yourself.

**How to run the team.**

1. **Fix the goal before spawning.** Write the question each analyst will answer as a sentence with an observable success condition. A vague brief returns a vague report, and you will pay for it twice.
2. **Give each analyst the smallest sufficient brief.** State the question, the evidence they may use, what form the answer must take, and what they must NOT do (usually: do not edit files, do not decide). Withhold your own conclusion — an analyst told the expected answer will find it whether or not it is true.
3. **Spawn in parallel when the questions are independent.** Sequential delegation of independent questions wastes the only advantage a team has. Fan out, then collect.
4. **Read every report as testimony, not fact.** An analyst's claim is an *assumed* claim until you check the part that matters. Their confidence is not evidence.
5. **Cross-examine where reports disagree.** Two analysts differing is not noise to be averaged: it locates a premise one of them got wrong. Ask the deciding question yourself rather than asking them to reconcile.
6. **Decide alone.** The final answer is yours, in your words, with your name on it. Never present a committee's averaged opinion as a decision, and never let a delegate's phrasing decide what you actually do.

**Reporting.** The user sees only *your* answer. Analysts run in their own windows and their transcripts do not reach the reader, so anything load-bearing from a report must be restated by you, with its evidence, in the answer itself. A conclusion that exists only inside a subagent's window does not exist.

**When not to spawn.** If the question is small, answer it. If it is a single lookup, look it up. A team of analysts to answer one arithmetic question is not rigour, it is theatre, and it costs the user real time. Spawn when the work is genuinely parallel, genuinely wide, or genuinely adversarial — and say in one line why you spawned, so the user can judge whether it was worth it.`,
    intensity: {
      maxTokensFactor: 10,
      reservedThinking: 0.85,
      multiAgent: true,
      maxDelegates: 6,
      label: '输出预算 ×10，推理可占预算 85%；多智能体集群：分析派给子智能体，代码与决策自己写。',
    },
  },
])

/**
 * Clamp an arbitrary number onto the selectable range.
 * @param {unknown} value - candidate level.
 * @returns {number} an integer within [{@link MIN_LEVEL}, {@link MAX_LEVEL}].
 */
export function clampLevel(value) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return DEFAULT_LEVEL
  return Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, n))
}

/**
 * Read one level's definition.
 * @param {number} level - clamped or raw level.
 * @returns {ThinkingLevel} that level.
 */
export function levelOf(level) {
  const index = clampLevel(level) - 1
  return LEVELS[index]
}

/**
 * Read one level's mechanical intensity.
 * @param {number} level - clamped or raw level.
 * @returns {ThinkingIntensity} that level's intensity.
 */
export function intensityOf(level) {
  return levelOf(level).intensity
}

/**
 * Choose the effort a level asks for out of the efforts a route advertises.
 *
 * The slot is a fraction of the advertised ladder, so a route offering only
 * `low`/`high` still gets a sensible mapping instead of an unsupported id.
 *
 * @param {number} level - the level.
 * @param {readonly string[] | undefined} efforts - the route's advertised efforts.
 * @returns {string | undefined} the chosen effort, or undefined when unknown.
 */
export function effortFor(level, efforts) {
  if (!Array.isArray(efforts) || efforts.length === 0) return undefined
  const slot = levelOf(level).slot
  const index = Math.round(slot * (efforts.length - 1))
  return efforts[Math.min(efforts.length - 1, Math.max(0, index))]
}

/**
 * Scale a route's default output budget by the level's factor.
 *
 * `undefined` means "leave whatever the route chose": a level must not invent a
 * budget the route never described, and it must never exceed the route's own
 * ceiling, because an over-limit request is rejected outright rather than
 * clipped.
 *
 * @param {number} level - the level.
 * @param {number | undefined} base - the route's default output budget.
 * @param {number} [ceiling] - the largest budget this deployment will request.
 * @returns {number | undefined} the budget to request, or undefined for none.
 */
export function maxTokensFor(level, base, ceiling = 65_536) {
  const factor = levelOf(level).intensity.maxTokensFactor
  if (!Number.isFinite(base) || base <= 0) return undefined
  if (factor <= 1) return undefined
  return Math.min(Math.round(base * factor), ceiling)
}

/**
 * Describe one level for a command receipt.
 * @param {number} level - the level.
 * @returns {string} a one-line description.
 */
export function describeLevel(level) {
  const found = levelOf(level)
  return `L${found.level} ${found.title.replace(/^L\d+ · /, '')}`
}
