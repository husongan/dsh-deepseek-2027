/**
 * DeepSeek 2027 Plan — administrator command execution.
 *
 * One tool, `dev_admin`, running any command line at **High** integrity level on
 * this Windows host. Four mechanisms matter:
 *
 *  1. **Elevation without a prompt.** The host runs as a member of the local
 *     Administrators group, but its token is filtered (UAC). `Start-Process
 *     -Verb RunAs` raises an unfiltered token; on a host whose administrator
 *     policy allows that, no consent dialog appears and the call is synchronous.
 *     Where the policy does prompt, the call still completes — it just waits.
 *  2. **A job directory, not a pipe.** An elevated child cannot write to an
 *     anonymous pipe owned by a lower-integrity process, so the child gets a
 *     directory it can write back into: `job.json` in, `stdout.txt` /
 *     `stderr.txt` / `done.json` out. The runner (`dev-exec.ps1`) owns that file
 *     protocol, which keeps this module free of Win32 booking.
 *  3. **Output discipline.** stdout and stderr return as separate bounded
 *     blocks with their character counts, so a giant log does not flood the
 *     model's context while still letting it ask for more.
 *  4. **An unelevated path.** Some work must not be elevated: tools that refuse
 *     to run as administrator, and anything that needs to see the user's own
 *     environment. `elevated: false` runs on the current token.
 *
 * @module @local/dsh-deepseek-2027/admin
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where this module lives, so the runner script can be found beside it. */
const HERE = path.dirname(fileURLToPath(import.meta.url))

/** The job runner executed inside the elevated child. */
const RUNNER = path.join(HERE, 'dev-exec.ps1')

/** PowerShell host used for the launcher. Windows PowerShell 5.1 ships everywhere. */
const LAUNCHER = process.env.DSH_2027_POWERSHELL
  || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32\\WindowsPowerShell\\v1.0\\powershell.exe')

/** Root of the per-call job directories. */
const JOBS_ROOT = path.join(tmpdir(), 'dsh-2027-jobs')

/** Default ceiling on how long one command may run. */
const DEFAULT_TIMEOUT_MS = 120_000

/** Hard ceiling from the tool contract. */
const MAX_TIMEOUT_MS = 600_000

/** Largest slice of stdout/stderr returned inline, in characters. */
const OUTPUT_LIMIT = 24_000

/** Default working directory when the caller names none. */
const DEFAULT_CWD = process.env.SystemRoot || 'C:\\Windows'

/**
 * Clamp one text stream to the inline budget, keeping the head and the tail.
 *
 * A command's interesting lines are usually at one end or the other — the header
 * of a report, the error at the bottom — so the middle is what gets dropped.
 *
 * @param {string} text - raw stream text.
 * @returns {{ text: string, truncated: boolean, chars: number }} the bounded text.
 */
function bound(text) {
  const chars = text.length
  if (chars <= OUTPUT_LIMIT) return { text, truncated: false, chars }
  const head = Math.floor(OUTPUT_LIMIT * 0.7)
  const tail = OUTPUT_LIMIT - head
  return {
    text: `${text.slice(0, head)}\n\n… [${chars - OUTPUT_LIMIT} characters omitted] …\n\n${text.slice(chars - tail)}`,
    truncated: true,
    chars,
  }
}

/**
 * Read a file as UTF-8, treating a missing file as empty.
 * @param {string} file - absolute path.
 * @returns {Promise<string>} the contents, or ''.
 */
async function readTextOrEmpty(file) {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Resolve the deadline for one call.
 * @param {unknown} requested - caller-provided milliseconds.
 * @returns {number} a positive integer no larger than {@link MAX_TIMEOUT_MS}.
 */
function deadlineOf(requested) {
  const value = Number(requested)
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(Math.trunc(value), MAX_TIMEOUT_MS)
}

/**
 * Run one command under an elevated token.
 *
 * @param {object} request - the call.
 * @param {readonly string[]} request.argv - executable followed by its arguments.
 * @param {string} [request.cwd] - working directory inside the elevated process.
 * @param {string} [request.stdin] - text to feed the process's stdin.
 * @param {number} [request.timeoutMs] - hard deadline.
 * @param {Record<string, string>} [request.env] - extra environment entries.
 * @param {AbortSignal} [request.signal] - caller cancellation.
 * @returns {Promise<object>} exit facts plus bounded stdout/stderr.
 */
export async function runElevated(request) {
  const argv = Array.isArray(request.argv) ? request.argv.map(String) : []
  if (argv.length === 0) throw new Error('dev_admin needs argv: the executable and its arguments')
  const timeoutMs = deadlineOf(request.timeoutMs)
  const jobDir = path.join(JOBS_ROOT, `job-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`)
  await mkdir(jobDir, { recursive: true })

  const spec = {
    argv,
    cwd: request.cwd || DEFAULT_CWD,
    timeoutMs,
    env: request.env && typeof request.env === 'object' ? request.env : {},
    ...request.stdin === undefined ? {} : { stdinB64: Buffer.from(String(request.stdin), 'utf8').toString('base64') },
  }
  await writeFile(path.join(jobDir, 'job.json'), JSON.stringify(spec), 'utf8')

  const launcherArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', RUNNER, '-Job', jobDir]
  const started = Date.now()

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(LAUNCHER, launcherArgs, { cwd: DEFAULT_CWD, windowsHide: true, stdio: 'ignore' })
      const onAbort = () => {
        child.kill()
        reject(new Error('dev_admin was cancelled'))
      }
      if (request.signal !== undefined) {
        if (request.signal.aborted) return onAbort()
        request.signal.addEventListener('abort', onAbort, { once: true })
      }
      child.on('error', reject)
      child.on('exit', () => resolve())
    })

    const doneRaw = await readTextOrEmpty(path.join(jobDir, 'done.json'))
    const done = doneRaw === '' ? undefined : JSON.parse(doneRaw)
    const stdout = bound(await readTextOrEmpty(path.join(jobDir, 'stdout.txt')))
    const stderr = bound(await readTextOrEmpty(path.join(jobDir, 'stderr.txt')))

    if (done === undefined) {
      throw new Error(`the elevated launcher exited before reporting a result (${Date.now() - started} ms); the request may have been declined at a consent prompt`)
    }
    if (typeof done.error === 'string' && done.error !== '' && done.exitCode === null) {
      throw new Error(`the elevated runner failed: ${done.error}`)
    }
    return {
      elevated: true,
      integrity: 'high',
      user: String(done.user ?? ''),
      argv,
      cwd: spec.cwd,
      exitCode: done.exitCode ?? null,
      elapsedMs: done.elapsedMs ?? Date.now() - started,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutChars: stdout.chars,
      stderrChars: stderr.chars,
      truncated: stdout.truncated || stderr.truncated,
      timedOut: typeof done.error === 'string' && done.error.startsWith('timed out'),
    }
  } finally {
    // The answer has been read; the directory holds nothing the caller can use,
    // and a left-behind job.json would accumulate one directory per command.
    await rm(jobDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Decode console output produced by a Windows child process.
 *
 * A redirected `cmd.exe` or `powershell.exe` writes in the machine's OEM code
 * page — GBK on a Chinese install — not UTF-8. Valid UTF-8 is honoured because
 * many tools emit it deliberately; anything else is decoded with the OEM page so
 * a localized error message is readable rather than mojibake.
 *
 * @param {Buffer} bytes - raw stream bytes.
 * @returns {string} the decoded text.
 */
function decodeConsole(bytes) {
  if (bytes.length === 0) return ''
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    /* not UTF-8: fall through to the console code page */
  }
  for (const label of ['gbk', 'windows-1252', 'gb18030']) {
    try {
      return new TextDecoder(label).decode(bytes)
    } catch {
      /* try the next label */
    }
  }
  return bytes.toString('latin1')
}

/**
 * Run one command with the *current* (unelevated) token.
 *
 * @param {object} request - the same shape as {@link runElevated}.
 * @returns {Promise<object>} exit facts plus bounded stdout/stderr.
 */
export async function runDirect(request) {
  const argv = Array.isArray(request.argv) ? request.argv.map(String) : []
  if (argv.length === 0) throw new Error('dev_admin needs argv: the executable and its arguments')
  const timeoutMs = deadlineOf(request.timeoutMs)
  const started = Date.now()

  return await new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: request.cwd || DEFAULT_CWD,
      windowsHide: true,
      env: { ...process.env, ...(request.env && typeof request.env === 'object' ? request.env : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    // Console output arrives in the machine's OEM code page, not UTF-8: a
    // redirected cmd.exe or powershell.exe writes GBK on a Chinese system. Treat
    // the bytes as raw and decode them with that code page, so localized output
    // is readable instead of mojibake.
    const out = []
    const err = []
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => err.push(chunk))
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`command timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    const onAbort = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      reject(new Error('dev_admin was cancelled'))
    }
    if (request.signal !== undefined) {
      if (request.signal.aborted) return onAbort()
      request.signal.addEventListener('abort', onAbort, { once: true })
    }
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const stdout = bound(decodeConsole(Buffer.concat(out)))
      const stderr = bound(decodeConsole(Buffer.concat(err)))
      resolve({
        elevated: false,
        integrity: 'medium',
        user: process.env.USERNAME || '',
        argv,
        cwd: request.cwd || DEFAULT_CWD,
        exitCode: code,
        elapsedMs: Date.now() - started,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutChars: stdout.chars,
        stderrChars: stderr.chars,
        truncated: stdout.truncated || stderr.truncated,
        timedOut: false,
      })
    })
    if (request.stdin !== undefined) child.stdin.write(String(request.stdin))
    child.stdin.end()
  })
}
