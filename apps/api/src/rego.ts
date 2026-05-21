// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Syntactic validator for Rego policy source: strips comments and strings, then checks structure.

const PACKAGE_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*$/

// Built-ins that reach the network, the host clock, or the OPA runtime.
// Disallowed in tenant-authored policies because evaluation runs inside STS.
const FORBIDDEN_BUILTINS = [
  'http.send',
  'net.lookup_ip_addr',
  'net.cidr_contains',
  'net.cidr_intersects',
  'net.cidr_expand',
  'net.cidr_merge',
  'opa.runtime',
  'rand.intn',
  'time.now_ns',
] as const
const REGEX_META = /[\\^$.*+?()[\]{}|]/g
export const OPA_INPUT_SCHEMA_VERSION = '2026-05-20'
export const POLICY_SCHEMA_VERSIONS = new Set(['2026-03-16', OPA_INPUT_SCHEMA_VERSION])

interface Stripped {
  source: string
  unterminatedString: boolean
}

function stripCommentsAndStrings(src: string): Stripped {
  let out = ''
  let i = 0
  let unterminatedString = false
  while (i < src.length) {
    const ch = src[i]
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (ch === '"' || ch === '`') {
      const quote = ch
      out += ' '
      i++
      let closed = false
      while (i < src.length) {
        const c = src[i]
        if (quote === '"' && c === '\\' && i + 1 < src.length) { i += 2; continue }
        if (c === quote) { closed = true; i++; break }
        if (quote === '"' && c === '\n') break
        i++
      }
      if (!closed) { unterminatedString = true; break }
      continue
    }
    out += ch
    i++
  }
  return { source: out, unterminatedString }
}

function balancedDelimiters(src: string): string | null {
  const stack: string[] = []
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
  const openers = new Set(['(', '[', '{'])
  for (const ch of src) {
    if (openers.has(ch)) stack.push(ch)
    else if (ch in pairs) {
      const top = stack.pop()
      if (top !== pairs[ch]) return 'unbalanced_delimiters'
    }
  }
  return stack.length === 0 ? null : 'unbalanced_delimiters'
}

interface RegoCheck {
  packageName: string | null
  rules: Set<string>
  error: string | null
}

export function parseRego(content: string): RegoCheck {
  if (typeof content !== 'string' || content.length === 0) {
    return { packageName: null, rules: new Set(), error: 'empty_policy' }
  }
  const { source, unterminatedString } = stripCommentsAndStrings(content)
  if (unterminatedString) return { packageName: null, rules: new Set(), error: 'unterminated_string' }

  const balanceErr = balancedDelimiters(source)
  if (balanceErr) return { packageName: null, rules: new Set(), error: balanceErr }

  const pkgMatch = source.match(/(?:^|\n)\s*package\s+([A-Za-z0-9_.]+)/)
  if (!pkgMatch) return { packageName: null, rules: new Set(), error: 'missing_package_declaration' }
  const packageName = pkgMatch[1]
  if (!PACKAGE_NAME.test(packageName)) {
    return { packageName: null, rules: new Set(), error: 'invalid_package_name' }
  }

  const rules = new Set<string>()
  const ruleRe = /(?:^|\n)\s*(default\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\(.*?\))?\s*(?::=|=|contains\s|\{|if\s)/g
  for (const m of source.matchAll(ruleRe)) {
    const name = m[2]
    if (name === 'package' || name === 'import' || name === 'else' || name === 'with') continue
    rules.add(name)
  }

  for (const builtin of FORBIDDEN_BUILTINS) {
    const escaped = builtin.replace(REGEX_META, '\\$&')
    if (new RegExp(`(?:^|[^A-Za-z0-9_.])${escaped}\\s*\\(`).test(source)) {
      return { packageName: null, rules: new Set(), error: `forbidden_builtin:${builtin}` }
    }
  }

  return { packageName, rules, error: null }
}

export function validatePolicySource(content: string): string | null {
  return parseRego(content).error
}

export function validateAuthzPolicy(content: string): string | null {
  const check = parseRego(content)
  if (check.error) return check.error
  if (check.packageName !== 'caracal.authz') return 'must_use_package_caracal_authz'
  if (!check.rules.has('result')) return 'must_define_result_rule'
  return null
}

export function validatePolicySchemaVersion(schemaVersion: string): string | null {
  if (!POLICY_SCHEMA_VERSIONS.has(schemaVersion)) {
    return `unsupported_schema_version:${schemaVersion}`
  }
  return null
}

export function analyzeAuthzPolicy(content: string): string[] {
  if (validateAuthzPolicy(content)) return []
  const { source } = stripCommentsAndStrings(content)
  const warnings: string[] = []
  if (/default\s+result\s*:=\s*\{[\s\S]*?decision\s*:\s*allow/.test(source)
    || /default\s+result\s*:=\s*\{[\s\S]*?"decision"\s*:\s*"allow"/.test(content)) {
    warnings.push('default_result_allows_access')
  }
  if (!/\brequested_scopes\b/.test(source)) {
    warnings.push('missing_requested_scope_check')
  }
  return warnings
}
