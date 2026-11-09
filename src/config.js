import { LlmError } from '@deepseek-ai/dsh-llm'

export const PACKAGE = '@quotumorg/dsh-llm-quotum'
export const ENDPOINTS = Object.freeze({
  seat: 'https://api.venice.ai/api/v1',
  payg: 'https://quotum.org/api/payg/v1',
})
const normalized = new WeakSet()

function object(value, allowed, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}: expected an object`)
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${path}: unknown option`)
}

export function configure(input = {}) {
  if (normalized.has(input)) return input
  object(input, ['seat', 'payg', 'timeoutMs', 'logUsage'], 'quotum')
  const result = { timeoutMs: input.timeoutMs ?? 120000, logUsage: input.logUsage ?? false }
  if (!Number.isSafeInteger(result.timeoutMs) || result.timeoutMs < 1 || result.timeoutMs > 2147483647) throw new Error('quotum: invalid timeoutMs')
  if (typeof result.logUsage !== 'boolean') throw new Error('quotum: invalid logUsage')
  for (const mode of ['seat', 'payg']) {
    const raw = input[mode] ?? {}
    object(raw, ['enabled', 'provider', 'apiKeyEnv', 'models', 'defaultMaxTokens', 'inputLimitBytes'], `quotum.${mode}`)
    const row = {
      mode, baseURL: ENDPOINTS[mode], enabled: mode === 'seat', provider: `quotum-${mode}`,
      apiKeyEnv: mode === 'seat' ? 'QUOTUM_SEAT_KEY' : 'QUOTUM_PAYG_KEY',
      models: mode === 'seat' ? ['deepseek-v4-pro', 'kimi-k3'] : ['deepseek-v4-flash', 'openai-gpt-oss-120b'],
      defaultMaxTokens: mode === 'seat' ? 8192 : 2048, inputLimitBytes: mode === 'seat' ? 0 : 8192,
      ...raw,
    }
    if (typeof row.enabled !== 'boolean' || !/^[a-z][a-z0-9-]{0,63}$/.test(row.provider)) throw new Error(`quotum.${mode}: invalid route`)
    if (typeof row.apiKeyEnv !== 'string' || !/^QUOTUM_[A-Z0-9_]+$/.test(row.apiKeyEnv)) throw new Error(`quotum.${mode}: use an environment reference`)
    if (!Array.isArray(row.models) || !row.models.length || row.models.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9._/-]{1,200}$/.test(id)) || new Set(row.models).size !== row.models.length) throw new Error(`quotum.${mode}: invalid models`)
    if (!Number.isSafeInteger(row.defaultMaxTokens) || row.defaultMaxTokens < 1 || row.defaultMaxTokens > (mode === 'payg' ? 2048 : 8192)) throw new Error(`quotum.${mode}: invalid output cap`)
    if (mode === 'payg' ? ![8192, 32768].includes(row.inputLimitBytes) : row.inputLimitBytes !== 0) throw new Error(`quotum.${mode}: invalid input limit`)
    row.models = Object.freeze([...row.models])
    result[mode] = Object.freeze(row)
  }
  if (result.seat.enabled && result.payg.enabled && (result.seat.provider === result.payg.provider || result.seat.apiKeyEnv === result.payg.apiKeyEnv)) throw new Error('quotum: routes and credential references must be distinct')
  normalized.add(result)
  return Object.freeze(result)
}

// Standard Schema v1 is accepted by Cordis. No schema library is executed here.
// Generic validation is available; no Schemastery-generated settings form is claimed.
export const Config = {
  '~standard': {
    version: 1, vendor: 'quotumorg',
    validate(input) {
      try { return { value: configure(input) } }
      catch { return { issues: [{ message: 'quotum: invalid configuration; check route options' }] } }
    },
  },
}

export function environmentCredential(ref, env = process.env) {
  const value = env[ref]
  if (typeof value !== 'string' || !value.trim()) throw new LlmError(`quotum: export ${ref}`, 'MISSING_CREDENTIAL')
  const key = value.trim()
  if (/[^\x21-\x7e]/.test(key)) throw new LlmError(`quotum: invalid credential in ${ref}`, 'INVALID_CREDENTIAL')
  return key
}
