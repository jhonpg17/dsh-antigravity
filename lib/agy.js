// Helpers for dsh-antigravity. Zero runtime dependencies: only node:* modules.
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'])
export const MODES = Object.freeze(['accept-edits', 'auto', 'plan'])

export const DEFAULTS = Object.freeze({
  agyPath: '~/.local/bin/agy',
  cwd: '',
  defaultModel: '',
  defaultEffort: '',
  skipPermissions: true,
  timeoutSec: 300,
})

/** Max bytes kept in memory per stream while a child process runs. */
const MAX_CAPTURE = 8 * 1024 * 1024
/** Grace period between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 2000

/** Expand a leading `~` using os.homedir(). */
export function expandHome(p) {
  if (typeof p !== 'string') return p
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== ''
}

/**
 * Normalise plugin config. Unknown fields are ignored and invalid values fall
 * back to defaults silently.
 */
export function resolveConfig(config) {
  const c = config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  const out = {
    agyPath: expandHome(DEFAULTS.agyPath),
    cwd: process.cwd(),
    defaultModel: DEFAULTS.defaultModel,
    defaultEffort: DEFAULTS.defaultEffort,
    skipPermissions: DEFAULTS.skipPermissions,
    timeoutSec: DEFAULTS.timeoutSec,
  }
  if (nonEmptyString(c.agyPath)) out.agyPath = path.resolve(expandHome(c.agyPath.trim()))
  if (nonEmptyString(c.cwd)) out.cwd = path.resolve(expandHome(c.cwd.trim()))
  if (typeof c.defaultModel === 'string') out.defaultModel = c.defaultModel.trim()
  if (typeof c.defaultEffort === 'string') {
    const e = c.defaultEffort.trim()
    if (e === '' || EFFORTS.includes(e)) out.defaultEffort = e
  }
  if (typeof c.skipPermissions === 'boolean') out.skipPermissions = c.skipPermissions
  if (typeof c.timeoutSec === 'number' && Number.isFinite(c.timeoutSec) && c.timeoutSec > 0) {
    out.timeoutSec = Math.min(Math.max(Math.round(c.timeoutSec), 1), 3600)
  }
  return out
}

/** Truncate a string to `max` chars keeping the head. */
export function truncate(s, max) {
  const str = typeof s === 'string' ? s : String(s ?? '')
  if (str.length <= max) return str
  const marker = `\n…[truncated ${str.length - max} chars]`
  return str.slice(0, Math.max(0, max - marker.length)) + marker
}

/** Keep the last `max` chars of a string. */
export function tail(s, max) {
  const str = typeof s === 'string' ? s : String(s ?? '')
  return str.length <= max ? str : str.slice(str.length - max)
}

/**
 * Parse JSON tolerantly: whole text, then last parseable line (JSONL / logs
 * before the result), then the outermost {...} block. Returns undefined on failure.
 */
export function parseJsonLoose(text) {
  if (typeof text !== 'string') return undefined
  const t = text.trim()
  if (!t) return undefined
  try {
    return JSON.parse(t)
  } catch {}
  const lines = t.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.startsWith('{') && !line.startsWith('[')) continue
    try {
      return JSON.parse(line)
    } catch {}
  }
  const first = t.indexOf('{')
  const last = t.lastIndexOf('}')
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(t.slice(first, last + 1))
    } catch {}
  }
  return undefined
}

/**
 * Spawn a process without a shell. Never rejects.
 * @param {string[]} argv  [command, ...args]
 * @param {{cwd?: string, timeoutMs?: number, signal?: AbortSignal, env?: object}} [opts]
 * @returns {Promise<{code: number|null, signal: string|null, stdout: string, stderr: string,
 *   timedOut: boolean, aborted: boolean, error: string|null}>}
 */
export function runProcess(argv, opts = {}) {
  const { cwd, timeoutMs, signal, env } = opts
  return new Promise((resolve) => {
    const result = {
      code: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: false,
      error: null,
    }
    if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== 'string') {
      result.error = 'invalid argv'
      resolve(result)
      return
    }
    if (signal?.aborted) {
      result.aborted = true
      result.error = 'aborted'
      resolve(result)
      return
    }

    const useGroup = process.platform !== 'win32'
    let child
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        detached: useGroup,
      })
    } catch (err) {
      result.error = err?.message || String(err)
      resolve(result)
      return
    }

    const out = []
    const errChunks = []
    let outLen = 0
    let errLen = 0
    let settled = false
    let timer = null
    let killTimer = null

    // Signal the whole process group on POSIX so grandchildren holding the
    // pipes open die too; fall back to the direct child.
    const sendSignal = (sig) => {
      if (useGroup && child.pid) {
        try {
          process.kill(-child.pid, sig)
          return
        } catch {}
      }
      try {
        child.kill(sig)
      } catch {}
    }
    let killing = false
    const kill = () => {
      if (killing) return
      killing = true
      sendSignal('SIGTERM')
      killTimer = setTimeout(() => sendSignal('SIGKILL'), KILL_GRACE_MS)
      killTimer.unref?.()
    }

    const onAbort = () => {
      result.aborted = true
      kill()
    }

    const finish = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      signal?.removeEventListener?.('abort', onAbort)
      result.stdout = Buffer.concat(out).toString('utf8')
      result.stderr = Buffer.concat(errChunks).toString('utf8')
      if (result.aborted) result.error = 'aborted'
      else if (result.timedOut) result.error = 'timeout'
      resolve(result)
    }

    child.stdout.on('data', (b) => {
      if (outLen < MAX_CAPTURE) {
        out.push(b)
        outLen += b.length
      }
    })
    child.stderr.on('data', (b) => {
      // Keep the most recent stderr if it overflows (the tail is what matters).
      errChunks.push(b)
      errLen += b.length
      while (errLen > MAX_CAPTURE && errChunks.length > 1) errLen -= errChunks.shift().length
    })

    child.on('error', (err) => {
      result.error = err?.code === 'ENOENT' ? `command not found: ${argv[0]}` : err?.message || String(err)
      finish()
    })
    child.on('close', (code, sig) => {
      result.code = code
      result.signal = sig
      finish()
    })
    // If we killed the child but some descendant still holds the pipes open,
    // don't wait for 'close' forever.
    child.on('exit', (code, sig) => {
      if (!killing) return
      result.code = code
      result.signal = sig
      setTimeout(finish, 500).unref?.()
    })

    if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        result.timedOut = true
        kill()
      }, timeoutMs)
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}
