// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Policy template route unit tests for catalog shape and lookup stability.

import { describe, it, expect } from 'vitest'
import { policyTemplatesRoutes } from '../../../../../apps/api/src/routes/policy-templates.js'
import { buildRouteApp } from '../../../../shared/test-utils/typescript/fastify.js'

describe('GET /v1/policy-templates', () => {
  it('returns the built-in policy template catalog', async () => {
    const { app } = buildRouteApp(policyTemplatesRoutes)

    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/v1/policy-templates' })
    const templates = JSON.parse(res.body) as Array<{ id: string; content: string }>

    expect(res.statusCode).toBe(200)
    expect(templates.map((template) => template.id)).toEqual(
      expect.arrayContaining(['application-bindings', 'resource-grants', 'label-confinement', 'zone-restriction']),
    )
    expect(new Set(templates.map((template) => template.id)).size).toBe(templates.length)
    const grants = templates.find((template) => template.id === 'resource-grants')
    expect(grants?.content).toContain('# caracal:data-document')
    expect(grants?.content).toContain('grants := {')
    expect(grants?.content).not.toMatch(/result\s*:=/)
  })
})
