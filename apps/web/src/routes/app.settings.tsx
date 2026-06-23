/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the settings route.
*/
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { ModulePage } from "@/components/console/ModulePage";
import { Button, Card, ConfirmDialog, Field, SectionTitle, Tabs, useToast } from "@/components/ui";
import { resetAuthAccounts, signOut, useSession } from "@/platform/auth";
import { getProfile, resetInstallation, setProfile } from "@/platform/state/localInstall";

export const Route = createFileRoute("/app/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const session = useSession();
  const [tab, setTab] = useState("profile");

  const profile = getProfile();
  const [fullName, setFullName] = useState(profile.fullName);
  const [displayName, setDisplayName] = useState(profile.displayName);
  const accountId = profile.accountId;
  const [saving, setSaving] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

  function saveProfile() {
    setSaving(true);
    setProfile({
      ...getProfile(),
      fullName: fullName.trim() || "Owner",
      displayName: displayName.trim(),
    });
    setSaving(false);
    toast({ tone: "success", title: "Profile saved" });
  }

  async function resetEnvironment() {
    await resetAuthAccounts();
    resetInstallation();
    await signOut().catch(() => undefined);
    navigate({ to: "/sign-in" });
  }

  return (
    <ModulePage
      title="Settings"
      description="Manage your profile and account."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Settings" }]}
    >
      <div className="mb-5">
        <Tabs
          tabs={[
            { id: "profile", label: "Profile" },
            { id: "account", label: "Account" },
            { id: "testing", label: "Testing" },
          ]}
          active={tab}
          onChange={setTab}
        />
      </div>

      {tab === "profile" ? (
        <Card className="max-w-xl">
          <SectionTitle>Profile</SectionTitle>
          <div className="mt-4 flex flex-col gap-4">
            <Field
              label="Full name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
            <Field
              label="Display name"
              hint="Optional. How you appear in the Console."
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
            <Field
              label="Account ID"
              value={accountId}
              readOnly
              disabled
              hint="Generated and locked. Your internal identifier."
            />
            <div>
              <Button onClick={saveProfile} loading={saving}>
                Save changes
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      {tab === "account" ? (
        <Card className="max-w-xl">
          <SectionTitle>Account</SectionTitle>
          <dl className="mt-4 divide-y divide-border text-sm">
            <div className="flex justify-between py-2.5">
              <dt className="text-muted-foreground">Name</dt>
              <dd className="font-medium text-foreground">{session.data?.user?.name ?? "—"}</dd>
            </div>
            <div className="flex justify-between py-2.5">
              <dt className="text-muted-foreground">Email</dt>
              <dd className="font-mono text-xs text-foreground">
                {session.data?.user?.email ?? "—"}
              </dd>
            </div>
            <div className="flex justify-between py-2.5">
              <dt className="text-muted-foreground">Role</dt>
              <dd className="font-medium text-foreground">Owner</dd>
            </div>
          </dl>
          <div className="mt-4">
            <Button
              variant="secondary"
              onClick={async () => {
                await signOut();
                navigate({ to: "/sign-in" });
              }}
            >
              Sign out
            </Button>
          </div>
        </Card>
      ) : null}

      {tab === "testing" ? (
        <Card className="max-w-xl border-destructive/30">
          <SectionTitle>Reset environment</SectionTitle>
          <p className="mt-3 text-sm text-muted-foreground">
            Temporary testing tool. This deletes your profile, zones, and all local accounts and
            sessions, then returns you to sign-in so you can run onboarding again from a clean
            state.
          </p>
          <ul className="mt-3 flex flex-col gap-1.5 text-sm text-foreground">
            <li className="flex items-start gap-2">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground" />
              <span>Clears the local profile, zones, and active-zone selection.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground" />
              <span>Wipes every account and session from the local auth service.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground" />
              <span>Signs you out and returns to the sign-in screen.</span>
            </li>
          </ul>
          <div className="mt-5">
            <Button variant="danger" onClick={() => setResetOpen(true)}>
              Reset everything
            </Button>
          </div>
        </Card>
      ) : null}

      <ConfirmDialog
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title="Reset environment"
        description="This permanently deletes all local data and every account on the local auth service. This cannot be undone."
        confirmLabel="Delete and reset"
        tone="danger"
        onConfirm={resetEnvironment}
      />
    </ModulePage>
  );
}
