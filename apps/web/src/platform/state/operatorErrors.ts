/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file holds the session-scoped, in-memory log of Operator errors shared between the Operator workspace and the Audit page.
*/
import { useSyncExternalStore } from "react";

// The Operator surfaces client-observed failures (a send with no provider, a request that could not
// be processed) as error labels. Those are not authority decisions and are never sent to the
// server, so they are recorded here in a session-scoped, in-memory log that both the Operator
// workspace badge and the Audit page read, keeping no client-to-server error ingest surface.
export interface OperatorErrorRecord {
  id: string;
  message: string;
  at: number;
}

const MAX_RECORDS = 100;

let records: OperatorErrorRecord[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): OperatorErrorRecord[] {
  return records;
}

// Appends an error to the shared log, newest first, bounded so a long session cannot grow it
// without limit. Returns the recorded entry so a caller can reference the same id.
export function recordOperatorError(message: string): OperatorErrorRecord {
  const entry: OperatorErrorRecord = { id: crypto.randomUUID(), message, at: Date.now() };
  records = [entry, ...records].slice(0, MAX_RECORDS);
  emit();
  return entry;
}

export function clearOperatorErrors(): void {
  if (records.length === 0) return;
  records = [];
  emit();
}

// Subscribes a component to the shared log. The snapshot is the stable array reference between
// changes, so a consumer re-renders only when an error is recorded or the log is cleared.
export function useOperatorErrors(): OperatorErrorRecord[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
