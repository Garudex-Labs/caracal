/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Settings profile page for operator identity and account identifiers.
*/
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { InfoGrid, SettingsGroup } from "@/components/console/SettingsPanels";
import {
  AvatarPicker,
  Button,
  Field,
  IconButton,
  useCopyToClipboard,
  useToast,
} from "@/components/ui";
import { updateUser, useSession } from "@/platform/auth";
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
  const session = useSession();
  const profile = useProfile();
  const email = session.data?.user?.email ?? "-";

  const [fullName, setFullName] = useState(profile.fullName || session.data?.user?.name || "");
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [avatar, setAvatar] = useState(profile.avatar);
  const [saving, setSaving] = useState(false);

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

      <SettingsGroup title="Account identifiers" description="Identifiers for this owner account.">
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
