// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Side-effect-free upstream verification probe for Caracal-mandate-backed resources.

import { buildUntrustedProbeMandate, headProbeRequest } from './provider-token.js'

export interface ResourceVerifyResult {
  status: 'guarded' | 'unverified' | 'unreachable' | 'endpoint_error'
  detail: string
  checked_at: string
}

type UpstreamProbe = (rawUrl: string, authorization: string) => Promise<{ statusCode: number }>

// Probes whether a resource's upstream enforces Caracal mandate verification by presenting a
// deliberately-invalid mandate and classifying the response. A correct verifier rejects the
// probe before any business logic runs, so the check is side-effect-free and never presents a
// usable credential: it can reveal that the upstream rejects an invalid mandate (a verifier is
// guarding the URL) or that it accepts one (no verification in place), but it never sends a
// valid mandate and therefore cannot prove the positive path.
export async function runResourceVerificationCheck(
  upstreamUrl: string,
  issuer: string,
  audience: string,
  zoneId: string,
  probe: UpstreamProbe = headProbeRequest,
): Promise<ResourceVerifyResult> {
  const at = new Date().toISOString()
  const mandate = buildUntrustedProbeMandate(issuer, audience, zoneId)
  let statusCode: number
  try {
    ;({ statusCode } = await probe(upstreamUrl, `Bearer ${mandate}`))
  } catch {
    return {
      status: 'unreachable',
      detail: 'The upstream could not be reached.',
      checked_at: at,
    }
  }
  if (statusCode === 401 || statusCode === 403) {
    return {
      status: 'guarded',
      detail: 'The upstream rejected an invalid Caracal mandate, so a verifier is enforcing verification on this URL.',
      checked_at: at,
    }
  }
  if (statusCode >= 200 && statusCode < 300) {
    return {
      status: 'unverified',
      detail:
        'The upstream accepted an invalid Caracal mandate. It is not verifying mandates; add a Caracal verifier or adapter before routing traffic.',
      checked_at: at,
    }
  }
  return {
    status: 'endpoint_error',
    detail: `The upstream returned HTTP ${statusCode}. Confirm the URL points at a route a Caracal verifier guards.`,
    checked_at: at,
  }
}
