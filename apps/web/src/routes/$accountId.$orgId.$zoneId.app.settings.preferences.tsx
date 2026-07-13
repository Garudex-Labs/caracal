/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Settings preferences page for theme, guided-tour, audit retention, and mint rate limit choices.
*/
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { CreatedBy } from "@/components/console/CreatedBy";
import { ConfirmModal, SettingsGroup } from "@/components/console/SettingsPanels";
import { Button, Field, Skeleton, useToast } from "@/components/ui";
import {
  useAuditRetention,
  useMintRateLimit,
  useUpdateAuditRetention,
  useUpdateMintRateLimit,
} from "@/platform/api/hooks";
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
  const mintRate = useMintRateLimit();
  const updateMintRate = useUpdateMintRateLimit();
  const [mintPerMinute, setMintPerMinute] = useState("");

  useEffect(() => {
    if (retention.data) setDays(String(retention.data.retention_days));
  }, [retention.data]);

  useEffect(() => {
    if (mintRate.data) setMintPerMinute(String(mintRate.data.limit_per_minute));
  }, [mintRate.data]);

  const max = retention.data?.max_days ?? 0;
  const parsed = Number(days);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= max;
  const daysError =
    days === "" || valid ? undefined : parsed > max ? `Maximum ${max} days.` : "Enter 1 or more.";

  const mintMax = mintRate.data?.max_per_minute ?? 0;
  const mintParsed = Number(mintPerMinute);
  const mintValid = Number.isInteger(mintParsed) && mintParsed >= 1 && mintParsed <= mintMax;
  const mintError =
    mintPerMinute === "" || mintValid
      ? undefined
      : mintParsed > mintMax
        ? `Maximum ${mintMax} per minute; raise STS_MINT_RATE_LIMIT_PER_MIN to go higher.`
        : "Enter 1 or more.";

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

  function saveMintRate() {
    updateMintRate.mutate(mintParsed, {
      onSuccess: (result) => {
        toast({
          tone: "success",
          title: "Mint rate limit saved",
          description: `Each Resource and Application pair can mint ${result.limit_per_minute} mandates per minute.`,
        });
      },
      onError: (err) => {
        toast({
          tone: "error",
          title: "Could not save mint rate limit",
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
        {retention.data?.updated_by ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Last set by <CreatedBy id={retention.data.updated_by} />
            {retention.data.updated_at
              ? ` on ${new Date(retention.data.updated_at).toLocaleString()}`
              : ""}
            .
          </p>
        ) : null}
      </SettingsGroup>

      <SettingsGroup
        title="Mint rate limit"
        description="How many mandate mints per minute the STS allows for each Resource and Application pair, across all zones; requests beyond it are denied until the minute rolls over. The deployment ceiling comes from STS_MINT_RATE_LIMIT_PER_MIN."
        action={
          <Button onClick={saveMintRate} disabled={!mintValid} loading={updateMintRate.isPending}>
            Save
          </Button>
        }
      >
        <div className="min-h-[3.75rem] max-w-[11rem]">
          {mintRate.isLoading ? (
            <Skeleton className="h-[3.75rem] w-full" />
          ) : (
            <Field
              label="Mints per minute"
              type="number"
              min={1}
              max={mintMax}
              value={mintPerMinute}
              onChange={(e) => setMintPerMinute(e.target.value)}
              error={mintError}
              hint={`Maximum ${mintMax} per minute.`}
            />
          )}
        </div>
        {mintRate.data?.updated_by ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Last set by <CreatedBy id={mintRate.data.updated_by} />
            {mintRate.data.updated_at
              ? ` on ${new Date(mintRate.data.updated_at).toLocaleString()}`
              : ""}
            .
          </p>
        ) : null}
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
