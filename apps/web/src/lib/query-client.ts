// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0


import { MutationCache, QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError } from "./api";
import { userMessageFor } from "./errors";

// Retry only failures that can plausibly succeed unchanged: network drops,
// timeouts, 429 and 502/503/504. Client errors (401/403/404/409/422) never
// retry - the request must change first.
function retryQuery(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.retryable && failureCount < 2;
  }
  return failureCount < 1;
}

function retryDelay(attempt: number, error: unknown): number {
  if (error instanceof ApiError && error.retryAfterMs) {
    return Math.min(error.retryAfterMs, 30_000);
  }
  // Exponential backoff with jitter: ~1s, ~2s.
  return Math.min(1000 * 2 ** attempt, 15_000) * (0.75 + Math.random() / 2);
}

export function makeQueryClient() {
  return new QueryClient({
    // Fallback so a mutation without a local onError never fails silently.
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if (!mutation.options.onError) toast.error(userMessageFor(error));
      },
    }),
    defaultOptions: {
      queries: { staleTime: 30 * 1000, retry: retryQuery, retryDelay },
      mutations: { retry: false },
    },
  });
}
