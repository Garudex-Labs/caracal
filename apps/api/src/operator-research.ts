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

// One piece of evidence a researcher gathered from a single governed read. A success carries
// the live row count and a bounded list of names; a failure carries the typed reason so a
// partial gather still answers — a single denied or unreachable read narrows the evidence, it
// never fails the turn.
export interface Evidence {
  capability: string
  domain: string
  ok: boolean
  count?: number
  names?: string[]
  error?: string
}

// The per-turn blackboard: the typed evidence the turn's workers gathered. It is the turn's
// shared reasoning record — what was inspected and what it found — and lives only for the turn.
export interface Blackboard {
  evidence: Evidence[]
}

// An ephemeral worker bound to the Operator's own scoped control identity. It reads only — it
// can reach nothing but governed read capabilities — so it holds no authority to change state.
// A gather may be scoped to the object domains a turn concerns, so a request about one domain
// reads only that domain rather than fanning out across every governed read.
export interface Researcher {
  gather(domains?: string[]): Promise<Blackboard>
}

// The governed read capabilities: the capabilities mapped to a control command that the
// authoritative catalog marks non-mutating. Derived from the catalog and the control mapping,
// never hand-listed, so the read set can never drift from the mutating flag or the mapping —
// a researcher can never reach a mutating command.
export function governedReadCapabilities(): string[] {
  return Object.keys(CONTROL_CAPABILITIES).filter((id) => {
    const capability = CAPABILITIES[id]
    return capability !== undefined && !capability.mutating
  })
}

// Reduces a list result to a live count and a bounded list of safe names. Only a row's name
// (or its id when unnamed) reaches the prompt, never the whole row, so a read can never leak an
// arbitrary field — secrets, tokens, or policy logic — into the model context.
function summarizeRows(result: unknown): { count: number; names: string[] } {
  const rows = Array.isArray(result) ? result : []
  const names: string[] = []
  for (const row of rows.slice(0, EVIDENCE_SAMPLE_LIMIT)) {
    if (row && typeof row === 'object') {
      const record = row as Record<string, unknown>
      const label = typeof record.name === 'string' ? record.name : typeof record.id === 'string' ? record.id : null
      if (label) names.push(label)
    }
  }
  return { count: rows.length, names }
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
// executes, and audits it — the same dogfooded path the Operator executes a change through. The
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
            const { count, names } = summarizeRows(result)
            return { capability: id, domain, ok: true, count, names }
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
