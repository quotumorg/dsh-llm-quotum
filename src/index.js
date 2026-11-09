import { QuotumAdapter } from './adapter.js'
import { Config, configure } from './config.js'

export { Config, QuotumAdapter }
export const name = 'llm-quotum'
export const inject = ['llm']

export function apply(ctx, input) {
  // Config may already have been normalized by the host Standard Schema hook.
  const config = configure(input)
  const adapter = new QuotumAdapter({ config, onRecord(record) {
    try { ctx.emit('quotum/usage', record) } catch {}
    if (config.logUsage) {
      try { process.stderr.write(`${JSON.stringify({ event: 'quotum/usage', ...record })}\n`) } catch {}
    }
  } })
  if (adapter.providers().length) ctx.llm.registerAdapter(adapter.providers(), adapter)
}
