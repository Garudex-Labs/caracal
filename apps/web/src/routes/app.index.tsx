/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file redirects the legacy flat /app entry to the account/org/zone-scoped Console dashboard.
*/
import { createFileRoute, redirect } from "@tanstack/react-router";

import { consoleApi } from "@/platform/api/client";
import { getActiveZoneId } from "@/platform/state/localInstall";
import { appLink } from "@/platform/nav/appLink";

async function firstZoneId(): Promise<string | null> {
  const active = getActiveZoneId();
  if (active) return active;
  try {
    return (await consoleApi.zones.list())[0]?.id ?? null;
  } catch {
    return null;
  }
}

export const Route = createFileRoute("/app/")({
  beforeLoad: async () => {
    const zoneId = await firstZoneId();
    if (!zoneId) throw redirect({ to: "/onboarding" });
    throw redirect({ to: appLink("", zoneId), replace: true });
  },
});
