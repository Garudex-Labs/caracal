// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// A2A protocol types and AgentServiceConfig for the agent SDK.

export interface AgentServiceConfig {
  url: string
  zoneId: string
  clientId: string
  clientSecret?: string
  clientAssertion?: string
  clientAssertionType?: string
  subjectToken: string
  sessionId?: string
  agentSessionId?: string
  delegationEdgeId?: string
}

export interface ToolTokenOptions {
  scopes?: string[]
  sessionId?: string
  agentSessionId?: string
  delegationEdgeId?: string
  ttlSeconds?: number
}

export interface AgentEndpoint {
  url: string
  protocolVersions: string[]
  transports: Array<'http' | 'sse'>
}

export interface AgentManifest {
  id: string
  name: string
  endpoint: AgentEndpoint
  framework?: {
    name: string
    version?: string
  }
  capabilities: string[]
  metadata?: Record<string, unknown>
}

export interface InvocationEnvelope {
  requestId: string
  method: string
  params: unknown
  subjectToken?: string
  clientId?: string
  zoneId?: string
  resource?: string
  scopes?: string[]
  sessionId?: string
  agentSessionId?: string
  delegationEdgeId?: string
  transport?: 'http' | 'sse' | 'grpc' | 'sdk' | 'mcp' | 'a2a'
  target?: string
  metadata?: Record<string, unknown>
}

export interface InvocationResult {
  requestId: string
  result?: unknown
  error?: AgentError
  metadata?: Record<string, unknown>
}

export interface AgentError {
  code: string
  message: string
  details?: unknown
}

export interface StreamEvent {
  requestId: string
  sequence: number
  event: 'start' | 'chunk' | 'complete' | 'error'
  data?: unknown
}

export interface CancelRequest {
  requestId: string
  reason?: string
}

export interface Heartbeat {
  serviceId: string
  status: 'starting' | 'healthy' | 'degraded' | 'unhealthy'
  activeInvocations: number
  lastHeartbeatAt: string
  metadata?: Record<string, unknown>
}

export interface AgentHttpResponse {
  status: number
  headers: Record<string, string>
  body: unknown
}

export interface A2ARequest {
  agentUrl: string
  resource?: string
  method: string
  params: unknown
  requestId: string
  scopes?: string[]
  sessionId?: string
  agentSessionId?: string
  delegationEdgeId?: string
  metadata?: Record<string, unknown>
}

export interface A2AOptions {
  stsUrl: string
  zoneId?: string
  clientSecret?: string
  clientAssertion?: string
  clientAssertionType?: string
  ttlSeconds?: number
}

export interface A2AResponse {
  result: unknown
  requestId: string
}

export interface AdapterContext {
  config: AgentServiceConfig
  call: (req: A2ARequest) => Promise<A2AResponse>
  tool: (resource: string, opts?: ToolTokenOptions) => Promise<string>
}
