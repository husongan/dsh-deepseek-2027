/**
 * The persona: an operator-maintained identity the model carries into every
 * request.
 *
 * Three requirements shape this module, and each has a mechanical consequence:
 *
 *  - **It is present in every request.** It therefore registers as a *required*
 *    runtime context on the assembly waterfall rather than as an ordinary
 *    section: a section is composed once into the frozen system prompt, while a
 *    context is re-read for each assembly, so an edited persona takes effect on
 *    the next step without restarting anything.
 *  - **It never participates in compaction.** Compaction folds *messages*; a
 *    prompt context is not a message and is not in the compaction input, so
 *    standing here is the whole of that guarantee. This module also refuses to
 *    accept persona text into any message it creates.
 *  - **It is capped at 3000 tokens.** The cap is enforced on write, not on read,
 *    because a persona that silently truncates at request time would change the
 *    model's identity depending on when the last edit happened.
 *
 * Storage is one Markdown file beside this module, so the user can edit it with
 * any editor and the model can read it with its file tools.
 *
 * @module @local/dsh-deepseek-2027/persona
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This module's directory, so the file follows the installed bundle. */
const HERE = dirname(fileURLToPath(import.meta.url))

/** Directory holding the persona file. */
export const PERSONA_DIR = join(HERE, '_persona')

/** The persona file. */
export const PERSONA_PATH = join(PERSONA_DIR, 'PERSONA.md')

/** Hard cap on persona size, measured in estimated tokens. */
export const PERSONA_TOKEN_LIMIT = 3000

/**
 * Estimate a text's token count.
 *
 * A real tokenizer would need the model's vocabulary, which this bundle cannot
 * depend on. The estimate is deliberately conservative for mixed Chinese and
 * English: a CJK character is counted as one token (real vocabularies spend
 * roughly one to two), and Latin text as one token per four characters. Erring
 * upward means the cap holds for any tokenizer, which is what a hard limit
 * requires.
 *
 * @param {string} text - the candidate persona.
 * @returns {number} the estimated token count.
 */
export function estimateTokens(text) {
  const value = String(text ?? '')
  let tokens = 0
  let latin = 0
  for (const char of value) {
    if (/[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/.test(char)) {
      tokens += 1
      if (latin > 0) {
        tokens += Math.ceil(latin / 4)
        latin = 0
      }
    } else {
      latin += 1
    }
  }
  if (latin > 0) tokens += Math.ceil(latin / 4)
  return tokens
}

/**
 * The persona shipped before the user edits anything.
 *
 * It is written to be *operational* rather than decorative: traits are stated as
 * behaviour the model can execute, because a persona that only supplies an
 * adjective changes nothing in the output.
 */
export const DEFAULT_PERSONA = `# 人格

你是一个长期驻留在这台机器上的工程伙伴，不是一次性问答服务。

## 说话方式

- 直接用结论开头，再给理由。不铺垫，不客套，不用「很好的问题」这类填充。
- 不确定就说不确定，并说明缺哪条信息才能确定。绝不为了显得可靠而编造细节。
- 不用夸张词（完美、彻底、百分百）。做到什么就说什么。
- 中文回答时句子短，少用从句套从句；代码、路径、命令保持原文不翻译。

## 做事方式

- 先看现状再动手。改文件前先读，跑命令前先确认环境，因为你在这台机器上留下的每个痕迹都要能解释。
- 一次只推进一件事，做完再汇报，不把未完成的推测讲成已完成的事实。
- 出错时先复现再归因，不说「可能是环境问题」这种没有信息量的话。
- 用户说「没用」「还是不行」时，先承认是自己的问题，再去找真正的原因，不解释成工具或环境的限制。

## 边界

- 破坏性操作（删除、覆盖、格式化、改系统设置）先说明后果，得到确认再做。
- 涉及密码、密钥时不回显、不写进日志、不放进对话。
- 用户的时间比你的输出长度重要：能一句话说清就不写三段。

本文件可自由编辑。改动会在下一轮请求生效，不参与对话压缩。
`

/**
 * Read the persona, creating the default on first use.
 *
 * A missing file is not an error: the first call seeds the default so the user
 * has something concrete to edit instead of an empty box.
 *
 * @returns {Promise<string>} the persona text.
 */
export async function loadPersona() {
  try {
    return await readFile(PERSONA_PATH, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await savePersona(DEFAULT_PERSONA)
    return DEFAULT_PERSONA
  }
}

/**
 * Write the persona, refusing anything over the cap.
 *
 * The refusal names the actual count so the user can trim by a known amount
 * rather than guessing.
 *
 * @param {string} text - the new persona.
 * @returns {Promise<{ tokens: number }>} the accepted size.
 */
export async function savePersona(text) {
  const value = String(text ?? '')
  const tokens = estimateTokens(value)
  if (tokens > PERSONA_TOKEN_LIMIT) {
    throw new Error(`人格文本约 ${tokens} tokens，超过上限 ${PERSONA_TOKEN_LIMIT}；请删减后再保存。`)
  }
  await mkdir(PERSONA_DIR, { recursive: true })
  await writeFile(PERSONA_PATH, value.endsWith('\n') ? value : `${value}\n`, 'utf8')
  return { tokens }
}

/**
 * Report the persona's current size without modifying it.
 * @returns {Promise<{ tokens: number, limit: number, present: boolean }>} the size report.
 */
export async function personaSize() {
  try {
    const text = await readFile(PERSONA_PATH, 'utf8')
    return { tokens: estimateTokens(text), limit: PERSONA_TOKEN_LIMIT, present: true }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return { tokens: 0, limit: PERSONA_TOKEN_LIMIT, present: false }
  }
}
