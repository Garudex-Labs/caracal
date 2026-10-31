// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Scripted Anthropic Messages API upstream for agent e2e tests: requests one Bash tool call, then ends the turn.

import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 18090)
const command = process.env.STUB_COMMAND ?? 'true'
const REDACT = new Set(['x-api-key', 'authorization', 'cookie'])

function redact(name, value) {
  if (!REDACT.has(name)) return value
  const scheme = name === 'authorization' ? String(value).split(' ')[0] + ' ' : ''
  return `${scheme}<redacted len=${String(value).length}>`
}

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const data of events) res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`)
  res.end()
}

function message(content, stopReason) {
  return { id: 'msg_stub', type: 'message', role: 'assistant', model: 'stub', content, stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
}

function reply(body) {
  const last = body.messages?.at(-1)
  const sawToolResult = Array.isArray(last?.content) && last.content.some((c) => c.type === 'tool_result')
  const offersBash = Array.isArray(body.tools) && body.tools.some((t) => t.name === 'Bash')
  if (offersBash && !sawToolResult) return { kind: 'tool', input: { command, description: 'stub tool call' } }
  return { kind: 'text', text: 'DONE' }
}

function stream(res, r) {
  const start = { type: 'message_start', message: message([], null) }
  const block =
    r.kind === 'tool'
      ? [
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_stub', name: 'Bash', input: {} } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(r.input) } },
        ]
      : [
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: r.text } },
        ]
  sse(res, [
    start,
    ...block,
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: r.kind === 'tool' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ])
}

createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, redact(k, v)]))
    let body = {}
    try {
      body = raw ? JSON.parse(raw) : {}
    } catch {
      /* non-JSON body */
    }
    const path = req.url.split('?')[0]
    // One JSON line per request, auth values redacted, so tests can assert what reached the upstream.
    const expected = process.env.STUB_EXPECT_KEY
    const keyMatchesInjected = expected ? req.headers['x-api-key'] === expected : undefined
    process.stdout.write(JSON.stringify({ method: req.method, url: req.url, headers, keyMatchesInjected, stream: body.stream, model: body.model, tools: body.tools?.length }) + '\n')
    if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ input_tokens: 1 }))
    }
    if (req.method === 'POST' && path === '/v1/messages') {
      const r = reply(body)
      if (body.stream) return stream(res, r)
      const content = r.kind === 'tool' ? [{ type: 'tool_use', id: 'toolu_stub', name: 'Bash', input: r.input }] : [{ type: 'text', text: r.text }]
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(message(content, r.kind === 'tool' ? 'tool_use' : 'end_turn')))
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'stub' } }))
  })
}).listen(port, process.env.STUB_HOST ?? '127.0.0.1')
