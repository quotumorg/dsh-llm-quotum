import { LlmError } from '@deepseek-ai/dsh-llm'

// Provider bodies and transport causes may contain credentials or prompt echoes.
// Classify their code only. Public failures contain our fixed text and HTTP status.
export function providerError(mode, body, status, headers) {
  const rawCode = body?.error?.code ?? body?.code
  const detail = typeof rawCode === 'string' ? rawCode : ''
  let code = 'SERVER'
  if (status === 401 || status === 403) code = 'AUTH'
  else if (mode === 'seat' && status === 402 && headers?.has('payment-required') && !/spend.limit|insufficient/i.test(detail)) code = 'AUTH'
  else if (status === 402 || status === 429 && mode === 'payg' && !/provider-rate-limit/.test(detail)) code = 'QUOTA'
  else if (status === 429) code = 'RATE_LIMIT'
  else if (status === 202 || status === 409) code = 'IDEMPOTENCY_CONFLICT'
  else if (/context_length_exceeded|context_window_exceeded/.test(detail)) code = 'CONTEXT_WINDOW_EXCEEDED'
  else if (/input-limit/.test(detail)) code = 'INPUT_LIMIT'
  else if (status === 404) code = 'UNKNOWN_MODEL'
  else if (status === 408) code = 'TIMEOUT'
  else if (status !== undefined && status >= 400 && status < 500) code = 'INVALID_REQUEST'
  return new LlmError(`quotum ${mode}: ${code}${status === undefined ? '' : ` (http ${status})`}`, code,
    status === undefined ? undefined : { status })
}
