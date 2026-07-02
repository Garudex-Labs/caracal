/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the authenticated Console layout route.
*/
import { createFileRoute } from "@tanstack/react-router";

import { ConsoleLayout } from "@/components/console/ConsoleLayout";
import { canonicalizeConsoleParams, requireOnboardedInstallation } from "@/platform/auth/guards";
import { isSystemZoneViewTab } from "@/platform/state/systemZoneView";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app")({
  beforeLoad: async ({ params, location }) => {
    await requireOnboardedInstallation();
    // The read-only system-zone viewer is pinned to the Caracal org and the system zone, which are
    // not in the normal zone list, so canonicalization would wrongly collapse them; skip it there.
    if (isSystemZoneViewTab()) return;
    const base = `/${params.accountId}/${params.orgId}/${params.zoneId}/app`;
    const sub = location.pathname.startsWith(base) ? location.pathname.slice(base.length) : "";
    await canonicalizeConsoleParams({ ...params, sub });
  },
  component: ConsoleLayout,
});
