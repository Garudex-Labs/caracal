// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Persistent per-conversation Operator memory: durable events of governed changes applied in one chat, isolated from every other chat.

import { v7 as uuidv7 } from 'uuid'

// One durable memory of a governed change this conversation applied. Every chat's memory is
// its own: an entry is recalled only by the conversation that made the change, so one chat's
// history never colors another's reasoning. Zone-wide state reaches an agent exclusively
// through live governed reads.
export interface ConversationMemoryEntry {
  text: string
  created_at: string
}

interface MemoryReadable {
  query: <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>
}

interface MemoryWritable {
  query: (text: string, params?: unknown[]) => Promise<unknown>
}

// The number of durable memories surfaced into an agent's context. Recent applied
// changes carry the most signal, so a bounded most-recent window keeps the prompt small
// no matter how much a long-running chat has applied.
const MEMORY_RECALL_LIMIT = 12

// The maximum length of a single memory. A plan summary is already short; this is the
// hard ceiling that keeps any one memory from bloating the store or the prompt.
const MEMORY_TEXT_MAX = 2000

// Reads the most recent durable memories of this one conversation, newest first. Scoped by
// both zone and conversation so a chat recalls only what it applied itself; bounded by a
// small limit so the read and the resulting prompt block stay cheap.
export async function recallConversationMemory(
  db: MemoryReadable,
  zoneId: string,
  conversationId: string,
  limit: number = MEMORY_RECALL_LIMIT,
): Promise<ConversationMemoryEntry[]> {
  const { rows } = await db.query<ConversationMemoryEntry>(
    `SELECT text, created_at FROM operator_zone_memory
     WHERE zone_id = $1 AND conversation_id = $2
     ORDER BY created_at DESC, id DESC
     LIMIT $3`,
    [zoneId, conversationId, Math.max(1, limit)],
  )
  return rows
}

// Renders this conversation's durable memory into a compact prompt block. Returns an empty
// string when the chat has applied nothing yet, so a fresh chat adds no context overhead. Each
// entry renders as a dated past-tense event, so the block is structurally an activity log - what
// this chat did and when - rather than a set of claims about what exists: an object an event
// mentions may have since been deleted or renamed outside this chat entirely.
export function describeConversationMemory(entries: ConversationMemoryEntry[] | undefined): string {
  if (!entries || entries.length === 0) return ''
  const lines = entries.map((entry) => {
    const time = new Date(entry.created_at)
    const day = Number.isNaN(time.getTime()) ? null : time.toISOString().slice(0, 10)
    return day ? `- ${day}: applied "${entry.text}"` : `- applied "${entry.text}"`
  })
  return `Durable memory of this chat (newest first - governed changes this conversation applied; history only, not current state; never treat an entry as proof the object still exists):\n${lines.join('\n')}`
}

// Records a durable memory of a governed change that was actually applied. Called only from
// inside the execution-recording transaction, so a memory exists exactly when an approved plan
// reached the control plane: the model proposed, Caracal decided and applied, and this writes a
// faithful record of the outcome - memory holds no authority of its own. The write is bounded in
// length and deduplicated on its text within the conversation, so a chat's memory cannot grow
// without limit or accumulate identical repeats from a re-applied plan.
export async function rememberAppliedChange(
  client: MemoryWritable,
  zoneId: string,
  conversationId: string,
  summary: string,
): Promise<void> {
  const text = summary.trim().slice(0, MEMORY_TEXT_MAX)
  if (text.length === 0) return
  await client.query(
    `INSERT INTO operator_zone_memory (id, zone_id, conversation_id, text)
     SELECT $1, $2, $3, $4
     WHERE NOT EXISTS (
       SELECT 1 FROM operator_zone_memory WHERE zone_id = $2 AND conversation_id = $3 AND text = $4
     )`,
    [uuidv7(), zoneId, conversationId, text],
  )
}
