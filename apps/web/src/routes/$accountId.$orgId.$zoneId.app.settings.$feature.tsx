/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file renders settings-homed enterprise capabilities as locked upsell pages inside the Settings shell.
*/
import { createFileRoute, redirect } from "@tanstack/react-router";

import { EnterpriseUpsell } from "@/components/console/EnterpriseUpsell";
import { LOCKED_FEATURES } from "@/platform/edition/lockedFeatures";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/settings/$feature")({
  beforeLoad: ({ params }) => {
    const data = LOCKED_FEATURES[params.feature];
    if (!data || data.home !== "settings") {
      throw redirect({
        to: "/$accountId/$orgId/$zoneId/app/settings/profile",
        params,
        replace: true,
      });
    }
  },
  component: LockedSettingsPage,
});

function LockedSettingsPage() {
  const { feature } = Route.useParams();

  return (
    <div className="py-6">
      <EnterpriseUpsell feature={LOCKED_FEATURES[feature]} heading={false} />
    </div>
  );
}
