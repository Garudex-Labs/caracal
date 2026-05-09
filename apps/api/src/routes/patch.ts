// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Patch update builder for API route SQL assignments.

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
