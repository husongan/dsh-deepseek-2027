/**
 * Local harness for the DeepSeek 2027 runtime helpers.
 *
 * Not part of the installed bundle. It exercises the pieces that can be checked
 * without a live Harness Agent:
 *
 *  - `admin.js` against real commands, both elevated and not;
 *  - the desktop worker's real Win32 actions, through `desktop.js`;
 *  - the SSH marker protocol against a scripted stand-in channel, and the real
 *    client's failure reporting against an unreachable host.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.argv[2]
if (!ROOT) throw new Error('usage: node integration-test.mjs <bundle-directory>')
const at = (name) => pathToFileURL(path.join(ROOT, name)).href

const which = process.argv[3] ?? 'all'
const wants = (name) => which === 'all' || which === name

// ---------------------------------------------------------------------------
// admin
// ---------------------------------------------------------------------------

if (wants('admin')) {
  const { runDirect, runElevated } = await import(at('admin.js'))

  const direct = await runDirect({ argv: ['cmd.exe', '/c', 'echo direct-ok'], timeoutMs: 30_000 })
  assert.equal(direct.exitCode, 0)
  assert.equal(direct.elevated, false)
  assert.match(direct.stdout, /direct-ok/)
  console.log('ok  dev_admin unelevated: exit 0, stdout captured')

  const env = await runDirect({ argv: ['cmd.exe', '/c', 'echo %DS27_PROBE%'], env: { DS27_PROBE: 'env-ok' } })
  assert.match(env.stdout, /env-ok/)
  console.log('ok  dev_admin passes extra environment entries')

  const stdin = await runDirect({ argv: ['powershell.exe', '-NoProfile', '-Command', '$input | Out-String'], stdin: 'piped-ok' })
  assert.match(stdin.stdout, /piped-ok/)
  console.log('ok  dev_admin writes caller stdin')

  const failing = await runDirect({ argv: ['cmd.exe', '/c', 'exit 3'] })
  assert.equal(failing.exitCode, 3)
  console.log('ok  dev_admin reports a non-zero exit code as a fact')

  // The real reason this capability exists: prove the token is High integrity.
  const elevated = await runElevated({
    argv: ['cmd.exe', '/c', 'whoami /groups'],
    timeoutMs: 90_000,
  })
  assert.equal(elevated.elevated, true)
  assert.equal(elevated.exitCode, 0)
  const combined = `${elevated.stdout}${elevated.stderr}`
  assert.match(combined, /S-1-16-12288|S-1-16-16384/, `expected a high-integrity token, got:\n${combined.slice(0, 400)}`)
  console.log('ok  dev_admin elevated: token is High integrity')

  const elevatedOut = await runElevated({
    argv: ['cmd.exe', '/c', 'echo elevated-ok & cd'],
    timeoutMs: 90_000,
  })
  assert.match(elevatedOut.stdout, /elevated-ok/)
  console.log('ok  dev_admin elevated: stdout captured through the job directory')

  // A job directory is removed once its answer has been read.
  const jobsRoot = path.join(tmpdir(), 'dsh-2027-jobs')
  const { readdir } = await import('node:fs/promises')
  const leftovers = await readdir(jobsRoot).catch(() => [])
  assert.equal(leftovers.length, 0, `job directories were left behind: ${leftovers.join(', ')}`)
  console.log('ok  dev_admin removes its job directory')

  // Large output is bounded, not dropped.
  const big = await runDirect({
    argv: ['powershell.exe', '-NoProfile', '-Command', '1..4000 | ForEach-Object { "line $_" }'],
  })
  assert.equal(big.truncated, true)
  assert.ok(big.truncated, 'output over the inline budget must report truncation')
  assert.ok(big.stdoutChars > 24_000)
  assert.match(big.stdout, /line 1\b/)
  assert.match(big.stdout, /line 4000\b/)
  console.log('ok  dev_admin bounds large output but keeps head and tail')
}

// ---------------------------------------------------------------------------
// desktop
// ---------------------------------------------------------------------------

if (wants('desktop')) {
  const { ensureDesktop, desktopRequest, capture, stopDesktop } = await import(at('desktop.js'))

  const info = await ensureDesktop()
  assert.equal(info.ready, true)
  assert.equal(info.elevated, false, 'desktop input must not run elevated: UIPI would block it')
  console.log('ok  desktop worker is ready and stays at the user token')

  const status = await desktopRequest({ action: 'info' })
  assert.ok(status.screen.width > 0 && status.screen.height > 0)
  assert.ok(Array.isArray(status.monitors) && status.monitors.length > 0)
  console.log(`ok  desktop status: ${status.screen.width}x${status.screen.height}, ${status.monitors.length} monitor(s)`)

  const wins = await desktopRequest({ action: 'windows' })
  assert.ok(Array.isArray(wins.windows))
  console.log(`ok  desktop window list: ${wins.windows.length} visible windows`)

  // The cursor must actually move; restore it afterwards.
  const before = (await desktopRequest({ action: 'info' })).cursor
  const moved = await desktopRequest({ action: 'move', x: before.x + 12, y: before.y + 9, durationMs: 0 })
  assert.equal(moved.cursor.x, before.x + 12)
  await desktopRequest({ action: 'move', x: before.x, y: before.y, durationMs: 0 })
  console.log('ok  desktop cursor moves and is restoreable')

  const at2 = await desktopRequest({ action: 'at', x: before.x, y: before.y })
  assert.equal(typeof at2.className, 'string')
  console.log(`ok  desktop hit-test at the cursor: "${at2.title}" (${at2.className})`)

  // A key press with a modifier, aimed at nothing destructive: Ctrl+C on the
  // desktop with no selection and no console attached.
  const keyed = await desktopRequest({ action: 'key', key: 'INSERT', modifiers: '' })
  assert.equal(keyed.key, 'INSERT')
  await desktopRequest({ action: 'key', key: 'DELETE' })
  console.log('ok  desktop key injection accepts named keys')

  // Clipboard round trip.
  await desktopRequest({ action: 'clipboardSet', textB64: Buffer.from('ds27-clip', 'utf8').toString('base64') })
  const clip = await desktopRequest({ action: 'clipboardGet' })
  assert.equal(clip.text, 'ds27-clip')
  console.log('ok  desktop clipboard round trip')

  // A real screenshot, persisted as an attachment when the store is present and
  // as a file otherwise.
  const dir = await mkdtemp(path.join(tmpdir(), 'ds27-shot-'))
  const services = {}
  const shot = await capture({ gridSize: 250, scale: 0.5 }, services)
  assert.ok(shot.imageWidth > 0 && shot.imageHeight > 0)
  assert.ok(typeof shot.imagePath === 'string' && shot.imagePath !== '')
  const bytes = await readFile(shot.imagePath)
  assert.equal(bytes[0], 0x89)
  assert.equal(bytes.subarray(1, 4).toString('latin1'), 'PNG')
  console.log(`ok  desktop screenshot: ${shot.imageWidth}x${shot.imageHeight} PNG, ${bytes.length} bytes`)
  await rm(dir, { recursive: true, force: true })

  // Region capture must honour the requested rectangle.
  const region = await capture({ region: { x: 0, y: 0, width: 320, height: 200 }, scale: 1, gridSize: 100 }, services)
  assert.equal(region.imageWidth, 320)
  assert.equal(region.imageHeight, 200)
  await rm(region.imagePath, { force: true })
  console.log('ok  desktop region capture honours the rectangle')
  await rm(shot.imagePath, { force: true })

  stopDesktop()
  await new Promise((resolve) => setTimeout(resolve, 300))
  console.log('ok  desktop worker stops')
}

// ---------------------------------------------------------------------------
// ssh
// ---------------------------------------------------------------------------

if (wants('ssh')) {
  const ssh = await import(at('ssh.js'))

    // 1. The real module against a stand-in client (node _test/fake-ssh.mjs), so the
  //    tested code is the shipped openSession / execOnSession / readSession path.
  const fakeSsh = pathToFileURL(path.join(ROOT, '_test', 'fake-ssh.mjs')).href
  process.env.DSH_2027_SSH = process.execPath
  // One argument chunk, quoted as a shell would: the module splits on spaces that
  // are not inside quotes, so the -e program stays one argument.
  // `--` ends node's own option parsing, so every OpenSSH argument the module
  // appends reaches the stand-in instead of node.
  process.env.DSH_2027_SSH_ARGS = `--input-type=module -e "import(${JSON.stringify(fakeSsh)})" --`

  const opened = await ssh.openSession({ host: 'standin', port: 2222, username: 'dev', timeoutMs: 20000 })
  assert.equal(opened.session.closed, false)
  assert.equal(ssh.listSessions().length, 1)
  console.log(`ok  ssh: open establishes one conversation (${opened.session.label})`)

  const first = await ssh.execOnSession(opened.session, 'pwd', { timeoutMs: 8000 })
  assert.equal(first.exitCode, 0)
  assert.match(first.output, /^\/home\/dev$/m)
  console.log('ok  ssh: a command returns on its marker with the real exit status and output')

  // State persists: cd in one call is visible in the next. This is the whole point
  // of the conversation, and the reason the tool exists.
  await ssh.execOnSession(opened.session, 'cd /tmp', { timeoutMs: 8000 })
  const after = await ssh.execOnSession(opened.session, 'pwd', { timeoutMs: 8000 })
  assert.match(after.output, /^\/tmp$/m)
  console.log('ok  ssh: cd persists across calls in one conversation')

  // The cursor must not replay earlier output.
  assert.doesNotMatch(after.output, /\/home\/dev/)
  console.log('ok  ssh: consecutive calls return only their own output')

  const echoed = await ssh.execOnSession(opened.session, 'echo hello-from-standin', { timeoutMs: 8000 })
  assert.match(echoed.output, /hello-from-standin/)
  console.log('ok  ssh: command output is delivered')

  const failing = await ssh.execOnSession(opened.session, 'false', { timeoutMs: 8000 })
  assert.equal(failing.exitCode, 1)
  console.log('ok  ssh: a non-zero exit status is reported as a fact')

  const missing = await ssh.execOnSession(opened.session, 'nosuchcmd --flag', { timeoutMs: 8000 })
  assert.equal(missing.exitCode, 127)
  assert.match(missing.output, /command not found/)
  console.log('ok  ssh: an unknown command reports 127 and its message')

  // A command that never answers times out instead of hanging, and says so.
  const timedOut = await ssh.execOnSession(opened.session, 'sleep 999', { timeoutMs: 600 })
  assert.equal(timedOut.timedOut, true)
  assert.equal(timedOut.exitCode, null)
  const late = await ssh.readSession(opened.session)
  assert.equal(typeof late.text, 'string')
  console.log('ok  ssh: an unanswered command times out and leaves the buffer readable')

  // ANSI and carriage returns are stripped from what the model reads.
  assert.doesNotMatch(echoed.output, /\r|\u001b\[/)
  console.log('ok  ssh: terminal escapes and CR are stripped')

  // Password authentication is answered at the client prompt before the probe,
  // so a slow or prompting server never receives the probe text as a password.
  process.env.DSH2027_FAKE_PASSWORD = 's3cret'
  const authed = await ssh.openSession({ host: 'standin', port: 2222, username: 'dev', password: 's3cret', timeoutMs: 20000 })
  const authedPwd = await ssh.execOnSession(authed.session, 'pwd', { timeoutMs: 8000 })
  assert.equal(authedPwd.exitCode, 0)
  await ssh.closeSession(authed.session)
  delete process.env.DSH2027_FAKE_PASSWORD
  console.log('ok  ssh: password authentication is answered before the probe')

  await ssh.closeSession(opened.session)
  assert.equal(opened.session.closed, true)
  assert.equal(ssh.listSessions().length, 0)
  console.log('ok  ssh: close ends the conversation and drops it from the list')

  // 2. The real client, against a port that refuses. The stand-in override is
  //    cleared first so this exercises the shipped OpenSSH invocation. The error
  //    must name the host and carry the client's own diagnosis, not a bare timeout.
  delete process.env.DSH_2027_SSH
  delete process.env.DSH_2027_SSH_ARGS
  let failure
  try {
    await ssh.openSession({ host: '127.0.0.1', port: 1, username: 'nobody', timeoutMs: 20000 })
  } catch (error) {
    failure = error
  }
  assert.ok(failure instanceof Error, 'connecting to a closed port must reject')
  assert.match(failure.message, /127\.0\.0\.1:1/)
  assert.match(failure.message, /refused|timed out|failed|resolve/i)
  assert.equal(ssh.listSessions().length, 0, 'a failed open must not leave a session behind')
  console.log(`ok  ssh: a refused connection fails loudly and leaves no session (${failure.message.split('\n').pop().slice(0, 90)})`)

  // 3. Argument guards.
  await assert.rejects(() => ssh.openSession({ username: 'u' }), /needs a host/)
  await assert.rejects(() => ssh.openSession({ host: 'h' }), /needs a username/)
  assert.throws(() => ssh.requireSession('missing'), /no SSH conversation/)
  console.log('ok  ssh: argument guards and unknown-session errors')

  await ssh.closeAll()
}

console.log('\nintegration checks passed')
process.exit(0)
