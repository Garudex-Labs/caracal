// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Interoperability contract tests for public schemas and shared fixtures.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { signStream } from '@caracalai/core'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Schema = {
  $ref?: string
  $defs?: Record<string, Schema>
  type?: string | string[]
  const?: Json
  enum?: Json[]
  oneOf?: Schema[]
  required?: string[]
  properties?: Record<string, Schema>
  patternProperties?: Record<string, Schema>
  additionalProperties?: boolean | Schema
  items?: Schema
  minLength?: number
  minItems?: number
  uniqueItems?: boolean
  minimum?: number
  maximum?: number
  pattern?: string
}

const here = dirname(fileURLToPath(import.meta.url))
const schemaDir = resolve(here, '../../../../docs/public/schemas')
const fixtureDir = resolve(here, '../../../shared/fixtures/interoperability')

const contracts = [
  ['caracal-jwt-claims-2026-05-21.schema.json', 'jwt-claims.resource.valid.json'],
  ['caracal-token-response-2026-05-21.schema.json', 'token-response.gateway.valid.json'],
  ['caracal-policy-input-2026-05-20.schema.json', 'policy-input.sts.valid.json'],
  ['caracal-policy-result-2026-05-20.schema.json', 'policy-result.allow.valid.json'],
  ['caracal-audit-event-2026-05-21.schema.json', 'audit-event.allow.valid.json'],
  ['caracal-revocation-event-2026-05-21.schema.json', 'revocation-event.session.valid.json'],
  ['caracal-w3c-baggage-2026-05-21.schema.json', 'w3c-baggage.valid.json'],
  ['caracal-gateway-upstream-manifest-2026-05-21.schema.json', 'gateway-upstream-manifest.http.valid.json'],
  ['caracal-provider-credential-plugin-manifest-2026-05-21.schema.json', 'provider-credential-plugin-manifest.valid.json'],
  ['caracal-audit-exporter-manifest-2026-05-21.schema.json', 'audit-exporter-manifest.valid.json'],
  ['caracal-policy-pack-manifest-2026-05-21.schema.json', 'policy-pack-manifest.valid.json'],
  ['caracal-resource-verifier-manifest-2026-05-21.schema.json', 'resource-verifier-manifest.valid.json'],
  ['caracal-agent-connector-manifest-2026-05-21.schema.json', 'agent-connector-manifest.valid.json'],
] as const

function readJson(path: string): Json {
  return JSON.parse(readFileSync(path, 'utf8')) as Json
}

function resolveRef(schema: Schema, root: Schema): Schema {
  if (!schema.$ref) return schema
  if (!schema.$ref.startsWith('#/$defs/')) throw new Error(`unsupported schema ref ${schema.$ref}`)
  const key = schema.$ref.slice('#/$defs/'.length)
  const ref = root.$defs?.[key]
  if (!ref) throw new Error(`missing schema ref ${schema.$ref}`)
  return ref
}

function isObject(value: Json): value is { [key: string]: Json } {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateType(expected: string, value: Json, path: string): void {
  if (expected === 'null') {
    expect(value, path).toBeNull()
    return
  }
  if (expected === 'integer') {
    expect(typeof value, path).toBe('number')
    expect(Number.isInteger(value), path).toBe(true)
    return
  }
  if (expected === 'array') {
    expect(Array.isArray(value), path).toBe(true)
    return
  }
  if (expected === 'object') {
    expect(isObject(value), path).toBe(true)
    return
  }
  expect(typeof value, path).toBe(expected)
}

function validate(schema: Schema, value: Json, root: Schema, path = '$'): void {
  schema = resolveRef(schema, root)
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => {
      try {
        validate(candidate, value, root, path)
        return true
      } catch {
        return false
      }
    })
    expect(matches.length, `${path} oneOf matches`).toBe(1)
    return
  }
  if (schema.const !== undefined) expect(value, `${path} const`).toEqual(schema.const)
  if (schema.enum) expect(schema.enum, `${path} enum`).toContainEqual(value)
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    expect(types.some((type) => {
      try {
        validateType(type, value, path)
        return true
      } catch {
        return false
      }
    }), `${path} type`).toBe(true)
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined) expect(value.length, `${path} minLength`).toBeGreaterThanOrEqual(schema.minLength)
    if (schema.pattern) expect(value, `${path} pattern`).toMatch(new RegExp(schema.pattern))
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined) expect(value, `${path} minimum`).toBeGreaterThanOrEqual(schema.minimum)
    if (schema.maximum !== undefined) expect(value, `${path} maximum`).toBeLessThanOrEqual(schema.maximum)
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined) expect(value.length, `${path} minItems`).toBeGreaterThanOrEqual(schema.minItems)
    if (schema.uniqueItems) expect(new Set(value.map((item) => JSON.stringify(item))).size, `${path} uniqueItems`).toBe(value.length)
    if (schema.items) value.forEach((item, index) => validate(schema.items!, item, root, `${path}[${index}]`))
  }
  if (isObject(value)) {
    for (const required of schema.required ?? []) expect(value, `${path}.${required}`).toHaveProperty(required)
    const matchedByPattern = new Set<string>()
    for (const [pattern, patternSchema] of Object.entries(schema.patternProperties ?? {})) {
      const re = new RegExp(pattern)
      for (const [key, item] of Object.entries(value)) {
        if (re.test(key)) {
          matchedByPattern.add(key)
          validate(patternSchema, item, root, `${path}.${key}`)
        }
      }
    }
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) validate(propertySchema, value[key], root, `${path}.${key}`)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        expect(Object.hasOwn(schema.properties ?? {}, key) || matchedByPattern.has(key), `${path}.${key} additionalProperties`).toBe(true)
      }
    } else if (typeof schema.additionalProperties === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (!Object.hasOwn(schema.properties ?? {}, key) && !matchedByPattern.has(key)) {
          validate(schema.additionalProperties, item, root, `${path}.${key}`)
        }
      }
    }
  }
}

describe('public interoperability schemas', () => {
  it.each(contracts)('%s accepts %s', (schemaName, fixtureName) => {
    const schema = readJson(resolve(schemaDir, schemaName)) as Schema
    const fixture = readJson(resolve(fixtureDir, fixtureName))

    validate(schema, fixture, schema)
  })

  it('keeps trace context fixtures on W3C headers', () => {
    const fixture = readJson(resolve(fixtureDir, 'trace-context.headers.valid.json'))
    expect(fixture).toMatchObject({
      traceparent: expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/),
      tracestate: expect.any(String),
      baggage: expect.stringContaining('caracal.agent_session='),
    })
  })
})

describe('stream-sig canonicalization vectors', () => {
  interface Vector {
    description: string
    stream: string
    values: Record<string, string | null>
    expected_canonical: string
    hmac_key_hex: string
    expected_sig_hex: string
  }

  const vectors = JSON.parse(
    readFileSync(resolve(fixtureDir, 'stream-sig-canonicalize.vectors.json'), 'utf8'),
  ) as Vector[]

  it.each(vectors.map((v) => [v.description, v] as const))(
    '%s',
    (_desc, vector) => {
      const key = Buffer.from(vector.hmac_key_hex, 'hex')
      const sig = signStream(key, vector.stream, vector.values)
      expect(sig).toBe(vector.expected_sig_hex)
    },
  )
})
