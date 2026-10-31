// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Loopback broker between a governed agent and Caracal: forwards model traffic and answers tool hooks.

import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import type { AgentAdapter, ToolDecision } from './agentAdapters.js'
import { HOOK_TIMEOUT_SECONDS } from './agentAdapters.js'
import { scrubTokens } from './crash.js'

export interface AgentBrokerOptions {
  adapter: AgentAdapter
  // Decides one tool scope; a rejection or a late answer is treated as a denial.
  decide: (scope: string) => Promise<ToolDecision>
  // Sends one model request, path including its query, through the Gateway.
  forward: (path: string, init: RequestInit) => Promise<Response>
  decisionTimeoutMs?: number
  onDecision?: (tool: string | undefined, decision: ToolDecision) => void
}

export interface AgentBroker {
  // Base URL, including the per-launch path secret that keeps other local processes out.
  readonly url: string
  close(): Promise<void>
}

// Stays well under the agent's hook timeout so the agent always gets an explicit answer:
// agents run the tool when a hook errors or times out.
const DECISION_TIMEOUT_MS = Math.min(4_000, HOOK_TIMEOUT_SECONDS * 1000 - 2_000)
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/
// Hook payloads carry the full tool input, such as a file being written.
const MAX_HOOK_BODY_BYTES = 64 * 1024 * 1024
const DROP_REQUEST = new Set([
  'host',
  'connection',
  'keep-alive',
  'content-length',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'cookie',
])
// The Gateway declares X-Caracal-Revoked as a trailer, which is invalid on bodiless responses
// such as HEAD; fetch has already decoded any content encoding.
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'content-length', 'transfer-encoding', 'content-encoding', 'trailer'])

function describe(err: unknown): string {
  const e = err as { code?: unknown; requestId?: unknown; message?: unknown }
  const code = typeof e?.code === 'string' ? e.code : 'error'
  const requestId = typeof e?.requestId === 'string' ? ` (request_id=${e.requestId})` : ''
  return scrubTokens(`${code}${requestId}`)
}

async function decideWithin(decide: (scope: string) => Promise<ToolDecision>, scope: string, timeoutMs: number): Promise<ToolDecision> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<ToolDecision>((resolve) => {
    timer = setTimeout(() => resolve({ allow: false, reason: 'caracal: tool decision timed out' }), timeoutMs)
  })
  try {
    return await Promise.race([
      decide(scope).catch((err: unknown) => ({ allow: false, reason: `caracal: ${describe(err)}` }) as const),
      late,
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function modelError(res: ServerResponse, err: unknown): void {
  // Caracal denials are final; reporting them as 5xx makes agents retry with backoff for minutes.
  const status = (err as { httpStatus?: unknown })?.httpStatus
  const denied = status === 401 || status === 403
  json(res, denied ? 403 : 502, {
    type: 'error',
    error: { type: denied ? 'permission_error' : 'api_error', message: `caracal: ${describe(err)}` },
  })
}

export async function startAgentBroker(opts: AgentBrokerOptions): Promise<AgentBroker> {
  const base = `/${randomBytes(16).toString('hex')}`
  const timeoutMs = opts.decisionTimeoutMs ?? DECISION_TIMEOUT_MS

  async function hook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let tool: string | undefined
    let decision: ToolDecision
    try {
      tool = opts.adapter.toolName(JSON.parse((await readBody(req, MAX_HOOK_BODY_BYTES)).toString('utf8')))
      decision =
        tool && TOOL_NAME.test(tool)
          ? await decideWithin(opts.decide, `tool:${tool}`, timeoutMs)
          : { allow: false, reason: 'caracal: unrecognized tool call' }
    } catch (err) {
      decision = { allow: false, reason: `caracal: ${describe(err)}` }
    }
    opts.onDecision?.(tool, decision)
    json(res, 200, opts.adapter.hookResponse(decision))
  }

  async function model(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const abort = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) abort.abort()
    })
    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined || DROP_REQUEST.has(key) || key.startsWith('x-caracal-')) continue
      headers.set(key, Array.isArray(value) ? value.join(', ') : value)
    }
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req, Number.POSITIVE_INFINITY)
    let upstream: Response
    try {
      upstream = await opts.forward(path, { method: req.method, headers, body: body && new Uint8Array(body), signal: abort.signal })
    } catch (err) {
      modelError(res, err)
      return
    }
    const out: Record<string, string> = {}
    upstream.headers.forEach((value, key) => {
      if (!DROP_RESPONSE.has(key)) out[key] = value
    })
    res.writeHead(upstream.status, out)
    if (!upstream.body || req.method === 'HEAD') {
      res.end()
      return
    }
    const stream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0])
    stream.on('error', () => res.destroy())
    stream.pipe(res)
  }

  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    if (!url.startsWith(`${base}/`)) return json(res, 404, { error: 'not_found' })
    const path = url.slice(base.length)
    let handled: Promise<void>
    if (req.method === 'POST' && path === opts.adapter.hookPath) handled = hook(req, res)
    else if (path === '/model' || path.startsWith('/model/') || path.startsWith('/model?'))
      handled = model(req, res, path.slice('/model'.length) || '/')
    else return json(res, 404, { error: 'not_found' })
    handled.catch(() => {
      if (!res.headersSent) json(res, 502, { type: 'error', error: { type: 'api_error', message: 'caracal: broker error' } })
      else res.destroy()
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}${base}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
