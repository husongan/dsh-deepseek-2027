/**
 * DeepSeek 2027 Plan — one SSH conversation, opened once and reused.
 *
 * The model calls `dev_ssh` with `action: "open"`, and from then on the same
 * shell — same session, same working directory, same environment — answers every
 * later `action: "exec"`. That is the difference between a conversation and a
 * sequence of one-shot connections: `cd`, exported variables, an activated
 * virtualenv and a half-finished heredoc all survive between calls.
 *
 * Why the system OpenSSH client rather than a Node SSH library:
 *
 *  - No runtime dependency to install into the profile. `ssh.exe` ships with
 *    Windows, already honours `~/.ssh/config`, the user's keys and any running
 *    agent, so the bundle installs as plain files.
 *  - A real PTY shell is what makes state persist, and `ssh -tt` allocates one.
 *  - Password authentication still works: the client writes its prompt to the
 *    PTY we own, so the password is typed into that prompt instead of a library
 *    call.
 *
 * How a call is made reliable without a terminal multiplexer:
 *
 *  - Every command is written followed by a marker line that reports its exit
 *    status (`printf '\n<marker>:%s\n' "$?"`). A call returns when its marker
 *    arrives, so the model reads command output and never the prompt echo.
 *  - Output that arrives between calls is buffered per session, and each call
 *    returns only the text after the previous cursor. Nothing is lost and
 *    nothing is repeated.
 *  - The cursor and buffer live in the Host process. They are a derived cache of
 *    the terminal stream, not durable state: a reconnect clears them, and the
 *    model can always re-run a command to see current output.
 *
 * Credentials are supplied per call and are therefore visible in the session
 * log; the tool description says so. `identityFile` is preferred where the host
 * accepts it.
 *
 * @module @local/dsh-deepseek-2027/ssh
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

/** How much terminal backlog one session keeps for later reads. */
const BUFFER_LIMIT = 512 * 1024

/** Default deadline for one command. */
const DEFAULT_TIMEOUT_MS = 60_000

/** Default deadline for establishing a connection. */
const CONNECT_TIMEOUT_MS = 30_000

/** Largest text returned inline per call. */
const OUTPUT_LIMIT = 20_000

/** How long the stream must stay quiet before the readiness probe is written. */
const IDLE_PROBE_MS = 700

/**
 * The client executable to spawn.
 *
 * `DSH_2027_SSH` overrides it, which is how the local integration harness points
 * the shipped code paths at a stand-in with the same stdio contract instead of
 * testing a copy of them. Read at call time so the override works even when the
 * module was imported first.
 *
 * @returns {string} the executable path.
 */
function clientExecutable() {
  return process.env.DSH_2027_SSH
    || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32\\OpenSSH\\ssh.exe')
}

/**
 * Extra arguments prepended to the client invocation.
 *
 * Empty in normal use; the harness sets `DSH_2027_SSH_ARGS` to run the stand-in
 * through `node -e`. Split on whitespace outside quotes so a `-e` program stays
 * one argument.
 *
 * @returns {string[]} the leading arguments.
 */
function clientPrefixArgs() {
  const raw = (process.env.DSH_2027_SSH_ARGS ?? '').trim()
  if (raw === '') return []
  return raw.split(/\s+(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((part) => {
    const unquoted = part.startsWith('"') && part.endsWith('"') ? part.slice(1, -1) : part
    return unquoted
  })
}

/** Failures the client prints on its own streams, worth reporting verbatim. */
const AUTH_FAILURE = /(permission denied|host key verification failed|connection refused|could not resolve hostname|connection timed out|no route to host|too many authentication failures)/i

/** The client's own password prompt, at the very end of what it has written. */
const PASSWORD_PROMPT = /(password|passphrase)[^\n:]*:\s*$/i

/**
 * One live SSH conversation.
 * @typedef {object} SshSession
 * @property {string} id - handler id the model uses.
 * @property {import('node:child_process').ChildProcess} child - the ssh process.
 * @property {string} label - `user@host:port`.
 * @property {string} buffer - everything received so far.
 * @property {number} cursor - position already delivered.
 * @property {boolean} closed - whether the transport ended.
 * @property {string | undefined} cwd - last directory the shell reported.
 * @property {Set<() => void>} waiters - pending settle checks.
 */

/** @type {Map<string, SshSession>} */
const sessions = new Map()

/**
 * Bound one output block, keeping the head and the tail.
 * @param {string} text - raw text.
 * @returns {{ text: string, truncated: boolean, chars: number }} the bounded text.
 */
function bound(text) {
  const chars = text.length
  if (chars <= OUTPUT_LIMIT) return { text, truncated: false, chars }
  const head = Math.floor(OUTPUT_LIMIT * 0.75)
  const tail = OUTPUT_LIMIT - head
  return {
    text: `${text.slice(0, head)}\n… [${chars - OUTPUT_LIMIT} characters omitted] …\n${text.slice(chars - tail)}`,
    truncated: true,
    chars,
  }
}

/**
 * Strip ANSI escapes, carriage returns and control bytes from terminal output.
 * @param {string} text - raw channel text.
 * @returns {string} displayable text.
 */
function clean(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\u001b\][^\u0007]*\u0007/g, '')
    .replace(/[\u0000\u0007\u0008]/g, '')
}

/**
 * Append stream output to a session's buffer, trimming the oldest bytes.
 * @param {SshSession} session - target session.
 * @param {string} chunk - new text.
 */
function append(session, chunk) {
  session.buffer += chunk
  if (session.buffer.length > BUFFER_LIMIT) {
    const drop = session.buffer.length - BUFFER_LIMIT
    session.buffer = session.buffer.slice(drop)
    session.cursor = Math.max(0, session.cursor - drop)
  }
  for (const waiter of [...session.waiters]) waiter()
}

/**
 * Wait until `predicate` holds for the session buffer, or the deadline expires.
 * @param {SshSession} session - session to watch.
 * @param {(buffer: string) => boolean} predicate - settle condition.
 * @param {number} timeoutMs - deadline.
 * @param {AbortSignal | undefined} signal - caller cancellation.
 * @returns {Promise<boolean>} whether the predicate held before the deadline.
 */
function waitFor(session, predicate, timeoutMs, signal) {
  if (predicate(session.buffer)) return Promise.resolve(true)
  return new Promise((resolve, reject) => {
    const check = () => {
      if (!predicate(session.buffer)) return
      cleanup()
      resolve(true)
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve(false)
    }, timeoutMs)
    const onAbort = () => {
      cleanup()
      reject(new Error('the SSH call was cancelled'))
    }
    const cleanup = () => {
      clearTimeout(timer)
      session.waiters.delete(check)
      signal?.removeEventListener('abort', onAbort)
    }
    session.waiters.add(check)
    if (signal !== undefined) {
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
    }
    // Re-check after registration: output may have landed between the first test
    // and the waiter becoming visible.
    check()
  })
}

/**
 * Establish one conversation.
 *
 * The readiness handshake is idle-driven: the client prints its banner, MOTD and
 * prompt, and once that stream has been quiet for {@link IDLE_PROBE_MS} the probe
 * command is written. That covers key auth (no prompt at all) and password auth
 * (a prompt, answered as soon as it appears) with the same rule, so a slow server
 * never receives the probe as a password.
 *
 * @param {object} options - connection details.
 * @param {string} options.host - hostname or address.
 * @param {number} [options.port] - port, default 22.
 * @param {string} options.username - account.
 * @param {string} [options.password] - password, typed into the client's prompt.
 * @param {string} [options.identityFile] - private key path on this machine.
 * @param {string} [options.jump] - `user@host` ProxyJump hop.
 * @param {boolean} [options.acceptNewHostKey] - add unknown host keys; default true.
 * @param {number} [options.timeoutMs] - connect deadline.
 * @returns {Promise<{ session: SshSession, banner: string }>} the live session.
 */
export async function openSession(options) {
  const host = String(options.host ?? '').trim()
  if (host === '') throw new Error('dev_ssh open needs a host')
  const username = String(options.username ?? '').trim()
  if (username === '') throw new Error('dev_ssh open needs a username')
  const port = Number.isFinite(options.port) && options.port > 0 ? Math.trunc(options.port) : 22
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? Math.trunc(options.timeoutMs) : CONNECT_TIMEOUT_MS
  const acceptNew = options.acceptNewHostKey !== false

  const argv = [
    '-tt',
    '-o', `StrictHostKeyChecking=${acceptNew ? 'accept-new' : 'yes'}`,
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=8',
    '-o', 'LogLevel=ERROR',
    '-p', String(port),
    '-l', username,
  ]
  if (typeof options.identityFile === 'string' && options.identityFile.trim() !== '') {
    argv.push('-i', options.identityFile.trim(), '-o', 'IdentitiesOnly=yes')
  }
  if (typeof options.jump === 'string' && options.jump.trim() !== '') {
    argv.push('-J', options.jump.trim())
  }
  argv.push(host)

  const child = spawn(clientExecutable(), [...clientPrefixArgs(), ...argv], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TERM: 'xterm-256color' },
  })

  const id = `ssh-${randomUUID().slice(0, 8)}`
  /** @type {SshSession} */
  const session = {
    id,
    child,
    label: `${username}@${host}:${port}`,
    buffer: '',
    cursor: 0,
    closed: false,
    cwd: undefined,
    waiters: new Set(),
  }

  const label = session.label
  const readyMarker = `__DSH2027_READY_${id}__`
  let passwordSent = false
  let probeSent = false
  let ended = false
  let idleTimer

  child.stdin.setDefaultEncoding('utf8')
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  const feed = (chunk) => {
    append(session, chunk)
    if (ended) return
    const tail = session.buffer.slice(-4096)

    if (AUTH_FAILURE.test(tail)) {
      ended = true
      child.kill()
      return
    }
    // Answer the client's own password prompt before the idle probe can fire;
    // otherwise the probe text would be consumed as the password.
    if (!passwordSent && typeof options.password === 'string' && options.password !== '' && PASSWORD_PROMPT.test(tail)) {
      passwordSent = true
      child.stdin.write(`${options.password}\n`)
    }
    if (probeSent) return
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      if (ended || probeSent) return
      probeSent = true
      // Quiet the prompt: the marker protocol expects each response to start on a
      // line boundary without the shell's own decorations in front of it.
      child.stdin.write([
        `stty -echo 2>/dev/null; export PS1='' PS2='' PROMPT_COMMAND='';`,
        `printf '\\n%s\\n' '${readyMarker}';`,
        'pwd',
        '',
      ].join('\n'))
    }, IDLE_PROBE_MS)
  }

  child.stdout.on('data', feed)
  child.stderr.on('data', feed)
  child.stdin.on('error', () => {})
  child.on('error', (error) => {
    ended = true
    append(session, `\n${error.message}\n`)
  })
  child.on('exit', (code, signal) => {
    ended = true
    session.closed = true
    sessions.delete(id)
    append(session, `\n[ssh exited: code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}]\n`)
  })

  sessions.set(id, session)

  const ready = await waitFor(session, (buffer) => buffer.includes(readyMarker) || AUTH_FAILURE.test(buffer.slice(-4096)), timeoutMs, undefined)
  clearTimeout(idleTimer)

  const bannerRaw = clean(session.buffer)
  if (!bannerRaw.includes(readyMarker)) {
    session.closed = true
    sessions.delete(id)
    try {
      child.kill()
    } catch {
      /* already gone */
    }
    const reason = bannerRaw.trim().split('\n').slice(-8).join('\n')
    throw new Error(ready
      ? `the SSH connection to ${label} failed:\n${reason}`
      : `the SSH connection to ${label} did not become ready within ${timeoutMs} ms${reason === '' ? '' : `:\n${reason}`}`)
  }

  const initial = bannerRaw.slice(bannerRaw.indexOf(readyMarker) + readyMarker.length)
  session.cursor = session.buffer.length
  const firstLines = initial.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  session.cwd = firstLines[firstLines.length - 1]

  return {
    session,
    banner: bannerRaw.slice(0, bannerRaw.indexOf(readyMarker)).trim(),
  }
}

/**
 * Run one command on a live conversation and wait for its marker.
 *
 * @param {SshSession} session - the conversation.
 * @param {string} command - shell text to run.
 * @param {object} [options] - call options.
 * @param {number} [options.timeoutMs] - deadline.
 * @param {AbortSignal} [options.signal] - caller cancellation.
 * @returns {Promise<{ output: string, exitCode: number | null, timedOut: boolean, chars: number, truncated: boolean }>} the result.
 */
export async function execOnSession(session, command, options = {}) {
  if (session.closed) throw new Error(`the SSH conversation ${session.id} is closed; open a new one`)
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.min(Math.trunc(options.timeoutMs), 600_000)
    : DEFAULT_TIMEOUT_MS
  const marker = `__DSH2027_DONE_${randomUUID().slice(0, 8)}__`

  // Drain anything the shell produced while nobody was reading, so the answer
  // contains this command's output only.
  session.cursor = session.buffer.length

  // The status line is emitted on its own line after the command, always, and
  // after a leading newline so a command that ends without one cannot glue its
  // last byte onto the marker.
  session.child.stdin.write(`${command}\nprintf '\\n%s:%s\\n' '${marker}' "$?"\n`)

  const pattern = `${marker}:`
  const settled = await waitFor(session, (buffer) => buffer.includes(pattern), timeoutMs, options.signal)
  const raw = session.buffer.slice(session.cursor)
  session.cursor = session.buffer.length

  let output = raw
  let exitCode = null
  const at = raw.indexOf(pattern)
  if (at >= 0) {
    output = raw.slice(0, at)
    const lineEnd = raw.indexOf('\n', at)
    const statusText = raw.slice(at + pattern.length, lineEnd >= 0 ? lineEnd : undefined).trim()
    const parsed = Number.parseInt(statusText, 10)
    exitCode = Number.isInteger(parsed) ? parsed : null
  }
  const text = clean(output).replace(/^\s*\n/, '')
  const bounded = bound(text)

  return {
    output: bounded.text,
    exitCode,
    timedOut: !settled,
    chars: bounded.chars,
    truncated: bounded.truncated,
  }
}

/**
 * Read buffered terminal output without running a command.
 * @param {SshSession} session - the conversation.
 * @returns {{ output: string, chars: number, truncated: boolean }} output since the last cursor.
 */
export function readSession(session) {
  const raw = clean(session.buffer.slice(session.cursor))
  session.cursor = session.buffer.length
  return bound(raw)
}

/**
 * Close one conversation.
 * @param {SshSession} session - the conversation.
 * @returns {Promise<void>} after the transport ends.
 */
export async function closeSession(session) {
  sessions.delete(session.id)
  session.closed = true
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        session.child.kill()
      } catch {
        /* already gone */
      }
      resolve()
    }, 3000)
    session.child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    try {
      session.child.stdin.write('exit 0\n')
      session.child.stdin.end()
    } catch {
      clearTimeout(timer)
      resolve()
    }
  })
}

/**
 * List the live conversations.
 * @returns {object[]} one row per conversation.
 */
export function listSessions() {
  return [...sessions.values()].map((session) => ({
    id: session.id,
    label: session.label,
    closed: session.closed,
    bufferedChars: session.buffer.length,
  }))
}

/**
 * Resolve a conversation by id, or the only one when a single conversation is open.
 * @param {string | undefined} id - requested id.
 * @returns {SshSession} the conversation.
 */
export function requireSession(id) {
  if (typeof id === 'string' && id !== '') {
    const found = sessions.get(id)
    if (found === undefined) throw new Error(`no SSH conversation "${id}"; call action "list" to see the open ones`)
    return found
  }
  const all = [...sessions.values()]
  if (all.length === 0) throw new Error('no SSH conversation is open; call action "open" first')
  if (all.length > 1) throw new Error(`several SSH conversations are open (${all.map((entry) => entry.id).join(', ')}); name one with "session"`)
  return all[0]
}

/** Close every conversation; called when the plugin unloads. */
export async function closeAll() {
  await Promise.all([...sessions.values()].map((session) => closeSession(session).catch(() => {})))
  sessions.clear()
}
