/**
 * DeepSeek 2027 Plan — full desktop control.
 *
 * A single long-lived PowerShell worker owns the Win32 interop; compiling it
 * costs about nine seconds, so doing it per action would make every call
 * unusable. The worker is spawned once and then serves actions in milliseconds.
 *
 * Integer integrity is deliberate. Windows UIPI blocks input injection from a
 * higher-integrity process into ordinary applications, so an elevated sender
 * appears to succeed while nothing reaches the target window. Administrator
 * *commands* therefore use the elevated runner in `admin.js`; desktop input uses
 * the user's own token. Both are exposed under `dev_admin` vs `dev_desktop` so
 * the model can tell which environment it is in.
 *
 * Screenshots are persisted through the attachments service and returned inline
 * as an image block, so the model observes the desktop directly instead of being
 * handed a path it cannot open.
 *
 * @module @local/dsh-deepseek-2027/desktop
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where this module lives, so the worker script can be found beside it. */
const HERE = path.dirname(fileURLToPath(import.meta.url))

/** The Win32 worker. */
const WORKER = path.join(HERE, 'dev-desktop.ps1')

/** PowerShell host for the worker. Windows PowerShell has the WinForms assemblies. */
const POWERSHELL = process.env.DSH_2027_POWERSHELL || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32\\WindowsPowerShell\\v1.0\\powershell.exe')

/** Temp screenshots older than this are swept on the next capture. */
const SHOT_MAX_AGE_MS = 15 * 60 * 1000

/** How long the worker may take to compile its interop the first time. */
const READY_TIMEOUT_MS = 90_000

/** Where screenshots are staged before they become attachments. */
const SHOT_DIR = path.join(tmpdir(), 'dsh-2027-shots')

/** @type {import('node:child_process').ChildProcess | null} */
let worker = null
/** @type {Promise<object> | null} */
let ready = null
let nextId = 1
/** @type {Map<number, { resolve: (value: object) => void, reject: (error: Error) => void, timer: ReturnType<typeof setTimeout> }>} */
const pending = new Map()

/**
 * Spawn the worker if needed and resolve once it reports that interop compiled.
 * @returns {Promise<object>} the worker's readiness payload.
 */
export function ensureDesktop() {
  if (worker !== null && !worker.killed && worker.exitCode === null) return ready ?? Promise.resolve({ ready: true })

  const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WORKER], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  worker = child
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  let buffer = ''
  ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the desktop worker did not become ready in time')), READY_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (line === '') continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.ready === true) {
          clearTimeout(timer)
          resolve(message)
          continue
        }
        const waiter = pending.get(message.id)
        if (waiter === undefined) continue
        pending.delete(message.id)
        clearTimeout(waiter.timer)
        if (message.ok === false) waiter.reject(new Error(String(message.error ?? 'desktop action failed')))
        else waiter.resolve(message)
      }
    })
    child.stderr.on('data', (chunk) => {
      // The worker writes real failures here; keep the tail for the first error.
      buffer += ''
      lastStderr = (lastStderr + chunk).slice(-4000)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      for (const [, waiter] of pending) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error(`the desktop worker exited with code ${code}${lastStderr === '' ? '' : `: ${lastStderr.trim()}`}`))
      }
      pending.clear()
      worker = null
      ready = null
      reject(new Error(`the desktop worker exited with code ${code}`))
    })
  })
  // A rejected readiness promise would surface as an unhandled rejection when
  // nobody is awaiting it yet; the next call re-awaits the same `ready`.
  ready.catch(() => {})
  return ready
}

let lastStderr = ''

/**
 * Send one action to the worker and await its answer.
 * @param {object} request - the action payload; `id` is assigned here.
 * @returns {Promise<object>} the worker's result.
 */
export async function desktopRequest(request) {
  await ensureDesktop()
  const child = worker
  if (child === null || child.stdin === null) throw new Error('the desktop worker is not running')
  const id = nextId++
  const payload = { ...request, id }
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`desktop action "${request.action}" timed out`))
    }, 120_000)
    pending.set(id, { resolve, reject, timer })
    child.stdin.write(`${JSON.stringify(payload)}\n`)
  })
}

/** Stop the worker and fail anything still waiting on it. */
export function stopDesktop() {
  if (worker === null) return
  const child = worker
  worker = null
  ready = null
  try {
    child.stdin?.end()
    child.kill()
  } catch {
    /* already gone */
  }
}

/** Sweep screenshots that no longer matter. */
async function sweepShots() {
  try {
    const now = Date.now()
    for (const entry of await readdir(SHOT_DIR)) {
      const file = path.join(SHOT_DIR, entry)
      const info = await stat(file).catch(() => null)
      if (info && now - info.mtimeMs > SHOT_MAX_AGE_MS) await unlink(file).catch(() => {})
    }
  } catch {
    /* the directory may not exist yet */
  }
}

/**
 * Capture the desktop and turn it into an attachment the model can see.
 *
 * @param {object} args - capture options.
 * @param {object} services - the resolved Harness services.
 * @returns {Promise<object>} capture metadata plus the attachment reference.
 */
export async function capture(args, services) {
  await mkdir(SHOT_DIR, { recursive: true })
  void sweepShots()

  const file = path.join(SHOT_DIR, `shot-${Date.now()}-${process.pid}.png`)
  const region = args.region ?? {}
  const mark = args.mark ?? {}
  const scale = typeof args.scale === 'number' && args.scale > 0 ? args.scale : 1

  const result = await desktopRequest({
    action: 'shot',
    out: file,
    x: region.x ?? -1,
    y: region.y ?? -1,
    width: region.width ?? 0,
    height: region.height ?? 0,
    gridSize: args.gridSize ?? 100,
    crossX: mark.x ?? -999999,
    crossY: mark.y ?? -999999,
    scale,
  })

  const origin = result.origin ?? { x: 0, y: 0 }
  const sourceWidth = result.sourceWidth || result.width
  const sourceHeight = result.sourceHeight || result.height
  let attachment = null
  let imagePath = null
  try {
    const bytes = await readFile(file)
    const attachments = services.attachments
    if (attachments !== undefined && typeof attachments.saveImage === 'function') {
      attachment = await attachments.saveImage({
        data: bytes,
        mediaType: 'image/png',
        name: path.basename(file),
      })
      await unlink(file).catch(() => {})
    } else {
      imagePath = file
    }
  } catch (error) {
    imagePath = file
    console.error('[deepseek-2027] could not persist the screenshot:', error?.message ?? error)
  }

  const finalWidth = attachment?.width || result.width
  const finalHeight = attachment?.height || result.height
  const rawRatio = finalWidth / sourceWidth
  const ratio = Number.isFinite(rawRatio) && rawRatio > 0 ? rawRatio : result.scale || 1
  const shown = Math.round(ratio * 10000) / 10000

  return {
    action: 'screenshot',
    imageWidth: finalWidth,
    imageHeight: finalHeight,
    imagePixelsPerScreenPixel: shown,
    ...result,
    image: attachment,
    imagePath,
    summary:
      `Captured a ${sourceWidth}x${sourceHeight} screen area at origin (${origin.x}, ${origin.y}); ` +
      `the image is ${finalWidth}x${finalHeight}, grid every ${result.grid}px. ` +
      `Convert with: screen = (${origin.x}, ${origin.y}) + imagePixel / ${shown}.` +
      (attachment ? '' : imagePath ? ` Screenshot kept at ${imagePath}.` : ''),
  }
}
