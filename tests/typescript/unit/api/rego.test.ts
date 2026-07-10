// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the syntactic Rego validator.

import { describe, it, expect } from 'vitest'
import { parseRego, previewAuthzPolicy, validatePolicySource, validateAuthzPolicy } from '../../../../apps/api/src/rego.js'

describe('parseRego', () => {
  it('extracts package and rule names', () => {
    const out = parseRego(`package caracal.authz\n\ndefault result := false\nresult { input.x == 1 }`)
    expect(out.error).toBeNull()
    expect(out.packageName).toBe('caracal.authz')
    expect(out.rules.has('result')).toBe(true)
  })

  it('rejects missing package', () => {
    expect(parseRego('result := true').error).toBe('missing_package_declaration')
  })

  it('rejects unbalanced braces', () => {
    expect(parseRego('package p\nresult { input.a == 1').error).toBe('unbalanced_delimiters')
  })

  it('rejects unterminated string', () => {
    expect(parseRego('package p\nx := "oops').error).toBe('unterminated_string')
  })

  it('treats # inside strings as literal', () => {
    const out = parseRego('package p\nx := "value # not comment"\nresult := true')
    expect(out.error).toBeNull()
  })

  it('ignores delimiters inside comments', () => {
    const out = parseRego('package p\n# closing }\nresult := true')
    expect(out.error).toBeNull()
  })

  it('rejects forbidden built-ins', () => {
    expect(parseRego('package p\nresult := http.send({})').error).toBe('forbidden_builtin:http.send')
    expect(parseRego('package p\nresult := net.cidr_merge(["10.0.0.0/24"])').error).toBe('forbidden_builtin:net.cidr_merge')
    expect(parseRego('package p\nresult := data.http.send').error).toBeNull()
  })
})

describe('validatePolicySource', () => {
  it('passes for any package', () => {
    expect(validatePolicySource('package other\nresult := true')).toBeNull()
  })
})

describe('validateAuthzPolicy', () => {
  it('requires caracal.authz package', () => {
    expect(validateAuthzPolicy('package other\nresult := true')).toBe('must_use_package_caracal_authz')
  })

  it('requires the data-document directive', () => {
    expect(validateAuthzPolicy('package caracal.authz\ngrants := {}')).toBe('must_be_data_document')
  })

  it('accepts a data document that defines data and no result rule', () => {
    expect(
      validateAuthzPolicy(`# caracal:data-document
package caracal.authz
grants := { "agent-1": ["read"] }`),
    ).toBeNull()
  })

  it('rejects a data document that defines a result rule', () => {
    expect(
      validateAuthzPolicy(`# caracal:data-document
package caracal.authz
grants := { "agent-1": ["read"] }
result := { "decision": "allow" }`),
    ).toBe('data_document_must_not_define_result')
  })

  it('rejects an empty data document', () => {
    expect(
      validateAuthzPolicy(`# caracal:data-document
package caracal.authz`),
    ).toBe('data_document_must_define_data')
  })

  it('rejects rules owned by the platform decision contract', () => {
    expect(
      validateAuthzPolicy(`# caracal:data-document
package caracal.authz
principal_owns_resource if true`),
    ).toBe('data_document_rule_not_allowed:principal_owns_resource')
  })
})

describe('previewAuthzPolicy', () => {
  it('reports the parsed shape and referenced contract paths', () => {
    const preview = previewAuthzPolicy(`package caracal.authz
default result := {"decision": "deny", "evaluation_status": "complete", "determining_policies": [], "diagnostics": []}
result := {"decision": "allow", "evaluation_status": "complete", "determining_policies": [], "diagnostics": []} if {
  input.resource.identifier == "resource://api"
  every scope in input.context.requested_scopes { scope in data.allowed_scopes }
}`)
    expect(preview).not.toBeNull()
    expect(preview).toMatchObject({
      package: 'caracal.authz',
      rules: ['result'],
      default_result: true,
      decisions: ['allow', 'deny'],
      inputs_referenced: ['input.context.requested_scopes', 'input.resource.identifier'],
      data_referenced: ['data.allowed_scopes'],
    })
  })

  it('returns null for non-authz policies', () => {
    expect(previewAuthzPolicy('package other\nresult := true')).toBeNull()
  })
})
