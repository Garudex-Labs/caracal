/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Settings security page for password rotation and browser sign-out.
*/
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import {
  ConfirmModal,
  InfoGrid,
  InfoItem,
  SettingsGroup,
} from "@/components/console/SettingsPanels";
import { Button, Field, useToast } from "@/components/ui";
import { changePassword, signOut } from "@/platform/auth";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/settings/security")({
  component: SecurityPage,
});

function SecurityPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [changing, setChanging] = useState(false);
  const [signOutOpen, setSignOutOpen] = useState(false);

  async function submitPassword() {
    if (next.length < 8) {
      toast({
        tone: "error",
        title: "Password too short",
        description: "Use at least 8 characters.",
      });
      return;
    }
    setChanging(true);
    try {
      const result = await changePassword({
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: true,
      });
      if (result?.error) throw new Error(result.error.message ?? "change_failed");
      setCurrent("");
      setNext("");
      toast({
        tone: "success",
        title: "Password changed",
        description: "Other sessions were signed out.",
      });
    } catch (err) {
      toast({
        tone: "error",
        title: "Could not change password",
        description:
          err instanceof Error ? err.message : "Check your current password and try again.",
      });
    } finally {
      setChanging(false);
    }
  }

  async function confirmSignOut() {
    await signOut();
    // Cached console data belongs to the account that just signed out; a later login on this
    // browser must start from an empty cache rather than another account's zones.
    qc.clear();
    navigate({ to: "/sign-in" });
  }

  return (
    <div>
      <SettingsGroup
        title="Password"
        description="Changing your password revokes every other active session immediately."
        action={
          <Button onClick={submitPassword} loading={changing} disabled={!current || !next}>
            Update password
          </Button>
        }
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <Field
            label="Current password"
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
          <Field
            label="New password"
            type="password"
            hint="Minimum 8 characters."
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="Sign out"
        description="End this browser session without changing account or control-plane data."
        action={
          <Button variant="secondary" onClick={() => setSignOutOpen(true)}>
            Sign out
          </Button>
        }
      >
        <InfoGrid>
          <InfoItem label="Effect" value="Current session only" />
          <InfoItem label="Data" value="Unchanged" />
        </InfoGrid>
      </SettingsGroup>

      <ConfirmModal
        open={signOutOpen}
        title="Sign out"
        description="Are you sure you want to sign out of Caracal? You will need to sign in again to continue."
        confirmLabel="Sign out"
        onClose={() => setSignOutOpen(false)}
        onConfirm={confirmSignOut}
      />
    </div>
  );
}
