/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Settings profile page for operator identity and account identifiers.
*/
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { InfoGrid, InfoItem, SettingsGroup } from "@/components/console/SettingsPanels";
import { AvatarPicker, Button, Field, useToast } from "@/components/ui";
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
  const session = useSession();
  const profile = useProfile();

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

  return (
    <div>
      <SettingsGroup
        title="Profile image"
        description="Use a compact operator icon that appears in the dashboard navbar and profile menu."
      >
        <AvatarPicker value={avatar} fallbackName={displayName || fullName} onChange={setAvatar} />
      </SettingsGroup>

      <SettingsGroup
        title="Operator identity"
        description="The display name is the short name shown in Caracal chrome. The full name is stored on your authenticated user record."
        action={
          <Button onClick={save} loading={saving}>
            Save profile
          </Button>
        }
      >
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
      </SettingsGroup>

      <SettingsGroup title="Account identifiers" description="Identifiers for this owner account.">
        <InfoGrid>
          <InfoItem label="Account ID" value={profile.accountId} mono />
          <InfoItem label="Email" value={session.data?.user?.email ?? "-"} mono />
          <InfoItem label="Role" value="Owner" />
        </InfoGrid>
      </SettingsGroup>
    </div>
  );
}
