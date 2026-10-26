/**
 * One execution facade over two transports.
 *
 * Every tool in this bundle asks the same three questions — run this, read that,
 * write this — and the answer differs only in *where*. Locally that is a
 * PowerShell child process; remotely it is the already-open OpenSSH conversation
 * from `ssh.js`. Keeping the split here means the tool definitions never branch
 * on transport, and a new transport would be a change in this file alone.
 *
 * The remote side deliberately reuses one SSH conversation per server id. A
 * remote shell that keeps its working directory and environment across calls is
 * what makes a sequence of small commands behave like a session rather than like
 * a series of unrelated connections.
 *
 * @module @local/dsh-deepseek-2027/targets
 */
import { spawn } from 'node:child_process'
import { openSession, execOnSession, closeSession, listSessions, readSession } from './ssh.js'
import { assertOperation, resolvePath } from './servers.js'

/** Largest command output kept before truncation, in characters. */
const OUTPUT_LIMIT = 60000

/**
 * Decode captured bytes.
 *
 * Windows consoles emit their OEM code page (936 on a Chinese install) and the
 * remote side emits UTF-8, so a strict UTF-8 decode is tried first and GBK is
 * used only when it fails. Guessing the other way round would mangle every
 * non-ASCII byte on this machine.
 *
 * @param {Buffer} buffer - captured bytes.
 * @returns {string} the decoded text.
 */
function decode(buffer) {
  if (buffer.length === 0) return ''
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    try {
      return new TextDecoder('gbk').decode(buffer)
    } catch {
      return buffer.toString('utf8')
    }
  }
}

/**
 * Clamp a long output, keeping the tail where the error usually is.
 * @param {string} text - the raw output.
 * @returns {{ text: string, truncated: boolean }} the possibly shortened text.
 */
function clamp(text) {
  if (text.length <= OUTPUT_LIMIT) return { text, truncated: false }
  return {
    text: `... [${text.length - OUTPUT_LIMIT} earlier characters dropped]\n${text.slice(-OUTPUT_LIMIT)}`,
    truncated: true,
  }
}

/**
 * Run a PowerShell command on this machine.
 *
 * @param {string} command - the command text.
 * @param {object} [options] - run options.
 * @param {string} [options.cwd] - working directory.
 * @param {number} [options.timeoutMs] - deadline in milliseconds.
 * @param {Record<string, string>} [options.env] - extra environment entries.
 * @returns {Promise<{ exitCode: number|null, stdout: string, stderr: string, timedOut: boolean, truncated: boolean }>} the run result.
 */
export async function runLocal(command, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs) : 120000
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const out = []
  const err = []
  let size = 0
  child.stdout.on('data', (chunk) => {
    if (size < OUTPUT_LIMIT * 4) {
      out.push(chunk)
      size += chunk.length
    }
  })
  child.stderr.on('data', (chunk) => {
    if (size < OUTPUT_LIMIT * 4) {
      err.push(chunk)
      size += chunk.length
    }
  })
  let timedOut = false
  const deadline = setTimeout(() => {
    timedOut = true
    child.kill()
  }, timeoutMs)
  const exitCode = await new Promise((resolve) => {
    child.on('error', () => resolve(-1))
    child.on('close', (code) => resolve(code))
  })
  clearTimeout(deadline)
  const stdout = clamp(decode(Buffer.concat(out)))
  const stderr = clamp(decode(Buffer.concat(err)))
  return {
    exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    timedOut,
    truncated: stdout.truncated || stderr.truncated,
  }
}

/**
 * Quote one value for a PowerShell single-quoted string.
 * @param {string} value - the raw text.
 * @returns {string} the literal, quotes included.
 */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * One open remote conversation per server id, reused across tool calls.
 * @type {Map<string, object>}
 */
const remoteSessions = new Map()

/**
 * Open (or reuse) the SSH conversation for one server.
 *
 * The record's own id is the cache key, so editing a server's address in the
 * settings page must close the stale conversation — {@link forgetRemote} does
 * that on save.
 *
 * @param {object} server - the stored server record.
 * @returns {Promise<object>} the live session handle.
 */
async function ensureRemote(server) {
  const existing = remoteSessions.get(server.id)
  if (existing !== undefined && existing.closed !== true) return existing
  const session = await openSession({
    host: server.host,
    port: server.port,
    username: server.username,
    password: server.password === '' ? undefined : server.password,
    identityFile: server.identityFile === '' ? undefined : server.identityFile,
    acceptNewHostKey: true,
  })
  remoteSessions.set(server.id, session)
  return session
}

/**
 * Drop the cached conversation for one server id, closing it if open.
 * @param {string} id - the server id.
 * @returns {Promise<void>} resolves once the transport is closed.
 */
export async function forgetRemote(id) {
  const session = remoteSessions.get(id)
  remoteSessions.delete(id)
  if (session !== undefined && session.closed !== true) await closeSession(session).catch(() => {})
}

/**
 * List the currently open remote conversations.
 * @returns {object[]} one row per live conversation.
 */
export function listRemote() {
  return [...remoteSessions.values()].map((session) => ({
    id: session.id,
    label: session.label,
    closed: session.closed === true,
  }))
}

/**
 * Run one command on the resolved target.
 *
 * @param {object} target - the resolved target record.
 * @param {string} command - the command text.
 * @param {object} [options] - run options.
 * @param {string} [options.cwd] - working directory (local only).
 * @param {number} [options.timeoutMs] - deadline in milliseconds.
 * @returns {Promise<object>} the run result plus the transport used.
 */
export async function runOn(target, command, options = {}) {
  assertOperation(target, 'exec')
  const text = String(command ?? '')
  if (text.trim() === '') throw new Error('需要一个要执行的命令')
  if (target.kind === 'local') {
    const result = await runLocal(text, options)
    return { target: target.name, transport: 'local', ...result }
  }
  const session = await ensureRemote(target)
  const result = await execOnSession(session, text, { timeoutMs: options.timeoutMs ?? 120000 })
  return {
    target: target.name,
    transport: 'ssh',
    session: session.id,
    exitCode: result.exitCode,
    stdout: result.output ?? '',
    stderr: '',
    timedOut: result.timedOut === true,
    truncated: result.truncated === true,
  }
}

/**
 * Quote one value for a POSIX shell.
 * @param {string} value - the raw text.
 * @returns {string} the quoted literal.
 */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Read one file from the target.
 *
 * The file is fetched as base64 so that line endings, encoding and a file with
 * no trailing newline all survive the trip through a text-oriented command
 * channel unchanged.
 *
 * @param {object} target - the resolved target record.
 * @param {string} path - the file path.
 * @param {string} root - the target's working root.
 * @returns {Promise<{ path: string, text: string, bytes: number, transport: string }>} the content.
 */
export async function readFileOn(target, path, root) {
  assertOperation(target, 'read')
  const resolved = resolvePath(root, path)
  if (target.kind === 'local') {
    const result = await runLocal(
      `$p = ${psQuote(resolved)}; if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { [Console]::Error.Write("no such file"); exit 2 }; `
      + `$b = [System.IO.File]::ReadAllBytes($p); [Console]::Out.Write([Convert]::ToBase64String($b))`,
    )
    if (result.exitCode !== 0) throw new Error(`读取 "${resolved}" 失败：${result.stderr.trim() || '文件不存在'}`)
    const bytes = Buffer.from(result.stdout.trim(), 'base64')
    return { path: resolved, text: bytes.toString('utf8'), bytes: bytes.length, transport: 'local' }
  }
  const session = await ensureRemote(target)
  const result = await execOnSession(session, `base64 < ${shellQuote(resolved)}`, { timeoutMs: 60000 })
  if (result.exitCode !== 0) throw new Error(`读取 "${resolved}" 失败：${(result.output ?? '').trim() || '文件不存在'}`)
  const bytes = Buffer.from(String(result.output ?? '').replace(/\s+/g, ''), 'base64')
  return { path: resolved, text: bytes.toString('utf8'), bytes: bytes.length, transport: 'ssh' }
}

/**
 * Write one file on the target.
 *
 * The content travels as base64 for the same reason reads do: the channel is a
 * shell command line, so raw newlines and quotes would need escaping twice and
 * would still break on a file that contains the chosen delimiter.
 *
 * @param {object} target - the resolved target record.
 * @param {string} path - the file path.
 * @param {string} content - the text to write.
 * @param {string} root - the target's working root.
 * @param {object} [options] - write options.
 * @param {boolean} [options.append] - append instead of replacing.
 * @returns {Promise<{ path: string, bytes: number, transport: string }>} the write receipt.
 */
export async function writeFileOn(target, path, content, root, options = {}) {
  assertOperation(target, 'write')
  const resolved = resolvePath(root, path)
  const payload = Buffer.from(String(content ?? ''), 'utf8')
  const b64 = payload.toString('base64')
  if (target.kind === 'local') {
    const mode = options.append === true ? 'AppendAllText' : 'WriteAllText'
    const result = await runLocal(
      `$p = ${psQuote(resolved)}; $d = [System.IO.Path]::GetDirectoryName($p); if ($d -and -not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }; `
      + `$b = [Convert]::FromBase64String(${psQuote(b64)}); [System.IO.File]::${mode}($p, [System.Text.Encoding]::UTF8.GetString($b), (New-Object System.Text.UTF8Encoding($false)))`,
    )
    if (result.exitCode !== 0) throw new Error(`写入 "${resolved}" 失败：${result.stderr.trim()}`)
    return { path: resolved, bytes: payload.length, transport: 'local' }
  }
  const session = await ensureRemote(target)
  const dir = resolved.includes('/') ? resolved.slice(0, resolved.lastIndexOf('/')) : '.'
  const redirect = options.append === true ? '>>' : '>'
  const command = `mkdir -p ${shellQuote(dir === '' ? '.' : dir)} && printf %s ${shellQuote(b64)} | base64 -d ${redirect} ${shellQuote(resolved)}`
  const result = await execOnSession(session, command, { timeoutMs: 60000 })
  if (result.exitCode !== 0) throw new Error(`写入 "${resolved}" 失败：${(result.output ?? '').trim()}`)
  return { path: resolved, bytes: payload.length, transport: 'ssh' }
}

/**
 * Parse the tab-separated listing both transports emit.
 * @param {string} text - the raw listing text.
 * @returns {object[]} the entries.
 */
function parseListing(text) {
  const entries = []
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim() === '') continue
    const [kind, size, ...rest] = line.split('\t')
    const name = rest.join('\t')
    if (name === '') continue
    entries.push({ name, kind: kind === 'dir' ? 'dir' : 'file', bytes: Number(size) || 0 })
  }
  return entries
}

/**
 * List one directory on the target.
 * @param {object} target - the resolved target record.
 * @param {string} path - the directory path.
 * @param {string} root - the target's working root.
 * @returns {Promise<{ path: string, entries: object[], transport: string }>} the listing.
 */
export async function listOn(target, path, root) {
  assertOperation(target, 'read')
  const resolved = resolvePath(root, path ?? '.')
  if (target.kind === 'local') {
    const result = await runLocal(
      `$p = ${psQuote(resolved)}; if (-not (Test-Path -LiteralPath $p)) { [Console]::Error.Write("no such directory"); exit 2 }; `
      + 'Get-ChildItem -LiteralPath $p -Force | ForEach-Object { $k = if ($_.PSIsContainer) { "dir" } else { "file" }; '
      + '"$k`t$($_.Length)`t$($_.Name)" }',
    )
    if (result.exitCode !== 0) throw new Error(`列出 "${resolved}" 失败：${result.stderr.trim() || '目录不存在'}`)
    return { path: resolved, entries: parseListing(result.stdout), transport: 'local' }
  }
  const session = await ensureRemote(target)
  const command = `cd ${shellQuote(resolved)} && for f in .* *; do [ "$f" = "." ] && continue; [ "$f" = ".." ] && continue; [ -e "$f" ] || continue; `
    + 'if [ -d "$f" ]; then printf "dir\\t0\\t%s\\n" "$f"; else printf "file\\t%s\\t%s\\n" "$(wc -c < "$f")" "$f"; fi; done'
  const result = await execOnSession(session, command, { timeoutMs: 60000 })
  if (result.exitCode !== 0) throw new Error(`列出 "${resolved}" 失败：${(result.output ?? '').trim()}`)
  return { path: resolved, entries: parseListing(result.output ?? ''), transport: 'ssh' }
}

/**
 * Try one connection and report what happened.
 *
 * A "test" that only says "failed" is useless to someone typing an address, so
 * the result carries the transport's own diagnosis.
 *
 * @param {object} target - the resolved target record.
 * @returns {Promise<{ ok: boolean, target: string, transport: string, detail: string }>} the probe result.
 */
export async function probeTarget(target) {
  if (target.kind === 'local') {
    const result = await runLocal('$PSVersionTable.PSVersion.ToString()')
    return {
      ok: result.exitCode === 0,
      target: target.name,
      transport: 'local',
      detail: result.exitCode === 0 ? `PowerShell ${result.stdout.trim()}` : result.stderr.trim(),
    }
  }
  try {
    await forgetRemote(target.id)
    const session = await ensureRemote(target)
    const result = await execOnSession(session, 'uname -a 2>/dev/null || ver', { timeoutMs: 30000 })
    return {
      ok: result.exitCode === 0,
      target: target.name,
      transport: 'ssh',
      detail: String(result.output ?? '').trim(),
    }
  } catch (error) {
    return { ok: false, target: target.name, transport: 'ssh', detail: error?.message ?? String(error) }
  }
}

/**
 * Close every transport this module owns.
 * @returns {Promise<void>} resolves once all are closed.
 */
export async function closeAllTargets() {
  await Promise.all([...remoteSessions.keys()].map((id) => forgetRemote(id)))
}

export { listSessions, readSession }
