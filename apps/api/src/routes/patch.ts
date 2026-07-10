// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Patch update builder for API route SQL assignments.

import type { Attribution } from '../attribution.js'

type PatchAssignment = (placeholder: string) => string

export type PatchValue = unknown

export interface PatchField {
  value: PatchValue | undefined
  assignment: PatchAssignment
}

export interface PatchUpdate {
  sets: string[]
  values: PatchValue[]
}

export function patchColumn(column: string, value: PatchValue | undefined): PatchField {
  return { value, assignment: (placeholder) => `${column} = ${placeholder}` }
}

export function patchExpression(value: PatchValue | undefined, assignment: PatchAssignment): PatchField {
  return { value, assignment }
}

export function buildPatchUpdate(baseValues: PatchValue[], fields: PatchField[]): PatchUpdate | null {
  const sets: string[] = []
  const values = [...baseValues]
  for (const field of fields) {
    if (field.value !== undefined) {
      const placeholder = `$${values.length + 1}`
      sets.push(field.assignment(placeholder))
      values.push(field.value)
    }
  }
  return sets.length === 0 ? null : { sets, values }
}

// Stamps the update-side attribution onto a built patch. Appended after the no-fields
// check so an attribution stamp alone never turns an empty patch into a write.
export function appendAttribution(update: PatchUpdate, attribution: Attribution): PatchUpdate {
  update.values.push(attribution.actor)
  update.sets.push(`updated_by = $${update.values.length}`)
  update.values.push(attribution.viaOperator)
  update.sets.push(`updated_via_operator = $${update.values.length}`)
  return update
}
