// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Behavioural tests for loadEnv precedence, secret resolution, pinned-var enforcement, and composeSubstitutions filtering.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ENV_SCHEMA,
  composeSubstitutions,
  loadEnv,
  PinnedVarError,
  readDotenv,
  SecretFileError,
} from '../../../../packages/engine/src/envLoad.ts'
import { envEntries } from '../../../../packages/engine/src/envSchema.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'caracal-envload-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('loadEnv precedence', () => {
  it('process.env beats override file beats pins beats mode default beats generic default', () => {
    const override = join(dir, 'override.env')
    writeFileSync(override, 'LOG_LEVEL=warn\nREDIS_MAXMEMORY=256mb\nCARACAL_DEV_SHA=fromOverride\n')
    const values = loadEnv({
      mode: 'dev',
      pins: { CARACAL_DEV_SHA: 'fromPin' },
      overrideFile: override,
      processEnv: { LOG_LEVEL: 'debug' },
    })
    expect(values.LOG_LEVEL).toBe('debug')
    expect(values.REDIS_MAXMEMORY).toBe('256mb')
    expect(values.CARACAL_DEV_SHA).toBe('fromOverride')
    expect(values.CARACAL_REGISTRY).toBe('ghcr.io/garudex-labs/')
  })

  it('mode-specific default beats generic default', () => {
    const devValues = loadEnv({ mode: 'dev', processEnv: {} })
    const stableValues = loadEnv({ mode: 'stable', pins: { CARACAL_VERSION: '1.0.0' }, processEnv: {} })
    expect(devValues.CARACAL_STS_ISSUER_URL).toBe('http://sts:8080')
    expect(stableValues.CARACAL_STS_ISSUER_URL).toBe('http://localhost:8080')
    expect(devValues.CARACAL_MODE).toBe('dev')
    expect(stableValues.CARACAL_MODE).toBe('stable')
  })

  it('returns a frozen object', () => {
    const values = loadEnv({ mode: 'dev', processEnv: {} })
    expect(Object.isFrozen(values)).toBe(true)
  })

  it('missing override file produces empty overrides without throwing', () => {
    const values = loadEnv({
      mode: 'dev',
      overrideFile: join(dir, 'does-not-exist.env'),
      processEnv: {},
    })
    expect(values.LOG_LEVEL).toBe('info')
  })

  it('empty string in process.env wins over defaults (nullish coalescing)', () => {
    const values = loadEnv({
      mode: 'dev',
      processEnv: { LOG_LEVEL: '' },
    })
    expect(values.LOG_LEVEL).toBe('')
  })

  it('resolves every mode with its mode-specific defaults', () => {
    const cases = [
      ['dev', {}, 'dev', 'http://sts:8080'],
      ['rc', { CARACAL_MODE: 'rc', CARACAL_VERSION: '1.0.0-rc.1', CARACAL_REGISTRY: 'ghcr.io/garudex-labs/' }, 'rc', 'http://localhost:8080'],
      ['stable', { CARACAL_MODE: 'stable', CARACAL_VERSION: '1.0.0', CARACAL_REGISTRY: 'ghcr.io/garudex-labs/' }, 'stable', 'http://localhost:8080'],
    ] as const

    for (const [mode, pins, expectedMode, issuer] of cases) {
      const values = loadEnv({ mode, pins, processEnv: {} })
      expect(values.CARACAL_MODE).toBe(expectedMode)
      expect(values.CARACAL_STS_ISSUER_URL).toBe(issuer)
      expect(values.LOG_LEVEL).toBe('info')
      expect(values.POSTGRES_USER).toBe('caracal')
    }
  })

  it('process.env wins over matching override file and pins without mutating either input', () => {
    const override = join(dir, 'override.env')
    writeFileSync(override, 'LOG_LEVEL=warn\nCARACAL_DEV_SHA=fromOverride\n')
    const pins = { CARACAL_DEV_SHA: 'fromPin' }
    const processEnv = { LOG_LEVEL: 'error' }

    const values = loadEnv({ mode: 'dev', pins, overrideFile: override, processEnv })

    expect(values.LOG_LEVEL).toBe('error')
    expect(values.CARACAL_DEV_SHA).toBe('fromOverride')
    expect(pins.CARACAL_DEV_SHA).toBe('fromPin')
    expect(processEnv.LOG_LEVEL).toBe('error')
  })
})

describe('loadEnv pinned-var enforcement', () => {
  it('accepts pin matching process.env in stable mode', () => {
    expect(() =>
      loadEnv({
        mode: 'stable',
        pins: { CARACAL_VERSION: '2026.05.14' },
        processEnv: { CARACAL_VERSION: '2026.05.14' },
      }),
    ).not.toThrow()
  })

  it('accepts pin matching override file in stable mode', () => {
    const override = join(dir, 'override.env')
    writeFileSync(override, 'CARACAL_VERSION=2026.05.14\n')
    expect(() =>
      loadEnv({
        mode: 'stable',
        pins: { CARACAL_VERSION: '2026.05.14' },
        overrideFile: override,
        processEnv: {},
      }),
    ).not.toThrow()
  })

  it('rejects pinned var override in rc mode', () => {
    expect(() =>
      loadEnv({
        mode: 'rc',
        pins: { CARACAL_MODE: 'rc' },
        processEnv: { CARACAL_MODE: 'dev' },
      }),
    ).toThrow(PinnedVarError)
  })

  it('rejects every pinned var when overridden in stable', () => {
    const pins = { CARACAL_MODE: 'stable', CARACAL_VERSION: '1.0.0', CARACAL_REGISTRY: 'ghcr.io/garudex-labs/' }
    for (const key of Object.keys(pins)) {
      expect(() =>
        loadEnv({
          mode: 'stable',
          pins,
          processEnv: { [key]: 'evil' },
        }),
      ).toThrow(PinnedVarError)
    }
  })

  it('rejects every pinned var when overridden in rc', () => {
    const pins = { CARACAL_MODE: 'rc', CARACAL_VERSION: '1.0.0-rc.1', CARACAL_REGISTRY: 'ghcr.io/garudex-labs/' }
    for (const key of Object.keys(pins)) {
      expect(() =>
        loadEnv({
          mode: 'rc',
          pins,
          processEnv: { [key]: 'evil' },
        }),
      ).toThrow(PinnedVarError)
    }
  })

  it('rejects pinned vars from stable operator override files before compose substitution', () => {
    const override = join(dir, 'operator.env')
    writeFileSync(override, 'CARACAL_REGISTRY=ghcr.io/attacker/\nLOG_LEVEL=debug\n')

    expect(() =>
      loadEnv({
        mode: 'stable',
        pins: { CARACAL_MODE: 'stable', CARACAL_VERSION: '1.0.0', CARACAL_REGISTRY: 'ghcr.io/garudex-labs/' },
        overrideFile: override,
        processEnv: {},
      }),
    ).toThrow(PinnedVarError)
  })

  it('allows pinned-var override in dev (no pinning enforced)', () => {
    expect(() =>
      loadEnv({
        mode: 'dev',
        processEnv: { CARACAL_VERSION: 'whatever' },
      }),
    ).not.toThrow()
  })

  it('PinnedVarError carries key and mode', () => {
    try {
      loadEnv({ mode: 'stable', pins: { CARACAL_VERSION: 'a' }, processEnv: { CARACAL_VERSION: 'b' } })
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(PinnedVarError)
      expect((err as PinnedVarError).key).toBe('CARACAL_VERSION')
      expect((err as PinnedVarError).mode).toBe('stable')
    }
  })
})

describe('loadEnv secret resolution', () => {
  it('prefers POSTGRES_PASSWORD_FILE over direct POSTGRES_PASSWORD', () => {
    const file = join(dir, 'postgresPassword')
    writeFileSync(file, 'from-file\n')
    const values = loadEnv({
      mode: 'dev',
      processEnv: { POSTGRES_PASSWORD_FILE: file, POSTGRES_PASSWORD: 'from-env' },
    })
    expect(values.POSTGRES_PASSWORD).toBe('from-file')
  })

  it('falls through to direct env var when *_FILE points to missing file', () => {
    const values = loadEnv({
      mode: 'dev',
      processEnv: { POSTGRES_PASSWORD_FILE: join(dir, 'missing'), POSTGRES_PASSWORD: 'from-env' },
    })
    expect(values.POSTGRES_PASSWORD).toBe('from-env')
  })

  it('resolves from CARACAL_SECRETS_DIR using schema-declared file basename', () => {
    mkdirSync(join(dir, 'secrets'), { recursive: true })
    writeFileSync(join(dir, 'secrets', 'zoneKek'), 'kek-material\n')
    const values = loadEnv({
      mode: 'dev',
      processEnv: { CARACAL_SECRETS_DIR: join(dir, 'secrets') },
    })
    expect(values.ZONE_KEK).toBe('kek-material')
  })

  it('resolves CARACAL_SECRETS_DIR with a trailing separator', () => {
    const secretsDir = join(dir, 'secrets')
    mkdirSync(secretsDir, { recursive: true })
    writeFileSync(join(secretsDir, 'auditHmacKey'), 'audit-material\n')

    const values = loadEnv({
      mode: 'stable',
      pins: { CARACAL_MODE: 'stable', CARACAL_VERSION: '1.0.0', CARACAL_REGISTRY: 'ghcr.io/garudex-labs/' },
      processEnv: { CARACAL_SECRETS_DIR: `${secretsDir}/` },
    })

    expect(values.AUDIT_HMAC_KEY).toBe('audit-material')
  })

  it('prefers direct secret env over CARACAL_SECRETS_DIR material', () => {
    mkdirSync(join(dir, 'secrets'), { recursive: true })
    writeFileSync(join(dir, 'secrets', 'streamsHmacKey'), 'from-dir\n')

    const values = loadEnv({
      mode: 'dev',
      processEnv: {
        CARACAL_SECRETS_DIR: join(dir, 'secrets'),
        STREAMS_HMAC_KEY: 'from-env',
      },
    })

    expect(values.STREAMS_HMAC_KEY).toBe('from-env')
  })

  it('fails when an explicit secret file exists but is empty', () => {
    const file = join(dir, 'postgresPassword')
    writeFileSync(file, ' \n\t')

    expect(() =>
      loadEnv({
        mode: 'dev',
        processEnv: { POSTGRES_PASSWORD_FILE: file },
      }),
    ).toThrow(SecretFileError)
  })

  it('fails when a schema secret file under CARACAL_SECRETS_DIR is empty', () => {
    mkdirSync(join(dir, 'secrets'), { recursive: true })
    writeFileSync(join(dir, 'secrets', 'redisPassword'), '\n')

    expect(() =>
      loadEnv({
        mode: 'dev',
        processEnv: { CARACAL_SECRETS_DIR: join(dir, 'secrets') },
      }),
    ).toThrow(SecretFileError)
  })

  it('returns undefined when no secret source is available', () => {
    const values = loadEnv({ mode: 'dev', processEnv: {} })
    expect(values.POSTGRES_PASSWORD).toBeUndefined()
    expect(values.CARACAL_ADMIN_TOKEN).toBeUndefined()
  })

  it('trims trailing whitespace from secret files', () => {
    const file = join(dir, 'redisPassword')
    writeFileSync(file, '  hello-world  \n\n')
    const values = loadEnv({
      mode: 'dev',
      processEnv: { REDIS_PASSWORD_FILE: file },
    })
    expect(values.REDIS_PASSWORD).toBe('hello-world')
  })

  it('never reads secrets from the override file', () => {
    const override = join(dir, 'override.env')
    writeFileSync(override, 'POSTGRES_PASSWORD=leaked-from-env-file\nPOSTGRES_PASSWORD_FILE=/tmp/leaked\n')
    const values = loadEnv({ mode: 'dev', overrideFile: override, processEnv: {} })
    expect(values.POSTGRES_PASSWORD).toBeUndefined()
  })

  it('fails closed when *_FILE points to a non-readable path', () => {
    const nonReadable = join(dir, 'not-a-file')
    mkdirSync(nonReadable, { recursive: true })
    expect(() =>
      loadEnv({
        mode: 'dev',
        processEnv: { POSTGRES_PASSWORD_FILE: nonReadable },
      }),
    ).toThrow()
  })
})

describe('composeSubstitutions', () => {
  it('drops every secret from the rendered substitution map', () => {
    const file = join(dir, 'postgresPassword')
    writeFileSync(file, 'pg-secret\n')
    const values = loadEnv({
      mode: 'dev',
      processEnv: { POSTGRES_PASSWORD_FILE: file },
    })
    const subs = composeSubstitutions(values)
    for (const [key, spec] of envEntries()) {
      if (spec.secret) expect(subs[key]).toBeUndefined()
    }
    expect(subs.POSTGRES_USER).toBe('caracal')
    expect(subs.LOG_LEVEL).toBe('info')
  })

  it('omits undefined non-secret entries', () => {
    const values = loadEnv({ mode: 'stable', pins: { CARACAL_VERSION: '1.0.0' }, processEnv: {} })
    const subs = composeSubstitutions(values)
    expect('CARACAL_VERSION' in subs).toBe(true)
    expect(subs.CARACAL_VERSION).toBe('1.0.0')
  })

  it('preserves empty-string overrides for non-secret entries', () => {
    const values = loadEnv({ mode: 'dev', processEnv: { LOG_LEVEL: '' } })
    const subs = composeSubstitutions(values)
    expect('LOG_LEVEL' in subs).toBe(true)
    expect(subs.LOG_LEVEL).toBe('')
  })
})

describe('readDotenv parser', () => {
  it('returns empty object for missing files', () => {
    expect(readDotenv(join(dir, 'absent.env'))).toEqual({})
  })

  it('skips comments, blanks, and malformed lines', () => {
    const file = join(dir, 'x.env')
    writeFileSync(file, '# header\n\nFOO=bar\nnot-a-line\nlower=ignored\nBAZ=qux\n')
    expect(readDotenv(file)).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('strips matching single and double quotes', () => {
    const file = join(dir, 'q.env')
    writeFileSync(file, `A="double"\nB='single'\nC="mismatch'\n`)
    const out = readDotenv(file)
    expect(out.A).toBe('double')
    expect(out.B).toBe('single')
    expect(out.C).toBe(`"mismatch'`)
  })

  it('handles CRLF files and trims surrounding whitespace', () => {
    const file = join(dir, 'crlf.env')
    writeFileSync(file, 'FOO=bar\r\n  BAZ=qux  \r\n# comment\r\n')

    expect(readDotenv(file)).toEqual({ FOO: 'bar', BAZ: 'qux' })
  })

  it('keeps `=` characters in values', () => {
    const file = join(dir, 'eq.env')
    writeFileSync(file, 'URL=postgres://u:p=1@h/db\n')
    expect(readDotenv(file).URL).toBe('postgres://u:p=1@h/db')
  })

  it('uses the last value when a key appears multiple times', () => {
    const file = join(dir, 'dup.env')
    writeFileSync(file, 'LOG_LEVEL=info\nLOG_LEVEL=warn\n')
    expect(readDotenv(file).LOG_LEVEL).toBe('warn')
  })
})

describe('schema integrity invariants', () => {
  it('every secret has a file basename', () => {
    for (const [, spec] of envEntries()) {
      if (spec.secret) expect(spec.file).toBeTruthy()
    }
  })

  it('pinned vars never declare exposed=true', () => {
    for (const [, spec] of envEntries()) {
      if (spec.pinned && spec.pinned.length > 0) expect(spec.exposed).not.toBe(true)
    }
  })

  it('enum kinds carry a values list', () => {
    for (const [, spec] of envEntries()) {
      if (spec.kind === 'enum') expect(spec.values && spec.values.length > 0).toBe(true)
    }
  })

  it('all six known secrets are declared with their file basenames', () => {
    expect(ENV_SCHEMA.POSTGRES_PASSWORD.file).toBe('postgresPassword')
    expect(ENV_SCHEMA.REDIS_PASSWORD.file).toBe('redisPassword')
    expect(ENV_SCHEMA.CARACAL_ADMIN_TOKEN.file).toBe('caracalAdminToken')
    expect(ENV_SCHEMA.ZONE_KEK.file).toBe('zoneKek')
    expect(ENV_SCHEMA.AUDIT_HMAC_KEY.file).toBe('auditHmacKey')
    expect(ENV_SCHEMA.STREAMS_HMAC_KEY.file).toBe('streamsHmacKey')
  })
})
