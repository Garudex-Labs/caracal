// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the authentication backend configuration: TLS posture, cookie security, origins, and migration gating.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../../../../apps/auth/src/config.ts'

const SAVED = { ...process.env }

function reset(env: Record<string, string | undefined>): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('CARACAL_') || key === 'NODE_ENV' || key === 'DATABASE_URL' || key === 'PORT' || key === 'HOST') {
      delete process.env[key]
    }
  }
  // A database URL and signing secret are always required; supply them so the cases under test
  // exercise the dimension they target rather than the required-field guards.
  process.env.CARACAL_AUTH_DATABASE_URL = 'postgres://u:p@db:5432/caracal_auth'
  process.env.CARACAL_AUTH_SECRET = '0123456789abcdef0123456789abcdef'
  Object.assign(process.env, env)
}

beforeEach(() => reset({}))
afterEach(() => {
  process.env = { ...SAVED }
})

describe('required fields', () => {
  it('fails closed without a database url', () => {
    delete process.env.CARACAL_AUTH_DATABASE_URL
    expect(() => loadConfig()).toThrow(/CARACAL_AUTH_DATABASE_URL is required/)
  })

  it('fails closed without a signing secret', () => {
    delete process.env.CARACAL_AUTH_SECRET
    expect(() => loadConfig()).toThrow(/CARACAL_AUTH_SECRET is required/)
  })
})

describe('secure cookies', () => {
  it('defaults on in production', () => {
    reset({ NODE_ENV: 'production', CARACAL_AUTH_URL: 'http://auth-internal:3002' })
    expect(loadConfig().secureCookies).toBe(true)
  })

  it('derives from an https base url outside production', () => {
    reset({ CARACAL_AUTH_URL: 'https://auth.example.com' })
    expect(loadConfig().secureCookies).toBe(true)
  })

  it('is off for a plain-http local base url', () => {
    reset({ CARACAL_AUTH_URL: 'http://localhost:3002' })
    expect(loadConfig().secureCookies).toBe(false)
  })

  it('honors an explicit override', () => {
    reset({ CARACAL_AUTH_URL: 'https://auth.example.com', CARACAL_AUTH_SECURE_COOKIES: 'false' })
    expect(loadConfig().secureCookies).toBe(false)
  })
})

describe('database TLS posture', () => {
  it('requires TLS by default in production', () => {
    reset({ NODE_ENV: 'production' })
    expect(loadConfig().ssl).toBe('require')
  })

  it('honors an explicit disable even in production', () => {
    reset({ NODE_ENV: 'production', CARACAL_AUTH_DATABASE_SSL: 'disable' })
    expect(loadConfig().ssl).toBe('disable')
  })

  it('supports no-verify for self-signed managed chains', () => {
    reset({ CARACAL_AUTH_DATABASE_SSL: 'no-verify' })
    expect(loadConfig().ssl).toBe('no-verify')
  })

  it('defaults to plaintext for local development', () => {
    expect(loadConfig().ssl).toBe('disable')
  })
})

describe('trusted web origins', () => {
  it('always trusts its own origin and any configured origins', () => {
    reset({
      CARACAL_AUTH_URL: 'https://app.example.com',
      CARACAL_WEB_ORIGIN: 'https://www.example.com, https://staging.example.com',
    })
    const origins = loadConfig().webOrigins
    expect(origins).toContain('https://app.example.com')
    expect(origins).toContain('https://www.example.com')
    expect(origins).toContain('https://staging.example.com')
  })

  it('ignores malformed origin entries', () => {
    reset({ CARACAL_WEB_ORIGIN: 'not a url' })
    expect(loadConfig().webOrigins.every((o) => o.startsWith('http'))).toBe(true)
  })
})

describe('release version', () => {
  it('reports the injected stack version', () => {
    reset({ CARACAL_VERSION: 'v2026.07.03-rc.1' })
    expect(loadConfig().version).toBe('v2026.07.03-rc.1')
  })

  it('falls back to dev for local source runs', () => {
    expect(loadConfig().version).toBe('dev')
  })
})

describe('auto migration gating', () => {
  it('is on for local development', () => {
    expect(loadConfig().autoProvisionDatabase).toBe(true)
  })

  it('is off in production by default', () => {
    reset({ NODE_ENV: 'production' })
    expect(loadConfig().autoProvisionDatabase).toBe(false)
  })

  it('honors an explicit opt-in even in production', () => {
    reset({ NODE_ENV: 'production', CARACAL_AUTH_AUTO_MIGRATE: 'true' })
    expect(loadConfig().autoProvisionDatabase).toBe(true)
  })

  it('honors an explicit opt-out outside production', () => {
    reset({ CARACAL_AUTH_AUTO_MIGRATE: 'false' })
    expect(loadConfig().autoProvisionDatabase).toBe(false)
  })
})

describe('port resolution', () => {
  it('prefers PORT (the container/healthcheck convention) over the legacy var', () => {
    reset({ PORT: '8080', CARACAL_AUTH_PORT: '3002' })
    expect(loadConfig().port).toBe(8080)
  })

  it('falls back to the auth port then the default', () => {
    reset({ CARACAL_AUTH_PORT: '4100' })
    expect(loadConfig().port).toBe(4100)
    reset({})
    expect(loadConfig().port).toBe(3002)
  })
})

describe('operator registration gating', () => {
  it('is open in development when no override is configured', () => {
    const cfg = loadConfig()
    expect(cfg.openRegistration).toBe(true)
    expect(cfg.operatorAllowlistFile).toBe('')
  })

  it('fails closed in production by default', () => {
    reset({ NODE_ENV: 'production' })
    expect(loadConfig().openRegistration).toBe(false)
  })

  it('honors an explicit open-registration override in production', () => {
    reset({ NODE_ENV: 'production', CARACAL_OPEN_REGISTRATION: 'true' })
    expect(loadConfig().openRegistration).toBe(true)
  })

  it('carries the allowlist file path from the environment', () => {
    reset({ CARACAL_OPERATOR_ALLOWLIST_FILE: ' /run/caracalHostSecrets/operatorAllowlist.json ' })
    expect(loadConfig().operatorAllowlistFile).toBe('/run/caracalHostSecrets/operatorAllowlist.json')
  })

  it('keeps the reverse proxy untrusted unless explicitly declared', () => {
    expect(loadConfig().trustProxy).toBe(false)
    reset({ CARACAL_AUTH_TRUST_PROXY: 'true' })
    expect(loadConfig().trustProxy).toBe(true)
  })
})

describe('password sign-up gating', () => {
  it('is enabled in development for usability', () => {
    const cfg = loadConfig()
    expect(cfg.passwordSignup).toBe(true)
    expect(cfg.requireEmailVerification).toBe(false)
  })

  it('is disabled in production by default and requires verified email', () => {
    reset({ NODE_ENV: 'production' })
    const cfg = loadConfig()
    expect(cfg.passwordSignup).toBe(false)
    expect(cfg.requireEmailVerification).toBe(true)
  })

  it('honors an explicit opt-in even in production when mail delivery is configured', () => {
    reset({
      NODE_ENV: 'production',
      CARACAL_PASSWORD_SIGNUP: 'true',
      CARACAL_SMTP_URL: 'smtps://mailer:secret@smtp.example.com:465',
      CARACAL_SMTP_FROM: 'Caracal <no-reply@example.com>',
    })
    expect(loadConfig().passwordSignup).toBe(true)
  })

  it('fails closed when opted in for production without a mail transport', () => {
    reset({ NODE_ENV: 'production', CARACAL_PASSWORD_SIGNUP: 'true' })
    expect(() => loadConfig()).toThrow(/CARACAL_PASSWORD_SIGNUP requires a mail transport/)
  })
})

describe('mail transport', () => {
  it('is absent by default', () => {
    const cfg = loadConfig()
    expect(cfg.smtpUrl).toBeNull()
    expect(cfg.smtpFrom).toBeNull()
  })

  it('resolves and trims the relay url and sender', () => {
    reset({ CARACAL_SMTP_URL: ' smtps://mailer:secret@smtp.example.com:465 ', CARACAL_SMTP_FROM: ' Caracal <no-reply@example.com> ' })
    const cfg = loadConfig()
    expect(cfg.smtpUrl).toBe('smtps://mailer:secret@smtp.example.com:465')
    expect(cfg.smtpFrom).toBe('Caracal <no-reply@example.com>')
  })

  it('treats an empty relay url as unset', () => {
    reset({ CARACAL_SMTP_URL: '' })
    expect(loadConfig().smtpUrl).toBeNull()
  })

  it('requires a sender address alongside the relay url', () => {
    reset({ CARACAL_SMTP_URL: 'smtps://mailer:secret@smtp.example.com:465' })
    expect(() => loadConfig()).toThrow(/CARACAL_SMTP_FROM is required/)
  })
})

describe('web origin defaults', () => {
  it('seeds the localhost dev origin outside production', () => {
    expect(loadConfig().webOrigins).toContain('http://localhost:3001')
  })

  it('does not seed a localhost dev origin in production', () => {
    reset({ NODE_ENV: 'production', CARACAL_AUTH_URL: 'https://app.example.com' })
    const origins = loadConfig().webOrigins
    expect(origins).toContain('https://app.example.com')
    expect(origins).not.toContain('http://localhost:3001')
  })
})

describe('web app origin for OAuth error redirects', () => {
  it('resolves the split dev SPA origin rather than the BFF origin', () => {
    // Local development serves the SPA on a separate Vite origin, so an OAuth error must land
    // there and not on the BFF, which serves no UI.
    const cfg = loadConfig()
    expect(cfg.baseURL).toBe('http://localhost:3002')
    expect(cfg.webAppOrigin).toBe('http://localhost:3001')
  })

  it('falls back to the BFF origin in a same-origin production deployment', () => {
    // With no separate web origin configured, the BFF serves the SPA, so its own origin is the
    // correct sign-in destination.
    reset({ NODE_ENV: 'production', CARACAL_AUTH_URL: 'https://app.example.com' })
    expect(loadConfig().webAppOrigin).toBe('https://app.example.com')
  })

  it('prefers a configured external web origin over the BFF origin', () => {
    reset({ NODE_ENV: 'production', CARACAL_AUTH_URL: 'https://api.example.com', CARACAL_WEB_ORIGIN: 'https://console.example.com' })
    expect(loadConfig().webAppOrigin).toBe('https://console.example.com')
  })
})
