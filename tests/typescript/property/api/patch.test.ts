// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Patch update builder property tests for placeholder and value invariants.

import { describe, it, expect } from 'vitest'
import { buildPatchUpdate, patchColumn, patchExpression } from '../../../../apps/api/src/routes/patch.js'

describe('buildPatchUpdate invariants', () => {
  it('keeps placeholders contiguous after base values', () => {
    for (let fields = 1; fields <= 12; fields++) {
      const update = buildPatchUpdate(
        ['id', 'zone'],
        Array.from({ length: fields }, (_, index) =>
          index % 2 === 0
            ? patchColumn(`column_${index}`, `value-${index}`)
            : patchExpression(`value-${index}`, (placeholder) => `json_${index} = json_${index} || ${placeholder}::jsonb`),
        ),
      )

      expect(update).not.toBeNull()
      expect(update?.values).toHaveLength(fields + 2)
      for (let index = 0; index < fields; index++) {
        expect(update?.sets[index]).toContain(`$${index + 3}`)
      }
    }
  })

  it('omits undefined fields without shifting retained values incorrectly', () => {
    const update = buildPatchUpdate(
      ['id'],
      [patchColumn('name', undefined), patchColumn('slug', 'api'), patchColumn('enabled', true), patchColumn('description', null)],
    )

    expect(update).toEqual({
      sets: ['slug = $2', 'enabled = $3', 'description = $4'],
      values: ['id', 'api', true, null],
    })
  })
})
