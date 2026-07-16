// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the side-effect-free resource mandate verification probe.

import { describe, it, expect } from 'vitest'
import { runResourceVerificationCheck } from '../../../../apps/api/src/resource-verify.js'

const UPSTREAM = 'https://api.pipernet.example/mcp'
const ISSUER = 'http://sts.test'
const AUDIENCE = 'resource://pipernet'
const ZONE = 'z1'

describe('runResourceVerificationCheck', () => {
  it('reports guarded when the upstream rejects the invalid mandate with 401', async () => {
    const result = await runResourceVerificationCheck(UPSTREAM, ISSUER, AUDIENCE, ZONE, async () => ({ statusCode: 401 }))
    expect(result.status).toBe('guarded')
  })

  it('treats 403 as guarded', async () => {
    const result = await runResourceVerificationCheck(UPSTREAM, ISSUER, AUDIENCE, ZONE, async () => ({ statusCode: 403 }))
    expect(result.status).toBe('guarded')
  })

  it('reports unverified when the upstream accepts the invalid mandate', async () => {
    const result = await runResourceVerificationCheck(UPSTREAM, ISSUER, AUDIENCE, ZONE, async () => ({ statusCode: 200 }))
    expect(result.status).toBe('unverified')
  })

  it('reports unreachable when the probe cannot connect', async () => {
    const result = await runResourceVerificationCheck(UPSTREAM, ISSUER, AUDIENCE, ZONE, async () => {
      throw new Error('resolves to a non-routable address')
    })
    expect(result.status).toBe('unreachable')
  })

  it('reports endpoint_error for other status codes', async () => {
    const result = await runResourceVerificationCheck(UPSTREAM, ISSUER, AUDIENCE, ZONE, async () => ({ statusCode: 404 }))
    expect(result.status).toBe('endpoint_error')
    expect(result.detail).toContain('404')
  })

  it('presents an untrusted probe mandate as a bearer credential rather than any real token', async () => {
    let seen = ''
    await runResourceVerificationCheck(UPSTREAM, ISSUER, AUDIENCE, ZONE, async (_url, authorization) => {
      seen = authorization
      return { statusCode: 401 }
    })
    expect(seen.startsWith('Bearer ')).toBe(true)
    const jwt = seen.slice('Bearer '.length)
    // The probe mandate is a real JWT signed with a throwaway key absent from Caracal's JWKS,
    // so a correct verifier rejects it before any business logic runs.
    expect(jwt.split('.')).toHaveLength(3)
  })

  it('probes the exact upstream URL it is given', async () => {
    let seen = ''
    await runResourceVerificationCheck(UPSTREAM, ISSUER, AUDIENCE, ZONE, async (url) => {
      seen = url
      return { statusCode: 401 }
    })
    expect(seen).toBe(UPSTREAM)
  })
})
