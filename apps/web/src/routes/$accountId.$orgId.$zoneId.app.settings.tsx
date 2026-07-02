/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the settings route.
*/
import { appLink } from "@/platform/nav/appLink";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { ModulePage } from "@/components/console/ModulePage";
import { EnterpriseUpsell } from "@/components/console/EnterpriseUpsell";
import {
  AvatarPicker,
  Badge,
  Button,
  Field,
  FieldLabel,
  LockBadge,
  Modal,
  PasswordField,
  Skeleton,
  Tooltip,
  useToast,
} from "@/components/ui";
import { LOCKED_FEATURES } from "@/platform/edition/lockedFeatures";
import { consoleApi, ConsoleApiError } from "@/platform/api/client";
import {
  useOperatorAiStatus,
  useOperatorAiCheck,
  useOperatorAiProviders,
  useCreateOperatorAiProvider,
  useUpdateOperatorAiProvider,
  useRotateOperatorAiProviderKey,
  useDeleteOperatorAiProvider,
  useSystemZoneId,
  systemZoneViewPath,
  useZones,
  useActiveZone,
  useUpdateZone,
} from "@/platform/api/hooks";
import type { OperatorAiProvider, OperatorAiAuth } from "@/platform/api/types";
import {
  AuthApiError,
  changePassword,
  deleteAccount,
  listSessions,
  revokeOtherSessions,
  signOut,
  updateUser,
  useSession,
} from "@/platform/auth";
import {
  clearLocalIdentity,
  getProfile,
  HANDLE_MAX,
  NAME_MAX,
  resolveDisplayName,
  sanitizeHandle,
  setProfile,
  useProfile,
} from "@/platform/state/localInstall";
import { setTheme, useTheme } from "@/platform/theme";

interface SettingsSection {
  id: string;
  label: string;
  description: string;
  featureSlug?: string;
}

interface SettingsNavGroup {
  id: string;
  label: string;
  items: SettingsSection[];
}

const SETTINGS_GROUPS: SettingsNavGroup[] = [
  {
    id: "account",
    label: "Account",
    items: [
      { id: "profile", label: "Profile", description: "Identity, avatar, and operator naming." },
      { id: "access", label: "Access", description: "Password and sign-in security." },
      { id: "sessions", label: "Sessions", description: "Authenticated devices and expiry." },
      { id: "preferences", label: "Preferences", description: "Theme defaults." },
    ],
  },
  {
    id: "administration",
    label: "Administration",
    items: [
      {
        id: "ai-operator",
        label: "AI Operator",
        description: "Model providers and governed routing for the Caracal Operator.",
      },
      {
        id: "sso",
        label: "SSO & Directory Sync",
        description: LOCKED_FEATURES.sso.summary,
        featureSlug: "sso",
      },
      {
        id: "members",
        label: "Members & Roles",
        description: LOCKED_FEATURES["teams-roles"].summary,
        featureSlug: "teams-roles",
      },
      {
        id: "organization",
        label: "Organization",
        description: LOCKED_FEATURES.organizations.summary,
        featureSlug: "organizations",
      },
      {
        id: "integrations",
        label: "Integrations",
        description: LOCKED_FEATURES.connectors.summary,
        featureSlug: "connectors",
      },
    ],
  },
  {
    id: "danger",
    label: "Danger zone",
    items: [
      {
        id: "lifecycle",
        label: "Account deletion",
        description: "Delete the authenticated account.",
      },
    ],
  },
];

const ALL_SECTIONS = SETTINGS_GROUPS.flatMap((group) => group.items);

type SectionId = string;

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const [section, setSection] = useState<SectionId>("profile");
  const current = ALL_SECTIONS.find((item) => item.id === section) ?? ALL_SECTIONS[0];
  const feature = current.featureSlug ? LOCKED_FEATURES[current.featureSlug] : undefined;

  return (
    <ModulePage
      title="Settings"
      description="Account and administration controls."
      breadcrumbs={[{ label: "Console", to: appLink() }, { label: "Settings" }]}
    >
      <div className="grid gap-8 xl:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="xl:sticky xl:top-20 xl:self-start">
          <div className="border border-border bg-card">
            {SETTINGS_GROUPS.map((group) => (
              <div key={group.id} className="border-b border-border last:border-b-0">
                <div className="px-4 pb-1.5 pt-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  {group.label}
                </div>
                <nav className="grid">
                  {group.items.map((item) => {
                    const active = item.id === section;
                    return (
                      <button
                        key={item.id}
                        onClick={() => setSection(item.id)}
                        className={[
                          "flex items-center justify-between gap-2 px-4 py-2.5 text-left transition-colors",
                          active
                            ? "bg-foreground text-background"
                            : "text-muted-foreground hover:bg-surface hover:text-foreground",
                        ].join(" ")}
                      >
                        <span className="text-sm font-semibold">{item.label}</span>
                        {item.featureSlug ? (
                          <span className={active ? "opacity-80" : ""}>
                            <LockBadge />
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </nav>
              </div>
            ))}
          </div>
        </aside>

        <section className="min-w-0 border-y border-border">
          <div className="border-b border-border py-6">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              {current.label}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <h2 className="text-2xl font-semibold tracking-tight text-foreground">
                {current.label}
              </h2>
              {feature ? <LockBadge /> : <HelpTip label={current.description} />}
            </div>
          </div>

          <div>
            {section === "profile" ? <ProfileSection /> : null}
            {section === "access" ? <AccessSection /> : null}
            {section === "sessions" ? <SessionsSection /> : null}
            {section === "preferences" ? <PreferencesSection /> : null}
            {section === "ai-operator" ? <AiOperatorSection /> : null}
            {section === "lifecycle" ? <LifecycleSection /> : null}
            {feature ? (
              <div className="py-6">
                <EnterpriseUpsell feature={feature} heading={false} />
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </ModulePage>
  );
}

function SettingsGroup({
  title,
  description,
  action,
  children,
  danger = false,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <section
      className={[
        "grid gap-5 border-t py-8 first:border-t-0 first:pt-8 last:pb-8 2xl:grid-cols-[minmax(220px,300px)_minmax(0,1fr)]",
        danger ? "border-destructive/30" : "border-border",
      ].join(" ")}
    >
      <div>
        <div className="flex items-center gap-2">
          <h3
            className={[
              "text-sm font-semibold",
              danger ? "text-destructive" : "text-foreground",
            ].join(" ")}
          >
            {title}
          </h3>
          {description ? <HelpTip label={description} /> : null}
        </div>
        {action ? <div className="mt-4">{action}</div> : null}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function HelpTip({ label }: { label: string }) {
  return (
    <Tooltip label={label}>
      <span
        tabIndex={0}
        aria-label="More information"
        className="inline-grid h-5 w-5 place-items-center rounded-full border border-border text-[11px] font-semibold text-muted-foreground outline-none transition-colors hover:border-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        ?
      </span>
    </Tooltip>
  );
}

function ProfileSection() {
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

function AccessSection() {
  const toast = useToast();
  const navigate = useNavigate();
  const session = useSession();

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
    navigate({ to: "/sign-in" });
  }

  return (
    <div>
      <SettingsGroup
        title="Signed-in account"
        description="The authenticated owner for this web session."
      >
        <InfoGrid>
          <InfoItem label="Name" value={session.data?.user?.name ?? "-"} />
          <InfoItem label="Email" value={session.data?.user?.email ?? "-"} mono />
          <InfoItem label="Role" value="Owner" />
        </InfoGrid>
      </SettingsGroup>

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

interface SessionRow {
  id: string;
  token?: string;
  createdAt?: string | Date;
  expiresAt?: string | Date;
  ipAddress?: string | null;
  userAgent?: string | null;
}

function SessionsSection() {
  const toast = useToast();
  const session = useSession();
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

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
    setRevoking(true);
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
      setRevoking(false);
    }
  }

  return (
    <div>
      <SettingsGroup
        title="Active sessions"
        description="Review authenticated devices and revoke every session except this browser."
        action={
          <Button
            variant="secondary"
            onClick={() => setConfirmOpen(true)}
            loading={revoking}
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
            <p className="m-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
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
                    {row.expiresAt ? (
                      <span className="text-xs text-muted-foreground md:text-right">
                        expires {new Date(row.expiresAt).toLocaleDateString()}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </SettingsGroup>

      <ConfirmModal
        open={confirmOpen}
        title="Sign out other sessions"
        description="This signs out every session except this one. Other devices will need to sign in again."
        confirmLabel="Sign out others"
        onClose={() => setConfirmOpen(false)}
        onConfirm={revokeOthers}
        danger
      />
    </div>
  );
}

function PreferencesSection() {
  const theme = useTheme();
  const { activeZone } = useActiveZone();
  const updateZone = useUpdateZone();
  const toast = useToast();
  const badgeOn = activeZone?.operator_coauthor_badge ?? true;

  async function toggleBadge(next: boolean) {
    if (!activeZone) return;
    try {
      await updateZone.mutateAsync({
        id: activeZone.id,
        input: { operator_coauthor_badge: next },
      });
    } catch {
      toast({ title: "Could not update the operator badge setting.", tone: "error" });
    }
  }

  return (
    <div>
      <SettingsGroup
        title="Appearance"
        description="Theme applies immediately across the web console."
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
        title="Operator attribution"
        description="Show a co-author badge on items the Caracal Operator creates in this zone."
      >
        <div className="flex items-start justify-between gap-3">
          <p className="max-w-prose text-xs text-muted-foreground">
            When on, items created through the Operator carry a small star next to the creator,
            marking them as co-authored by the Caracal Operator. Turning this off stops new items
            from being marked; items already marked keep their badge.
          </p>
          <button
            type="button"
            role="switch"
            aria-checked={badgeOn}
            aria-label="Operator co-author badge"
            disabled={!activeZone || updateZone.isPending}
            onClick={() => toggleBadge(!badgeOn)}
            className={[
              "relative mt-0.5 inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors",
              badgeOn ? "bg-foreground" : "bg-muted",
              !activeZone || updateZone.isPending ? "opacity-60" : "",
            ].join(" ")}
          >
            <span
              className={[
                "inline-block h-4 w-4 transform rounded-full bg-background shadow transition-transform",
                badgeOn ? "translate-x-4" : "translate-x-0.5",
              ].join(" ")}
            />
          </button>
        </div>
      </SettingsGroup>
    </div>
  );
}

/* ------------------------------ AI Operator ------------------------------ */

// Common OpenAI-compatible base URLs across providers, offered as endpoint suggestions. The model
// id is whatever the endpoint serves, so it is typed in rather than chosen from a list; only the
// endpoint, which genuinely varies by provider, is worth suggesting. Each is the provider's
// OpenAI-compatible /chat/completions surface (Anthropic and Gemini expose one natively; others go
// through a proxy), with placeholders the operator fills in for their own resource.
const ENDPOINT_SUGGESTIONS: { name: string; url: string }[] = [
  { name: "OpenAI", url: "https://api.openai.com/v1" },
  {
    name: "Azure Foundry",
    url: "https://YOUR-RESOURCE.services.ai.azure.com/PROVIDER-NAME/v1",
  },
  { name: "Anthropic", url: "https://api.anthropic.com/v1" },
  { name: "Google Gemini", url: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { name: "OpenRouter", url: "https://openrouter.ai/api/v1" },
  { name: "LiteLLM proxy", url: "http://localhost:4000/v1" },
  { name: "Ollama (local)", url: "http://localhost:11434/v1" },
];

// The Operator addresses a provider by a slug used to build its configuration keys, so the slug
// is constrained to the shape the API enforces: lowercase letters, digits, and underscores.
function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 32);
}

function checkErrorMessage(err: unknown): string {
  if (err instanceof ConsoleApiError) {
    if (err.code === "ai_unavailable") return "No AI provider is configured for the Operator.";
    if (err.code === "ai_unreachable") {
      // Surface the upstream's own status so a rejected key (401/403) reads differently from a
      // wrong endpoint (404) or an unreachable host, rather than one ambiguous message.
      const attempts = (err.detail as { attempts?: { reason?: string }[] } | undefined)?.attempts;
      const reason = attempts?.[0]?.reason ?? "";
      const status = reason.match(/status (\d{3})/)?.[1];
      if (status === "401" || status === "403")
        return "The provider rejected the key. Check the API key.";
      if (status === "404") return "The endpoint was not found. Check the base URL.";
      if (status) return `The provider returned ${status}. Check the endpoint and key.`;
      return "The provider could not be reached. Check the endpoint.";
    }
  }
  return "The connectivity check failed. Try again.";
}

function writeErrorMessage(err: unknown): string {
  if (err instanceof ConsoleApiError) {
    if (err.code === "governed_execution_unconfigured")
      return "Self-governance is not configured, so a key cannot be sealed.";
    if (err.code === "invalid_provider")
      return "Some fields are invalid. Check the form and try again.";
    if (err.code === "provider_not_found") return "That provider no longer exists.";
  }
  return "The change could not be saved. Try again.";
}

function AiOperatorSection() {
  const status = useOperatorAiStatus(true);
  const list = useOperatorAiProviders();
  const check = useOperatorAiCheck();
  const remove = useDeleteOperatorAiProvider();
  const systemZone = useSystemZoneId();
  const toast = useToast();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<OperatorAiProvider | null>(null);
  const [rotating, setRotating] = useState<OperatorAiProvider | null>(null);
  const [deleting, setDeleting] = useState<OperatorAiProvider | null>(null);

  const available = list.data?.available ?? false;
  const providers = list.data?.providers ?? [];
  const runtime = status.data?.providers ?? [];
  const connected = status.data?.enabled ?? false;

  function runtimeReady(slug: string, model: string): boolean {
    return runtime.some(
      (entry) =>
        entry.available &&
        (entry.id === slug || entry.id.startsWith(`${slug}__`) || entry.model === model),
    );
  }

  return (
    <div>
      <SettingsGroup
        title="Status"
        description="The models the Operator uses, in failover order, and a live connectivity check."
      >
        <div className="grid gap-4">
          {status.isLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={connected ? "success" : "warning"}>
                {connected ? "Connected" : "No model ready"}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {connected
                  ? `${runtime.length} model${runtime.length === 1 ? "" : "s"} in failover order`
                  : "Add a model below to bring the Operator online."}
              </span>
              {systemZone.data ? (
                <a
                  href={systemZoneViewPath(systemZone.data)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <svg
                    viewBox="0 0 24 24"
                    className="h-3.5 w-3.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <rect x="3" y="11" width="18" height="11" rx="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                  Open System Zone
                </a>
              ) : null}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              size="sm"
              type="button"
              loading={check.isPending}
              disabled={!connected}
              onClick={() => check.mutate()}
            >
              Test connectivity
            </Button>
            {check.isSuccess ? (
              <span className="text-xs text-emerald-600 dark:text-emerald-400">
                {check.data.provider} · {check.data.model} · {check.data.latency_ms} ms
              </span>
            ) : null}
            {check.isError ? (
              <span className="text-xs text-destructive">{checkErrorMessage(check.error)}</span>
            ) : null}
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="Models"
        description="Add a provider once; its key is sealed into Caracal and the Operator reaches every model through the governed gateway."
        action={
          <Button
            size="sm"
            mutating
            disabled={!available}
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            Add provider
          </Button>
        }
      >
        <div className="grid gap-4">
          {!available ? (
            <div className="border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-700 dark:text-amber-400">
              Self-governance is not configured for this deployment, so a key cannot be sealed.
              Enable the Operator control plane to manage models here.
            </div>
          ) : null}

          {list.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : providers.length === 0 ? (
            <p className="border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              No models yet. Add a provider to bring the Operator online.
            </p>
          ) : (
            <div className="divide-y divide-border border border-border bg-card">
              {providers.map((provider) => (
                <div
                  key={provider.slug}
                  className="flex flex-wrap items-start justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {provider.label}
                      </span>
                      {!provider.enabled ? <Badge tone="muted">Disabled</Badge> : null}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                      {provider.baseUrl}
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {provider.models.map((model) => (
                        <Badge
                          key={model}
                          tone={runtimeReady(provider.slug, model) ? "success" : "neutral"}
                        >
                          {model}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      mutating
                      onClick={() => {
                        setEditing(provider);
                        setFormOpen(true);
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      mutating
                      onClick={() => setRotating(provider)}
                    >
                      Rotate key
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      mutating
                      onClick={() => setDeleting(provider)}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </SettingsGroup>

      <ProviderFormModal
        open={formOpen}
        editing={editing}
        existingSlugs={providers.map((provider) => provider.slug)}
        onClose={() => setFormOpen(false)}
        onSaved={() => {
          setFormOpen(false);
          toast({ tone: "success", title: editing ? "Provider updated" : "Provider added" });
        }}
      />

      {rotating ? (
        <RotateKeyModal
          provider={rotating}
          onClose={() => setRotating(null)}
          onRotated={() => {
            setRotating(null);
            toast({ tone: "success", title: "Key rotated" });
          }}
        />
      ) : null}

      <ConfirmModal
        open={deleting !== null}
        title="Delete provider"
        description={
          deleting
            ? `Remove ${deleting.label}? Its sealed key is destroyed and the Operator's grant to it is revoked.`
            : ""
        }
        confirmLabel="Delete"
        danger
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await remove.mutateAsync(deleting.slug);
            toast({ tone: "info", title: "Provider deleted" });
          } catch (err) {
            toast({ tone: "error", title: "Delete failed", description: writeErrorMessage(err) });
          }
        }}
      />
    </div>
  );
}

// The endpoint base-URL field with a focus-triggered suggestions menu. Each provider's
// OpenAI-compatible base URL is clickable to fill the field; a final non-clickable row makes clear
// that any other OpenAI-compatible URL can be typed in directly, so the list reads as a shortcut
// rather than a closed set. A native datalist cannot show a non-selectable hint, so this is a
// small popover that closes on outside click or Escape.
function EndpointField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative block">
      <FieldLabel label="Endpoint base URL" info="Any OpenAI-compatible endpoint works." />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onFocus={() => setOpen(true)}
        placeholder="https://api.openai.com/v1"
        className="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-ring focus:ring-2 focus:ring-ring/25"
      />
      {open ? (
        <div className="animate-pop-in absolute z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-xl">
          {ENDPOINT_SUGGESTIONS.map((item) => (
            <button
              key={item.url}
              type="button"
              onClick={() => {
                onChange(item.url);
                setOpen(false);
              }}
              className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/50"
            >
              <span className="text-sm text-foreground">{item.name}</span>
              <span className="truncate font-mono text-[11px] text-muted-foreground">
                {item.url}
              </span>
            </button>
          ))}
          <div className="mt-1 border-t border-border px-2 py-1.5 text-[11px] text-muted-foreground">
            Custom (Any OpenAI-compatible URL).
          </div>
        </div>
      ) : null}
    </div>
  );
}

// The add and edit form. Adding starts empty so the operator supplies only what matters: an
// OpenAI-compatible endpoint, a key, and the model ids the endpoint serves. The slug defaults
// from the label. Editing locks the slug and omits the key, which is changed through rotate. The
// provider and resource details Caracal sets automatically (api-key auth, an Authorization Bearer
// header, the llm:invoke and agent:lifecycle scopes, and the gateway binding) are explained
// rather than asked for.
function ProviderFormModal({
  open,
  editing,
  existingSlugs,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: OperatorAiProvider | null;
  existingSlugs: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const create = useCreateOperatorAiProvider();
  const update = useUpdateOperatorAiProvider();

  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [modelDraft, setModelDraft] = useState("");
  const [contextWindow, setContextWindow] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [authLocation, setAuthLocation] = useState<"header" | "query">("header");
  const [headerName, setHeaderName] = useState("Authorization");
  const [authScheme, setAuthScheme] = useState("Bearer");
  const [queryParamName, setQueryParamName] = useState("api_key");
  const [showPlacement, setShowPlacement] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the form whenever it opens: an edit loads the provider, a fresh add starts empty so the
  // operator supplies only what matters — endpoint, key, and the model ids the endpoint serves.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setModelDraft("");
    if (editing) {
      setSlug(editing.slug);
      setSlugEdited(true);
      setLabel(editing.label);
      setBaseUrl(editing.baseUrl);
      setModels(editing.models);
      setContextWindow(editing.contextWindow ? String(editing.contextWindow) : "");
      setApiKey("");
      setAuthLocation(editing.auth.location);
      setHeaderName(editing.auth.headerName ?? "Authorization");
      setAuthScheme(editing.auth.authScheme ?? "");
      setQueryParamName(editing.auth.queryParamName ?? "api_key");
      setShowPlacement(
        editing.auth.location !== "header" ||
          (editing.auth.headerName ?? "Authorization") !== "Authorization",
      );
    } else {
      setSlug("");
      setSlugEdited(false);
      setLabel("");
      setBaseUrl("");
      setModels([]);
      setContextWindow("");
      setApiKey("");
      setAuthLocation("header");
      setHeaderName("Authorization");
      setAuthScheme("Bearer");
      setQueryParamName("api_key");
      setShowPlacement(false);
    }
  }, [open, editing]);

  // The slug defaults to a sanitized form of the label so a new provider needs no separate id,
  // unless the operator edits the slug directly, after which it is left alone.
  function changeLabel(value: string) {
    setLabel(value);
    if (!editing && !slugEdited) setSlug(sanitizeSlug(value));
  }

  function addModel() {
    const value = modelDraft.trim();
    if (!value || models.includes(value)) {
      setModelDraft("");
      return;
    }
    setModels((prev) => [...prev, value]);
    setModelDraft("");
  }

  const slugTaken = !editing && existingSlugs.includes(slug);
  const valid =
    slug.length > 0 &&
    !slugTaken &&
    label.trim().length > 0 &&
    baseUrl.trim().length > 0 &&
    models.length > 0 &&
    (editing !== null || apiKey.length > 0);
  const busy = create.isPending || update.isPending;

  async function save() {
    setError(null);
    const ctx = contextWindow.trim() ? Number(contextWindow) : 0;
    const auth: OperatorAiAuth =
      authLocation === "query"
        ? { location: "query", queryParamName: queryParamName.trim() || "api_key" }
        : {
            location: "header",
            headerName: headerName.trim() || "Authorization",
            authScheme: authScheme.trim() || undefined,
          };
    try {
      if (editing) {
        await update.mutateAsync({
          slug: editing.slug,
          patch: { label, baseUrl, models, contextWindow: ctx, auth },
        });
      } else {
        await create.mutateAsync({
          slug,
          label,
          baseUrl,
          models,
          contextWindow: ctx,
          apiKey,
          enabled: true,
          auth,
        });
      }
      onSaved();
    } catch (err) {
      setError(writeErrorMessage(err));
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? "Edit provider" : "Add a model provider"}
      description={
        editing
          ? "Update the endpoint and models. Rotate the key from the provider's menu."
          : "Supply an OpenAI-compatible endpoint and key; Caracal seals and governs it."
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={!valid}>
            {editing ? "Save changes" : "Add provider"}
          </Button>
        </>
      }
    >
      <div className="grid gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Label"
            value={label}
            onChange={(event) => changeLabel(event.target.value)}
            placeholder="OpenAI production"
          />
          <Field
            label="Provider id"
            info="A short slug Caracal uses to name the sealed provider and resource."
            value={slug}
            onChange={(event) => {
              setSlug(sanitizeSlug(event.target.value));
              setSlugEdited(true);
            }}
            placeholder="openai"
            disabled={editing !== null}
            error={slugTaken ? "That id is already in use." : undefined}
          />
          <div className="sm:col-span-2">
            <EndpointField value={baseUrl} onChange={setBaseUrl} />
          </div>
          <Field
            label="Context window"
            info="Optional. The model's token window, used for the usage gauge."
            value={contextWindow}
            onChange={(event) => setContextWindow(event.target.value.replace(/[^0-9]/g, ""))}
            placeholder="128000"
            inputMode="numeric"
          />
          {!editing ? (
            <PasswordField
              label="API key"
              info="Sent once and sealed into Caracal; it is never stored in the console or read back."
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="sk-…"
            />
          ) : null}
        </div>

        <div className="grid gap-2">
          <FieldLabel
            label="Models"
            info="The exact model ids this endpoint serves. One provider can serve several behind the same key."
          />
          <div className="flex gap-2">
            <input
              value={modelDraft}
              onChange={(event) => setModelDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addModel();
                }
              }}
              placeholder="e.g. gpt-5.5, then Enter"
              className="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-ring focus:ring-2 focus:ring-ring/25"
            />
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={addModel}
              disabled={!modelDraft.trim()}
            >
              Add
            </Button>
          </div>
          {models.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {models.map((model) => (
                <span
                  key={model}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 font-mono text-[11px] text-foreground"
                >
                  {model}
                  <button
                    type="button"
                    aria-label={`Remove ${model}`}
                    onClick={() => setModels((prev) => prev.filter((value) => value !== model))}
                    className="text-muted-foreground transition-colors hover:text-destructive"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <div>
          <button
            type="button"
            onClick={() => setShowPlacement((v) => !v)}
            className="text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {showPlacement ? "Hide" : "Advanced:"} key placement
          </button>
          {showPlacement ? (
            <div className="mt-3 grid gap-4 border border-border bg-muted/30 p-3">
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Where the sealed key is sent. Default is an Authorization Bearer header. Some
                upstreams differ — Azure uses an <span className="font-mono">api-key</span> header,
                a LiteLLM/OpenRouter proxy expects <span className="font-mono">X-API-Key</span>, and
                a few take it in the query string.
              </p>
              <div className="flex gap-2">
                {(["header", "query"] as const).map((loc) => (
                  <button
                    key={loc}
                    type="button"
                    onClick={() => setAuthLocation(loc)}
                    className={[
                      "h-8 px-3 text-xs font-medium capitalize transition-colors",
                      authLocation === loc
                        ? "bg-foreground text-background"
                        : "border border-border text-muted-foreground hover:bg-surface",
                    ].join(" ")}
                  >
                    {loc}
                  </button>
                ))}
              </div>
              {authLocation === "header" ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label="Header name"
                    value={headerName}
                    onChange={(e) => setHeaderName(e.target.value)}
                    placeholder="Authorization"
                  />
                  <Field
                    label="Scheme prefix"
                    info="Optional. Blank sends the raw key (e.g. Azure)."
                    value={authScheme}
                    onChange={(e) => setAuthScheme(e.target.value)}
                    placeholder="Bearer"
                  />
                </div>
              ) : (
                <Field
                  label="Query parameter"
                  value={queryParamName}
                  onChange={(e) => setQueryParamName(e.target.value)}
                  placeholder="api_key"
                />
              )}
            </div>
          ) : null}
        </div>

        <div className="border border-border bg-muted/40 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
          The endpoint must speak the OpenAI <span className="font-mono">/chat/completions</span>{" "}
          format — OpenAI and Azure work directly; for Claude, Gemini, or others, point this at an
          OpenAI-compatible proxy such as LiteLLM or OpenRouter. Caracal seals the key into the
          caracal.sys system zone, sets the scopes and gateway binding, and routes the Operator only
          through the governed gateway.
        </div>

        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
    </Modal>
  );
}

function RotateKeyModal({
  provider,
  onClose,
  onRotated,
}: {
  provider: OperatorAiProvider;
  onClose: () => void;
  onRotated: () => void;
}) {
  const rotate = useRotateOperatorAiProviderKey();
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    try {
      await rotate.mutateAsync({ slug: provider.slug, apiKey });
      onRotated();
    } catch (err) {
      setError(writeErrorMessage(err));
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Rotate key — ${provider.label}`}
      description="The new key is sealed into Caracal, replacing the old one. The model stays online."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={rotate.isPending}>
            Cancel
          </Button>
          <Button onClick={save} loading={rotate.isPending} disabled={apiKey.length === 0}>
            Rotate key
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <PasswordField
          label="New API key"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="sk-…"
        />
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
    </Modal>
  );
}

function LifecycleSection() {
  const toast = useToast();
  const navigate = useNavigate();
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
        description="Profile deletion also removes owned zones."
      >
        <div className="grid gap-3 lg:grid-cols-3">
          <Metric
            label="Zones"
            value={zones.isLoading ? "..." : zones.isError ? "!" : String(zoneCount)}
          />
          <Metric label="Owner email" value={email || "-"} mono />
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="Delete profile"
        description="Permanently removes your profile, sessions, sign-in accounts, and zones."
        danger
      >
        <div className="border border-destructive/30 bg-destructive/5 p-4">
          {zones.isError ? (
            <p className="mt-3 text-sm text-destructive">Zone state unavailable.</p>
          ) : zoneCount > 0 ? (
            <p className="mt-3 text-sm text-destructive">
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

function ConfirmModal({
  open,
  title,
  description,
  confirmLabel,
  onClose,
  onConfirm,
  danger = false,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  danger?: boolean;
}) {
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={confirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}

function InfoGrid({ children }: { children: ReactNode }) {
  return <dl className="grid gap-3 border border-border bg-card p-4 md:grid-cols-3">{children}</dl>;
}

function InfoItem({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </dt>
      <dd
        className={["mt-1 truncate text-sm text-foreground", mono ? "font-mono text-xs" : ""].join(
          " ",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function Metric({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="border border-border bg-card p-4">
      <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </div>
      <div
        className={[
          "mt-2 text-lg font-semibold text-foreground",
          mono ? "font-mono text-sm" : "",
        ].join(" ")}
      >
        {value}
      </div>
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
