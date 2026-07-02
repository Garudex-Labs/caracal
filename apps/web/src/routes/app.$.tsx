/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file redirects legacy flat /app/* links to the account/org/zone-scoped Console path.
*/
import { createFileRoute, redirect } from "@tanstack/react-router";

import { consoleApi } from "@/platform/api/client";
import { getActiveZoneId } from "@/platform/state/localInstall";
import { appLink } from "@/platform/nav/appLink";

export const Route = createFileRoute("/app/$")({
  beforeLoad: async ({ params }) => {
    let zoneId = getActiveZoneId();
    if (!zoneId) {
      try {
        zoneId = (await consoleApi.zones.list())[0]?.id ?? null;
      } catch {
        zoneId = null;
      }
    }
    if (!zoneId) throw redirect({ to: "/onboarding" });
    const sub = params._splat ? `/${params._splat}` : "";
    throw redirect({ to: appLink(sub, zoneId), replace: true });
  },
});
