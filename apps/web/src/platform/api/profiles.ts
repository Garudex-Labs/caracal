/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file resolves immutable profile ids to current display names for attribution rendering.
*/
import { consoleApi } from "./client";

// Attribution fields persist immutable profile ids; rendering resolves them to the profile's
// current display name so a rename updates every historical record on screen while the stored
// audit identity never changes. A page renders many attribution cells at once, so concurrent
// lookups are coalesced into one request per tick; caching and refresh live in React Query at
// the call sites. Ids the backend does not recognize (admin credentials, other installs'
// stamps) resolve to null and render verbatim.
type Waiter = (name: string | null) => void;

const pending = new Map<string, Waiter[]>();
let flushScheduled = false;

async function flush(): Promise<void> {
  flushScheduled = false;
  const batch = new Map(pending);
  pending.clear();
  let names = new Map<string, string>();
  try {
    const { profiles } = await consoleApi.profiles.resolve([...batch.keys()]);
    names = new Map(profiles.map((p) => [p.id, p.name]));
  } catch {
    // A failed lookup is not a failed render: callers fall back to the stored identity and the
    // next render retries.
  }
  for (const [id, waiters] of batch) {
    const name = names.get(id) ?? null;
    for (const resolve of waiters) resolve(name === "" ? null : name);
  }
}

export function resolveProfileName(id: string): Promise<string | null> {
  return new Promise((resolve) => {
    const waiters = pending.get(id);
    if (waiters) waiters.push(resolve);
    else pending.set(id, [resolve]);
    if (!flushScheduled) {
      flushScheduled = true;
      queueMicrotask(() => void flush());
    }
  });
}
