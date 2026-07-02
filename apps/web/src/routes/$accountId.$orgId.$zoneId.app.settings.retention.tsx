/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Settings audit retention page for the platform-wide audit removal window.
*/
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { SettingsGroup } from "@/components/console/SettingsPanels";
import { Button, Field, Skeleton, useToast } from "@/components/ui";
import { useAuditRetention, useUpdateAuditRetention } from "@/platform/api/hooks";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/settings/retention")({
  component: RetentionPage,
});

function RetentionPage() {
  const toast = useToast();
  const retention = useAuditRetention();
  const update = useUpdateAuditRetention();
  const [days, setDays] = useState("");

  useEffect(() => {
    if (retention.data) setDays(String(retention.data.retention_days));
  }, [retention.data]);

  const max = retention.data?.max_days ?? 0;
  const parsed = Number(days);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= max;
  const error =
    days === "" || valid
      ? undefined
      : parsed > max
        ? `The deployment ceiling is ${max} days.`
        : "Enter a whole number of days, 1 or more.";

  function save() {
    update.mutate(parsed, {
      onSuccess: (result) => {
        toast({
          tone: "success",
          title: "Retention window saved",
          description: `Audit events older than ${result.retention_days} days are removed automatically.`,
        });
      },
      onError: (err) => {
        toast({
          tone: "error",
          title: "Could not save retention window",
          description: err instanceof Error ? err.message : "Unexpected error.",
        });
      },
    });
  }

  return (
    <div>
      <SettingsGroup
        title="Audit retention"
        description="Audit events are stored in monthly batches. On every rotation pass the audit service permanently removes batches older than this window, across all zones."
        action={
          <Button onClick={save} disabled={!valid || update.isPending}>
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        }
      >
        {retention.isLoading ? (
          <Skeleton className="h-9 w-48" />
        ) : (
          <div className="max-w-xs">
            <Field
              label="Retention window (days)"
              type="number"
              min={1}
              max={max}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              error={error}
              hint={`Deployment ceiling: ${max} days, set by AUDIT_RETENTION_DAYS. Removal is permanent and applies platform-wide.`}
            />
          </div>
        )}
      </SettingsGroup>
    </div>
  );
}
