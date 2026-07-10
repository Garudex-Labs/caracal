// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Express middleware that delegates bearer verification to @caracalai/verify.

import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { Claims } from '@caracalai/identity'
import {
  authenticate,
  authErrorBody,
  extractBearer,
  httpStatusForAuthError,
  type AuthDeps,
  type AuthError,
  type AuthOverrides,
  type MandateVerifier,
} from '@caracalai/verify'
import { bind, fromHeaders, type CaracalContext } from '@caracalai/sdk/advanced'

export interface MiddlewareOptions extends AuthDeps {
  bindContext?: boolean
}

export interface VerifierMiddlewareOptions {
  verifier: MandateVerifier
  bindContext?: boolean
}

export interface CaracalRequest extends Request {
  caracal?: Claims
  caracalClaims?: Claims
  caracalContext?: CaracalContext
}

export function caracalAuth(opts: MiddlewareOptions | VerifierMiddlewareOptions, route: AuthOverrides = {}): RequestHandler {
  return async (req: CaracalRequest, res: Response, next: NextFunction): Promise<void> => {
    const token = extractBearer(req.headers['authorization'])
    if (!token) {
      const { status, body } = mapError({ code: 'missing_token', description: 'Missing bearer token' })
      res.status(status).json(body)
      return
    }

    const result = 'verifier' in opts ? await opts.verifier.authenticate(token, route) : await authenticate(token, { ...opts, ...route })
    if (!result.ok) {
      const { status, body } = mapError(result.error)
      res.status(status).json(body)
      return
    }

    req.caracal = result.principal
    req.caracalClaims = result.principal

    const env = fromHeaders(req.headers as Record<string, string | string[] | undefined>)
    const baseCtx: CaracalContext = {
      subjectToken: token,
      zoneId: result.principal.zoneId ?? middlewareZone(opts) ?? '',
      applicationId: result.principal.clientId ?? '',
      sessionId: result.principal.sessionId ?? env.sessionId,
      delegationId: result.principal.delegationId ?? env.delegationId,
      parentDelegationId: env.parentDelegationId,
      subjectAuthorityRecordId: result.principal.authorityRecordId,
      traceId: env.traceId,
      traceFlags: env.traceFlags,
      traceState: env.traceState,
      baggage: env.baggage,
      hop: result.principal.hopCount ?? env.hop,
    }
    req.caracalContext = baseCtx

    if (opts.bindContext === false) {
      next()
      return
    }

    bind(baseCtx, () => {
      next()
    })
  }
}

function mapError(err: AuthError): { status: number; body: { error: string; error_description: string; error_hint?: string } } {
  return { status: httpStatusForAuthError(err.code), body: authErrorBody(err) }
}

function middlewareZone(opts: MiddlewareOptions | VerifierMiddlewareOptions): string | undefined {
  return 'verifier' in opts ? opts.verifier.defaults.zoneId : opts.zoneId
}
