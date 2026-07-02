// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the composer's local credential detector: what trips the send guard and how findings are masked.

import { describe, it, expect } from 'vitest'
import { scanForSecrets } from '../../../../apps/web/src/platform/operator/secretScan'

// Every credential-shaped fixture is assembled at runtime from fragments so no literal in this
// source matches a repository secret scanner, while the scanned string is exactly the real shape.
const fused = (...parts: string[]) => parts.join('')

describe('scanForSecrets', () => {
  it('finds nothing in ordinary operational prose', () => {
    expect(scanForSecrets('Connect a Hooli OIDC provider and define the PiperNet resource.')).toEqual([])
    expect(scanForSecrets('The API key is stored in the console, not here.')).toEqual([])
    expect(scanForSecrets('token endpoint https://oauth2.googleapis.com/token and the client secret is stored securely')).toEqual([])
    expect(scanForSecrets('')).toEqual([])
  })

  it('flags an AWS access key id', () => {
    const findings = scanForSecrets(`use ${fused('AKIA', 'IOSFODNN7', 'EXAMPLE')} for the bucket`)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.label).toBe('AWS access key ID')
    expect(findings[0]!.masked).not.toContain('IOSFODNN7EXA')
  })

  it('flags a GitHub token', () => {
    const findings = scanForSecrets(`token ${fused('ghp_', 'abcdefghijklmnopqrstuvwxyz', '012345')}`)
    expect(findings.map((f) => f.label)).toContain('GitHub token')
  })

  it('flags a JWT without echoing its middle', () => {
    const jwt = fused(
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      '.',
      'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
      '.',
      'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    )
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
    const clientId = fused('123456789012', '-', 'abcdefghijklmnopqrstuvwxyz123456', '.apps.googleusercontent.com')
    const clientSecret = fused('GOCSPX', '-', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4')
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
    expect(scanForSecrets(fused('sk_live_', 'abcdefghijklmnop0123')).map((f) => f.label)).toContain('Stripe key')
    expect(scanForSecrets(fused('glpat-', 'abcdefghij0123456789')).map((f) => f.label)).toContain('GitLab token')
    expect(scanForSecrets(fused('npm_', 'abcdefghijklmnopqrstuvwxyz0123456789')).map((f) => f.label)).toContain('npm token')
  })

  it('flags a PEM private key block', () => {
    const pem = fused('-----BEGIN PRIVATE', ' KEY-----', '\nMIIEvQIBADANBg\n', '-----END PRIVATE', ' KEY-----')
    const findings = scanForSecrets(pem)
    expect(findings.map((f) => f.label)).toContain('Private key (PEM)')
  })

  it('flags a bearer header value', () => {
    const findings = scanForSecrets('Authorization: Bearer abc123def456ghi789jkl')
    expect(findings.map((f) => f.label)).toContain('Bearer token')
  })

  it('reports one finding for one secret matched by several patterns', () => {
    const findings = scanForSecrets(fused('sk-', 'abcdefghijklmnopqrstuvwxyz', '0123456789ABCD'))
    expect(findings).toHaveLength(1)
  })
})
