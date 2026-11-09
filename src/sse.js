/** Minimal Server-Sent Events reader for OpenAI-style chat streams (WHATWG event-stream framing). */

/**
 * Yield one `{ event, data }` record per dispatched SSE event.
 * Handles CRLF/CR/LF line endings, multi-line `data:` fields, comments and a
 * final event without a trailing blank line.
 * @param {ReadableStream<Uint8Array>} body
 * @returns {AsyncGenerator<{ event: string, data: string }>}
 */
export async function * readSse(body) {
  const decoder = new TextDecoder()
  let buffer = ''
  let event = ''
  let data = []
  const dispatch = () => {
    const record = data.length > 0 ? { event: event || 'message', data: data.join('\n') } : undefined
    event = ''
    data = []
    return record
  }
  const take = function * (final) {
    for (;;) {
      const match = /\r\n|\r|\n/.exec(buffer)
      if (match === null) break
      // A lone CR at the end of the buffer may be the first half of CRLF.
      if (!final && match[0] === '\r' && match.index === buffer.length - 1) break
      const line = buffer.slice(0, match.index)
      buffer = buffer.slice(match.index + match[0].length)
      if (line === '') {
        const record = dispatch()
        if (record !== undefined) yield record
        continue
      }
      if (line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'data') data.push(value)
      else if (field === 'event') event = value
    }
  }
  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      yield * take(false)
    }
    buffer += decoder.decode()
    if (buffer.length > 0) buffer += '\n'
    yield * take(true)
    const tail = dispatch()
    if (tail !== undefined) yield tail
  } finally {
    try { await reader.cancel() } catch {}
    reader.releaseLock()
  }
}
