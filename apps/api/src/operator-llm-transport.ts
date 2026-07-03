// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Data-plane transport that mints a Caracal resource mandate for a governed LLM upstream and presents it at the gateway so the Operator never holds the upstream key.

import { OAuthClient } from '@caracalai/oauth'

// The reserved role label the system-zone grant authorizes on the governed LLM resource.
// The minting agent must carry it for the data-document grant's role to match, and it is the
// label the provisioned policy maps to llm:invoke.
const OPERATOR_LABEL = 'operator'
const LIFECYCLE_SCOPE = 'agent:lifecycle'
const LLM_SCOPE = 'llm:invoke'

// A minted resource mandate cached for its usable lifetime. The target agent session whose
// liveness the gateway re-exchange depends on is spawned with a ttl that outlives the
// mandate, so the mandate stays usable for its full lifetime and the session is reaped by
// its ttl once superseded.
interface CachedMandate {
  mandate: string
  expiresAt: number
}

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
  // The lifetime requested for each minted mandate. The spawned agent sessions outlive it by
  // a buffer so the target session is still active when the gateway re-exchanges the mandate.
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

const DEFAULT_MANDATE_TTL_SECONDS = 900
const REFRESH_MARGIN_SECONDS = 60
const AGENT_TTL_BUFFER_SECONDS = 120

// A mint cycle failed. stage names the step so a token-exchange failure reads differently
// from a coordinator failure; reason carries no client secret and is safe to surface.
export class OperatorLlmTransportError extends Error {
  constructor(
    public readonly stage: 'identity' | 'bootstrap' | 'spawn' | 'delegate' | 'mint',
    public readonly reason: string,
  ) {
    super(`operator llm transport ${stage} failed: ${reason}`)
    this.name = 'OperatorLlmTransportError'
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export function createOperatorLlmTransport(config: OperatorLlmTransportConfig): OperatorLlmTransport {
  const fetchImpl = config.fetchImpl ?? fetch
  const stsUrl = config.stsUrl.replace(/\/+$/, '')
  const coordinatorUrl = config.coordinatorUrl.replace(/\/+$/, '')
  const gatewayUrl = config.gatewayUrl.replace(/\/+$/, '')
  const mandateTtl = config.mandateTtlSeconds ?? DEFAULT_MANDATE_TTL_SECONDS
  const agentTtl = mandateTtl + AGENT_TTL_BUFFER_SECONDS

  const cache = new Map<string, CachedMandate>()
  const inflight = new Map<string, Promise<CachedMandate>>()

  // Spawns one short-lived agent session as the Operator, authorized by the bootstrap
  // mandate. The session carries the operator label so the data-document grant's role matches
  // when it later mints and presents. Returns the new agent session id.
  async function spawnAgent(bootstrap: string, identity: OperatorTransportIdentity): Promise<string> {
    const res = await fetchImpl(`${coordinatorUrl}/zones/${encodeURIComponent(identity.zoneId)}/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bootstrap}` },
      body: JSON.stringify({ application_id: identity.applicationId, labels: [OPERATOR_LABEL], ttl_seconds: agentTtl }),
    })
    if (!res.ok) throw new Error(`spawn agent failed (${res.status}): ${await res.text()}`)
    const body = (await res.json()) as { agent_session_id?: string }
    if (!body.agent_session_id) throw new Error('spawn agent returned no agent_session_id')
    return body.agent_session_id
  }

  // Issues a delegation edge from the source agent session to the target, narrowing the
  // target to llm:invoke on the governed resource. The edge is what lets the target mint a
  // resource mandate the delegated-mint decision accepts; the resource constraint scopes the
  // edge to exactly this upstream. Returns the new edge id.
  async function createDelegation(
    bootstrap: string,
    identity: OperatorTransportIdentity,
    sourceSessionId: string,
    targetSessionId: string,
    resourceIdentifier: string,
  ): Promise<string> {
    const res = await fetchImpl(`${coordinatorUrl}/zones/${encodeURIComponent(identity.zoneId)}/delegations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bootstrap}` },
      body: JSON.stringify({
        issuer_application_id: identity.applicationId,
        receiver_application_id: identity.applicationId,
        source_session_id: sourceSessionId,
        target_session_id: targetSessionId,
        scopes: [LLM_SCOPE],
        constraints: { resources: [resourceIdentifier] },
        ttl_seconds: agentTtl,
      }),
    })
    if (!res.ok) throw new Error(`create delegation failed (${res.status}): ${await res.text()}`)
    const body = (await res.json()) as { delegation_edge_id?: string }
    if (!body.delegation_edge_id) throw new Error('create delegation returned no delegation_edge_id')
    return body.delegation_edge_id
  }

  // Best-effort retirement of an agent session. Used only to clean up the sessions of a cycle
  // that failed before producing a usable mandate; a successful cycle's sessions are reaped by
  // their ttl, so this never races an in-flight gateway call.
  async function terminateAgent(bootstrap: string, zoneId: string, agentSessionId: string): Promise<void> {
    await fetchImpl(`${coordinatorUrl}/zones/${encodeURIComponent(zoneId)}/agents/${encodeURIComponent(agentSessionId)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${bootstrap}` },
    })
  }

  // One OAuth client per resolved identity. Its token cache lets the bootstrap session be
  // reused across mint cycles and dedups concurrent exchanges; a changed identity (which
  // should not happen in a running process) rebuilds it so a stale secret is never presented.
  let oauth: { client: OAuthClient; key: string } | null = null
  function oauthFor(identity: OperatorTransportIdentity): OAuthClient {
    const key = `${identity.zoneId}::${identity.applicationId}`
    if (!oauth || oauth.key !== key) {
      oauth = { client: new OAuthClient(stsUrl, identity.zoneId, identity.applicationId, undefined, fetchImpl), key }
    }
    return oauth.client
  }

  // Runs the full delegated-mint flow for one resource: bootstrap a session mandate on the
  // resource the Operator owns, spawn a source and a target agent session (a delegation needs
  // two distinct endpoints), issue a delegation edge narrowing the target to llm:invoke on
  // the resource, then mint the resource mandate as the application principal referencing the
  // target session and edge. The mandate carries the agent session, edge, and resource target
  // in its claims, which is exactly what the gateway re-exchange authorizes.
  async function mintCycle(identity: OperatorTransportIdentity, resourceIdentifier: string): Promise<CachedMandate> {
    const client = oauthFor(identity)
    let bootstrap: string
    try {
      const res = await client.exchange('', resourceIdentifier, { clientSecret: identity.clientSecret, scopes: [LIFECYCLE_SCOPE] })
      bootstrap = res.accessToken
    } catch (err) {
      throw new OperatorLlmTransportError('bootstrap', describe(err))
    }

    const spawned: string[] = []
    try {
      let source: string
      let target: string
      try {
        source = await spawnAgent(bootstrap, identity)
        spawned.push(source)
        target = await spawnAgent(bootstrap, identity)
        spawned.push(target)
      } catch (err) {
        throw new OperatorLlmTransportError('spawn', describe(err))
      }

      let edgeId: string
      try {
        edgeId = await createDelegation(bootstrap, identity, source, target, resourceIdentifier)
      } catch (err) {
        throw new OperatorLlmTransportError('delegate', describe(err))
      }

      let mandate: string
      let expiresIn: number
      try {
        const minted = await client.exchange('', resourceIdentifier, {
          clientSecret: identity.clientSecret,
          scopes: [LLM_SCOPE],
          agentSessionId: target,
          delegationEdgeId: edgeId,
          ttlSeconds: mandateTtl,
        })
        mandate = minted.accessToken
        expiresIn = minted.expiresIn
      } catch (err) {
        throw new OperatorLlmTransportError('mint', describe(err))
      }
      return { mandate, expiresAt: Date.now() / 1000 + expiresIn }
    } catch (err) {
      // The cycle did not produce a usable mandate, so the sessions it spawned are orphaned;
      // terminate them best-effort rather than leak agent sessions until their ttl expires.
      await Promise.allSettled(spawned.map((id) => terminateAgent(bootstrap, identity.zoneId, id)))
      throw err
    }
  }

  async function ensureMandate(resourceIdentifier: string): Promise<CachedMandate> {
    const cached = cache.get(resourceIdentifier)
    if (cached && Date.now() / 1000 < cached.expiresAt - REFRESH_MARGIN_SECONDS) return cached

    const existing = inflight.get(resourceIdentifier)
    if (existing) return existing

    const identity = config.resolveIdentity()
    if (!identity) throw new OperatorLlmTransportError('identity', 'operator system-zone identity is not provisioned')

    const pending = (async () => {
      try {
        const fresh = await mintCycle(identity, resourceIdentifier)
        cache.set(resourceIdentifier, fresh)
        return fresh
      } finally {
        inflight.delete(resourceIdentifier)
      }
    })()
    inflight.set(resourceIdentifier, pending)
    return pending
  }

  return {
    governedFetch(resourceIdentifier: string): typeof fetch {
      return (async (input: RequestInfo | URL, init?: RequestInit) => {
        const { mandate } = await ensureMandate(resourceIdentifier)
        const headers = new Headers(init?.headers ?? {})
        headers.set('Authorization', `Bearer ${mandate}`)
        headers.set('X-Caracal-Resource', resourceIdentifier)
        const url = typeof input === 'string' || input instanceof URL ? input : (input as Request).url
        return fetchImpl(url as URL, { ...init, headers })
      }) as typeof fetch
    },
  }
}
