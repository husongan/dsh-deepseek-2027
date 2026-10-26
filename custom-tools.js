/**
 * AI-authored tools: the model writes a tool, the plugin mounts it live, and a
 * Markdown note records what it does.
 *
 * Why a spec file rather than generated JavaScript. Mounting model-authored code
 * into the Host process is a privilege escalation the user never agreed to, and
 * a syntax error there takes the whole plugin down rather than one call. So the
 * model declares a tool in JSON — name, description, JSON Schema, and a *body
 * that is a command line*, not source — and this module compiles that declaration
 * into a registry definition. The executable reach of a self-authored tool is
 * therefore exactly the reach the model already has through `dev_admin`: it
 * cannot do anything the existing tools could not.
 *
 * Hot loading is the registry's own affordance: `tools.register()` returns a
 * disposer, and the Host's tool-update projection reports additions to the model
 * as a developer message, so a tool authored mid-turn is callable in the next
 * step without restarting the Harness.
 *
 * Storage: one directory of `<slug>.json` specs plus `<slug>.md` notes, both
 * beside this module. The note is the human-readable half and is what the system
 * prompt points the model at, so the model's own knowledge of its toolbox is
 * ordinary text it can read, diff and edit.
 *
 * @module @local/dsh-deepseek-2027/custom-tools
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This module's directory, so the registry follows the installed bundle. */
const HERE = dirname(fileURLToPath(import.meta.url))

/** Directory holding every authored spec and note. */
export const CUSTOM_DIR = join(HERE, '_custom')

/** Largest note this module will render into the prompt, in characters. */
const NOTE_PROMPT_LIMIT = 24000

/** Business part of a tool name: lowercase, digits, single underscores. */
const NAME_PATTERN = /^[a-z][a-z0-9_]{1,46}$/

/** Names the registry already reserves or this bundle already owns. */
const RESERVED = new Set([
  'run_code',
  'dev_admin',
  'dev_desktop',
  'dev_ssh',
  'dev_tool',
  'think',
])

/**
 * Turn a tool name into a file stem.
 *
 * The name is already constrained to `[a-z0-9_]`, so this is a belt-and-braces
 * pass that also collapses repeated underscores: a spec file must never be able
 * to escape the directory it lives in.
 *
 * @param {string} name - the tool name.
 * @returns {string} a safe file stem.
 */
function slugOf(name) {
  return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'tool'
}

/**
 * Absolute paths for one authored tool.
 * @param {string} name - the tool name.
 * @returns {{ spec: string, note: string }} the two file paths.
 */
export function pathsOf(name) {
  const slug = slugOf(name)
  return { spec: join(CUSTOM_DIR, `${slug}.json`), note: join(CUSTOM_DIR, `${slug}.md`) }
}

/**
 * Read one authored spec from disk.
 * @param {string} name - the tool name.
 * @returns {Promise<object | undefined>} the spec, or undefined when absent.
 */
export async function readSpec(name) {
  try {
    const text = await readFile(pathsOf(name).spec, 'utf8')
    return JSON.parse(text)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw new Error(`无法读取自定义工具 "${name}" 的定义：${error?.message ?? error}`)
  }
}

/**
 * Read every authored spec, skipping ones that cannot be parsed.
 *
 * A single corrupt file must not prevent the other tools from mounting, so the
 * failure is reported in the returned list instead of thrown.
 *
 * @returns {Promise<{ specs: object[], broken: { file: string, reason: string }[] }>} the loaded set.
 */
export async function readAllSpecs() {
  let files
  try {
    files = await readdir(CUSTOM_DIR)
  } catch (error) {
    if (error?.code === 'ENOENT') return { specs: [], broken: [] }
    throw error
  }
  const specs = []
  const broken = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(await readFile(join(CUSTOM_DIR, file), 'utf8'))
      parsed.file = file
      specs.push(parsed)
    } catch (error) {
      broken.push({ file, reason: error?.message ?? String(error) })
    }
  }
  return { specs, broken }
}

/**
 * Validate one spec and fail loudly on anything ambiguous.
 *
 * A tool that mounts and then misbehaves is worse than one the model was told
 * to fix, because its failure surfaces as a confusing tool error mid-turn.
 *
 * @param {unknown} input - the candidate spec.
 * @returns {object} the normalized spec.
 */
export function normalizeSpec(input) {
  if (typeof input !== 'object' || input === null) throw new Error('工具定义必须是一个 JSON 对象')
  const name = String(input.name ?? '').trim().toLowerCase()
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`工具名 "${name}" 不合法：需为小写字母开头，只含小写字母、数字、下划线，长度 2–47`)
  }
  if (RESERVED.has(name)) throw new Error(`工具名 "${name}" 是保留名，请换一个`)
  const description = String(input.description ?? '').trim()
  if (description === '') throw new Error('工具定义必须写明 description：模型靠它判断何时调用')
  if (description.length > 2000) throw new Error('description 过长（上限 2000 字符）')

  const parameters = input.parameters
  if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters)) {
    throw new Error('parameters 必须是一个 JSON Schema 对象，形如 {"type":"object","properties":{...}}')
  }
  if (parameters.type !== 'object') throw new Error('parameters.type 必须是 "object"')

  const command = input.command
  if (typeof command !== 'string' || command.trim() === '') {
    throw new Error('command 必须以字符串给出：这是工具被调用时要执行的命令行模板')
  }

  const note = String(input.note ?? '').trim()
  return {
    name,
    description,
    parameters,
    command,
    cwd: typeof input.cwd === 'string' ? input.cwd.trim() : '',
    elevated: input.elevated === false ? false : true,
    timeoutMs: Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
      ? Math.min(Math.trunc(input.timeoutMs), 600000)
      : 120000,
    note: note === '' ? buildStubNote(name, description) : note,
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

/**
 * Build a starting note when the model supplied none.
 * @param {string} name - the tool name.
 * @param {string} description - the tool's description.
 * @returns {string} a Markdown note.
 */
function buildStubNote(name, description) {
  return [
    `# ${name}`,
    '',
    description,
    '',
    '## 用法',
    '',
    '调用时把参数作为 JSON 对象传入。参数模板 `{{参数名}}` 会被替换成对应值。',
    '',
    '> 本文件由 AI 创建，可直接编辑补充说明。',
  ].join('\n')
}

/**
 * Persist one spec and its note.
 * @param {object} spec - the normalized spec.
 * @returns {Promise<{ spec: string, note: string }>} the written paths.
 */
export async function writeSpec(spec) {
  const paths = pathsOf(spec.name)
  await mkdir(CUSTOM_DIR, { recursive: true })
  await writeFile(paths.spec, `${JSON.stringify(spec, null, 2)}\n`, 'utf8')
  await writeFile(paths.note, `${spec.note.trim()}\n`, 'utf8')
  return paths
}

/**
 * Delete one authored tool's files.
 * @param {string} name - the tool name.
 * @returns {Promise<boolean>} whether anything was removed.
 */
export async function deleteSpec(name) {
  const paths = pathsOf(name)
  let removed = false
  for (const path of [paths.spec, paths.note]) {
    try {
      await rm(path)
      removed = true
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return removed
}

/**
 * Quote one value for a PowerShell single-quoted literal.
 * @param {string} value - the raw text.
 * @returns {string} the literal, quotes included.
 */
function psLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * Expand the command template with one call's arguments.
 *
 * A template placeholder is `{{name}}`. Two rules matter for safety: an unquoted
 * substitution would let an argument smuggle a shell operator, so each value is
 * inserted as a single PowerShell literal; and a placeholder with no matching
 * argument is refused rather than silently emptied, because an emptied value can
 * turn a filter into a wildcard.
 *
 * @param {string} template - the command template.
 * @param {object} args - the call's arguments.
 * @returns {{ command: string, missing: string[] }} the expanded command and any unfilled placeholders.
 */
export function expandTemplate(template, args) {
  const missing = []
  const command = String(template).replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_match, key) => {
    const value = args?.[key]
    if (value === undefined || value === null) {
      missing.push(key)
      return ''
    }
    const text = Array.isArray(value)
      ? value.map((item) => String(item)).join(' ')
      : typeof value === 'object' ? JSON.stringify(value) : String(value)
    return psLiteral(text)
  })
  return { command, missing }
}

/**
 * Render the Markdown note index for the prompt.
 *
 * The prompt gets a directory, not the whole notes: notes grow without bound, and
 * a system prompt that grows with them would crowd out the task. Each entry names
 * the file so the model can read the one it needs with its file tools.
 *
 * @returns {Promise<{ text: string, count: number }>} the index and tool count.
 */
export async function renderToolIndex() {
  const { specs, broken } = await readAllSpecs()
  if (specs.length === 0 && broken.length === 0) {
    return { text: '', count: 0 }
  }
  const lines = []
  for (const spec of specs) {
    const notePath = pathsOf(spec.name).note
    const oneLine = String(spec.description ?? '').replace(/\s+/g, ' ').trim()
    lines.push(`- \`${spec.name}\` — ${oneLine}（说明：${notePath}）`)
  }
  for (const entry of broken) {
    lines.push(`- 损坏的定义 \`${entry.file}\`：${entry.reason}`)
  }
  return { text: lines.join('\n'), count: specs.length }
}

/**
 * Read one note trimmed to the prompt limit.
 * @param {string} name - the tool name.
 * @returns {Promise<string>} the note text, or '' when absent.
 */
export async function readNote(name) {
  try {
    const text = await readFile(pathsOf(name).note, 'utf8')
    if (text.length <= NOTE_PROMPT_LIMIT) return text
    return `${text.slice(0, NOTE_PROMPT_LIMIT)}\n\n... [说明过长，已截断；完整内容见 ${pathsOf(name).note}]`
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}
