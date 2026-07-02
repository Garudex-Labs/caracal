// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Internal-only assembly of the Operator's governed control client from its reserved identity and the deployment's control endpoints.

import { createControlClient, type ControlClient } from './control-client.js'
import type { OperatorControlIdentity } from './config.js'

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

// Builds the Operator's governed control client, or null when governed execution is not
// fully configured. Governed execution is all-or-nothing: it requires both the Operator's
// reserved control identity and an enabled control plane to invoke. A null result means
// the Operator must refuse to execute rather than fall back to any other authority.
export function buildOperatorControlClient(
  identity: OperatorControlIdentity | null,
  endpoints: OperatorControlEndpoints,
  fetchImpl: typeof fetch = fetch,
  zoneScope?: string,
  authorizedBy?: string,
  coAuthorOperator?: boolean,
): ControlClient | null {
  if (!identity || !endpoints.controlEnabled) return null
  return createControlClient(
    {
      stsUrl: endpoints.stsUrl,
      controlUrl: endpoints.controlUrl,
      audience: endpoints.audience,
      applicationId: identity.applicationId,
      clientSecret: identity.clientSecret,
      ttlSeconds: endpoints.ttlSeconds,
      zoneScope,
      authorizedBy,
      coAuthorOperator,
    },
    fetchImpl,
  )
}
