/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Settings danger-zone page for deleting the account and its owned zones.
*/
import { useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { InfoGrid, InfoItem, SettingsGroup } from "@/components/console/SettingsPanels";
import { Button, Field, Modal, useToast } from "@/components/ui";
import { consoleApi } from "@/platform/api/client";
import { useZones } from "@/platform/api/hooks";
import { AuthApiError, deleteAccount, useSession } from "@/platform/auth";
import { appLink } from "@/platform/nav/appLink";
import { clearLocalIdentity } from "@/platform/state/localInstall";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/settings/danger")({
  component: DangerPage,
});

function DangerPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const session = useSession();
  const zones = useZones();
  const email = session.data?.user?.email ?? "";

  const [confirm, setConfirm] = useState("");
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const zoneCount = zones.data?.length ?? 0;
  const blocked = zones.isLoading;
  const confirmReady = confirm.trim() === email;

  async function confirmDelete() {
    setDeleting(true);
    try {
      // Profile deletion must be the guaranteed outcome: clean up owned zones on a
      // best-effort basis so a single zone failure (e.g. a 404 for an already
      // archived zone) can never leave the operator's profile behind.
      let zoneFailures = 0;
      try {
        const latest = await zones.refetch();
        for (const zone of latest.data ?? []) {
          try {
            await consoleApi.zones.delete(zone.id);
          } catch {
            zoneFailures += 1;
          }
        }
      } catch {
        zoneFailures += 1;
      }

      await deleteAccount(confirm);
      clearLocalIdentity();
      qc.clear();
      if (zoneFailures > 0) {
        toast({
          tone: "info",
          title: "Profile deleted",
          description: `${zoneFailures} zone${zoneFailures === 1 ? "" : "s"} could not be removed and may need manual cleanup.`,
        });
      }
      navigate({ to: "/sign-in" });
    } catch (err) {
      toast({
        tone: "error",
        title: "Could not delete profile",
        description:
          err instanceof AuthApiError
            ? err.code
            : err instanceof Error
              ? err.message
              : "Unexpected error.",
      });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div>
      <SettingsGroup
        title="Deletion scope"
        description="Deleting the profile also removes every zone it owns."
      >
        <InfoGrid>
          <InfoItem
            label="Zones"
            value={zones.isLoading ? "..." : zones.isError ? "!" : String(zoneCount)}
          />
          <InfoItem label="Owner email" value={email || "-"} mono />
        </InfoGrid>
      </SettingsGroup>

      <SettingsGroup
        title="Delete profile"
        description="Permanently removes your profile, sessions, sign-in accounts, and zones."
        danger
      >
        <div className="border border-destructive/30 bg-destructive/5 p-4">
          {zones.isError ? (
            <p className="text-sm text-destructive">Zone state unavailable.</p>
          ) : zoneCount > 0 ? (
            <p className="text-sm text-destructive">
              Includes {zoneCount} zone{zoneCount === 1 ? "" : "s"}.
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <Link
              to={appLink("/zones")}
              className="inline-flex h-9 items-center rounded-md border border-border bg-background px-4 text-sm font-medium text-foreground transition-colors hover:bg-surface"
            >
              Manage zones
            </Link>
            <Button variant="danger" disabled={blocked} onClick={() => setOpen(true)}>
              Delete profile
            </Button>
          </div>
        </div>

        <Modal
          open={open}
          onClose={() => setOpen(false)}
          title="Delete profile"
          description="This deletes your profile, sessions, sign-in accounts, and all owned zones. This action cannot be undone."
          footer={
            <>
              <Button variant="secondary" onClick={() => setOpen(false)} disabled={deleting}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={confirmDelete}
                loading={deleting}
                disabled={!confirmReady}
              >
                Delete profile and zones
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <p className="text-sm leading-6 text-muted-foreground">
              Type <span className="font-mono text-foreground">{email}</span> to confirm.
            </p>
            <InfoGrid>
              <InfoItem label="Zones" value={String(zoneCount)} />
              <InfoItem label="Profile" value="Delete" />
            </InfoGrid>
            <Field
              label="Confirm email"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              autoFocus
            />
          </div>
        </Modal>
      </SettingsGroup>
    </div>
  );
}
