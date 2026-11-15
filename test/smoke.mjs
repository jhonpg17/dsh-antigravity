// Smoke test for dsh-antigravity. No network, no real agy, no npm install.
// Run from the repo root: node test/smoke.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const failures = []
async function step(label, fn) {
  try {
    await fn()
    console.log(`ok   - ${label}`)
  } catch (err) {
    failures.push({ label, err })
    console.log(`FAIL - ${label}\n       ${err?.stack || err}`)
  }
}

const plugin = await import('../index.js')
const registered = []
const byName = (n) => registered.find((t) => t.name === n)

await step('exports name/inject/apply', () => {
  assert.equal(plugin.name, 'antigravity')
  assert.deepEqual(plugin.inject, ['tools'])
  assert.equal(typeof plugin.apply, 'function')
})

await step('apply registers exactly 4 well-formed tools', () => {
  const ctx = {
    tools: {
      register(def) {
        registered.push(def)
        return () => {}
      },
    },
  }
  plugin.apply(ctx, { agyPath: '/nonexistent/agy' })
  assert.equal(registered.length, 4)
  assert.deepEqual(registered.map((t) => t.name).sort(), ['agy_models', 'agy_run', 'agy_status', 'run_python'])
  for (const t of registered) {
    assert.equal(typeof t.name, 'string')
    assert.ok(typeof t.description === 'string' && t.description.length > 0, `${t.name}.description`)
    assert.equal(t.parameters?.type, 'object', `${t.name}.parameters`)
    assert.equal(typeof t.output?.render, 'function', `${t.name}.output.render`)
    assert.equal(typeof t.output?.schema, 'object', `${t.name}.output.schema`)
    assert.equal(typeof t.execute, 'function', `${t.name}.execute`)
    const rendered = t.output.render({}, { ok: true })
    assert.equal(rendered[0].type, 'text')
  }
})

await step('apply tolerates empty / unknown / invalid config', () => {
  const sink = { tools: { register: () => () => {} } }
  plugin.apply(sink)
  plugin.apply(sink, {})
  plugin.apply(sink, { foo: 1, timeoutSec: 'x', skipPermissions: 'yes', agyPath: 42, defaultEffort: 'ultra' })
})

await step('run_python prints 42', async () => {
  const r = await byName('run_python').execute({ code: 'print(6*7)' }, {})
  assert.equal(r.exitCode, 0, JSON.stringify(r))
  assert.equal(r.stdout.trim(), '42')
  assert.equal(r.ok, true)
})

await step('run_python reports non-zero exit without throwing', async () => {
  const r = await byName('run_python').execute({ code: 'import sys; sys.stderr.write("boom"); sys.exit(3)' }, {})
  assert.equal(r.ok, false)
  assert.equal(r.exitCode, 3)
  assert.match(r.stderr, /boom/)
})

await step('agy_status with missing binary', async () => {
  const r = await byName('agy_status').execute({}, {})
  assert.equal(r.ok, true)
  assert.equal(r.installed, false)
  assert.equal(r.agyPath, '/nonexistent/agy')
  assert.equal(typeof r.authenticated, 'boolean')
  assert.equal(typeof r.credentialsPath, 'string')
})

await step('agy_run with empty prompt throws (invalid argument)', async () => {
  await assert.rejects(() => byName('agy_run').execute({ prompt: '' }, {}), Error)
})

await step('agy_run / agy_models with missing binary return ok:false', async () => {
  const r = await byName('agy_run').execute({ prompt: 'hi' }, {})
  assert.equal(r.ok, false)
  assert.match(r.error, /not found/)
  const m = await byName('agy_models').execute({}, {})
  assert.equal(m.ok, false)
})

// Fake agy (shell script in a temp dir) to exercise parsing, without network.
if (process.platform !== 'win32') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-agy-smoke-'))
  try {
    const fake = path.join(dir, 'agy')
    fs.writeFileSync(
      fake,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo "agy 9.9.9"; exit 0; fi',
        'if [ "$1" = "models" ]; then printf "gemini-x\\tGemini X\\nclaude-y\\tClaude Y\\n\\n"; exit 0; fi',
        'if [ "$1" = "-p" ] && [ "$2" = "sleep" ]; then sleep 5; exit 0; fi',
        'echo "diagnostic on stderr" >&2',
        'echo \'{"status":"SUCCESS","response":"pong","conversationId":"c-1","model":"gemini-x","durationSeconds":1.5,"usage":{"inputTokens":3,"outputTokens":4,"thinkingTokens":1,"totalTokens":8}}\'',
        '',
      ].join('\n'),
      { mode: 0o755 },
    )
    const tools = []
    plugin.apply({ tools: { register: (d) => (tools.push(d), () => {}) } }, { agyPath: fake, cwd: dir })
    const t = (n) => tools.find((x) => x.name === n)

    await step('fake agy: agy_status', async () => {
      const r = await t('agy_status').execute({}, {})
      assert.equal(r.installed, true)
      assert.equal(r.version, 'agy 9.9.9')
    })
    await step('fake agy: agy_models', async () => {
      const r = await t('agy_models').execute({}, {})
      assert.equal(r.ok, true)
      assert.equal(r.count, 2)
      assert.deepEqual(r.models[0], { id: 'gemini-x', name: 'Gemini X' })
    })
    await step('fake agy: agy_run success', async () => {
      const r = await t('agy_run').execute({ prompt: 'ping', effort: 'low' }, {})
      assert.equal(r.ok, true, JSON.stringify(r))
      assert.equal(r.response, 'pong')
      assert.equal(r.conversationId, 'c-1')
      assert.equal(r.usage.totalTokens, 8)
    })
    await step('fake agy: agy_run timeout', async () => {
      const r = await t('agy_run').execute({ prompt: 'sleep', timeoutSec: 1 }, {})
      assert.deepEqual(r, { ok: false, error: 'timeout after 1s' })
    })
    await step('fake agy: agy_run abort', async () => {
      const ac = new AbortController()
      setTimeout(() => ac.abort(), 200)
      const r = await t('agy_run').execute({ prompt: 'sleep' }, { signal: ac.signal })
      assert.deepEqual(r, { ok: false, error: 'aborted' })
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

if (failures.length) {
  console.error(`\nSMOKE FAILED (${failures.length}):`)
  for (const f of failures) console.error(`- ${f.label}: ${f.err?.message || f.err}`)
  process.exit(1)
}
console.log('SMOKE OK')
process.exit(0)
