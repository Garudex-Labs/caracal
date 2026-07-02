/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file binds a guide's progress to the signed-in account record, with the browser cache as a write-through fallback.
*/
import { useCallback, useEffect, useRef, useState } from "react";

import { updateUser, useSession } from "@/platform/auth";
import {
  guideRank,
  mergeGuides,
  parseGuides,
  readGuidesCache,
  serializeGuides,
  writeGuidesCache,
  type GuideMap,
  type GuideStatus,
} from "@/platform/state/guides";

export interface GuideProgress {
  /** Resolved status, merged across the browser cache and the account record. */
  status: GuideStatus;
  /** True once the signed-in account record has answered, so launch decisions never race it. */
  ready: boolean;
  /** Move the guide forward. Regressions are ignored, so a retired guide can never revive. */
  advance(next: GuideStatus): void;
}

function pushToAccount(map: GuideMap): void {
  void updateUser({ guides: serializeGuides(map) }).catch(() => {});
}

// The account record is the source of truth; the cache makes reads synchronous and carries
// progress across a briefly unreachable backend. Every advance writes both, and each
// sign-in heals an account record that lags the cache (an earlier write interrupted by
// going offline or a restart), so the two can never drift apart for long.
export function useGuide(id: string): GuideProgress {
  const session = useSession();
  const user = session.data?.user ?? null;
  const serverRaw = user ? ((user as { guides?: string | null }).guides ?? "") : "";
  const [local, setLocal] = useState<GuideMap>(readGuidesCache);
  const healedRef = useRef(false);

  useEffect(() => {
    if (!user || healedRef.current) return;
    healedRef.current = true;
    const server = parseGuides(serverRaw);
    const merged = mergeGuides(readGuidesCache(), server);
    const lagging = Object.entries(merged).some(
      ([key, status]) => guideRank(status) > guideRank(server[key] ?? "unseen"),
    );
    if (lagging) pushToAccount(merged);
  }, [user, serverRaw]);

  const merged = mergeGuides(local, parseGuides(serverRaw));
  const status = merged[id] ?? "unseen";

  const advance = useCallback(
    (next: GuideStatus) => {
      const map = mergeGuides(readGuidesCache(), parseGuides(serverRaw));
      const current = map[id] ?? "unseen";
      if (guideRank(next) <= guideRank(current)) return;
      const advanced = { ...map, [id]: next };
      writeGuidesCache(advanced);
      setLocal(advanced);
      pushToAccount(advanced);
    },
    [id, serverRaw],
  );

  return { status, ready: !session.isPending && user !== null, advance };
}
