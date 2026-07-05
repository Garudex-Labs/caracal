// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Async control helpers for bounded runtime operations.

// Rejects with `message` after `timeoutMs` if `task` has not settled.
// The underlying `task` is not cancelled and may continue running; its
// later resolution/rejection is discarded. Pass only idempotent reads
// (e.g. SELECT 1, PING) or operations whose stray completion is safe.
export async function withTimeout<T>(task: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
