/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the contextual enterprise capability route for observability and policy upgrades.
*/
import { createFileRoute } from "@tanstack/react-router";

import { EnterpriseUpsell } from "@/components/console/EnterpriseUpsell";
import { ModulePage } from "@/components/console/ModulePage";
import { Button, LockBadge } from "@/components/ui";
import { config } from "@/platform/config";
import { LOCKED_FEATURES } from "@/platform/edition/lockedFeatures";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/enterprise/$feature")({
  component: LockedFeaturePage,
});

const HOME_LABEL: Record<string, string> = {
  observability: "Observability",
  policy: "Policy",
  settings: "Settings",
};

function LockedFeaturePage() {
  const { feature } = Route.useParams();
  const data = LOCKED_FEATURES[feature];

  if (!data) {
    return (
      <ModulePage title="Enterprise" description="This capability is part of Caracal Enterprise.">
        <div className="border border-border p-6">
          <p className="text-sm text-muted-foreground">Learn more about Caracal Enterprise.</p>
          <a
            className="mt-4 inline-block"
            href={config.enterpriseUrl}
            target="_blank"
            rel="noreferrer"
          >
            <Button>Explore Enterprise</Button>
          </a>
        </div>
      </ModulePage>
    );
  }

  return (
    <ModulePage
      title={data.title}
      description={data.summary}
      breadcrumbs={[
        { label: "Console", to: "/app" },
        { label: HOME_LABEL[data.home] ?? "Enterprise" },
        { label: data.title },
      ]}
      actions={<LockBadge />}
    >
      <EnterpriseUpsell feature={data} heading={false} />
    </ModulePage>
  );
}
