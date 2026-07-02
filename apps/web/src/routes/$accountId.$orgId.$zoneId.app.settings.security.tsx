/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Settings security page for sign-in methods, password rotation, and device sessions.
*/
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { ConfirmModal, SettingsGroup } from "@/components/console/SettingsPanels";
import { Badge, Button, Field, Skeleton, useToast } from "@/components/ui";
import {
  changePassword,
  fetchEnabledProviders,
  linkSocial,
  listAccounts,
  listSessions,
  revokeOtherSessions,
  revokeSession,
  useSession,
  type EnabledProviders,
  type SocialProvider,
} from "@/platform/auth";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/settings/security")({
  component: SecurityPage,
});

interface SessionRow {
  id: string;
  token?: string;
  createdAt?: string | Date;
  expiresAt?: string | Date;
  ipAddress?: string | null;
  userAgent?: string | null;
}

interface AccountRow {
  id: string;
  providerId: string;
}

const SOCIAL_PROVIDERS: { id: SocialProvider; label: string; manageUrl?: string }[] = [
  { id: "google", label: "Google", manageUrl: "https://myaccount.google.com/connections" },
  { id: "github", label: "GitHub" },
];

function SecurityPage() {
  const toast = useToast();
  const session = useSession();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [changing, setChanging] = useState(false);
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null);
  const [providers, setProviders] = useState<EnabledProviders | null>(null);
  const [linking, setLinking] = useState<SocialProvider | null>(null);
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revokingAll, setRevokingAll] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<SessionRow | null>(null);

  const email = session.data?.user?.email ?? "";
  const currentToken = (session.data?.session as { token?: string } | undefined)?.token;
  // Password change only exists for a credential account; an operator who signs in purely
  // through Google or GitHub has no password to rotate, so the section stays hidden.
  const hasPassword = accounts?.some((account) => account.providerId === "credential") ?? false;

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await listSessions();
      if (result?.error) throw new Error(result.error.message ?? "list_failed");
      setRows((result?.data as SessionRow[]) ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load sessions.");
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void load();
    void listAccounts()
      .then((result) => setAccounts((result?.data as AccountRow[]) ?? []))
      .catch(() => setAccounts([]));
    void fetchEnabledProviders().then(setProviders);
  }, [load]);

  async function connect(provider: SocialProvider) {
    setLinking(provider);
    try {
      const result = await linkSocial({ provider, callbackURL: window.location.href });
      if (result?.error) throw new Error(result.error.message ?? "link_failed");
    } catch (err) {
      setLinking(null);
      toast({
        tone: "error",
        title: "Could not connect provider",
        description: err instanceof Error ? err.message : "Unexpected error.",
      });
    }
  }

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
      await load();
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

  async function revokeOthers() {
    setRevokingAll(true);
    try {
      const result = await revokeOtherSessions();
      if (result?.error) throw new Error(result.error.message ?? "revoke_failed");
      toast({ tone: "success", title: "Other sessions signed out" });
      await load();
    } catch (err) {
      toast({
        tone: "error",
        title: "Could not revoke sessions",
        description: err instanceof Error ? err.message : "Unexpected error.",
      });
    } finally {
      setRevokingAll(false);
    }
  }

  async function revokeOne(row: SessionRow) {
    if (!row.token) return;
    try {
      const result = await revokeSession({ token: row.token });
      if (result?.error) throw new Error(result.error.message ?? "revoke_failed");
      toast({
        tone: "success",
        title: "Session revoked",
        description: describeAgent(row.userAgent),
      });
      await load();
    } catch (err) {
      toast({
        tone: "error",
        title: "Could not revoke the session",
        description: err instanceof Error ? err.message : "Unexpected error.",
      });
    }
  }

  return (
    <div>
      <SettingsGroup
        title="Sign-in methods"
        description={
          <>
            Providers that verify{" "}
            {email ? <span className="font-medium text-primary">{email}</span> : "your email"} link
            to this account automatically.
          </>
        }
      >
        {accounts === null ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            <li className="flex items-center justify-between gap-3 px-4 py-3">
              <div>
                <div className="text-sm font-medium text-foreground">Email &amp; password</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {hasPassword
                    ? "Sign in with your email and a password."
                    : "No password is set for this account; you sign in through a provider."}
                </div>
              </div>
              {hasPassword ? <Badge tone="success">Enabled</Badge> : <Badge>Not set</Badge>}
            </li>
            {SOCIAL_PROVIDERS.map((provider) => {
              const connected = accounts.some((account) => account.providerId === provider.id);
              const available = providers?.[provider.id] ?? false;
              if (!connected && !available) return null;
              return (
                <li key={provider.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div>
                    <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                      {provider.label}
                      {provider.manageUrl ? (
                        <a
                          href={provider.manageUrl}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`Manage ${provider.label} connections`}
                          className="text-muted-foreground transition-colors hover:text-foreground"
                        >
                          <ExternalLinkIcon />
                        </a>
                      ) : null}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {connected
                        ? `Sign in with the ${provider.label} identity that owns ${email || "this email"}.`
                        : `Connect ${provider.label} to also sign in with it.`}
                    </div>
                  </div>
                  {connected ? (
                    <Badge tone="success">Connected</Badge>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={linking === provider.id}
                      onClick={() => connect(provider.id)}
                    >
                      Connect
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </SettingsGroup>

      {hasPassword ? (
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
      ) : null}

      <SettingsGroup
        title="Active sessions"
        description="Every authenticated device on this account. Revoke a single device, or sign out everything except this browser."
        action={
          <Button
            variant="secondary"
            onClick={() => setConfirmAll(true)}
            loading={revokingAll}
            disabled={!rows || rows.length <= 1}
          >
            Sign out other sessions
          </Button>
        }
      >
        <div className="scrollbar-thin max-h-[420px] overflow-y-auto rounded-lg border border-border">
          {rows === null ? (
            <div className="flex flex-col gap-2 p-4">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : error ? (
            <div className="m-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2">
              <p className="text-sm text-destructive">{error}</p>
              <Button
                variant="secondary"
                size="sm"
                className="mt-2"
                onClick={() => {
                  setRows(null);
                  void load();
                }}
              >
                Retry
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No active sessions.</p>
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((row) => {
                const isCurrent = currentToken !== undefined && row.token === currentToken;
                return (
                  <li
                    key={row.id}
                    className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_auto]"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {describeAgent(row.userAgent)}
                        </span>
                        {isCurrent ? <Badge tone="success">This device</Badge> : null}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {row.ipAddress ? `${row.ipAddress} · ` : ""}
                        {row.createdAt ? `started ${new Date(row.createdAt).toLocaleString()}` : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 md:justify-end">
                      {row.expiresAt ? (
                        <span className="text-xs text-muted-foreground">
                          expires {new Date(row.expiresAt).toLocaleDateString()}
                        </span>
                      ) : null}
                      {!isCurrent && row.token ? (
                        <Button variant="ghost" size="sm" onClick={() => setRevokeTarget(row)}>
                          Revoke
                        </Button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </SettingsGroup>

      <ConfirmModal
        open={confirmAll}
        title="Sign out other sessions"
        description="This signs out every session except this one. Other devices will need to sign in again."
        confirmLabel="Sign out others"
        onClose={() => setConfirmAll(false)}
        onConfirm={revokeOthers}
        danger
      />

      <ConfirmModal
        open={revokeTarget !== null}
        title="Revoke session"
        description={
          revokeTarget
            ? `Sign out ${describeAgent(revokeTarget.userAgent)}? That device will need to sign in again.`
            : ""
        }
        confirmLabel="Revoke"
        onClose={() => setRevokeTarget(null)}
        onConfirm={async () => {
          if (revokeTarget) await revokeOne(revokeTarget);
        }}
        danger
      />
    </div>
  );
}

function ExternalLinkIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
    </svg>
  );
}

function describeAgent(userAgent: string | null | undefined): string {
  if (!userAgent) return "Unknown device";
  const ua = userAgent;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Mac OS X/.test(ua)
      ? "macOS"
      : /Linux/.test(ua)
        ? "Linux"
        : /Android/.test(ua)
          ? "Android"
          : /iPhone|iPad/.test(ua)
            ? "iOS"
            : "";
  return os ? `${browser} on ${os}` : browser;
}
