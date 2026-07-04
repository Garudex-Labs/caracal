// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Internal-only assembly of the Operator's governed control client from its reserved identity and the deployment's control endpoints.

import { ControlClient } from '@caracalai/admin'
import type { OperatorControlIdentity } from './config.js'
import type { AgentRole } from './operator-agent-roles.js'

// The deployment endpoints the Operator's control client talks to: the STS that mints its
// scoped tokens and the control plane it invokes. controlUrl is the API's own base, since
// the Operator invokes the control plane in-process over the loopback interface.
export interface OperatorControlEndpoints {
  stsUrl: string
  audience: string
  controlUrl: string
  // Governed execution requires the control plane to be enabled; when it is not, no client
  // is built and the Operator reports governed execution as unconfigured rather than
  // executing through an absent control surface.
  controlEnabled: boolean
  // The short lifetime requested for each minted token. Tokens are single-use, so this
  // only bounds the window between mint and invoke.
  ttlSeconds?: number
}

export interface OperatorControlClientInput {
  identity: OperatorControlIdentity | null
  role: AgentRole
  endpoints: OperatorControlEndpoints
  fetchImpl?: typeof fetch
  zoneScope?: string
  authorizedBy?: string
  coAuthorOperator?: boolean
  requestId?: string
}

// Builds the governed control client for one Operator role, or null when governed execution
// is not fully configured. Governed execution is all-or-nothing: it requires the Operator's
// resolved identities and an enabled control plane to invoke. Each role invokes as its own
// reserved application, so the STS can only mint the scopes that role's traits grant. A null
// result means the Operator must refuse to execute rather than fall back to any other
// authority.
export function buildOperatorControlClient(input: OperatorControlClientInput): ControlClient | null {
  if (!input.identity || !input.endpoints.controlEnabled) return null
  const credential = input.identity[input.role]
  return new ControlClient({
    stsUrl: input.endpoints.stsUrl,
    controlUrl: input.endpoints.controlUrl,
    audience: input.endpoints.audience,
    applicationId: credential.applicationId,
    clientSecret: credential.clientSecret,
    ttlSeconds: input.endpoints.ttlSeconds,
    zoneScope: input.zoneScope,
    authorizedBy: input.authorizedBy,
    coAuthorOperator: input.coAuthorOperator,
    requestId: input.requestId,
    fetchImpl: input.fetchImpl,
  })
}
