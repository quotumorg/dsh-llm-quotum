/** OpenAI Chat Completions chunks → harness StreamChunk values, with billing extras captured on the side. */
import { LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import { isObject } from './billing.js'

const FINISH = { stop: 'stop', tool_calls: 'tool-calls', function_call: 'tool-calls', length: 'max-tokens' }

/**
 * Stateful translator for one response. `feed()` returns chunks to emit now;
 * `end()` closes open blocks and returns usage then finish (nothing may follow).
 */
export class ChunkTranslator {
  constructor() {
    this.next = 0
    /** @type {{ kind: 'text'|'reasoning', index: number, text: string } | undefined} */
    this.open = undefined
    /** tool position → block state */
    this.tools = new Map()
    this.finishReason = undefined
    this.usage = undefined
    /** Top-level non-standard fields seen in any chunk (`cost`, `quotum_billing`, `id`, `model`). */
    this.extras = {}
    this.sawContent = false
  }

  /** @returns {import('@deepseek-ai/dsh-llm').StreamChunk[]} */
  closeOpen() {
    if (this.open === undefined) return []
    const { kind, index, text } = this.open
    this.open = undefined
    return [{ type: 'block-end', index, block: { type: kind, text } }]
  }

  delta(kind, text) {
    const out = []
    if (this.open?.kind !== kind) {
      out.push(...this.closeOpen())
      this.open = { kind, index: this.next++, text: '' }
      out.push({ type: 'block-start', index: this.open.index, blockType: kind })
    }
    this.open.text += text
    out.push({ type: kind === 'text' ? 'text-delta' : 'reasoning-delta', index: this.open.index, text })
    this.sawContent = true
    return out
  }

  captureExtras(chunk) {
    if (!isObject(chunk)) return
    for (const key of ['cost', 'quotum_billing', 'id', 'model', 'duplicate_response']) {
      if (chunk[key] !== undefined) this.extras[key] = chunk[key]
    }
    if (isObject(chunk.usage)) {
      this.usage = chunk.usage
      if (isObject(chunk.usage.cost) && this.extras.cost === undefined) this.extras.cost = chunk.usage.cost
    }
  }

  /** @param {Record<string, unknown>} chunk one decoded `data:` JSON object */
  feed(chunk) {
    const out = []
    if (!isObject(chunk)) return out
    this.captureExtras(chunk)
    const choices = Array.isArray(chunk.choices) ? chunk.choices : []
    for (const choice of choices) {
      if (!isObject(choice) || (choice.index ?? 0) !== 0) continue
      const delta = isObject(choice.delta) ? choice.delta : isObject(choice.message) ? choice.message : {}
      const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content
        : typeof delta.reasoning === 'string' ? delta.reasoning : ''
      if (reasoning.length > 0) out.push(...this.delta('reasoning', reasoning))
      if (typeof delta.content === 'string' && delta.content.length > 0) out.push(...this.delta('text', delta.content))
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) out.push(...this.toolDelta(call))
      }
      if (typeof choice.finish_reason === 'string') this.finishReason = choice.finish_reason
    }
    return out
  }

  toolDelta(call) {
    if (!isObject(call)) return []
    const out = []
    const position = Number.isInteger(call.index) ? call.index : this.tools.size
    let state = this.tools.get(position)
    const fn = isObject(call.function) ? call.function : {}
    if (state === undefined) {
      out.push(...this.closeOpen())
      if (typeof call.id !== 'string' || call.id.length === 0) throw new LlmError('quotum: missing tool call id', 'MALFORMED_RESPONSE')
      const id = call.id
      state = { index: this.next++, id: ToolCallId(id), name: '', args: '' }
      this.tools.set(position, state)
      out.push({ type: 'block-start', index: state.index, blockType: 'tool-call' })
    }
    const name = typeof fn.name === 'string' ? fn.name : undefined
    if (name !== undefined) state.name += name
    const args = typeof fn.arguments === 'string' ? fn.arguments
      : isObject(fn.arguments) ? JSON.stringify(fn.arguments) : ''
    state.args += args
    out.push({ type: 'tool-call-delta', index: state.index, id: state.id, ...name !== undefined ? { name: state.name } : {}, argumentsDelta: args })
    this.sawContent = true
    return out
  }

  /** Close blocks, then usage, then finish. Throws EMPTY_RESPONSE when nothing at all was produced. */
  end() {
    const out = [...this.closeOpen()]
    for (const state of [...this.tools.values()].sort((a, b) => a.index - b.index)) {
      if (state.name.length === 0) throw new LlmError('quotum: tool call without a function name', 'MALFORMED_RESPONSE')
      out.push({ type: 'block-end', index: state.index, block: { type: 'tool-call', id: state.id, name: state.name, arguments: state.args || '{}' } })
    }
    const usage = tokenUsage(this.usage)
    if (usage !== undefined) out.push({ type: 'usage', usage })
    const reason = this.finishReason
    if (reason === undefined) throw new LlmError('quotum: stream ended before finish_reason; inspect receipt before retry', 'TRANSPORT')
    if (reason !== 'content_filter' && FINISH[reason] === undefined) throw new LlmError('quotum: unsupported finish reason', 'MALFORMED_RESPONSE')
    if (reason === 'content_filter') {
      out.push({ type: 'finish', reason: { kind: 'error', failure: { message: 'quotum: response stopped by the provider content filter', code: 'CONTENT_FILTER' } } })
      return out
    }
    if (!this.sawContent && reason !== 'length') {
      throw new LlmError('quotum: the provider returned no content', 'EMPTY_RESPONSE')
    }
    const kind = FINISH[reason] ?? (this.tools.size > 0 ? 'tool-calls' : 'stop')
    out.push({ type: 'finish', reason: { kind } })
    return out
  }
}

/** OpenAI usage → harness TokenUsage with disjoint cached input. */
export function tokenUsage(usage) {
  const n = (value) => Number.isSafeInteger(value) && value >= 0 ? value : undefined
  if (!isObject(usage)) return undefined
  const prompt = n(usage.prompt_tokens)
  const output = n(usage.completion_tokens)
  if (prompt === undefined || output === undefined) return undefined
  const cached = n(usage.prompt_tokens_details?.cached_tokens) ?? n(usage.prompt_cache_hit_tokens)
  const reasoning = n(usage.completion_tokens_details?.reasoning_tokens)
  const total = n(usage.total_tokens)
  return {
    inputTokens: cached !== undefined && cached <= prompt ? prompt - cached : prompt,
    outputTokens: output,
    ...total !== undefined && total === prompt + output ? { totalTokens: total } : {},
    ...cached !== undefined && cached <= prompt && cached > 0 ? { cacheReadTokens: cached } : {},
    ...reasoning !== undefined ? { reasoningTokens: reasoning } : {},
  }
}
