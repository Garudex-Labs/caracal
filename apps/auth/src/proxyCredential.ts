// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Chooses which admin credential the Console BFF presents on a proxied request, keeping the god token off the read path.

// The upstream credential a proxied request presents: the bearer to try first and, only when a
// safe fallback exists, a second bearer to retry with if the first is rejected as unrecognized.
export interface ProxyCredential {
  token: string
  fallbackToken?: string
}

// Whether a proxied request decides a human-approval hold - the exact surface the API grants
// an approve-capability token beyond reads, matched with the same one-resource, two-verb
// precision so the BFF and the API always agree on which credential a request needs.
function isApprovalDecision(method: string, path: string): boolean {
  if (method !== 'POST') return false
  return /^\/v1\/zones\/[^/]+\/approvals\/[^/]+\/(approve|reject)$/.test(path.split('?')[0])
}

// Decides the credential for one proxied console request. A read (GET or HEAD) presents the
// read-only token; a step-up decision presents the approve token, since the API deliberately
// denies the write token that authority; any other write presents the write token. Each may
// fall back to the deployment admin token if its own token is rejected as unrecognized, so a
// not-yet-provisioned or rotated derived token never makes a request fail closed - the admin
// token is the break-glass fallback rather than the everyday credential. When a derived token
// is absent or equal to the admin token there is nothing weaker to prefer and no distinct
// fallback, so the admin token is presented directly.
export function selectProxyCredential(
  method: string,
  path: string,
  adminToken: string,
  readToken: string | undefined,
  writeToken: string | undefined,
  approveToken: string | undefined,
): ProxyCredential {
  const verb = method.toUpperCase()
  const isRead = verb === 'GET' || verb === 'HEAD'
  const preferred = isRead ? readToken : isApprovalDecision(verb, path) ? approveToken : writeToken
  if (preferred && preferred !== adminToken) {
    return { token: preferred, fallbackToken: adminToken }
  }
  return { token: adminToken }
}

// Decides whether a rejected proxied request should be retried once with the fallback
// credential. A retry happens only on 401, which means the presented token was not recognized
// - the case a not-yet-provisioned or rotated read token produces. A 403 is a genuine
// authorization denial (the credential is valid but lacks the authority), so it is surfaced
// unchanged rather than retried under broader authority, which would mask a real policy
// outcome. With no distinct fallback there is nothing to retry with.
export function shouldRetryWithFallback(status: number, token: string, fallbackToken: string | undefined): boolean {
  return status === 401 && fallbackToken !== undefined && fallbackToken !== token
}
