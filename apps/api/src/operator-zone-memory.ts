// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Persistent zone-scoped Operator memory: durable knowledge of governed changes already applied in a zone, carried across conversations.

import { v7 as uuidv7 } from 'uuid'

// One durable memory of a governed change that was applied in a zone. Persisted
// independently of any single conversation, so a new conversation in the same zone
// recalls what has already been configured without re-reading the whole history.
export interface ZoneMemoryEntry {
  text: string
  created_at: string
}

interface ZoneMemoryReadable {
  query: <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>
}

interface ZoneMemoryWritable {
  query: (text: string, params?: unknown[]) => Promise<unknown>
}

// The number of durable memories surfaced into an agent's context. Recent applied
// changes carry the most signal, so a bounded most-recent window keeps the prompt small
// while still grounding the agent in the zone's established shape.
const ZONE_MEMORY_RECALL_LIMIT = 12

// The maximum length of a single memory. A plan summary is already short; this is the
// hard ceiling that keeps any one memory from bloating the store or the prompt.
const ZONE_MEMORY_TEXT_MAX = 2000

// Reads the most recent durable memories for a zone, newest first. Bounded by a small
// limit so the read and the resulting prompt block stay cheap no matter how much history
// the zone has accumulated.
export async function recallZoneMemory(
  db: ZoneMemoryReadable,
  zoneId: string,
  limit: number = ZONE_MEMORY_RECALL_LIMIT,
): Promise<ZoneMemoryEntry[]> {
  const { rows } = await db.query<ZoneMemoryEntry>(
    `SELECT text, created_at FROM operator_zone_memory
     WHERE zone_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [zoneId, Math.max(1, limit)],
  )
  return rows
}

// Renders durable zone memory into a compact prompt block. Returns an empty string when a
// zone has no recorded changes yet, so an untouched zone adds no context overhead. Each entry
// renders as a dated past-tense event, so the block is structurally an activity log - what was
// done and when - rather than a set of claims about what exists: an object an event mentions may
// have since been deleted or renamed outside the Operator entirely.
export function describeZoneMemory(entries: ZoneMemoryEntry[] | undefined): string {
  if (!entries || entries.length === 0) return ''
  const lines = entries.map((entry) => {
    const time = new Date(entry.created_at)
    const day = Number.isNaN(time.getTime()) ? null : time.toISOString().slice(0, 10)
    return day ? `- ${day}: applied "${entry.text}"` : `- applied "${entry.text}"`
  })
  return `Durable zone memory (newest first - governed changes applied in earlier conversations; history only, not current state; never treat an entry as proof the object still exists):\n${lines.join('\n')}`
}

// Records a durable memory of a governed change that was actually applied. Called only from
// inside the execution-recording transaction, so a memory exists exactly when an approved plan
// reached the control plane: the model proposed, Caracal decided and applied, and this writes a
// faithful record of the outcome - memory holds no authority of its own. The write is bounded in
// length and deduplicated on its text, so a zone's memory cannot grow without limit or accumulate
// identical repeats from a re-applied plan.
export async function rememberAppliedChange(
  client: ZoneMemoryWritable,
  zoneId: string,
  conversationId: string,
  summary: string,
): Promise<void> {
  const text = summary.trim().slice(0, ZONE_MEMORY_TEXT_MAX)
  if (text.length === 0) return
  await client.query(
    `INSERT INTO operator_zone_memory (id, zone_id, conversation_id, text)
     SELECT $1, $2, $3, $4
     WHERE NOT EXISTS (
       SELECT 1 FROM operator_zone_memory WHERE zone_id = $2 AND text = $4
     )`,
    [uuidv7(), zoneId, conversationId, text],
  )
}
