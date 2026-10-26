/**
 * Local harness for validating the DeepSeek 2027 tool definitions and level
 * mapping against the real `@deepseek-ai/dsh-tools` schema compiler.
 *
 * This file is not part of the installed bundle: it exists so the authoring
 * machine can prove that every parameter and output schema the plugin hands to
 * the registry is accepted by the raw-subset checker, and that a level maps onto
 * a route's advertised efforts the way the request waterfall assumes.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.argv[2]
if (!ROOT) throw new Error('usage: node schema-check.mjs <bundle-directory>')

/** Resolve a bundle file the way ESM needs it on Windows. */
const at = (name) => pathToFileURL(path.join(ROOT, name)).href

const tools = await import('@deepseek-ai/dsh-tools')

// The toolset registers through a fake context so the real definitions can be
// captured; nothing here touches a live Host.
const registered = []
const sections = []
const fakeCtx = {
  get: () => undefined,
  effect: (factory) => factory(),
  on: () => () => {},
  tools: { register: (definition) => { registered.push(definition); return () => {} } },
  systemPrompt: {
    getSectionOrder: () => 100,
    section: (section) => { sections.push(section); return () => {} },
  },
  inject: (_names, callback) => callback(fakeCtx),
  logger: { warn() {}, info() {} },
}

const developer = await import(at('developer.js'))
developer.apply(fakeCtx, { adminEnabled: true, desktopEnabled: true, sshEnabled: true, manual: true })

assert.equal(registered.length, 3, `expected three tools, got ${registered.length}`)
assert.ok(sections.length >= 1, 'the operating manual section must be registered')

for (const definition of registered) {
  // The registry's own contract checks.
  assert.equal(typeof definition.output.render, 'function', `${definition.name} needs output.render`)
  tools.assertSupportedJsonSchema(definition.parameters)
  tools.assertSupportedJsonSchema(definition.output.schema)
  // The registry snapshots and validates output against this schema; an open
  // object accepts the fields the renderers read.
  const schema = definition.parameters
  assert.equal(schema.type, 'object')
  assert.ok(Array.isArray(schema.required) && schema.required.length > 0, `${definition.name} must require its primary selector`)
  const violations = tools.validateJsonSchemaValue(definition.parameters, {})
  assert.ok(violations.length > 0, `${definition.name} must reject an empty call`)
  console.log(`ok  ${definition.name}: parameters and output schema accepted, empty call rejected`)
}

// A representative call per tool must satisfy the schema.
assert.deepEqual(tools.validateJsonSchemaValue(registered[0].parameters, { argv: ['cmd.exe', '/c', 'ver'] }), [])
assert.deepEqual(tools.validateJsonSchemaValue(registered[1].parameters, { action: 'screenshot' }), [])
assert.deepEqual(tools.validateJsonSchemaValue(registered[2].parameters, { action: 'open', host: 'h', username: 'u' }), [])
console.log('ok  representative calls validate')

const levels = await import(at('levels.js'))
assert.equal(levels.LEVELS.length, 10)
assert.equal(levels.MIN_LEVEL, 1)
assert.equal(levels.MAX_LEVEL, 10)
// Levels must map onto an advertised ladder without ever asking for an
// out-of-range effort; `resolveCallConfig` rejects an unsupported explicit one.
const efforts = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
for (let level = 1; level <= 10; level += 1) {
  const chosen = levels.effortFor(level, efforts)
  assert.ok(efforts.includes(chosen), `level ${level} chose ${chosen}, which the route does not advertise`)
}
assert.equal(levels.effortFor(1, efforts), 'off')
assert.equal(levels.effortFor(10, efforts), 'max')
assert.equal(levels.effortFor(5, undefined), undefined)
assert.equal(levels.effortFor(5, []), undefined)
assert.equal(levels.clampLevel(0), 1)
assert.equal(levels.clampLevel(99), 10)
assert.equal(levels.clampLevel('x'), levels.DEFAULT_LEVEL)
console.log('ok  ten levels map onto every advertised ladder shape')

// The mechanical half of the boost must grow with the level and never exceed the
// ceiling: a rejected oversized budget costs far more than a capped one.
let previousFactor = 0
for (let level = 1; level <= 10; level += 1) {
  const intensity = levels.intensityOf(level)
  assert.ok(intensity.maxTokensFactor >= previousFactor, `level ${level} spends less budget than level ${level - 1}`)
  previousFactor = intensity.maxTokensFactor
  assert.ok(intensity.reservedThinking >= 0 && intensity.reservedThinking <= 1)
  assert.ok(Number.isInteger(intensity.reviewRounds) && intensity.reviewRounds >= 0)
}
const l10 = levels.intensityOf(10)
assert.ok(l10.maxTokensFactor >= 4, 'L10 must multiply the output budget substantially')
assert.ok(l10.reviewRounds >= 4, 'L10 must grant at least four review rounds')
assert.equal(l10.allowContinuation, true)
assert.ok(levels.intensityOf(1).maxTokensFactor === 1, 'L1 must not inflate the budget')

const budget = levels.maxTokensFor(10, 8192, 65_536)
assert.ok(budget > 8192 && budget <= 65_536, `L10 budget ${budget} must be raised and capped`)
assert.equal(levels.maxTokensFor(10, 8192, 20_000), 20_000, 'the ceiling wins over the multiplier')
assert.equal(levels.maxTokensFor(1, 8192), undefined, 'a plain level leaves the route budget alone')
assert.equal(levels.maxTokensFor(10, undefined), undefined, 'an unknown base budget stays unknown')
console.log('ok  the level boost raises budget and rounds monotonically, inside the ceiling')

// The top level's protocol must actually carry the long-think discipline, not just
// name a level: the phases, the audit labels, and the continuation rule.
const top = levels.levelOf(10).protocol
for (const marker of ['Phase 1 — Frame', 'Phase 2 — Hypothesise', 'Phase 3 — Derive', 'Phase 4 — Falsify', 'Phase 5 — Converge', 'Phase 6 — Audit', 'verified', 'derived', 'assumed', 'Continuation rule']) {
  assert.ok(top.includes(marker), `L10 protocol must state ${JSON.stringify(marker)}`)
}
assert.ok(top.length > 2500, 'L10 protocol must be a full long-think brief')
console.log(`ok  L10 protocol carries the six-phase long think (${top.length} characters)`)

// The host plugin must import without touching a live registry.
const host = await import(at('index.js'))
assert.equal(typeof host.apply, 'function')
assert.ok(host.inject.includes('systemPrompt'))
assert.equal(host.THINK_COMMAND, 'think')
assert.equal(host.REINJECT_COMMAND, 'deepseek2027')
console.log('ok  host plugin imports and declares its dependency')

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
assert.equal(pkg.type, 'module')
assert.ok(pkg.dsh?.bundle?.patch === './cordis.patch.yml')
assert.ok(pkg.dsh?.client?.platform === 'web')
for (const file of ['index.js', 'levels.js', 'admin.js', 'desktop.js', 'ssh.js', 'developer.js', 'client.js', 'dev-exec.ps1', 'dev-desktop.ps1', 'cordis.patch.yml', 'icon.svg']) {
  assert.ok(pkg.files.includes(file), `files must ship ${file}`)
}
console.log('ok  package manifest ships every runtime file')

console.log('\nall checks passed')
