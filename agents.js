/**
 * Agent definitions the model writes for itself.
 *
 * L12 has a lead and a staff, but a staff of identical generalists is barely
 * better than one mind. This module lets the lead *define its own specialists*:
 * each definition names a role, states what that role should attend to, and fixes
 * the response shape it must return. The lead then delegates by name —
 * `spawn("security-reviewer", …)` — instead of re-describing the same specialist
 * in every brief.
 *
 * Analysts always run on the lead's own model. There is no per-agent model
 * choice, deliberately: a team whose members are weaker than the lead produces
 * reports the lead must re-derive, which is worse than no team at all.
 *
 * Two decisions worth stating:
 *
 *  - **Definitions are data, not code.** A definition is Markdown plus a small
 *    JSON header, stored under `_agents/`. It cannot execute anything: it only
 *    shapes the prompt an analyst receives. That is the safe half of "define your
 *    own agents" — the dangerous half, letting a model write agents that can act,
 *    is deliberately absent.
 *  - **A definition cannot grant capability.** Whatever a role says it may do, the
 *    analyst is still spawned under a read-only preset. A definition that claims
 *    "you may edit files" is a lie the boundary silently refuses, and the loader
 *    says so at the point of use rather than letting the analyst discover it.
 *
 * Storage is one file per role beside this module, so the user can read and edit
 * their team with any editor, and the model can revise it with its file tools.
 *
 * @module @local/dsh-deepseek-2027/agents
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This module's directory, so the roster follows the installed bundle. */
const HERE = dirname(fileURLToPath(import.meta.url))

/** Directory holding one file per defined agent. */
export const AGENTS_DIR = join(HERE, '_agents')

/** Role name rules: lowercase, digits, single hyphens. */
const ROLE_PATTERN = /^[a-z][a-z0-9-]{1,38}$/

/** Largest definition body accepted, in characters. */
const BODY_LIMIT = 8000

/**
 * Turn a role name into a file stem.
 * @param {string} role - the role name.
 * @returns {string} a safe file stem.
 */
function stemOf(role) {
  return String(role).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent'
}

/**
 * Absolute path of one role definition.
 * @param {string} role - the role name.
 * @returns {string} the path.
 */
export function pathOf(role) {
  return join(AGENTS_DIR, `${stemOf(role)}.md`)
}

/**
 * The specialists shipped before the model defines any of its own.
 *
 * They exist so the first delegation works without a setup step, and so the shape
 * of a good definition is visible in an example rather than only described.
 */
export const BUILTIN_ROLES = Object.freeze({
  'code-reader': `把一段代码读成事实，而不是读成印象。

关注：数据怎么流动、状态存在哪、错误在哪一层被吞掉、哪些假设没有写在代码里。
忽略：命名品味、格式偏好、与问题无关的重构机会。

回报形式：
1. 这段代码实际做了什么（一句话，按执行顺序）。
2. 关键数据流：入口 → 中间 → 出口，标出每一步的载体（变量、文件、网络、内存）。
3. 我看不见的风险：哪一行在什么输入下会出错，以及为什么现在没出错。
4. 未验证的部分。`,

  'evidence-hunter': `你只做一件事：找到能回答问题的证据，并标明它的强度。

关注：一手来源（源码、命令输出、官方文档、真实数据），而不是二手描述。
忽略：博客转述、猜测、以及"通常大家都这么做"。

回报形式：
1. 结论，连同它的证据强度（强/中/弱）。
2. 每条证据：来源、原文关键片段、它证明了什么。
3. 你没找到的：明确写"查不到"，不要用常识填充。
4. 反证：有没有证据指向相反结论。`,

  'adversary': `你的工作是被付钱来推翻给定结论的。不要客气，也不要为了反对而反对。

关注：结论依赖的每一个前提，尤其是那些被当作显然的。
忽略：结论的表达方式、语气、以及"整体看起来很有道理"。

回报形式：
1. 这个结论最脆弱的一个前提是什么。
2. 能否构造一个具体输入/场景，使结论为假。写出那个输入。
3. 如果推不翻，说清为什么它站得住——具体到哪条证据挡回了你。
4. 如果不确定，说清缺什么证据才能判定。`,

  'design-critic': `你评审设计决策，不评审实现细节。

关注：被放弃的方案、约束是否真实、代价是否被低估、失败时如何退化。
忽略：与当前决策无关的长期架构愿景。

回报形式：
1. 这个设计在替谁解决什么问题（一句话，如果说不清就是设计没想清）。
2. 它排除了哪些替代方案，排除的理由是否成立。
3. 最可能出问题的地方，以及出事时的表现（不是"可能不稳定"，而是具体会怎样）。
4. 如果你只能改一处，改哪里。`,
})

/**
 * Parse one definition file: an optional fenced header block, then the body.
 *
 * Format:
 * ```
 * ---
 * role: security-reviewer
 * ---
 * body…
 * ```
 *
 * The header is optional so a hand-written file works with no ceremony.
 *
 * @param {string} text - the file's contents.
 * @param {string} fallbackRole - the role to use when the header omits one.
 * @returns {{ role: string, body: string }} the parsed definition.
 */
export function parseDefinition(text, fallbackRole) {
  const raw = String(text ?? '')
  const header = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (header === null) {
    return { role: fallbackRole, body: raw.trim() }
  }
  const fields = {}
  for (const line of header[1].split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at < 0) continue
    fields[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim()
  }
  return {
    role: String(fields.role ?? fallbackRole).trim() || fallbackRole,
    body: raw.slice(header[0].length).trim(),
  }
}

/**
 * Serialize a definition back to the file format.
 * @param {{ role: string, body: string }} definition - the definition.
 * @returns {string} the file contents.
 */
export function serializeDefinition(definition) {
  const lines = ['---', `role: ${definition.role}`, 'tools: none (read-only analyst)', '---', '', String(definition.body ?? '').trim(), '']
  return lines.join('\n')
}

/**
 * Validate a definition the model supplied.
 *
 * @param {object} input - the candidate.
 * @returns {{ role: string, body: string }} the normalized definition.
 */
export function normalizeDefinition(input) {
  const role = String(input?.role ?? '').trim().toLowerCase()
  if (!ROLE_PATTERN.test(role)) {
    throw new Error(`agent 名称 "${role}" 不合法：小写字母开头，只含小写字母、数字、连字符，长度 2–39`)
  }
  const body = String(input?.body ?? '').trim()
  if (body === '') throw new Error('agent 定义必须写明职责：它该关注什么、忽略什么、按什么形式回报')
  if (body.length > BODY_LIMIT) throw new Error(`agent 定义过长（上限 ${BODY_LIMIT} 字符）`)
  return { role, body }
}

/**
 * Write one definition to disk.
 * @param {{ role: string, body: string }} definition - the definition.
 * @returns {Promise<string>} the written path.
 */
export async function saveDefinition(definition) {
  const path = pathOf(definition.role)
  await mkdir(AGENTS_DIR, { recursive: true })
  await writeFile(path, serializeDefinition(definition), 'utf8')
  return path
}

/**
 * Read one definition, falling back to the built-in roster.
 * @param {string} role - the role name.
 * @returns {Promise<{ role: string, body: string, builtin: boolean } | undefined>} the definition.
 */
export async function readDefinition(role) {
  const wanted = stemOf(role)
  try {
    const text = await readFile(pathOf(role), 'utf8')
    const parsed = parseDefinition(text, role)
    return { ...parsed, role: parsed.role || role, builtin: false }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  for (const [name, body] of Object.entries(BUILTIN_ROLES)) {
    if (stemOf(name) === wanted) return { role: name, body, builtin: true }
  }
  return undefined
}

/**
 * List every defined role, built-ins included.
 * @returns {Promise<{ role: string, builtin: boolean, summary: string }[]>} the roster.
 */
export async function listDefinitions() {
  const rows = []
  for (const [name, body] of Object.entries(BUILTIN_ROLES)) {
    rows.push({ role: name, builtin: true, summary: firstLine(body) })
  }
  let files = []
  try {
    files = await readdir(AGENTS_DIR)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  for (const file of files) {
    if (!file.endsWith('.md')) continue
    try {
      const text = await readFile(join(AGENTS_DIR, file), 'utf8')
      const parsed = parseDefinition(text, file.replace(/\.md$/, ''))
      const existing = rows.findIndex((row) => row.role === parsed.role)
      const row = { role: parsed.role, builtin: false, summary: firstLine(parsed.body) }
      if (existing >= 0) rows[existing] = row
      else rows.push(row)
    } catch {
      // An unreadable definition is skipped; the roster stays usable.
    }
  }
  return rows
}

/**
 * Delete one definition. Built-ins cannot be deleted, only shadowed.
 * @param {string} role - the role name.
 * @returns {Promise<boolean>} whether a file was removed.
 */
export async function deleteDefinition(role) {
  try {
    await rm(pathOf(role))
    return true
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return false
  }
}

/**
 * Take the first meaningful line of a body, for a one-line roster summary.
 * @param {string} body - the definition body.
 * @returns {string} the summary.
 */
function firstLine(body) {
  const line = String(body ?? '')
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part !== '' && !part.startsWith('#') && !part.startsWith('---'))
  return line === undefined ? '' : line.slice(0, 120)
}

/**
 * Render the roster for the lead's system prompt.
 *
 * Only names and one-line summaries: the full bodies are read on demand through
 * `dev_agent`'s `read`, because a dozen full definitions would consume the context
 * this feature exists to conserve. Every analyst runs on the same model as the
 * lead, so there is no model column to render.
 *
 * @returns {Promise<string>} the roster section, or '' when empty.
 */
export async function renderRoster() {
  const rows = await listDefinitions()
  if (rows.length === 0) return ''
  return rows.map((row) => `- \`${row.role}\`（${row.builtin ? '内置' : '自定义'}）— ${row.summary}`).join('\n')
}
