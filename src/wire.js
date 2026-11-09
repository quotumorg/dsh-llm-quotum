/** Harness request → OpenAI Chat Completions body, plus the PAYG input-byte estimate. */
import { LlmError } from '@deepseek-ai/dsh-llm'

const textOf = (content, role) => {
  const parts = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'image') {
      // The routes declare text-only input, so LlmRuntime projects images to placeholder text first.
      throw new LlmError(`quotum: image content in a ${role} message is not supported on this text-only route`, 'UNSUPPORTED_CONTENT')
    }
    // reasoning, tool-call, file (projected to text upstream) and tool-update blocks are handled by the caller or dropped.
  }
  return parts.join('')
}

/**
 * Translate harness messages to Chat Completions messages.
 * Leading system messages keep the system role; later ones become user-role
 * `<system-reminder>` text (no mid-conversation system support is declared).
 * Developer (tool-update) messages are dropped: the complete active tool list is sent each request.
 * Reasoning replay: `current-turn` sends `reasoning_content` only on assistant messages after the
 * last user message (the DeepSeek thinking-mode rule for tool loops), `all` on every one, `none` never.
 * @param {import('@deepseek-ai/dsh-llm').GenerateOptions<string>} options
 * @param {{ reasoningReplay: 'current-turn'|'all'|'none' }} flags
 */
export function toChatMessages(options, flags) {
  const out = []
  let lastUser = -1
  options.messages.forEach((message, i) => { if (message.role === 'user') lastUser = i })
  const systemText = []
  if (typeof options.system === 'string' && options.system.length > 0) systemText.push(options.system)
  let leading = true
  for (const [position, message] of options.messages.entries()) {
    if (message.role === 'system') {
      const text = textOf(message.content, 'system')
      if (text.length === 0) continue
      if (leading) systemText.push(text)
      else out.push({ role: 'user', content: `<system-reminder>\n${text}\n</system-reminder>` })
      continue
    }
    if (message.role === 'developer') continue
    leading = false
    if (message.role === 'user') {
      out.push({ role: 'user', content: textOf(message.content, 'user') })
    } else if (message.role === 'assistant') {
      const text = textOf(message.content, 'assistant')
      const reasoning = message.content.filter(b => b.type === 'reasoning').map(b => b.text).join('')
      const calls = message.content.filter(b => b.type === 'tool-call').map(b => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: b.arguments },
      }))
      const entry = { role: 'assistant', content: text.length > 0 || calls.length === 0 ? text : null }
      if (calls.length > 0) entry.tool_calls = calls
      const replay = flags.reasoningReplay === 'all' || (flags.reasoningReplay === 'current-turn' && position > lastUser)
      if (replay && reasoning.length > 0) entry.reasoning_content = reasoning
      out.push(entry)
    } else if (message.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: message.toolCallId, content: textOf(message.content, 'tool') })
    }
  }
  if (systemText.length > 0) out.unshift({ role: 'system', content: systemText.join('\n\n') })
  return out
}

/**
 * Build the JSON body for one request.
 * @param {'seat'|'payg'} mode
 * @param {import('@deepseek-ai/dsh-llm').GenerateOptions<string>} options
 * @param {{ stream: boolean, reasoningReplay: 'current-turn'|'all'|'none', veniceSystemPrompt: boolean }} flags
 */
export function buildBody(mode, options, flags) {
  if (mode === 'payg' && options.stop?.length) {
    throw new LlmError('quotum payg: stop sequences are not supported', 'UNSUPPORTED_OPTION')
  }
  if (options.stop !== undefined && options.stop.length > 4) {
    throw new LlmError('quotum: at most 4 stop sequences are supported', 'UNSUPPORTED_OPTION')
  }
  const body = { model: options.model, messages: toChatMessages(options, flags) }
  if (options.tools !== undefined && options.tools.length > 0) {
    body.tools = options.tools.map(tool => ({
      type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))
  }
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (options.stop !== undefined && options.stop.length > 0) body.stop = [...options.stop]
  if (options.reasoningEffort !== undefined) body.reasoning_effort = options.reasoningEffort
  if (mode === 'seat') body.venice_parameters = { include_venice_system_prompt: flags.veniceSystemPrompt }
  body.stream = flags.stream
  if (flags.stream) body.stream_options = { include_usage: true }
  return body
}

/**
 * Estimate PAYG's documented input count: UTF-8 bytes of the JSON of messages,
 * tools and tool_choice, + 512, + 256 per message, + 1,024 when tools are sent.
 * The server's canonical JSON may differ slightly; this is a pre-flight guard, not the meter.
 */
export function paygInputBytes(body) {
  const sorted = value => Array.isArray(value) ? value.map(sorted)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value
  const canonical = JSON.stringify(sorted({ messages: body.messages, tools: body.tools || [], tool_choice: body.tool_choice || 'auto' }))
  return Buffer.byteLength(canonical, 'utf8') + 512 + 256 * body.messages.length + (body.tools?.length ? 1024 : 0)
}
