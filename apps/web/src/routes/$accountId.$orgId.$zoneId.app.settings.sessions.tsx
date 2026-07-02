/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Settings sessions page listing authenticated devices with per-device revocation.
*/
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { ConfirmModal, SettingsGroup } from "@/components/console/SettingsPanels";
import { Badge, Button, Skeleton, useToast } from "@/components/ui";
import { listSessions, revokeOtherSessions, revokeSession, useSession } from "@/platform/auth";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/settings/sessions")({
  component: SessionsPage,
});

interface SessionRow {
  id: string;
  token?: string;
  createdAt?: string | Date;
  expiresAt?: string | Date;
  ipAddress?: string | null;
  userAgent?: string | null;
}

function SessionsPage() {
  const toast = useToast();
  const session = useSession();
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revokingAll, setRevokingAll] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<SessionRow | null>(null);

  const currentToken = (session.data?.session as { token?: string } | undefined)?.token;

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
  }, [load]);

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
        <div className="min-h-[320px] border border-border bg-card">
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
