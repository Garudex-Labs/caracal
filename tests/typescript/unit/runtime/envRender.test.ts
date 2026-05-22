// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Behavioural tests for renderDevEnv and renderOperatorTemplate: determinism, mode coverage, secret/pinned exclusion.

import { describe, expect, it } from 'vitest'
import { renderDevEnv, renderOperatorTemplate, devEnvRelativePath } from '../../../../packages/engine/src/envRender.ts'
import { envEntries, type StackMode } from '../../../../packages/engine/src/envSchema.ts'

describe('renderDevEnv', () => {
  it('is deterministic across repeated calls', () => {
    expect(renderDevEnv()).toBe(renderDevEnv())
  })

  it('starts with the copyright header', () => {
    const out = renderDevEnv()
    expect(out.startsWith('# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.')).toBe(true)
  })

  it('contains every non-secret schema entry with its dev default', () => {
    const out = renderDevEnv()
    for (const [key, spec] of envEntries()) {
      if (spec.secret) {
        expect(out).not.toMatch(new RegExp(`^${key}=`, 'm'))
        continue
      }
      const def = spec.defaults?.dev ?? spec.default
      if (def === undefined) continue
      expect(out).toContain(`${key}=${def}`)
    }
  })

  it('never includes secret material', () => {
    const out = renderDevEnv()
    expect(out).not.toMatch(/^POSTGRES_PASSWORD=/m)
    expect(out).not.toMatch(/^REDIS_PASSWORD=/m)
    expect(out).not.toMatch(/^CARACAL_ADMIN_TOKEN=/m)
    expect(out).not.toMatch(/^ZONE_KEK=/m)
    expect(out).not.toMatch(/^AUDIT_HMAC_KEY=/m)
    expect(out).not.toMatch(/^STREAMS_HMAC_KEY=/m)
  })

  it('emits CARACAL_MODE=dev as the dev default', () => {
    expect(renderDevEnv()).toContain('CARACAL_MODE=dev')
  })

  it('devEnvRelativePath returns the canonical committed path', () => {
    expect(devEnvRelativePath()).toBe('infra/docker/dev.env')
  })
})

describe('renderOperatorTemplate', () => {
  const modes: StackMode[] = ['dev', 'rc', 'stable']

  for (const mode of modes) {
    describe(`mode=${mode}`, () => {
      it('is deterministic', () => {
        expect(renderOperatorTemplate(mode)).toBe(renderOperatorTemplate(mode))
      })

      it('contains the mode label in the banner', () => {
        expect(renderOperatorTemplate(mode)).toContain(`Caracal ${mode} stack`)
      })

      it('every value line is commented out', () => {
        const out = renderOperatorTemplate(mode)
        for (const line of out.split('\n')) {
          if (line.trim() === '' || line.startsWith('#')) continue
          throw new Error(`uncommented entry: ${line}`)
        }
      })

      it('never includes any secret', () => {
        const out = renderOperatorTemplate(mode)
        for (const [key, spec] of envEntries()) {
          if (!spec.secret) continue
          expect(out).not.toContain(`${key}=`)
        }
      })

      it('never includes pinned vars active in this mode', () => {
        const out = renderOperatorTemplate(mode)
        for (const [key, spec] of envEntries()) {
          if (!spec.pinned?.includes(mode)) continue
          expect(out).not.toContain(`${key}=`)
        }
      })

      it('includes every exposed, non-secret, non-pinned-in-mode entry', () => {
        const out = renderOperatorTemplate(mode)
        for (const [key, spec] of envEntries()) {
          if (spec.secret || !spec.exposed) continue
          if (spec.pinned?.includes(mode)) continue
          expect(out).toMatch(new RegExp(`^# ${key}=`, 'm'))
        }
      })
    })
  }

  it('dev template differs from stable template (mode-specific defaults)', () => {
    expect(renderOperatorTemplate('dev')).not.toBe(renderOperatorTemplate('stable'))
  })
})
