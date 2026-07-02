// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// The ephemeral Operator state researcher: gathers live evidence through governed reads onto a per-turn blackboard so a read answer is grounded in real state, not a guess.

import { CONTROL_CAPABILITIES, type ControlGen } from './operator-control-map.js'
import { CAPABILITIES } from './operator-capabilities.js'
import { ControlClientError, type ControlClient } from './control-client.js'

// The most rows a single read contributes to the prompt. Evidence carries the full live count
// but only a bounded list of names, so a large zone never inflates the prompt.
const EVIDENCE_SAMPLE_LIMIT = 5

// One identified object a read surfaced: its live id paired with its name when it has one. The id
// is what a mutate-by-id capability binds to, so carrying it lets the planner target an existing
// object by its real identifier instead of guessing one from the name.
export interface EvidenceItem {
  id: string
  name?: string
}

// One piece of evidence a researcher gathered from a single governed read. A success carries
// the live row count, a bounded list of names, the identified objects (id with name) so a change
// can target one by its real id, and the decision-relevant attributes the planner and guardian
// need to reason correctly - the distinct provider auth modes and the distinct resource scopes
// present, extracted under a strict per-domain allowlist so a read still surfaces no secret, token,
// or policy logic. A failure carries the typed reason so a partial gather still answers - a single
// denied or unreachable read narrows the evidence, it never fails the turn.
export interface Evidence {
  capability: string
  domain: string
  ok: boolean
  count?: number
  names?: string[]
  items?: EvidenceItem[]
  attributes?: Record<string, string[]>
  error?: string
}

// The per-turn blackboard: the typed evidence the turn's workers gathered. It is the turn's
// shared reasoning record - what was inspected and what it found - and lives only for the turn.
export interface Blackboard {
  evidence: Evidence[]
}

// An ephemeral worker bound to the Operator's own scoped control identity. It reads only - it
// can reach nothing but governed read capabilities - so it holds no authority to change state.
// A gather may be scoped to the object domains a turn concerns, so a request about one domain
// reads only that domain rather than fanning out across every governed read.
export interface Researcher {
  gather(domains?: string[]): Promise<Blackboard>
}

// The governed read capabilities: the capabilities mapped to a control command that the
// authoritative catalog marks non-mutating. Derived from the catalog and the control mapping,
// never hand-listed, so the read set can never drift from the mutating flag or the mapping -
// a researcher can never reach a mutating command.
export function governedReadCapabilities(): string[] {
  return Object.keys(CONTROL_CAPABILITIES).filter((id) => {
    const capability = CAPABILITIES[id]
    return capability !== undefined && !capability.mutating
  })
}

// The decision-relevant attributes each domain's rows expose, by the safe field they live in.
// Only these explicitly named, non-secret descriptor fields are ever read off a row - a provider's
// auth mode and a resource's scopes - so the planner can reason about what actually exists (which
// auth mode a provider uses, which scopes a resource offers) without any row's secret, token, or
// policy logic ever reaching the model. A domain absent here contributes no attributes.
const DOMAIN_ATTRIBUTE_FIELDS: Record<string, { field: string; label: string }[]> = {
  provider: [{ field: 'kind', label: 'auth' }],
  resource: [{ field: 'scopes', label: 'scopes' }],
}

// The most distinct values a single attribute surfaces, so a large or varied zone never inflates
// the prompt while the planner still sees the shape of what exists.
const ATTRIBUTE_VALUE_LIMIT = 16

// Collects a row's value for an allowlisted attribute field into the distinct set: a string is
// taken as-is, a string array contributes each primitive entry, and anything else is ignored. Only
// the named field is ever touched, so no other part of the row can leak.
function collectAttribute(into: Set<string>, value: unknown): void {
  if (typeof value === 'string') {
    if (value.length > 0) into.add(value)
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) if (typeof entry === 'string' && entry.length > 0) into.add(entry)
  }
}

// Extracts the decision-relevant attributes for a domain from its rows under the strict allowlist:
// the distinct values of each allowlisted field across all rows, bounded so the prompt stays small.
// Returns undefined when the domain has no allowlisted fields or none of its rows carry a value, so
// an evidence entry only carries attributes when there is real signal to ground on.
function summarizeAttributes(rows: Record<string, unknown>[], domain: string): Record<string, string[]> | undefined {
  const fields = DOMAIN_ATTRIBUTE_FIELDS[domain]
  if (!fields) return undefined
  const attributes: Record<string, string[]> = {}
  for (const { field, label } of fields) {
    const distinct = new Set<string>()
    for (const row of rows) collectAttribute(distinct, row[field])
    if (distinct.size > 0) attributes[label] = Array.from(distinct).slice(0, ATTRIBUTE_VALUE_LIMIT)
  }
  return Object.keys(attributes).length > 0 ? attributes : undefined
}

// Reduces a list result to a live count, a bounded list of safe names, the identified objects (id
// with name) a change can target, and the decision-relevant attributes its domain exposes. Only a
// row's name, its id, and the allowlisted descriptor fields reach the prompt, never the whole row,
// so a read can never leak an arbitrary field - secrets, tokens, or policy logic - into the model
// context.
function summarizeRows(
  result: unknown,
  domain: string,
): { count: number; names: string[]; items: EvidenceItem[]; attributes?: Record<string, string[]> } {
  const rows = Array.isArray(result) ? result : []
  const objects = rows.filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object')
  const names: string[] = []
  const items: EvidenceItem[] = []
  for (const row of objects.slice(0, EVIDENCE_SAMPLE_LIMIT)) {
    const name = typeof row.name === 'string' ? row.name : undefined
    const id = typeof row.id === 'string' ? row.id : undefined
    const label = name ?? id ?? null
    if (label) names.push(label)
    if (id) items.push(name ? { id, name } : { id })
  }
  return { count: rows.length, names, items, attributes: summarizeAttributes(objects, domain) }
}

// Narrows the governed reads to the object domains a turn actually concerns, so a request about one
// domain reads only that domain instead of fanning out across every read. An unspecified or empty
// domain set reads everything, and a domain set that maps to no governed read also falls back to the
// full set, so a turn can never end up with nothing to ground on because triage named a domain that
// has no read behind it.
function selectReads(domains: string[] | undefined): string[] {
  const all = governedReadCapabilities()
  if (!domains || domains.length === 0) return all
  const scoped = all.filter((id) => domains.includes(CAPABILITIES[id].domain))
  return scoped.length > 0 ? scoped : all
}

// Builds the state researcher over a control client. Each governed read mints a token narrowed
// to exactly that read's scopes and invokes the list command; the control plane authorizes,
// executes, and audits it - the same dogfooded path the Operator executes a change through. The
// reads run concurrently and are isolated: one read's failure becomes a typed evidence entry,
// never an exception that loses the others. A gather is scoped to the domains the turn names, so
// the fan-out is the smallest set that grounds the request, bounded by the governed read set.
export function createStateResearcher(client: ControlClient): Researcher {
  return {
    async gather(domains?: string[]): Promise<Blackboard> {
      const reads = selectReads(domains)
      const gen: ControlGen = { secret: '' }
      const evidence = await Promise.all(
        reads.map(async (id): Promise<Evidence> => {
          const capability = CONTROL_CAPABILITIES[id]
          const domain = CAPABILITIES[id].domain
          const invocation = capability.buildInvocation({}, gen)
          try {
            const result = await client.invoke(invocation.command, invocation.subcommand, invocation.flags, capability.scopes)
            const { count, names, items, attributes } = summarizeRows(result, domain)
            return { capability: id, domain, ok: true, count, names, items, attributes }
          } catch (err) {
            const error = err instanceof ControlClientError ? err.reason : 'read failed'
            return { capability: id, domain, ok: false, error }
          }
        }),
      )
      return { evidence }
    },
  }
}
