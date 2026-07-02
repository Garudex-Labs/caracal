// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the composer's local credential detector: what trips the send guard and how findings are masked.

import { describe, it, expect } from 'vitest'
import { scanForSecrets } from '../../../../apps/web/src/platform/operator/secretScan'

describe('scanForSecrets', () => {
  it('finds nothing in ordinary operational prose', () => {
    expect(scanForSecrets('Connect a Hooli OIDC provider and define the PiperNet resource.')).toEqual([])
    expect(scanForSecrets('The API key is stored in the console, not here.')).toEqual([])
    expect(scanForSecrets('token endpoint https://oauth2.googleapis.com/token and the client secret is stored securely')).toEqual([])
    expect(scanForSecrets('')).toEqual([])
  })

  it('flags an AWS access key id', () => {
    const findings = scanForSecrets('use AKIAIOSFODNN7EXAMPLE for the bucket')
    expect(findings).toHaveLength(1)
    expect(findings[0]!.label).toBe('AWS access key ID')
    expect(findings[0]!.masked).not.toContain('IOSFODNN7EXA')
  })

  it('flags a GitHub token', () => {
    const findings = scanForSecrets('token ghp_abcdefghijklmnopqrstuvwxyz012345')
    expect(findings.map((f) => f.label)).toContain('GitHub token')
  })

  it('flags a JWT without echoing its middle', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
    const findings = scanForSecrets(`here is my session ${jwt}`)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.label).toBe('JWT')
    expect(findings[0]!.masked.length).toBeLessThan(20)
  })

  it('flags a key=value credential assignment', () => {
    const findings = scanForSecrets('client_secret=sup3rs3cretvalue')
    expect(findings.map((f) => f.label)).toContain('Assigned credential')
  })

  it('flags a Google OAuth client id and secret pasted as labeled lines', () => {
    // Assembled at runtime so no credential-shaped literal sits in the source for scanners to flag.
    const clientId = ['123456789012', '-', 'abcdefghijklmnopqrstuvwxyz123456', '.apps.googleusercontent.com'].join('')
    const clientSecret = ['GOCSPX', '-', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4'].join('')
    const findings = scanForSecrets(`id ${clientId}\nsecret ${clientSecret}`)
    expect(findings.map((f) => f.label)).toContain('Google OAuth client ID')
    expect(findings.map((f) => f.label)).toContain('Google OAuth client secret')
    expect(findings).toHaveLength(2)
  })

  it('flags a credential value after a bare label with no separator', () => {
    const findings = scanForSecrets('password Tr0ub4dor.and.3lephants')
    expect(findings.map((f) => f.label)).toContain('Labeled credential')
    expect(scanForSecrets('password everywhere in the audit trail')).toEqual([])
  })

  it('flags vendor-prefixed keys', () => {
    expect(scanForSecrets('sk_live_abcdefghijklmnop0123').map((f) => f.label)).toContain('Stripe key')
    expect(scanForSecrets('glpat-abcdefghij0123456789').map((f) => f.label)).toContain('GitLab token')
    expect(scanForSecrets('npm_abcdefghijklmnopqrstuvwxyz0123456789').map((f) => f.label)).toContain('npm token')
  })

  it('flags a PEM private key block', () => {
    const findings = scanForSecrets('-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----')
    expect(findings.map((f) => f.label)).toContain('Private key (PEM)')
  })

  it('flags a bearer header value', () => {
    const findings = scanForSecrets('Authorization: Bearer abc123def456ghi789jkl')
    expect(findings.map((f) => f.label)).toContain('Bearer token')
  })

  it('reports one finding for one secret matched by several patterns', () => {
    const findings = scanForSecrets('sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD')
    expect(findings).toHaveLength(1)
  })
})
