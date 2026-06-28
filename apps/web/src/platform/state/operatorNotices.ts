/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file holds the session-scoped, in-memory log of Operator notices shared between the Operator workspace and the Audit page.
*/
import { useSyncExternalStore } from "react";

// The Operator surfaces client-observed conditions (a send with no provider, a request that could
// not be processed, a degraded-but-handled state) as labels. These are not authority decisions and
// are never sent to the server, so they are recorded here in a session-scoped, in-memory log that
// both the Operator workspace badge and the Audit page read, keeping no client-to-server ingest
// surface. severity distinguishes a hard failure from a non-blocking warning so the Audit page can
// label, colour, filter, and sort by it.
export type OperatorNoticeSeverity = "error" | "warning";

export interface OperatorNoticeRecord {
  id: string;
  severity: OperatorNoticeSeverity;
  message: string;
  at: number;
}

const MAX_RECORDS = 100;

let records: OperatorNoticeRecord[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): OperatorNoticeRecord[] {
  return records;
}

// Appends a notice to the shared log, newest first, bounded so a long session cannot grow it
// without limit. Returns the recorded entry so a caller can reference the same id.
export function recordOperatorNotice(
  severity: OperatorNoticeSeverity,
  message: string,
): OperatorNoticeRecord {
  const entry: OperatorNoticeRecord = {
    id: crypto.randomUUID(),
    severity,
    message,
    at: Date.now(),
  };
  records = [entry, ...records].slice(0, MAX_RECORDS);
  emit();
  return entry;
}

export function clearOperatorNotices(): void {
  if (records.length === 0) return;
  records = [];
  emit();
}

// Subscribes a component to the shared log. The snapshot is the stable array reference between
// changes, so a consumer re-renders only when a notice is recorded or the log is cleared.
export function useOperatorNotices(): OperatorNoticeRecord[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
