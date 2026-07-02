/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Settings profile page for operator identity, account identifiers, and browser sign-out.
*/
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { ConfirmModal, InfoGrid, SettingsGroup } from "@/components/console/SettingsPanels";
import {
  AvatarPicker,
  Button,
  Field,
  IconButton,
  useCopyToClipboard,
  useToast,
} from "@/components/ui";
import { signOut, updateUser, useSession } from "@/platform/auth";
import {
  getProfile,
  HANDLE_MAX,
  NAME_MAX,
  resolveDisplayName,
  sanitizeHandle,
  setProfile,
  useProfile,
} from "@/platform/state/localInstall";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/settings/profile")({
  component: ProfilePage,
});

function ProfilePage() {
  const toast = useToast();
  const copyToClipboard = useCopyToClipboard();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const session = useSession();
  const profile = useProfile();
  const email = session.data?.user?.email ?? "-";

  const [fullName, setFullName] = useState(profile.fullName || session.data?.user?.name || "");
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [avatar, setAvatar] = useState(profile.avatar);
  const [saving, setSaving] = useState(false);
  const [signOutOpen, setSignOutOpen] = useState(false);

  useEffect(() => {
    setFullName(profile.fullName || session.data?.user?.name || "");
    setDisplayName(profile.displayName);
    setAvatar(profile.avatar);
  }, [profile, session.data?.user?.name]);

  async function save() {
    const name = fullName.trim() || "Owner";
    const handle = resolveDisplayName(fullName, displayName);
    setSaving(true);
    try {
      const result = await updateUser({ name, image: avatar || undefined });
      if (result?.error) throw new Error(result.error.message ?? "update_failed");
      setProfile({ ...getProfile(), fullName: name, displayName: handle, avatar });
      toast({ tone: "success", title: "Profile saved" });
    } catch (err) {
      toast({
        tone: "error",
        title: "Could not save profile",
        description: err instanceof Error ? err.message : "Unexpected error.",
      });
    } finally {
      setSaving(false);
    }
  }

  function copyAccountId() {
    void copyToClipboard(profile.accountId, { successTitle: "Account ID copied" });
  }

  function copyEmail() {
    void copyToClipboard(email, { successTitle: "Email copied" });
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
        title="Identity"
        action={
          <Button onClick={save} loading={saving}>
            Save profile
          </Button>
        }
      >
        <div className="grid gap-6">
          <AvatarPicker
            value={avatar}
            fallbackName={displayName || fullName}
            onChange={setAvatar}
          />
          <div className="grid gap-4 lg:grid-cols-2">
            <Field
              label="Full name"
              value={fullName}
              maxLength={NAME_MAX}
              onChange={(e) => setFullName(e.target.value.slice(0, NAME_MAX))}
            />
            <Field
              label="Display name"
              hint="Optional. Defaults to your first name. Shown in the profile menu."
              value={displayName}
              maxLength={HANDLE_MAX}
              onChange={(e) => setDisplayName(sanitizeHandle(e.target.value))}
            />
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="Account identifiers"
        description="Identifiers for this owner account."
        action={
          <Button variant="secondary" onClick={() => setSignOutOpen(true)}>
            Sign out
          </Button>
        }
      >
        <InfoGrid>
          <div className="flex min-h-[4rem] min-w-0 flex-col justify-between">
            <dt className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Account ID
            </dt>
            <dd className="mt-2 flex min-h-7 min-w-0 items-center justify-between gap-2">
              <span className="truncate font-mono text-xs text-foreground">
                {profile.accountId}
              </span>
              <IconButton
                type="button"
                label="Copy Account ID"
                className="h-7 w-7 flex-shrink-0"
                onClick={copyAccountId}
              >
                <CopyIcon />
              </IconButton>
            </dd>
          </div>
          <div className="flex min-h-[4rem] min-w-0 flex-col justify-between">
            <dt className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Email
            </dt>
            <dd className="mt-2 flex min-h-7 min-w-0 items-center justify-between gap-2">
              <span className="truncate font-mono text-xs text-foreground">{email}</span>
              <IconButton
                type="button"
                label="Copy Email"
                className="h-7 w-7 flex-shrink-0"
                onClick={copyEmail}
              >
                <CopyIcon />
              </IconButton>
            </dd>
          </div>
          <div className="flex min-h-[4rem] min-w-0 flex-col justify-between">
            <dt className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              Role
            </dt>
            <dd className="mt-2 flex min-h-7 items-center text-sm text-foreground">Owner</dd>
          </div>
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

function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}
