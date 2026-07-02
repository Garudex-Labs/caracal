/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Settings preferences page for theme, guided-tour, and audit retention choices.
*/
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { ConfirmModal, SettingsGroup } from "@/components/console/SettingsPanels";
import { Button, Field, Skeleton, useToast } from "@/components/ui";
import { useAuditRetention, useUpdateAuditRetention } from "@/platform/api/hooks";
import { updateUser } from "@/platform/auth";
import { clearGuidesCache } from "@/platform/state/guides";
import { setTheme, useTheme } from "@/platform/theme";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/settings/preferences")({
  component: PreferencesPage,
});

function PreferencesPage() {
  const theme = useTheme();
  const toast = useToast();
  const [resetOpen, setResetOpen] = useState(false);
  const retention = useAuditRetention();
  const update = useUpdateAuditRetention();
  const [days, setDays] = useState("");

  useEffect(() => {
    if (retention.data) setDays(String(retention.data.retention_days));
  }, [retention.data]);

  const max = retention.data?.max_days ?? 0;
  const parsed = Number(days);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= max;
  const daysError =
    days === "" || valid ? undefined : parsed > max ? `Maximum ${max} days.` : "Enter 1 or more.";

  function saveRetention() {
    update.mutate(parsed, {
      onSuccess: (result) => {
        toast({
          tone: "success",
          title: "Retention window saved",
          description: `Audit events are kept for ${result.retention_days} days.`,
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

  async function resetGuides() {
    try {
      const result = await updateUser({ guides: "" });
      if (result?.error) throw new Error(result.error.message ?? "update_failed");
      clearGuidesCache();
      toast({
        tone: "success",
        title: "Guided tours restarted",
        description: "Walkthroughs will run again the next time you open their pages.",
      });
    } catch (err) {
      toast({
        tone: "error",
        title: "Could not restart tours",
        description: err instanceof Error ? err.message : "Unexpected error.",
      });
    }
  }

  return (
    <div>
      <SettingsGroup
        title="Appearance"
        description="Theme is stored per device and applies immediately across the web console."
      >
        <div className="inline-flex rounded-lg border border-border bg-muted/40 p-1">
          {(["dark", "light"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={theme === option}
              onClick={() => setTheme(option)}
              className={[
                "h-8 rounded-md px-3.5 text-xs font-medium capitalize transition-colors",
                theme === option
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              ].join(" ")}
            >
              {option}
            </button>
          ))}
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="Guided tours"
        description="Tour progress lives on your account, so a retired walkthrough stays retired on every device until you restart it here."
        action={
          <Button variant="secondary" onClick={() => setResetOpen(true)}>
            Restart tours
          </Button>
        }
      />

      <SettingsGroup
        title="Audit retention"
        description="Audit events older than this window are removed permanently, across all zones."
        action={
          <Button onClick={saveRetention} disabled={!valid} loading={update.isPending}>
            Save
          </Button>
        }
      >
        <div className="min-h-[3.75rem] max-w-[11rem]">
          {retention.isLoading ? (
            <Skeleton className="h-[3.75rem] w-full" />
          ) : (
            <Field
              label="Retention window (days)"
              type="number"
              min={1}
              max={max}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              error={daysError}
              hint={`Maximum ${max} days.`}
            />
          )}
        </div>
      </SettingsGroup>

      <ConfirmModal
        open={resetOpen}
        title="Restart guided tours"
        description="Every console walkthrough will run again on its next visit, on all of your devices."
        confirmLabel="Restart tours"
        onClose={() => setResetOpen(false)}
        onConfirm={resetGuides}
      />
    </div>
  );
}
