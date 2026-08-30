// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0


import { useEffect, useRef } from "react";
import {
  useQuery,
  useQueryClient,
  keepPreviousData,
} from "@tanstack/react-query";
import {
  dashboard,
} from "@/lib/api";
import { useCurrentOrg } from "@/hooks/use-current-org";
import { useCurrentProject } from "@/hooks/use-current-project";
import type { TraceQueryParams } from "@/lib/types";

// ── Sessions ───────────────────────────────────────────────────────

export function useSessions(options?: {
  refetchInterval?: number | false;
  platform?: string;
  user?: string;
  days?: number;
  limit?: number;
  offset?: number;
  mine?: boolean;
}) {
  const { currentOrg } = useCurrentOrg();
  const { currentProject } = useCurrentProject();
  return useQuery({
    queryKey: ['sessions', currentOrg?.slug, currentProject?.slug, 'list', options?.platform, options?.user, options?.days, options?.limit, options?.offset, options?.mine],
    queryFn: () =>
      dashboard.sessions({
        platform: options?.platform,
        user: options?.user,
        days: options?.days,
        limit: options?.limit,
        offset: options?.offset,
        mine: options?.mine,
      }),
    refetchInterval: options?.refetchInterval,
    enabled: !!currentOrg && !!currentProject,
    refetchOnMount: "always",
    staleTime: 0,
  });
}

/** The unified investigation listing: one server-side query for search,
 * filters, thresholds, sort, and pagination. */
export function useTraceQuery(params: TraceQueryParams) {
  const { currentOrg } = useCurrentOrg();
  const { currentProject } = useCurrentProject();
  return useQuery({
    queryKey: ['sessions', currentOrg?.slug, currentProject?.slug, 'query', params],
    queryFn: () => dashboard.sessionsQuery(params),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    enabled: !!currentOrg && !!currentProject,
  });
}
export function useSessionDetail(id: string | undefined) {
  const { currentOrg } = useCurrentOrg();
  const { currentProject } = useCurrentProject();
  return useQuery({
    queryKey: ['sessions', currentOrg?.slug, currentProject?.slug, 'detail', id],
    queryFn: () => dashboard.session(id!),
    enabled: !!id && !!currentOrg && !!currentProject,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    refetchOnMount: "always",
    staleTime: 1_000,
  });
}

export function useSessionSubscription() {
  const qc = useQueryClient();
  const listDebounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    import("@/lib/graphql-ws").then(({ subscribeToSessionUpdates }) => {
      unsubscribe = subscribeToSessionUpdates((sessionId) => {
        // Debounce the list refetch (many events → one list refresh)
        clearTimeout(listDebounceRef.current);
        listDebounceRef.current = setTimeout(() => {
          qc.invalidateQueries({ queryKey: ["sessions"] });
        }, 300);
        // Session detail: invalidate immediately so new turns appear
        qc.invalidateQueries({ queryKey: ["sessions"], predicate: (query) => query.queryKey.includes(sessionId) });
      });
    });

    return () => {
      clearTimeout(listDebounceRef.current);
      unsubscribe?.();
    };
  }, [qc]);
}
