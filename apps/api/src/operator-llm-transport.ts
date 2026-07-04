// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Data-plane transport that routes governed LLM calls through the Caracal gateway on SDK-minted resource mandates so the Operator never holds the upstream key.

import { Caracal } from '@caracalai/sdk'

// The reserved role label the system-zone grant authorizes on the governed LLM resource.
// The minting agent must carry it for the data-document grant's role to match, and it is the
// label the provisioned policy maps to llm:invoke.
const OPERATOR_LABEL = 'operator'
const LLM_SCOPE = 'llm:invoke'

// The Operator's resolved system-zone identity. Supplied by a getter rather than a static
// value because it is provisioned after the server is listening; a null result means
// governed execution is not yet configured and every governed call fails closed.
export interface OperatorTransportIdentity {
  zoneId: string
  applicationId: string
  clientSecret: string
}

export interface OperatorLlmTransportConfig {
  stsUrl: string
  coordinatorUrl: string
  gatewayUrl: string
  resolveIdentity: () => OperatorTransportIdentity | null
  // The lifetime requested for each minted mandate. The SDK spawns the backing agent
  // sessions with a ttl that outlives it, so the mandate stays usable for its full lifetime.
  mandateTtlSeconds?: number
  fetchImpl?: typeof fetch
}

export interface OperatorLlmTransport {
  // A fetch bound to one governed resource: it presents that resource's current mandate and
  // resource header on every outbound request, routing it through the gateway which injects
  // the sealed upstream key. The AI SDK calls it with the gateway base URL, so the request is
  // already gateway-addressed and only needs authority attached.
  governedFetch(resourceIdentifier: string): typeof fetch
}

// A governed call was attempted before the system-zone identity was provisioned. Mint-cycle
// failures surface as the SDK's own error types (CaracalError, CoordinatorError,
// InteractionRequiredError), each already free of the client secret.
export class OperatorLlmTransportError extends Error {
  constructor(public readonly reason: string) {
    super(`operator llm transport identity failed: ${reason}`)
    this.name = 'OperatorLlmTransportError'
  }
}

export function createOperatorLlmTransport(config: OperatorLlmTransportConfig): OperatorLlmTransport {
  // One SDK facade per resolved identity and governed resource. The facade holds its sealed
  // credential in its token source, so when rotation reseals the secret the entry is rebuilt
  // rather than ever presenting a stale credential; the mandate cache and delegated-mint
  // cycle live inside Caracal.governedTransport.
  const facades = new Map<string, { identity: OperatorTransportIdentity; transport: typeof fetch }>()
  function transportFor(identity: OperatorTransportIdentity, resourceIdentifier: string): typeof fetch {
    const existing = facades.get(resourceIdentifier)
    if (
      existing &&
      existing.identity.zoneId === identity.zoneId &&
      existing.identity.applicationId === identity.applicationId &&
      existing.identity.clientSecret === identity.clientSecret
    ) {
      return existing.transport
    }
    const caracal = Caracal.fromClientSecret({
      coordinatorUrl: config.coordinatorUrl,
      stsUrl: config.stsUrl,
      zoneId: identity.zoneId,
      applicationId: identity.applicationId,
      clientSecret: identity.clientSecret,
      resources: [resourceIdentifier],
      gatewayUrl: config.gatewayUrl,
      fetchImpl: config.fetchImpl,
    })
    const transport = caracal.governedTransport(resourceIdentifier, {
      scopes: [LLM_SCOPE],
      labels: [OPERATOR_LABEL],
      mandateTtlSeconds: config.mandateTtlSeconds,
    })
    facades.set(resourceIdentifier, { identity, transport })
    return transport
  }

  return {
    governedFetch(resourceIdentifier: string): typeof fetch {
      return (async (input: RequestInfo | URL, init?: RequestInit) => {
        const identity = config.resolveIdentity()
        if (!identity) throw new OperatorLlmTransportError('operator system-zone identity is not provisioned')
        return transportFor(identity, resourceIdentifier)(input, init)
      }) as typeof fetch
    },
  }
}
