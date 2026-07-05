// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Fetch-standard helpers: authenticate a Request and render an error Response.

import { authenticate, extractBearer, httpStatusForAuthError, type AuthDeps } from './authenticate.js'
import type { AuthError, AuthResult } from './types.js'

// authErrorBody renders the canonical OAuth-style JSON error body shared by all
// HTTP adapters.
export function authErrorBody(err: AuthError): { error: string; error_description: string; error_hint?: string } {
  return {
    error: err.code,
    error_description: err.description,
    ...(err.hint ? { error_hint: err.hint } : {}),
  }
}

// authenticateRequest verifies the bearer mandate on a fetch-standard Request.
// It works in any runtime with WinterTC Request/Response globals: Node 18+,
// Deno, Bun, and edge workers.
export async function authenticateRequest(request: Request, deps: AuthDeps): Promise<AuthResult> {
  const token = extractBearer(request.headers.get('authorization') ?? undefined)
  return authenticate(token ?? '', deps)
}

// unauthorizedResponse renders an AuthError as a fetch-standard JSON Response
// using the same status mapping and body shape as the framework adapters.
export function unauthorizedResponse(error: AuthError): Response {
  return new Response(JSON.stringify(authErrorBody(error)), {
    status: httpStatusForAuthError(error.code),
    headers: { 'content-type': 'application/json' },
  })
}
