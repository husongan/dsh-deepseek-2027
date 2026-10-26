/**
 * A stand-in for `ssh.exe`, used only by the local integration harness.
 *
 * It implements just enough of the client/shell contract for the real module code
 * paths to run unmodified:
 *
 *  - prints a banner, and a password prompt first when `DSH2027_FAKE_PASSWORD`
 *    is set (which the module must answer before sending its probe);
 *  - behaves like a POSIX shell over stdin: `pwd`, `cd`, `export`, `echo`,
 *    `true`, `false`, `sleep`, and the marker `printf` lines the module appends;
 *  - exits on `exit`.
 *
 * Driven through `DSH_2027_SSH=node` plus `DSH_2027_SSH_ARGS`, so the tested code
 * is the real `openSession` / `execOnSession` / `readSession` implementation and
 * not a copy. Every OpenSSH option the module passes is accepted and ignored; the
 * host is the last positional argument, as the client treats it.
 */

/** Options that consume the following word, so it is not mistaken for the host. */
const VALUE_OPTIONS = new Set(['-o', '-p', '-l', '-i', '-J', '-F', '-E', '-c', '-m', '-O', '-Q', '-S', '-W', '-w', '-L', '-R', '-D', '-b', '-e'])

const argv = process.argv.slice(2)
const positionals = []
for (let index = 0; index < argv.length; index += 1) {
  const token = argv[index]
  if (token === '-e') {
    // The harness passes its own `-e <uri>` pair before the OpenSSH options;
    // only the OpenSSH `-e` (escape char) would consume a value, so treat this one
    // as the harness marker and remember what follows.
    harnessEntry = argv[index + 1]
    index += 1
    continue
  }
  if (VALUE_OPTIONS.has(token)) {
    index += 1
    continue
  }
  if (token.startsWith('-')) continue
  positionals.push(token)
}

let harnessEntry
const target = positionals[positionals.length - 1] ?? 'standin'
const portOption = argv[argv.indexOf('-p') + 1]
const userOption = argv[argv.indexOf('-l') + 1]
const user = userOption ?? 'user'
const port = portOption ?? '22'

let cwd = `/home/${user}`
let status = 0
let buffer = ''

/** Write to stdout the way a terminal would. */
const out = (text) => process.stdout.write(text.replace(/\n/g, '\r\n'))

const password = process.env.DSH2027_FAKE_PASSWORD ?? ''
if (password !== '') out(`${user}@${target}'s password: `)

out(`Welcome to the stand-in shell for ${target} (${user}, port ${port})\r\n`)
out('Last login: never\r\n')

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let nl
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).replace(/\r$/, '')
    buffer = buffer.slice(nl + 1)
    if (password !== '' && line === password) continue
    // A blocking command holds the line that follows it, exactly as a real shell
    // does: the module's status marker cannot run before the command finishes.
    pending.push(line)
  }
  void drain()
})

/** Lines waiting for their turn, in arrival order. */
const pending = []
let draining = false

/**
 * Run queued lines until one blocks.
 * @returns {Promise<void>} after the queue has either drained or blocked.
 */
async function drain() {
  if (draining) return
  draining = true
  try {
    while (pending.length > 0) {
      const line = pending.shift()
      const blocked = await handle(line)
      if (blocked) {
        // Unshift the line that must run when the sleep ends, then wait for it.
        pending.unshift(...[])
        break
      }
    }
  } finally {
    draining = false
  }
}

/**
 * Run one shell line.
 * @param {string} line - the line.
 * @returns {Promise<boolean>} whether the shell is now blocked on this command.
 */
async function handle(line) {
  const text = line.trim()

  // The module's own prompt-silencing and readiness probes.
  if (/^stty\b/.test(text) || /^export\b/.test(text) || text === '') return false
  const ready = /^printf '\\n%s\\n' '([^']+)';?$/.exec(text)
  if (ready !== null) {
    out(`\n${ready[1]}\n`)
    return false
  }
  const done = /^printf '\\n%s:%s\\n' '([^']+)' "\$\?"$/.exec(text)
  if (done !== null) {
    out(`\n${done[1]}:${status}\n`)
    return false
  }

  if (text === 'exit' || text === 'exit 0') process.exit(0)
  if (text === 'pwd') {
    out(`${cwd}\n`)
    status = 0
    return false
  }
  if (text.startsWith('cd ')) {
    const next = text.slice(3).trim()
    cwd = next.startsWith('/') ? next : `${cwd}/${next}`.replace(/\/+/g, '/')
    status = 0
    return false
  }
  if (text === 'true') {
    status = 0
    return false
  }
  if (text === 'false') {
    status = 1
    return false
  }
  const sleeping = /^sleep\s+(\d+)$/.exec(text)
  if (sleeping !== null) {
    const seconds = Number(sleeping[1])
    // The harness relies on this one outlasting its deadline.
    freeing = new Promise((resolve) => setTimeout(resolve, seconds * 1000))
    const held = pending
    await freeing
    status = 0
    pending.unshift(...held)
    void drain()
    return true
  }
  if (text.startsWith('echo ')) {
    out(`${text.slice(5).replace(/^["']|["']$/g, '')}\n`)
    status = 0
    return false
  }
  out(`fake-shell: command not found: ${text.split(' ')[0]}\r\n`)
  status = 127
  return false
}

/** The pending sleep, kept so a long one can be observed. */
let freeing
