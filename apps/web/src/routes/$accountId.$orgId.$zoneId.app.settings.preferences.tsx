/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Settings preferences page for theme and guided-tour choices.
*/
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { ConfirmModal, SettingsGroup } from "@/components/console/SettingsPanels";
import { Button, useToast } from "@/components/ui";
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
        <div className="inline-flex border border-border bg-card p-1">
          {(["dark", "light"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={theme === option}
              onClick={() => setTheme(option)}
              className={[
                "h-8 px-3 text-xs font-medium capitalize transition-colors",
                theme === option
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:bg-surface hover:text-foreground",
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
      >
        <p className="max-w-prose text-sm text-muted-foreground">
          Restarting clears the completion record for every console walkthrough, such as the
          first-zone setup guide. Each tour runs again the next time its page is opened.
        </p>
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
