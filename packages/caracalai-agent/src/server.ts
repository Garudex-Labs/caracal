// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Framework-neutral agent protocol bootstrap helpers.

import type {
  AgentManifest,
  AgentHttpResponse,
  CancelRequest,
  Heartbeat,
  InvocationEnvelope,
  InvocationResult,
  StreamEvent,
} from './types.js'

export interface AgentServerHandlers {
  invoke: (envelope: InvocationEnvelope) => Promise<InvocationResult>
  stream?: (envelope: InvocationEnvelope) => AsyncIterable<StreamEvent>
  cancel?: (request: CancelRequest) => Promise<InvocationResult>
  heartbeat?: () => Promise<Heartbeat>
}

export interface AgentServer {
  manifest: () => AgentManifest
  health: () => Promise<Heartbeat>
  invoke: (envelope: InvocationEnvelope) => Promise<InvocationResult>
  stream: (envelope: InvocationEnvelope) => AsyncIterable<StreamEvent>
  cancel: (request: CancelRequest) => Promise<InvocationResult>
}

export const AgentProtocolPaths = {
  manifest: '/manifest',
  heartbeat: '/heartbeat',
  invoke: '/invoke',
  stream: '/stream',
  cancel: '/cancel',
  a2a: '/a2a',
} as const

export interface AgentRouteAuth {
  authorization?: string
}

export type AgentAuthorizer = (
  auth: AgentRouteAuth,
  envelope: InvocationEnvelope,
) => Promise<InvocationEnvelope> | InvocationEnvelope

export interface AgentHttpRoutes {
  manifest: () => Promise<AgentHttpResponse>
  heartbeat: () => Promise<AgentHttpResponse>
  invoke: (body: InvocationEnvelope, auth?: AgentRouteAuth) => Promise<AgentHttpResponse>
  stream: (body: InvocationEnvelope, auth?: AgentRouteAuth) => Promise<AgentHttpResponse>
  cancel: (body: CancelRequest) => Promise<AgentHttpResponse>
  a2a: (body: InvocationEnvelope, auth?: AgentRouteAuth) => Promise<AgentHttpResponse>
}

export function createAgentServer(
  manifest: AgentManifest,
  handlers: AgentServerHandlers,
): AgentServer {
  return {
    manifest: (): AgentManifest => manifest,
    health: async (): Promise<Heartbeat> => handlers.heartbeat?.() ?? ({
      serviceId: manifest.id,
      status: 'healthy',
      activeInvocations: 0,
      lastHeartbeatAt: new Date().toISOString(),
    }),
    invoke: handlers.invoke,
    stream: (envelope: InvocationEnvelope): AsyncIterable<StreamEvent> => {
      if (!handlers.stream) return emptyStream(envelope.requestId)
      return handlers.stream(envelope)
    },
    cancel: async (request: CancelRequest): Promise<InvocationResult> => handlers.cancel?.(request) ?? ({
      requestId: request.requestId,
      error: {
        code: 'cancel_unsupported',
        message: 'Cancellation is not supported by this agent service',
      },
    }),
  }
}

export function createAgentHttpRoutes(server: AgentServer): AgentHttpRoutes {
  return {
    manifest: async (): Promise<AgentHttpResponse> => jsonResponse(200, server.manifest()),
    heartbeat: async (): Promise<AgentHttpResponse> => jsonResponse(200, await server.health()),
    invoke: async (): Promise<AgentHttpResponse> => unauthorized(),
    stream: async (): Promise<AgentHttpResponse> => unauthorized(),
    cancel: async (body: CancelRequest): Promise<AgentHttpResponse> => jsonResponse(200, await server.cancel(body)),
    a2a: async (): Promise<AgentHttpResponse> => unauthorized(),
  }
}

export function createAuthorizedAgentHttpRoutes(
  server: AgentServer,
  authorize: AgentAuthorizer,
): AgentHttpRoutes {
  return {
    manifest: async (): Promise<AgentHttpResponse> => jsonResponse(200, server.manifest()),
    heartbeat: async (): Promise<AgentHttpResponse> => jsonResponse(200, await server.health()),
    invoke: async (body: InvocationEnvelope, auth?: AgentRouteAuth): Promise<AgentHttpResponse> => {
      try {
        const envelope = await authorize(auth ?? {}, body)
        return jsonResponse(200, await server.invoke(envelope))
      } catch (err) {
        return jsonResponse(500, agentError(body.requestId, err))
      }
    },
    stream: async (body: InvocationEnvelope, auth?: AgentRouteAuth): Promise<AgentHttpResponse> => {
      try {
        const envelope = await authorize(auth ?? {}, body)
        return {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
          body: await streamBody(server.stream(envelope)),
        }
      } catch (err) {
        return jsonResponse(500, agentError(body.requestId, err))
      }
    },
    cancel: async (body: CancelRequest): Promise<AgentHttpResponse> => jsonResponse(200, await server.cancel(body)),
    a2a: async (body: InvocationEnvelope, auth?: AgentRouteAuth): Promise<AgentHttpResponse> => {
      try {
        const envelope = await authorize(auth ?? {}, body)
        return jsonResponse(200, await server.invoke(envelope))
      } catch (err) {
        return jsonResponse(500, agentError(body.requestId, err))
      }
    },
  }
}

function unauthorized(): AgentHttpResponse {
  return jsonResponse(401, {
    error: {
      code: 'missing_authorizer',
      message: 'Agent route authorizer is required',
    },
  })
}

function jsonResponse(status: number, body: unknown): AgentHttpResponse {
  return {
    status,
    headers: { 'Content-Type': 'application/json' },
    body,
  }
}

function agentError(requestId: string, err: unknown): InvocationResult {
  return {
    requestId,
    error: {
      code: 'agent_handler_failed',
      message: err instanceof Error ? err.message : 'Agent handler failed',
    },
  }
}

async function streamBody(events: AsyncIterable<StreamEvent>): Promise<string> {
  let body = ''
  for await (const event of events) {
    body += `event: ${event.event}\n`
    body += `data: ${JSON.stringify(event)}\n\n`
  }
  return body
}

async function* emptyStream(requestId: string): AsyncIterable<StreamEvent> {
  yield {
    requestId,
    sequence: 0,
    event: 'complete',
  }
}
