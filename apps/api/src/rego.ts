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

// The default result literal: the balanced object assigned by `default result :=`,
// with string contents tracked so braces inside strings do not skew the depth.
function defaultResultLiteral(content: string): string | null {
  const match = /default\s+result\s*:=\s*\{/.exec(content)
  if (!match) return null
  let depth = 0
  let inString = false
  let literal = ''
  for (let i = match.index + match[0].length - 1; i < content.length; i++) {
    const ch = content[i]
    literal += ch
    if (inString) {
      if (ch === '\\') { literal += content[i + 1] ?? ''; i++; continue }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') depth++
    if (ch === '}') {
      depth--
      if (depth === 0) return literal
    }
  }
  return literal
}

export function analyzeAuthzPolicy(content: string): string[] {
  if (validateAuthzPolicy(content)) return []
  const { source } = stripCommentsAndStrings(content)
  const warnings: string[] = []
  const defaultLiteral = defaultResultLiteral(content)
  if (defaultLiteral !== null && /"decision"\s*:\s*"allow"/.test(defaultLiteral)) {
    warnings.push('default_result_allows_access')
  }
  if (!/\bdefault\s+result\b/.test(source)) {
    warnings.push('missing_default_result')
  }
  if (!/\brequested_scopes\b/.test(source)) {
    warnings.push('missing_requested_scope_check')
  }
  return warnings
}

export interface AuthzPolicyPreview {
  package: string
  rules: string[]
  default_result: boolean
  decisions: string[]
  inputs_referenced: string[]
  data_referenced: string[]
}

function collectPaths(source: string, root: string): string[] {
  const re = new RegExp(`\\b${root}((?:\\.[a-zA-Z_][a-zA-Z0-9_]*)+)`, 'g')
  const paths = new Set<string>()
  for (const m of source.matchAll(re)) paths.add(`${root}${m[1]}`)
  return [...paths].sort()
}

export function previewAuthzPolicy(content: string): AuthzPolicyPreview | null {
  const check = parseRego(content)
  if (check.error || check.packageName !== 'caracal.authz') return null
  const { source } = stripCommentsAndStrings(content)
  const decisions = new Set<string>()
  for (const m of content.matchAll(/"decision"\s*:\s*"(allow|deny)"/g)) decisions.add(m[1])
  return {
    package: check.packageName,
    rules: [...check.rules].sort(),
    default_result: /\bdefault\s+result\b/.test(source),
    decisions: [...decisions].sort(),
    inputs_referenced: collectPaths(source, 'input'),
    data_referenced: collectPaths(source, 'data'),
  }
}
