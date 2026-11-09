import { randomUUID } from 'node:crypto'
import { attributionHeaders, LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { environmentCredential } from './config.js'
import { seatSpend, paygSpend } from './billing.js'
import { providerError } from './errors.js'
import { buildBody, paygInputBytes } from './wire.js'
import { readSse } from './sse.js'
import { ChunkTranslator, tokenUsage } from './translate.js'

export class QuotumAdapter extends LlmAdapter {
  constructor({ config, fetch: transport, onRecord = () => {}, env = process.env }) {
    super()
    this.config = config
    this.fetch = transport ?? globalThis.fetch
    this.onRecord = onRecord
    this.env = env
    this.routes = new Map(['seat', 'payg'].map(mode => config[mode]).filter(row => row.enabled).map(row => [row.provider, row]))
  }
  providers() { return [...this.routes.keys()] }
  route(provider) {
    const row = this.routes.get(provider)
    if (!row) throw new LlmError('quotum: unknown provider route', 'NO_ADAPTER')
    return row
  }
  providerInfo(provider) { return { id: provider, name: `quotum ${this.route(provider).mode}` } }
  providerRetryPolicy(provider) {
    this.route(provider)
    return resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'quotum.retryPolicy')
  }
  async listModels(provider) {
    return this.route(provider).models.map(id => ({ provider, id, name: id, inputModalities: ['text'] }))
  }
  async resolveModel(provider, model, signal) {
    signal?.throwIfAborted()
    return { provider, id: model, name: model, inputModalities: ['text'], defaultMaxTokens: this.route(provider).defaultMaxTokens }
  }
  async * stream(options) {
    const route = this.route(options.provider)
    options.signal?.throwIfAborted()
    const key = environmentCredential(route.apiKeyEnv, this.env)
    if (typeof options.model !== 'string' || !/^[a-zA-Z0-9._/-]{1,200}$/.test(options.model) || options.model.includes(key)) throw new LlmError('quotum: invalid model id', 'UNKNOWN_MODEL')
    const body = buildBody(route.mode, options, { stream: true, reasoningReplay: route.mode === 'seat' ? 'current-turn' : 'none', veniceSystemPrompt: false })
    if (body.max_tokens !== undefined && (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1)) throw new LlmError('quotum: invalid output cap', 'UNSUPPORTED_OPTION')
    body.max_tokens = Math.min(body.max_tokens ?? route.defaultMaxTokens, route.defaultMaxTokens)
    // Capabilities are deliberately not guessed from a model name or a global listing.
    if (options.reasoningEffort !== undefined) throw new LlmError('quotum: explicit reasoning effort is not configured', 'UNSUPPORTED_OPTION')
    if (route.mode === 'payg' && (body.messages.length > 60 || (body.tools?.length ?? 0) > 32)) throw new LlmError('quotum payg: message or tool count limit', 'INPUT_LIMIT')
    const inputBytes = route.mode === 'payg' ? paygInputBytes(body) : undefined
    if (inputBytes > route.inputLimitBytes) throw new LlmError(`quotum payg: ${inputBytes} input bytes exceeds ${route.inputLimitBytes}; use the seat route; 32768 requires project long context`, 'INPUT_LIMIT')
    const idempotencyKey = route.mode === 'payg' ? randomUUID() : undefined
    const translator = new ChunkTranslator()
    const controller = new AbortController()
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
    let response, outcome = 'error', failureCode, requestId
    const started = Date.now()
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)
    try {
      options.signal?.throwIfAborted()
      try {
        response = await this.fetch(`${route.baseURL}/chat/completions`, {
          method: 'POST', redirect: 'error', signal,
          headers: { ...attributionHeaders(), 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${key}`, ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
          body: JSON.stringify(body),
        })
      } finally { clearTimeout(timer) }
      requestId = response.headers.get('x-quotum-request-id') ?? response.headers.get('x-request-id')
      if (response.status !== 200) {
        const raw = await errorBody(response)
        translator.captureExtras(raw)
        throw providerError(route.mode, raw, response.status, response.headers)
      }
      if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
        // Streaming is mandatory for this candidate; do not accept an unbounded JSON body.
        throw new LlmError('quotum: expected an event stream', 'MALFORMED_RESPONSE')
      }
      for await (const frame of readSse(response.body)) {
        options.signal?.throwIfAborted()
        if (frame.data === '[DONE]') break
        let json
        try { json = JSON.parse(frame.data) }
        catch { throw new LlmError('quotum: invalid event data', 'MALFORMED_RESPONSE') }
        if (!json || typeof json !== 'object' || Array.isArray(json)) throw new LlmError('quotum: invalid event object', 'MALFORMED_RESPONSE')
        translator.captureExtras(json)
        if (json.error !== undefined) throw providerError(route.mode, json)
        if (json.duplicate_response !== undefined) throw new LlmError('quotum: receipt without replayed output', 'IDEMPOTENCY_CONFLICT')
        for (const chunk of translator.feed(json)) yield chunk
      }
      const tail = translator.end()
      outcome = tail.at(-1).reason.kind === 'error' ? 'error' : 'completed'
      failureCode = tail.at(-1).reason.failure?.code
      for (const chunk of tail) yield chunk
    } catch (error) {
      if (options.signal?.aborted) { outcome = 'aborted'; failureCode = 'ABORTED'; throw options.signal.reason }
      // Never retain a fetch/decoder cause: it can include authorization or content.
      const safe = error instanceof LlmError ? error : new LlmError('quotum: response transport failed; inspect receipt before retry', controller.signal.aborted ? 'TIMEOUT' : 'TRANSPORT')
      failureCode = safe.code
      throw safe
    } finally {
      clearTimeout(timer)
      if (outcome === 'error' && failureCode === undefined) { outcome = 'aborted'; failureCode = 'CONSUMER_CLOSED' }
      // A consumer returning early cancels the socket, but cannot undo a provider charge.
      controller.abort()
      try { if (response?.body && !response.body.locked) await response.body.cancel() } catch {}
      const spend = route.mode === 'payg' ? paygSpend(translator.extras.quotum_billing) : seatSpend(translator.extras)
      const opaque = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value) && !value.includes(key) ? value : undefined
      try { this.onRecord({
        provider: route.provider, mode: route.mode, model: options.model,
        endpoint: `${route.baseURL}/chat/completions`, authorization: '[redacted]',
        outcome, ...(failureCode ? { code: failureCode } : {}), elapsedMs: Date.now() - started,
        usage: tokenUsage(translator.usage) ?? null,
        spend: { state: spend.state, ...(spend.state === 'known' ? { usd: spend.usd, nano: String(spend.nano) } : {}) },
        ...(opaque(spend.receipt) ? { receipt: opaque(spend.receipt) } : {}),
        ...(opaque(requestId) ? { requestId: opaque(requestId) } : {}),
        ...(idempotencyKey ? { idempotencyKey, inputBytes, inputLimitBytes: route.inputLimitBytes } : {}),
      }) } catch {}
    }
  }
}

async function errorBody(response) {
  const reader = response.body?.getReader()
  if (!reader) return {}
  const chunks = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > 16384) return {}
      chunks.push(value)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return {} }
  } catch { return {} }
  finally { try { await reader.cancel() } catch {}; reader.releaseLock() }
}
