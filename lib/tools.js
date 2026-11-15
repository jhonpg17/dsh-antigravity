// Tool definitions for dsh-antigravity. Each factory receives the resolved
// config and returns the plain object passed to ctx.tools.register().
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  EFFORTS,
  MODES,
  expandHome,
  parseJsonLoose,
  resolveConfig,
  runProcess,
  tail,
  truncate,
} from './agy.js'

const STDERR_TAIL = 2000
const PY_STDOUT_MAX = 20000
const PY_STDERR_MAX = 4000

function render(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function optString(args, key) {
  const v = args[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new TypeError(`${key} must be a string`)
  const t = v.trim()
  return t === '' ? undefined : t
}

function optEnum(args, key, values) {
  const v = optString(args, key)
  if (v === undefined) return undefined
  if (!values.includes(v)) throw new TypeError(`${key} must be one of: ${values.join(', ')}`)
  return v
}

function optInt(args, key, min, max) {
  const v = args[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new TypeError(`${key} must be an integer between ${min} and ${max}`)
  }
  return v
}

function optBool(args, key) {
  const v = args[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'boolean') throw new TypeError(`${key} must be a boolean`)
  return v
}

function resolveCwd(base, cwd) {
  return cwd ? path.resolve(base, expandHome(cwd)) : base
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function isExecutable(p) {
  try {
    if (!fs.statSync(p).isFile()) return false
    fs.accessSync(p, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function num(...vals) {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  }
  return 0
}

function str(...vals) {
  for (const v of vals) if (typeof v === 'string' && v !== '') return v
  return ''
}

function processFailure(r, what) {
  if (r.aborted) return 'aborted'
  if (r.error && r.error !== 'timeout') return r.error
  if (r.signal) return `${what} killed by ${r.signal}`
  return `${what} exited with code ${r.code}`
}

/** Normalise agy's `--output-format json` payload. */
function normalizeRun(parsed, fallbackModel) {
  const p = isObj(parsed) ? parsed : {}
  const u = isObj(p.usage) ? p.usage : isObj(p.stats) ? p.stats : isObj(p.tokens) ? p.tokens : {}
  const inputTokens = num(u.inputTokens, u.input_tokens, u.promptTokens, u.prompt_tokens)
  const outputTokens = num(u.outputTokens, u.output_tokens, u.completionTokens, u.completion_tokens)
  const thinkingTokens = num(u.thinkingTokens, u.thinking_tokens, u.reasoningTokens, u.reasoning_tokens)
  const totalTokens =
    num(u.totalTokens, u.total_tokens) || inputTokens + outputTokens + thinkingTokens
  let durationSeconds = num(p.durationSeconds, p.duration_seconds)
  if (!durationSeconds) {
    const ms = num(p.durationMs, p.duration_ms)
    if (ms) durationSeconds = ms / 1000
  }
  let response = p.response ?? p.result ?? p.text ?? p.output ?? p.message ?? ''
  if (typeof response !== 'string') response = JSON.stringify(response)
  return {
    status: str(p.status, p.state).toUpperCase(),
    error: str(p.error?.message, typeof p.error === 'string' ? p.error : ''),
    response,
    conversationId: str(p.conversationId, p.conversation_id, p.sessionId, p.session_id, p.id),
    model: str(p.model, p.modelId, p.model_id, fallbackModel),
    durationSeconds,
    usage: { inputTokens, outputTokens, thinkingTokens, totalTokens },
  }
}

const errorProps = {
  ok: { type: 'boolean' },
  error: { type: 'string' },
}

// ---------------------------------------------------------------------------
// agy_run
// ---------------------------------------------------------------------------
export function agyRunTool(config) {
  const cfg = resolveConfig(config)
  return {
    name: 'agy_run',
    description:
      'Delegate a complete task to the Google Antigravity agent (agy CLI) in headless mode and return its final answer. ' +
      'The agent can read and edit files and run commands inside `cwd`. Use it for self-contained tasks; ' +
      'include all the context it needs in `prompt`. Returns { ok, response, conversationId, model, usage } or { ok: false, error }.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Full task description for the Antigravity agent.' },
        model: { type: 'string', description: 'Model id (see agy_models). Defaults to the configured/agy default.' },
        effort: { type: 'string', enum: [...EFFORTS], description: 'Reasoning effort.' },
        mode: { type: 'string', enum: [...MODES], description: 'Agent permission mode.' },
        cwd: { type: 'string', description: 'Working directory for the agent. Defaults to the configured cwd.' },
        skipPermissions: {
          type: 'boolean',
          description: 'Pass --dangerously-skip-permissions (default from config, normally true).',
        },
        timeoutSec: { type: 'integer', description: 'Timeout in seconds (1-3600). Default from config.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ...errorProps,
          status: { type: 'string' },
          response: { type: 'string' },
          conversationId: { type: 'string' },
          model: { type: 'string' },
          durationSeconds: { type: 'number' },
          usage: {
            type: 'object',
            properties: {
              inputTokens: { type: 'number' },
              outputTokens: { type: 'number' },
              thinkingTokens: { type: 'number' },
              totalTokens: { type: 'number' },
            },
          },
          stderrTail: { type: 'string' },
        },
        required: ['ok'],
      },
      render,
    },
    timeoutMs: 3600 * 1000 + 60 * 1000,
    async execute(args, exec = {}) {
      const a = isObj(args) ? args : {}
      if (typeof a.prompt !== 'string' || a.prompt.trim() === '') {
        throw new Error('agy_run: `prompt` must be a non-empty string')
      }
      const model = optString(a, 'model') ?? (cfg.defaultModel || undefined)
      const effort = optEnum(a, 'effort', EFFORTS) ?? (cfg.defaultEffort || undefined)
      const mode = optEnum(a, 'mode', MODES)
      const skip = optBool(a, 'skipPermissions') ?? cfg.skipPermissions
      const timeoutSec = optInt(a, 'timeoutSec', 1, 3600) ?? cfg.timeoutSec
      const cwd = resolveCwd(cfg.cwd, optString(a, 'cwd'))

      if (!isDir(cwd)) return { ok: false, error: `cwd is not a directory: ${cwd}`, stderrTail: '' }
      if (!isExecutable(cfg.agyPath)) {
        return { ok: false, error: `agy not found or not executable: ${cfg.agyPath}`, stderrTail: '' }
      }

      const argv = [cfg.agyPath, '-p', a.prompt, '--output-format', 'json']
      if (model) argv.push('--model', model)
      if (effort) argv.push('--effort', effort)
      if (mode) argv.push('--mode', mode)
      if (skip) argv.push('--dangerously-skip-permissions')

      const started = Date.now()
      const r = await runProcess(argv, {
        cwd,
        timeoutMs: timeoutSec * 1000,
        signal: exec?.signal,
        env: { ...process.env, NO_COLOR: '1' },
      })
      const stderrTail = tail(r.stderr, STDERR_TAIL)

      if (r.aborted) return { ok: false, error: 'aborted' }
      if (r.timedOut) return { ok: false, error: `timeout after ${timeoutSec}s` }

      const parsed = parseJsonLoose(r.stdout)
      if (r.code !== 0 || r.error) {
        const n = parsed !== undefined ? normalizeRun(parsed, model) : null
        return { ok: false, error: n?.error || processFailure(r, 'agy'), stderrTail }
      }
      if (parsed === undefined) {
        return {
          ok: false,
          error: r.stdout.trim() ? 'could not parse agy JSON output' : 'agy produced no output',
          stderrTail: stderrTail || tail(r.stdout, STDERR_TAIL),
        }
      }
      const n = normalizeRun(parsed, model)
      if (n.status && n.status !== 'SUCCESS') {
        return { ok: false, error: n.error || `agy status ${n.status}`, stderrTail }
      }
      return {
        ok: true,
        status: 'SUCCESS',
        response: n.response,
        conversationId: n.conversationId,
        model: n.model,
        durationSeconds: n.durationSeconds || Math.round((Date.now() - started) / 100) / 10,
        usage: n.usage,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// agy_models
// ---------------------------------------------------------------------------
export function parseModels(raw) {
  const models = []
  const seen = new Set()
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const l = line.trim()
    if (!l) continue
    let id
    let name
    if (l.includes('\t')) {
      const [a, ...rest] = l.split('\t')
      id = a.trim()
      name = rest.join(' ').trim() || id
    } else if (/^[\w.\-/:@]+$/.test(l)) {
      id = l
      name = l
    } else {
      continue
    }
    if (!id || seen.has(id)) continue
    seen.add(id)
    models.push({ id, name })
  }
  return models
}

export function agyModelsTool(config) {
  const cfg = resolveConfig(config)
  return {
    name: 'agy_models',
    description:
      'List the models available to the Google Antigravity CLI (agy). Use the returned `id` as `model` in agy_run.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          ...errorProps,
          count: { type: 'integer' },
          models: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, name: { type: 'string' } },
              required: ['id', 'name'],
            },
          },
          raw: { type: 'string' },
        },
        required: ['ok'],
      },
      render,
    },
    timeoutMs: 90 * 1000,
    async execute(_args, exec = {}) {
      if (!isExecutable(cfg.agyPath)) {
        return { ok: false, error: `agy not found or not executable: ${cfg.agyPath}`, raw: '' }
      }
      const r = await runProcess([cfg.agyPath, 'models'], {
        cwd: isDir(cfg.cwd) ? cfg.cwd : os.homedir(),
        timeoutMs: 60 * 1000,
        signal: exec?.signal,
        env: { ...process.env, NO_COLOR: '1' },
      })
      const raw = truncate(r.stdout, PY_STDOUT_MAX)
      if (r.aborted) return { ok: false, error: 'aborted', raw }
      if (r.timedOut) return { ok: false, error: 'timeout after 60s', raw }
      if (r.code !== 0 || r.error) {
        return { ok: false, error: processFailure(r, 'agy models'), raw: raw || tail(r.stderr, STDERR_TAIL) }
      }
      const models = parseModels(r.stdout)
      return { ok: true, count: models.length, models, raw }
    },
  }
}

// ---------------------------------------------------------------------------
// agy_status
// ---------------------------------------------------------------------------
export function agyStatusTool(config) {
  const cfg = resolveConfig(config)
  return {
    name: 'agy_status',
    description:
      'Check the Google Antigravity CLI installation: whether the agy binary exists and is executable, its version, ' +
      'and whether OAuth credentials are stored.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          ...errorProps,
          installed: { type: 'boolean' },
          version: { type: 'string' },
          authenticated: { type: 'boolean' },
          agyPath: { type: 'string' },
          credentialsPath: { type: 'string' },
        },
        required: ['ok'],
      },
      render,
    },
    timeoutMs: 20 * 1000,
    async execute(_args, exec = {}) {
      const credentialsPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
      let authenticated = false
      try {
        authenticated = fs.statSync(credentialsPath).isFile()
      } catch {}
      const installed = isExecutable(cfg.agyPath)
      let version = ''
      if (installed) {
        const r = await runProcess([cfg.agyPath, '--version'], {
          cwd: os.homedir(),
          timeoutMs: 12 * 1000,
          signal: exec?.signal,
          env: { ...process.env, NO_COLOR: '1' },
        })
        if (r.aborted) return { ok: false, error: 'aborted' }
        const firstLine = (s) => (s || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || ''
        version = firstLine(r.stdout) || (r.code === 0 ? firstLine(r.stderr) : '')
      }
      return { ok: true, installed, version, authenticated, agyPath: cfg.agyPath, credentialsPath }
    },
  }
}

// ---------------------------------------------------------------------------
// run_python
// ---------------------------------------------------------------------------
export function runPythonTool(config) {
  const cfg = resolveConfig(config)
  return {
    name: 'run_python',
    description:
      'Run a Python 3 snippet with `python3 -I` (isolated mode) and return exit code, stdout and stderr. ' +
      'Print what you want to see. stdout is truncated to 20000 chars and stderr to 4000.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Python source code to execute.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to the configured cwd.' },
        timeoutSec: { type: 'integer', description: 'Timeout in seconds (1-600, default 60).' },
      },
      required: ['code'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ...errorProps,
          exitCode: { type: 'integer' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
        },
        required: ['ok'],
      },
      render,
    },
    timeoutMs: 600 * 1000 + 30 * 1000,
    async execute(args, exec = {}) {
      const a = isObj(args) ? args : {}
      if (typeof a.code !== 'string' || a.code.trim() === '') {
        throw new Error('run_python: `code` must be a non-empty string')
      }
      const timeoutSec = optInt(a, 'timeoutSec', 1, 600) ?? 60
      const cwd = resolveCwd(cfg.cwd, optString(a, 'cwd'))
      if (!isDir(cwd)) {
        return { ok: false, error: `cwd is not a directory: ${cwd}`, exitCode: -1, stdout: '', stderr: '' }
      }

      let dir
      try {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-agy-py-'))
        const file = path.join(dir, 'snippet.py')
        fs.writeFileSync(file, a.code, 'utf8')
        const r = await runProcess(['python3', '-I', file], {
          cwd,
          timeoutMs: timeoutSec * 1000,
          signal: exec?.signal,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
        })
        const stdout = truncate(r.stdout, PY_STDOUT_MAX)
        const stderr = truncate(r.stderr, PY_STDERR_MAX)
        if (r.aborted) return { ok: false, error: 'aborted', exitCode: r.code, stdout, stderr }
        if (r.timedOut) {
          return { ok: false, error: `timeout after ${timeoutSec}s`, exitCode: r.code, stdout, stderr }
        }
        if (r.error) return { ok: false, error: r.error, exitCode: r.code, stdout, stderr }
        return { ok: r.code === 0, exitCode: r.code, stdout, stderr }
      } catch (err) {
        return { ok: false, error: err?.message || String(err), exitCode: -1, stdout: '', stderr: '' }
      } finally {
        if (dir) {
          try {
            fs.rmSync(dir, { recursive: true, force: true })
          } catch {}
        }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// agy_usage
// ---------------------------------------------------------------------------
/** Map an agy bucket name/window onto the two quota windows DSH reports. */
function normWindow(value, name) {
  const v = String(value ?? '').toLowerCase().trim()
  if (v === 'weekly' || v.includes('week')) return 'weekly'
  if (v === '5h' || v.includes('5') || v.includes('five')) return '5h'
  const n = String(name ?? '').toLowerCase()
  if (n.includes('week')) return 'weekly'
  if (n.includes('five') || n.includes('5')) return '5h'
  return v || 'other'
}

/** 0..100 with one decimal; -1 when the payload has no usable fraction. */
function roundPercent(fraction) {
  const f = Number(fraction)
  if (!Number.isFinite(f)) return -1
  return Math.min(100, Math.max(0, Math.round(f * 1000) / 10))
}

/** Prefer agy's structured `command.data`, fall back to the text table. */
export function parseUsage(payload) {
  const data = isObj(payload) && isObj(payload.command) ? payload.command.data : undefined
  const groups = []
  if (isObj(data) && Array.isArray(data.groups)) {
    for (const g of data.groups) {
      if (!isObj(g) || typeof g.name !== 'string') continue
      const buckets = []
      for (const b of Array.isArray(g.buckets) ? g.buckets : []) {
        if (!isObj(b)) continue
        buckets.push({
          id: str(b.id),
          name: str(b.name),
          window: normWindow(b.window, b.name),
          remainingPercent: roundPercent(b.remaining_fraction),
          resetTime: str(b.reset_time, b.resetTime),
          description: str(b.description),
        })
      }
      groups.push({ name: g.name, description: str(g.description), buckets })
    }
  }
  if (groups.length === 0) {
    // Text table: "<group>\t<label>\t<NN>%\t<reset ISO>"
    const byName = new Map()
    const raw = isObj(payload) ? str(payload.response, payload.stdout) : String(payload ?? '')
    for (const line of raw.split(/\r?\n/)) {
      const cols = line.split('\t').map((c) => c.trim())
      if (cols.length < 3) continue
      const [groupName, label, percentRaw, resetRaw] = cols
      const pct = Number(String(percentRaw).replace('%', ''))
      if (!groupName || !Number.isFinite(pct)) continue
      if (!byName.has(groupName)) byName.set(groupName, { name: groupName, description: '', buckets: [] })
      byName.get(groupName).buckets.push({
        id: '',
        name: label,
        window: normWindow('', label),
        remainingPercent: roundPercent(pct / 100),
        resetTime: resetRaw || '',
        description: '',
      })
    }
    groups.push(...byName.values())
  }
  return groups
}

function usageBar(percent, width = 20) {
  const pct = percent < 0 ? 0 : Math.min(100, percent)
  const filled = Math.round((pct / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

function renderUsage(_args, value) {
  if (!isObj(value) || value.ok !== true) return render(_args, value)
  const lines = []
  for (const g of value.groups ?? []) {
    lines.push(g.name)
    if (g.description) lines.push(`  ${g.description}`)
    for (const b of g.buckets ?? []) {
      const pct = b.remainingPercent < 0 ? '?' : b.remainingPercent.toFixed(1) + '%'
      lines.push(`  ${String(b.window).padEnd(6)} ${usageBar(b.remainingPercent)} ${pct.padStart(6)}  reset ${b.resetTime || '-'}`)
    }
  }
  return [{ type: 'text', text: lines.join('\n') || JSON.stringify(value, null, 2) }]
}

export function agyUsageTool(config) {
  const cfg = resolveConfig(config)
  return {
    name: 'agy_usage',
    description:
      'Show the Google Antigravity quota usage reported by `agy -p "/usage"`: every model group with its ' +
      'weekly and 5-hour limit (remaining %, reset time). Groups share one quota, so all models inside a ' +
      'group consume the same bucket. Use it before a long run with an expensive model.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          ...errorProps,
          groups: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                buckets: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      name: { type: 'string' },
                      window: { type: 'string', enum: ['weekly', '5h', 'other'] },
                      remainingPercent: { type: 'number' },
                      resetTime: { type: 'string' },
                      description: { type: 'string' },
                    },
                    required: ['name', 'window', 'remainingPercent'],
                  },
                },
              },
              required: ['name', 'buckets'],
            },
          },
          raw: { type: 'string' },
        },
        required: ['ok'],
      },
      render: renderUsage,
    },
    timeoutMs: 90 * 1000,
    async execute(_args, exec = {}) {
      if (!isExecutable(cfg.agyPath)) {
        return { ok: false, error: `agy not found or not executable: ${cfg.agyPath}`, groups: [], raw: '' }
      }
      const r = await runProcess([cfg.agyPath, '-p', '/usage', '--output-format', 'json'], {
        cwd: isDir(cfg.cwd) ? cfg.cwd : os.homedir(),
        timeoutMs: 60 * 1000,
        signal: exec?.signal,
        env: { ...process.env, NO_COLOR: '1' },
      })
      if (r.aborted) return { ok: false, error: 'aborted', groups: [], raw: '' }
      if (r.timedOut) return { ok: false, error: 'timeout after 60s', groups: [], raw: '' }
      const raw = truncate(r.stdout || r.stderr, PY_STDOUT_MAX)
      const parsed = parseJsonLoose(r.stdout)
      const groups = parseUsage(parsed !== undefined ? parsed : r.stdout)
      if (groups.length === 0) {
        return { ok: false, error: processFailure(r, 'agy /usage'), groups: [], raw }
      }
      return { ok: true, groups, raw }
    },
  }
}

export const toolFactories = [agyRunTool, agyModelsTool, agyStatusTool, agyUsageTool, runPythonTool]
