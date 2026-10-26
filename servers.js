/**
 * Remote-server registry and the local/remote execution target it feeds.
 *
 * One concern: remembering how to reach a machine, and turning that record into
 * the two operations every tool in this bundle needs — run a command, read or
 * write a file. The transport is the system OpenSSH client for a remote server
 * and PowerShell for this machine, so nothing here speaks a protocol itself; it
 * only decides *which* transport, with what arguments, and refuses to guess when
 * the user has not said which machine a tool call meant.
 *
 * Storage: one JSON file inside the profile directory. It is deliberately not a
 * Session event — server credentials outlive any one conversation, and a
 * password must not land in a Session log where the model would read it back.
 *
 * @module @local/dsh-deepseek-2027/servers
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Target id meaning "this machine", always present and never removable. */
export const LOCAL_TARGET = 'local'

/**
 * The operations a tool may perform. A target carries the subset it allows;
 * an empty set means "no restriction was configured" rather than "nothing".
 */
export const OPERATIONS = ['read', 'write', 'exec']

/** Operations every target allows when the user never opened the settings page. */
const DEFAULT_OPERATIONS = [...OPERATIONS]

/**
 * Absolute path of the registry file for one profile directory.
 * @param {string} profileDir - the profile root.
 * @returns {string} the JSON file path.
 */
export function registryPath(profileDir) {
  return join(profileDir, 'deepseek-2027-servers.json')
}

/**
 * Coerce one stored operations value.
 *
 * Unknown names are dropped and duplicates collapse, so a hand-edited file that
 * grew a typo loses that permission instead of silently granting it. An empty
 * result is widened to every operation: the settings page renders an unchecked
 * box as "not chosen", and the safe reading of an all-unchecked target is the
 * default set, not a target that can do nothing.
 *
 * @param {unknown} value - stored operations.
 * @returns {string[]} the normalized operations.
 */
function normalizeOperations(value) {
  if (!Array.isArray(value)) return [...DEFAULT_OPERATIONS]
  const kept = OPERATIONS.filter((operation) => value.includes(operation))
  return kept.length === 0 ? [...DEFAULT_OPERATIONS] : kept
}

/**
 * Validate and normalize one stored server record.
 *
 * Throws on a record that cannot be identified or addressed: a registry that
 * half-loads would otherwise offer a target whose connection fails for a reason
 * the user cannot see.
 *
 * @param {unknown} value - one stored record.
 * @returns {object} the normalized record.
 */
function normalizeServer(value) {
  if (typeof value !== 'object' || value === null) throw new TypeError('server entry must be an object')
  const host = String(value.host ?? '').trim()
  if (host === '') throw new TypeError('server entry needs a host')
  const username = String(value.username ?? '').trim()
  if (username === '') throw new TypeError('server entry needs a username')
  const port = Number(value.port ?? 22)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError(`server "${host}" has an invalid port ${JSON.stringify(value.port)}`)
  }
  const id = String(value.id ?? '').trim() || randomUUID()
  return {
    id,
    name: String(value.name ?? '').trim() || `${username}@${host}`,
    host,
    port,
    username,
    password: typeof value.password === 'string' ? value.password : '',
    identityFile: String(value.identityFile ?? '').trim(),
    operations: normalizeOperations(value.operations),
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
  }
}

/**
 * Read the registry file.
 *
 * A missing file is an empty registry — first run — while an unreadable or
 * malformed one is reported to the caller instead of being replaced: silently
 * discarding a saved password because the file had a stray comma would be worse
 * than refusing to start.
 *
 * @param {string} profileDir - the profile root.
 * @returns {Promise<object[]>} the stored servers.
 */
export async function loadServers(profileDir) {
  let text
  try {
    text = await readFile(registryPath(profileDir), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`cannot read the server registry at ${registryPath(profileDir)}: ${error?.message ?? error}`)
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.servers) ? parsed.servers : []
  return list.map(normalizeServer)
}

/**
 * Replace the registry file atomically enough for a single-process owner.
 * @param {string} profileDir - the profile root.
 * @param {object[]} servers - the full list to persist.
 * @returns {Promise<void>} resolves once the bytes are written.
 */
export async function saveServers(profileDir, servers) {
  const path = registryPath(profileDir)
  await mkdir(dirname(path), { recursive: true })
  const body = JSON.stringify({ version: 1, servers }, null, 2)
  await writeFile(path, `${body}\n`, 'utf8')
}

/**
 * Insert or replace one server, keyed by id.
 * @param {string} profileDir - the profile root.
 * @param {object} input - the record to store.
 * @returns {Promise<object>} the stored record.
 */
export async function upsertServer(profileDir, input) {
  const normalized = normalizeServer({ ...input, id: String(input?.id ?? '').trim() || randomUUID() })
  const existing = await loadServers(profileDir)
  const index = existing.findIndex((server) => server.id === normalized.id)
  if (index >= 0) existing[index] = { ...normalized, createdAt: existing[index].createdAt }
  else existing.push(normalized)
  await saveServers(profileDir, existing)
  return index >= 0 ? existing[index] : normalized
}

/**
 * Remove one server by id.
 * @param {string} profileDir - the profile root.
 * @param {string} id - the record id.
 * @returns {Promise<boolean>} whether a record was removed.
 */
export async function deleteServer(profileDir, id) {
  const existing = await loadServers(profileDir)
  const next = existing.filter((server) => server.id !== id)
  if (next.length === existing.length) return false
  await saveServers(profileDir, next)
  return true
}

/**
 * Absolute path of the file holding the default-target choice.
 *
 * Kept beside the registry rather than inside it so that deleting every server
 * cannot silently reset which machine the tools were pointed at.
 *
 * @param {string} profileDir - the profile root.
 * @returns {string} the JSON file path.
 */
export function defaultsPath(profileDir) {
  return join(profileDir, 'deepseek-2027-target.json')
}

/**
 * Read the default-target choice.
 *
 * A missing or unreadable file means "this machine": the tools must have a
 * defined target on first run, and local is the only choice that cannot fail
 * because a connection is down.
 *
 * @param {string} profileDir - the profile root.
 * @returns {Promise<{ defaultTarget: string }>} the stored defaults.
 */
export async function loadDefaults(profileDir) {
  let text
  try {
    text = await readFile(defaultsPath(profileDir), 'utf8')
  } catch {
    return { defaultTarget: LOCAL_TARGET }
  }
  try {
    const parsed = JSON.parse(text)
    const wanted = String(parsed?.defaultTarget ?? '').trim()
    return { defaultTarget: wanted === '' ? LOCAL_TARGET : wanted }
  } catch {
    return { defaultTarget: LOCAL_TARGET }
  }
}

/**
 * Persist the default-target choice.
 * @param {string} profileDir - the profile root.
 * @param {{ defaultTarget?: string }} input - the choice; `local` clears it.
 * @returns {Promise<{ defaultTarget: string }>} the stored defaults.
 */
export async function saveDefaults(profileDir, input) {
  const wanted = String(input?.defaultTarget ?? '').trim() || LOCAL_TARGET
  const path = defaultsPath(profileDir)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify({ version: 1, defaultTarget: wanted }, null, 2)}\n`, 'utf8')
  return { defaultTarget: wanted }
}

/**
 * Describe the local target.
 *
 * It is synthesized rather than stored: "this machine" cannot be deleted or
 * pointed somewhere else, and its operations are always all of them — the
 * profile's own file policy is the thing that governs what a tool may do here.
 *
 * @returns {object} the local target record.
 */
export function localTarget() {
  return {
    id: LOCAL_TARGET,
    name: '本机',
    kind: 'local',
    host: '127.0.0.1',
    port: 0,
    username: '',
    password: '',
    identityFile: '',
    operations: [...OPERATIONS],
    createdAt: '',
  }
}

/**
 * Resolve a tool call's target reference onto a stored record.
 *
 * Three shapes are accepted so a tool description can stay honest: an omitted
 * reference means the configured default, `local` names this machine, and
 * anything else is a server id. A reference that names no stored server throws
 * rather than falling back to this machine — silently running a remote-intended
 * command locally is the one mistake this registry exists to prevent.
 *
 * @param {string} profileDir - the profile root.
 * @param {string | undefined} reference - the tool's target argument.
 * @param {string} configuredDefault - the settings page's default target id.
 * @returns {Promise<object>} the target record.
 */
export async function resolveTarget(profileDir, reference, configuredDefault = LOCAL_TARGET) {
  const wanted = String(reference ?? '').trim() || String(configuredDefault ?? '').trim() || LOCAL_TARGET
  if (wanted === LOCAL_TARGET) return localTarget()
  const servers = await loadServers(profileDir)
  const found = servers.find((server) => server.id === wanted)
  if (found !== undefined) return found
  const byName = servers.find((server) => server.name === wanted)
  if (byName !== undefined) return byName
  const known = servers.map((server) => server.name).join('、')
  throw new Error(
    wanted === ''
      ? '没有配置默认执行目标：请在设置里选择「本机」或一台远程服务器。'
      : `未知执行目标 "${wanted}"。已配置：本机${known === '' ? '' : `、${known}`}。`,
  )
}

/**
 * Refuse an operation the chosen target does not allow.
 * @param {object} target - the resolved target.
 * @param {string} operation - one of {@link OPERATIONS}.
 * @returns {void} throws when the target forbids it.
 */
export function assertOperation(target, operation) {
  const allowed = Array.isArray(target.operations) ? target.operations : DEFAULT_OPERATIONS
  if (!allowed.includes(operation)) {
    throw new Error(`执行目标「${target.name}」未开启「${operation}」操作；请在设置里勾选它。`)
  }
}

/**
 * Reject a path that escapes the target's working root.
 *
 * Both transports concatenate a path onto a base directory, so a relative path
 * is the only form whose meaning is unambiguous across them. An absolute path is
 * accepted only when it already sits under the root, which keeps "write this
 * file in the project" working while refusing `C:\Windows\...` from a tool call
 * that named no root.
 *
 * @param {string} root - the target's working root.
 * @param {string} candidate - the requested path.
 * @returns {string} the path to use, rooted and normalized with forward slashes.
 */
export function resolvePath(root, candidate) {
  const raw = String(candidate ?? '').trim()
  if (raw === '') throw new Error('需要一个文件路径')
  const base = String(root ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  const normalized = raw.replace(/\\/g, '/')
  const absolute = /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('/')
  if (!absolute) return base === '' ? normalized : `${base}/${normalized}`.replace(/\/+/g, '/')
  if (base === '') return normalized
  const lowerBase = base.toLowerCase()
  const lowerPath = normalized.toLowerCase()
  if (lowerPath === lowerBase || lowerPath.startsWith(`${lowerBase}/`)) return normalized
  throw new Error(`路径 "${raw}" 不在执行目标的根目录 "${base}" 之下`)
}
