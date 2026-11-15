// dsh-antigravity — Cordis plugin that exposes the Google Antigravity CLI (agy)
// as native DeepSeek Harness tools. Zero runtime dependencies.
import { resolveConfig } from './lib/agy.js'
import { agyModelsTool, agyRunTool, agyStatusTool, agyUsageTool, runPythonTool } from './lib/tools.js'

export const name = 'antigravity'
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config)
  // register() returns a disposer; Cordis cleans it up with the plugin scope.
  ctx.tools.register(agyRunTool(cfg))
  ctx.tools.register(agyModelsTool(cfg))
  ctx.tools.register(agyStatusTool(cfg))
  ctx.tools.register(agyUsageTool(cfg))
  ctx.tools.register(runPythonTool(cfg))
}
