/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Control API developer workspace: keys, scopes, authentication, and usage.
*/
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { ModulePage } from "@/components/console/ModulePage";
import {
  DetailField,
  DetailGroup,
  Mono,
  ResourceWorkspace,
} from "@/components/console/ResourceWorkspace";
import { ZoneScopedPage } from "@/components/console/ZoneScope";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Field,
  InfoHint,
  Modal,
  Tabs,
  useToast,
  type Column,
} from "@/components/ui";
import { cx } from "@/lib/cx";
import { highlightCode, TERMINAL_HIGHLIGHT } from "@/lib/codeHighlight";
import {
  CONTROL_MAX_TTL_SECONDS,
  CONTROL_MIN_TTL_SECONDS,
  CONTROL_PERMISSIONS,
  ConsoleApiError,
} from "@/platform/api/client";
import {
  useControlKeys,
  useControlStatus,
  useCreateControlKey,
  useDisableControl,
  useEnableControl,
  useIssueControlToken,
  useRevokeControlKey,
  useRotateControlKey,
} from "@/platform/api/hooks";
import type { ControlKey, ControlKeyCreateResult, ControlTokenResult } from "@/platform/api/types";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/control")({
  component: ControlRoute,
});

function ControlRoute() {
  return (
    <ZoneScopedPage
      title="Control API"
      description="Programmatic, scoped automation of zone management."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Control API" }]}
    >
      {(zone) => <ControlPage zoneId={zone.id} zoneSlug={zone.slug} />}
    </ZoneScopedPage>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ConsoleApiError) {
    if (error.notConfigured) return "Control plane not connected.";
    if (error.unreachable) return "Control plane unreachable.";
    return error.code.replace(/_/g, " ");
  }
  return "Unexpected error.";
}

type TabId = "keys" | "auth" | "reference" | "settings";

function ControlPage({ zoneId, zoneSlug }: { zoneId: string; zoneSlug: string }) {
  const [tab, setTab] = useState<TabId>("keys");
  const keysQuery = useControlKeys(zoneId);
  const keys = useMemo(() => keysQuery.data ?? [], [keysQuery.data]);

  const tabs = (
    <Tabs
      tabs={[
        { id: "keys", label: "Keys", count: keys.length },
        { id: "auth", label: "Authentication" },
        { id: "reference", label: "Reference" },
        { id: "settings", label: "Settings" },
      ]}
      active={tab}
      onChange={(id) => setTab(id as TabId)}
    />
  );

  if (tab === "keys") {
    return (
      <ControlKeysTab
        zoneId={zoneId}
        keys={keys}
        loading={keysQuery.isLoading}
        error={keysQuery.isError ? errorMessage(keysQuery.error) : null}
        headerExtra={tabs}
      />
    );
  }

  if (tab === "reference") {
    return <ReferenceTab zoneSlug={zoneSlug} headerExtra={tabs} />;
  }

  return (
    <ResourceWorkspaceShell headerExtra={tabs}>
      {tab === "auth" ? <AuthTab zoneId={zoneId} /> : <SettingsTab />}
    </ResourceWorkspaceShell>
  );
}

function ResourceWorkspaceShell({
  headerExtra,
  children,
}: {
  headerExtra: ReactNode;
  children: ReactNode;
}) {
  return (
    <ModulePage
      title="Control API"
      description="Programmatic, scoped automation of zone management."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Control API" }]}
    >
      <div className="mb-6">{headerExtra}</div>
      {children}
    </ModulePage>
  );
}

/* ------------------------------- Keys tab ------------------------------- */

function ControlKeysTab({
  zoneId,
  keys,
  loading,
  error,
  headerExtra,
}: {
  zoneId: string;
  keys: ControlKey[];
  loading: boolean;
  error: string | null;
  headerExtra: ReactNode;
}) {
  const toast = useToast();
  const rotateKey = useRotateControlKey(zoneId);
  const revokeKey = useRevokeControlKey(zoneId);
  const [createOpen, setCreateOpen] = useState(false);
  const [secret, setSecret] = useState<{ id: string; name: string; secret: string } | null>(null);
  const [rotateTarget, setRotateTarget] = useState<ControlKey | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ControlKey | null>(null);
  const [issueTarget, setIssueTarget] = useState<ControlKey | null>(null);
  const [tokenResult, setTokenResult] = useState<ControlTokenResult | null>(null);

  const columns: Column<ControlKey>[] = [
    {
      id: "name",
      header: "Key",
      sortable: true,
      cell: (k) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-foreground">{k.name}</div>
          <div className="truncate font-mono text-xs text-muted-foreground">{k.id}</div>
        </div>
      ),
    },
    {
      id: "scopes",
      header: "Permissions",
      cell: (k) => (
        <span className="text-xs text-muted-foreground">
          {k.scopes.length} scope{k.scopes.length === 1 ? "" : "s"}
        </span>
      ),
    },
    {
      id: "ttl",
      header: "Max TTL",
      cell: (k) => (
        <span className="text-xs text-muted-foreground">
          {k.maxTtlSeconds ? `${k.maxTtlSeconds}s` : "default"}
        </span>
      ),
    },
    {
      id: "created",
      header: "Created",
      sortable: true,
      align: "right",
      cell: (k) => (
        <span className="text-xs text-muted-foreground">
          {new Date(k.createdAt).toLocaleDateString()}
        </span>
      ),
    },
  ];

  return (
    <>
      <ResourceWorkspace
        title="Control API"
        description="Programmatic, scoped automation of zone management."
        breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Control API" }]}
        primaryAction={{ label: "New control key", onClick: () => setCreateOpen(true) }}
        headerExtra={headerExtra}
        rows={keys}
        loading={loading}
        columns={columns}
        rowKey={(k) => k.id}
        search={{
          placeholder: "Search control keys…",
          match: (k, q) =>
            k.name.toLowerCase().includes(q) ||
            k.id.toLowerCase().includes(q) ||
            k.scopes.some((s) => s.toLowerCase().includes(q)),
        }}
        sortOptions={[
          { id: "name", label: "Name" },
          { id: "recent", label: "Newest" },
        ]}
        empty={{
          title: error ? "Could not load control keys" : "No control keys yet",
          description:
            error ??
            "Control keys grant scoped, zone-bound automation. Create one to drive zone management from the Control API.",
        }}
        detail={{
          title: (k) => k.name,
          description: (k) => k.id,
          width: "max-w-2xl",
          render: (k) => (
            <ControlKeyInspector
              keyRecord={k}
              onRotate={() => setRotateTarget(k)}
              onRevoke={() => setRevokeTarget(k)}
              onIssueToken={() => setIssueTarget(k)}
            />
          ),
        }}
      />

      <CreateControlKeyModal
        open={createOpen}
        zoneId={zoneId}
        onClose={() => setCreateOpen(false)}
        onCreated={(result) => {
          setCreateOpen(false);
          setSecret({ id: result.id, name: result.name, secret: result.clientSecret });
        }}
      />

      <ControlSecretModal secret={secret} onClose={() => setSecret(null)} />

      <ConfirmDialog
        open={rotateTarget !== null}
        onClose={() => setRotateTarget(null)}
        title="Rotate client secret"
        description={`This immediately invalidates the current secret for "${rotateTarget?.name ?? ""}". Any automation using the old secret fails until updated with the new one.`}
        confirmLabel="Rotate secret"
        tone="danger"
        onConfirm={async () => {
          if (!rotateTarget) return;
          try {
            const res = await rotateKey.mutateAsync(rotateTarget.id);
            setSecret({ id: rotateTarget.id, name: rotateTarget.name, secret: res.clientSecret });
          } catch (err) {
            toast({ tone: "error", title: "Rotation failed", description: errorMessage(err) });
          }
        }}
      />

      <ConfirmDialog
        open={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        title="Revoke control key"
        description={`Revoking "${revokeTarget?.name ?? ""}" permanently disables it. Any automation using it stops working immediately. This cannot be undone.`}
        confirmLabel="Revoke key"
        tone="danger"
        onConfirm={async () => {
          if (!revokeTarget) return;
          try {
            await revokeKey.mutateAsync(revokeTarget.id);
            toast({ tone: "info", title: "Control key revoked", description: revokeTarget.name });
          } catch (err) {
            toast({ tone: "error", title: "Revoke failed", description: errorMessage(err) });
          }
        }}
      />

      <IssueTokenModal
        zoneId={zoneId}
        keyRecord={issueTarget}
        onClose={() => setIssueTarget(null)}
        onIssued={(result) => {
          setIssueTarget(null);
          setTokenResult(result);
        }}
      />

      <TokenResultModal result={tokenResult} onClose={() => setTokenResult(null)} />
    </>
  );
}

// Composes least-privilege control scopes from the permission catalog and optional TTL/
// expiry guards. Every constraint is validated before submit so operators never discover
// a rejected key after the fact.
function CreateControlKeyModal({
  open,
  zoneId,
  onClose,
  onCreated,
}: {
  open: boolean;
  zoneId: string;
  onClose: () => void;
  onCreated: (result: ControlKeyCreateResult) => void;
}) {
  const create = useCreateControlKey(zoneId);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [maxTtl, setMaxTtl] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [error, setError] = useState<string | null>(null);

  const groups = useMemo(() => {
    const map = new Map<string, typeof CONTROL_PERMISSIONS>();
    for (const permission of CONTROL_PERMISSIONS) {
      const list = map.get(permission.command) ?? [];
      list.push(permission);
      map.set(permission.command, list);
    }
    return [...map.entries()];
  }, []);

  function reset() {
    setName("");
    setSelected(new Set());
    setMaxTtl("");
    setExpiresAt("");
    setError(null);
  }

  function close() {
    reset();
    onClose();
  }

  function toggle(scope: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  }

  async function submit() {
    setError(null);
    if (!name.trim()) return setError("A key name is required.");
    if (selected.size === 0) return setError("Select at least one permission.");
    let maxTtlSeconds: number | undefined;
    if (maxTtl.trim()) {
      const parsed = Number.parseInt(maxTtl, 10);
      if (
        !Number.isInteger(parsed) ||
        parsed < CONTROL_MIN_TTL_SECONDS ||
        parsed > CONTROL_MAX_TTL_SECONDS
      ) {
        return setError(
          `Max token TTL must be between ${CONTROL_MIN_TTL_SECONDS} and ${CONTROL_MAX_TTL_SECONDS} seconds.`,
        );
      }
      maxTtlSeconds = parsed;
    }
    let expiresIso: string | undefined;
    if (expiresAt.trim()) {
      const ts = Date.parse(expiresAt);
      if (!Number.isFinite(ts)) return setError("Expiry must be a valid date and time.");
      if (ts <= Date.now()) return setError("Expiry must be in the future.");
      expiresIso = new Date(ts).toISOString();
    }
    try {
      const result = await create.mutateAsync({
        name: name.trim(),
        scopes: [...selected],
        maxTtlSeconds,
        expiresAt: expiresIso,
      });
      reset();
      onCreated(result);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="New control key"
      description="Scoped, zone-bound automation credential."
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button onClick={submit} loading={create.isPending}>
            Create key
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="Name"
          placeholder="ci-deploy-bot"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />

        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-foreground">
              Permissions ({selected.size})
            </span>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={() =>
                setSelected((prev) =>
                  prev.size === CONTROL_PERMISSIONS.length
                    ? new Set()
                    : new Set(CONTROL_PERMISSIONS.map((p) => p.scope)),
                )
              }
            >
              {selected.size === CONTROL_PERMISSIONS.length ? "Clear all" : "Select all"}
            </button>
          </div>
          <div className="flex flex-col gap-3">
            {groups.map(([command, permissions]) => (
              <div key={command} className="border border-border">
                <div className="border-b border-border bg-muted/30 px-3 py-1.5 font-mono text-xs font-semibold text-foreground">
                  {command}
                </div>
                <div className="flex flex-wrap gap-1.5 p-2">
                  {permissions.map((permission) => {
                    const on = selected.has(permission.scope);
                    return (
                      <button
                        key={permission.scope}
                        type="button"
                        onClick={() => toggle(permission.scope)}
                        title={permission.summary}
                        className={cx(
                          "rounded border px-2 py-1 font-mono text-[11px] transition-colors",
                          on
                            ? "border-foreground bg-foreground text-background"
                            : "border-border text-muted-foreground hover:border-foreground/40",
                        )}
                      >
                        {permission.verb}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        <details className="border-t border-border pt-3">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
            Advanced: token guards
          </summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field
              label="Max token TTL (seconds)"
              type="number"
              min={CONTROL_MIN_TTL_SECONDS}
              max={CONTROL_MAX_TTL_SECONDS}
              placeholder="default"
              hint={`${CONTROL_MIN_TTL_SECONDS}–${CONTROL_MAX_TTL_SECONDS}s`}
              value={maxTtl}
              onChange={(e) => setMaxTtl(e.target.value)}
            />
            <Field
              label="Key expiry"
              type="datetime-local"
              hint="Optional. Key stops issuing tokens after this."
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          </div>
        </details>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
    </Modal>
  );
}

function ControlSecretModal({
  secret,
  onClose,
}: {
  secret: { id: string; name: string; secret: string } | null;
  onClose: () => void;
}) {
  const toast = useToast();
  return (
    <Modal
      open={secret !== null}
      onClose={onClose}
      title="Control key secret"
      description="Copy the client secret now. It is never shown again."
      footer={<Button onClick={onClose}>Done</Button>}
    >
      {secret ? (
        <div className="flex flex-col gap-4">
          <DetailGroup title={secret.name}>
            <DetailField label="Client ID">
              <Mono>{secret.id}</Mono>
            </DetailField>
          </DetailGroup>
          <div>
            <span className="mb-1.5 block text-sm font-medium text-foreground">Client secret</span>
            <div className="flex items-stretch gap-2">
              <input
                readOnly
                value={secret.secret}
                className="min-w-0 flex-1 border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-foreground"
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(secret.secret);
                  toast({ tone: "success", title: "Secret copied" });
                }}
              >
                Copy
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Store it in your automation&apos;s secret manager as <Mono>CARACAL_CONTROL_SECRET</Mono>
            .
          </p>
        </div>
      ) : null}
    </Modal>
  );
}

function ControlKeyInspector({
  keyRecord,
  onRotate,
  onRevoke,
  onIssueToken,
}: {
  keyRecord: ControlKey;
  onRotate: () => void;
  onRevoke: () => void;
  onIssueToken: () => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onRotate}>
          Rotate secret
        </Button>
        <Button variant="danger" size="sm" onClick={onRevoke}>
          Revoke
        </Button>
      </div>
      <DetailGroup title="Key">
        <DetailField label="Name">{keyRecord.name}</DetailField>
        <DetailField label="Client ID">
          <Mono>{keyRecord.id}</Mono>
        </DetailField>
        <DetailField label="Max TTL">
          {keyRecord.maxTtlSeconds ? `${keyRecord.maxTtlSeconds}s` : "Zone default"}
        </DetailField>
        {keyRecord.expiresAt ? (
          <DetailField label="Expires">
            {new Date(keyRecord.expiresAt).toLocaleString()}
          </DetailField>
        ) : null}
        <DetailField label="Created">{new Date(keyRecord.createdAt).toLocaleString()}</DetailField>
      </DetailGroup>

      <section className="border-t border-border pt-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Permissions ({keyRecord.scopes.length})
        </h3>
        {keyRecord.scopes.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {keyRecord.scopes.map((scope) => (
              <span
                key={scope}
                className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
              >
                {scope}
              </span>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            No scoped permissions: this key can authenticate but invokes nothing.
          </p>
        )}
      </section>

      <section className="border-t border-border pt-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Restrictions
        </h3>
        <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
          {["zone-bound", "application-only", "no-subject-token", "no-delegation"].map((r) => (
            <li key={r} className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="h-1 w-1 rounded-full bg-muted-foreground" />
              <span className="font-mono">{r}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="border-t border-border pt-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Exchange for an invocation token
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Paste the key&apos;s one-time secret to mint a short-lived, least-privilege STS token
          scoped to this key. The token is generated on demand and never stored.
        </p>
        <div className="mt-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={onIssueToken}
            disabled={keyRecord.scopes.length === 0}
          >
            Issue token
          </Button>
          {keyRecord.scopes.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              This key grants no scopes, so it can authenticate but invoke nothing.
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function IssueTokenModal({
  zoneId,
  keyRecord,
  onClose,
  onIssued,
}: {
  zoneId: string;
  keyRecord: ControlKey | null;
  onClose: () => void;
  onIssued: (result: ControlTokenResult) => void;
}) {
  const issue = useIssueControlToken(zoneId);
  const [clientSecret, setClientSecret] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ttl, setTtl] = useState("300");
  const [error, setError] = useState<string | null>(null);

  const keyScopes = keyRecord?.scopes ?? [];
  const keyId = keyRecord?.id ?? null;
  // Reset the form whenever the targeted key changes (including close/reopen) so a stale
  // secret or scope set never leaks across keys.
  useEffect(() => {
    setClientSecret("");
    setSelected(new Set(keyScopes));
    setTtl("300");
    setError(null);
    // keyScopes is derived from keyId; keying the effect on keyId is sufficient.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyId]);

  const ttlOptions = ["300", "600", "900"].filter(
    (option) => !keyRecord?.maxTtlSeconds || Number.parseInt(option, 10) <= keyRecord.maxTtlSeconds,
  );
  const effectiveTtls =
    ttlOptions.length > 0 ? ttlOptions : [String(keyRecord?.maxTtlSeconds ?? 300)];

  function toggle(scope: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  }

  async function submit() {
    if (!keyRecord) return;
    setError(null);
    if (!clientSecret.trim()) return setError("Paste the key's client secret.");
    if (selected.size === 0) return setError("Select at least one permission.");
    const ttlSeconds = Number.parseInt(effectiveTtls.includes(ttl) ? ttl : effectiveTtls[0], 10);
    try {
      const result = await issue.mutateAsync({
        keyId: keyRecord.id,
        clientSecret: clientSecret.trim(),
        scopes: [...selected],
        ttlSeconds,
      });
      onIssued(result);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Modal
      open={keyRecord !== null}
      onClose={onClose}
      title="Issue invocation token"
      description={keyRecord ? `Mint a token for "${keyRecord.name}".` : ""}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={issue.isPending}>
            Issue token
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="Client secret"
          type="password"
          placeholder="cs_…"
          hint="The one-time secret shown when the key was created or rotated."
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          autoFocus
        />
        <div>
          <span className="mb-2 block text-sm font-medium text-foreground">
            Permissions ({selected.size})
          </span>
          <div className="flex flex-wrap gap-1.5">
            {keyScopes.map((scope) => {
              const on = selected.has(scope);
              return (
                <button
                  key={scope}
                  type="button"
                  onClick={() => toggle(scope)}
                  className={cx(
                    "rounded border px-2 py-1 font-mono text-[11px] transition-colors",
                    on
                      ? "border-foreground bg-foreground text-background"
                      : "border-border text-muted-foreground hover:border-foreground/40",
                  )}
                >
                  {scope}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            A token can never exceed the scopes granted to its key.
          </p>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-foreground">Token TTL (seconds)</span>
          <select
            value={effectiveTtls.includes(ttl) ? ttl : effectiveTtls[0]}
            onChange={(e) => setTtl(e.target.value)}
            className="border border-border bg-background px-3 py-2 text-sm text-foreground"
          >
            {effectiveTtls.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
    </Modal>
  );
}

function TokenResultModal({
  result,
  onClose,
}: {
  result: ControlTokenResult | null;
  onClose: () => void;
}) {
  const toast = useToast();
  return (
    <Modal
      open={result !== null}
      onClose={onClose}
      title="Invocation token"
      description="Copy the token now. It is short-lived and never shown again."
      footer={<Button onClick={onClose}>Done</Button>}
    >
      {result ? (
        <div className="flex flex-col gap-4">
          <DetailGroup title="Token">
            <DetailField label="Resource">
              <Mono>{result.resource}</Mono>
            </DetailField>
            <DetailField label="Type">{result.tokenType}</DetailField>
            <DetailField label="Invoke path">
              <Mono>{result.invokePath}</Mono>
            </DetailField>
          </DetailGroup>
          <div>
            <span className="mb-1.5 block text-sm font-medium text-foreground">Access token</span>
            <div className="flex items-stretch gap-2">
              <input
                readOnly
                value={result.accessToken}
                className="min-w-0 flex-1 border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-foreground"
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(result.accessToken);
                  toast({ tone: "success", title: "Token copied" });
                }}
              >
                Copy
              </Button>
            </div>
          </div>
          <div>
            <span className="mb-1.5 block text-sm font-medium text-foreground">
              Scopes ({result.scopes.length})
            </span>
            <div className="flex flex-wrap gap-1.5">
              {result.scopes.map((scope) => (
                <span
                  key={scope}
                  className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                >
                  {scope}
                </span>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

/* ------------------------------- Settings tab ------------------------------- */

function SettingsTab() {
  return (
    <div className="flex max-w-3xl flex-col gap-2">
      <h2 className="text-base font-semibold tracking-tight text-foreground">Control endpoint</h2>
      <p className="text-sm text-muted-foreground">
        The Control endpoint is the local gate that lets authenticated automation reach the Control
        API. It stays closed until you enable it, and you&apos;ll confirm before the gate opens.
        Disable it at any time to immediately stop all Control API traffic.
      </p>
      <div className="mt-4">
        <EndpointStatusBar />
      </div>
    </div>
  );
}

function EndpointStatusBar() {
  const toast = useToast();
  const statusQuery = useControlStatus();
  const enable = useEnableControl();
  const disable = useDisableControl();
  const [confirmAction, setConfirmAction] = useState<"enable" | "disable" | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const status = statusQuery.data;

  if (statusQuery.isLoading) {
    return (
      <Card>
        <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
          <span className="h-2 w-2 animate-pulse rounded-full bg-muted-foreground/50" />
          Checking Control endpoint…
        </div>
      </Card>
    );
  }
  if (!status || !status.manageable) {
    return (
      <Card>
        <div className="text-sm font-medium text-foreground">Management unavailable</div>
        <p className="mt-1 text-sm text-muted-foreground">
          Control endpoint management is unavailable on this host. Keys can still be created and
          used against a running Control endpoint.
        </p>
      </Card>
    );
  }

  const enabled = status.enabled === true;
  const runtimeTone =
    status.service === "ok" ? "success" : status.service === "down" ? "danger" : "warning";
  const url = status.invokeUrl ?? null;

  return (
    <>
      <Card className="p-0">
        <div className="flex flex-wrap items-start justify-between gap-4 p-5">
          <div className="flex min-w-0 flex-col gap-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={enabled ? "success" : "muted"}>{enabled ? "Enabled" : "Disabled"}</Badge>
              {enabled ? <Badge tone={runtimeTone}>{status.service ?? "unknown"}</Badge> : null}
            </div>
            <p className="text-sm text-muted-foreground">
              {enabled
                ? "The gate is open. Automation with a valid token can reach the Control API."
                : "The gate is closed. All Control API calls are rejected until you enable it."}
            </p>
          </div>
          <Button
            size="sm"
            variant={enabled ? "danger" : "primary"}
            loading={enable.isPending || disable.isPending}
            onClick={() => setConfirmAction(enabled ? "disable" : "enable")}
          >
            {enabled ? "Disable endpoint" : "Enable endpoint"}
          </Button>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Invoke URL
            </span>
            <span className="truncate font-mono text-xs text-foreground">
              {url ?? "-"}
              {!enabled && url ? (
                <span className="ml-2 not-italic text-muted-foreground">(not exposed)</span>
              ) : null}
            </span>
          </div>
          {url ? (
            <button
              onClick={() => {
                void navigator.clipboard?.writeText(url);
                toast({ tone: "success", title: "Copied" });
              }}
              className="shrink-0 rounded-md border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              Copy
            </button>
          ) : null}
        </div>

        <div className="border-t border-border">
          <button
            onClick={() => setShowDetails((v) => !v)}
            aria-expanded={showDetails}
            className="flex w-full items-center justify-between px-5 py-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Technical details
            <svg
              viewBox="0 0 24 24"
              className={cx("h-4 w-4 transition-transform", showDetails && "rotate-180")}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          {showDetails ? (
            <dl className="grid border-t border-border sm:grid-cols-2">
              <StatusRow label="Lifecycle" value={status.lifecycle} />
              <StatusRow label="Runtime" value={status.service} />
              <StatusRow label="Health" value={status.detail} />
              <StatusRow label="Optimization" value={status.optimization} />
              <StatusRow label="Health URL" value={status.healthUrl} mono />
              <StatusRow label="Ready URL" value={status.readyUrl} mono />
              <StatusRow label="Gate file" value={status.marker} mono />
            </dl>
          ) : null}
        </div>
      </Card>

      <ConfirmDialog
        open={confirmAction !== null}
        onClose={() => setConfirmAction(null)}
        title={confirmAction === "disable" ? "Disable Control endpoint" : "Enable Control endpoint"}
        description={
          confirmAction === "disable"
            ? "Closes the local Control endpoint gate. Automation calling the Control API stops working until re-enabled."
            : "Opens the local Control endpoint gate so authenticated automation can call the Control API. The API service must be running."
        }
        confirmLabel={confirmAction === "disable" ? "Disable" : "Enable"}
        tone={confirmAction === "disable" ? "danger" : "primary"}
        onConfirm={async () => {
          const action = confirmAction;
          try {
            if (action === "disable") await disable.mutateAsync();
            else await enable.mutateAsync();
            toast({
              tone: "success",
              title:
                action === "disable" ? "Control endpoint disabled" : "Control endpoint enabled",
            });
          } catch (err) {
            toast({
              tone: "error",
              title: "Control action failed",
              description: errorMessage(err),
            });
          }
        }}
      />
    </>
  );
}

function StatusRow({ label, value, mono }: { label: string; value?: string; mono?: boolean }) {
  if (!value) return null;
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-2 last:border-b-0">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cx("min-w-0 truncate text-right text-xs text-foreground", mono && "font-mono")}
      >
        {value}
      </dd>
    </div>
  );
}

/* --------------------------- Authentication tab --------------------------- */

function AuthTab({ zoneId }: { zoneId: string }) {
  const examples = [
    {
      id: "curl",
      label: "cURL",
      lang: "Shell",
      code: `# 1. Issue a token from the Keys tab (or exchange at STS directly)
TOKEN=...

# 2. Call the Control API
curl -s https://gateway.caracal.run/v1/control/invoke \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"noun":"agent","verb":"read","zone":"${zoneId}"}'`,
    },
    {
      id: "node",
      label: "Node",
      lang: "TypeScript",
      code: `import { ControlClient } from "@caracalai/sdk";

const control = new ControlClient({
  zone: "${zoneId}",
  clientId: process.env.CARACAL_CONTROL_ID,
  clientSecret: process.env.CARACAL_CONTROL_SECRET,
});

const agents = await control.agents.list();`,
    },
    {
      id: "python",
      label: "Python",
      lang: "Python",
      code: `from caracalai import ControlClient

control = ControlClient(
    zone="${zoneId}",
    client_id=os.environ["CARACAL_CONTROL_ID"],
    client_secret=os.environ["CARACAL_CONTROL_SECRET"],
)

agents = control.agents.list()`,
    },
  ];

  return (
    <div className="grid gap-px border border-border bg-border lg:grid-cols-2 [&>*]:bg-background">
      <Panel title="How control authentication works">
        <ol className="flex flex-col gap-3 text-sm text-muted-foreground">
          <Step n={1}>
            Create a control key in the <span className="font-medium text-foreground">Keys</span>{" "}
            tab. The one-time secret is shown once, in your browser.
          </Step>
          <Step n={2}>
            Exchange the key for a short-lived, least-privilege STS token scoped as{" "}
            <Mono>control:&lt;noun&gt;:&lt;verb&gt;</Mono> - use{" "}
            <span className="font-medium text-foreground">Issue token</span> on a key, or the STS
            client-credentials grant shown alongside.
          </Step>
          <Step n={3}>
            Call the Control API with the STS token. Every call is zone-bound and recorded in Audit.
          </Step>
        </ol>
      </Panel>
      <Panel title="Call the Control API">
        <CodeTabs examples={examples} />
      </Panel>
    </div>
  );
}

function CodeTabs({
  examples,
}: {
  examples: { id: string; label: string; lang: string; code: string }[];
}) {
  const [active, setActive] = useState(examples[0]?.id ?? "");
  const current = examples.find((e) => e.id === active) ?? examples[0];

  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="flex items-center gap-1 border-b border-border bg-muted/40 px-1.5 py-1">
        {examples.map((example) => (
          <button
            key={example.id}
            onClick={() => setActive(example.id)}
            className={cx(
              "rounded px-2.5 py-1 text-xs font-medium transition-colors",
              example.id === current?.id
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {example.label}
          </button>
        ))}
      </div>
      {current ? <CodeBlock code={current.code} lang={current.lang} /> : null}
    </div>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-foreground text-[10px] font-semibold text-background">
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}

/* ------------------------------ Reference tab ------------------------------ */

interface SurfaceRow {
  noun: string;
  verb: string;
  scope: string;
  summary: string;
}

// Derived from the single permission catalog so the reference can never drift from the
// scopes a key can actually be granted.
const SURFACE_ROWS: SurfaceRow[] = CONTROL_PERMISSIONS.map((permission) => ({
  noun: permission.command,
  verb: permission.verb,
  scope: permission.scope,
  summary: permission.summary,
}));

const SURFACE_NOUNS = [...new Set(SURFACE_ROWS.map((row) => row.noun))].sort();
const SURFACE_VERBS = [...new Set(SURFACE_ROWS.map((row) => row.verb))].sort();

function verbTone(verb: string): "muted" | "warning" | "danger" {
  if (verb === "delete") return "danger";
  if (verb === "write") return "warning";
  return "muted";
}

function ReferenceTab({ zoneSlug, headerExtra }: { zoneSlug: string; headerExtra: ReactNode }) {
  const [noun, setNoun] = useState("all");
  const [verb, setVerb] = useState("all");

  const rows = useMemo(
    () =>
      SURFACE_ROWS.filter(
        (row) => (noun === "all" || row.noun === noun) && (verb === "all" || row.verb === verb),
      ),
    [noun, verb],
  );

  const columns: Column<SurfaceRow>[] = [
    {
      id: "noun",
      header: "Noun",
      sortable: true,
      cell: (row) => (
        <span className="font-mono text-xs font-medium text-foreground">{row.noun}</span>
      ),
    },
    {
      id: "verb",
      header: "Verb",
      sortable: true,
      cell: (row) => <Badge tone={verbTone(row.verb)}>{row.verb}</Badge>,
    },
    {
      id: "scope",
      header: "Scope",
      cell: (row) => <span className="font-mono text-xs text-muted-foreground">{row.scope}</span>,
    },
    {
      id: "summary",
      header: "Summary",
      cell: (row) => <span className="text-xs text-muted-foreground">{row.summary}</span>,
    },
  ];

  return (
    <ResourceWorkspace
      title="Control API"
      description="Programmatic, scoped automation of zone management."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Control API" }]}
      headerExtra={headerExtra}
      toolbarExtra={
        <div className="ml-auto">
          <InfoHint
            label={`The Control API exposes zone management as noun:verb permissions. A control key is granted a subset of these scopes; its STS tokens can never exceed them. Operating on zone ${zoneSlug}.`}
          />
        </div>
      }
      rows={rows}
      loading={false}
      columns={columns}
      rowKey={(row) => row.scope}
      pageSize={12}
      search={{
        placeholder: "Search permissions by noun, verb, scope, or summary…",
        match: (row, q) =>
          row.noun.toLowerCase().includes(q) ||
          row.verb.toLowerCase().includes(q) ||
          row.scope.toLowerCase().includes(q) ||
          row.summary.toLowerCase().includes(q),
      }}
      filters={[
        {
          id: "noun",
          label: "Noun",
          value: noun,
          onChange: setNoun,
          options: [
            { id: "all", label: "All nouns" },
            ...SURFACE_NOUNS.map((n) => ({ id: n, label: n })),
          ],
        },
        {
          id: "verb",
          label: "Verb",
          value: verb,
          onChange: setVerb,
          options: [
            { id: "all", label: "All verbs" },
            ...SURFACE_VERBS.map((v) => ({ id: v, label: v })),
          ],
        },
      ]}
      sortValues={{
        noun: (row) => row.noun,
        verb: (row) => row.verb,
      }}
      empty={{
        title: "No permissions",
        description: "No control permissions match the current search and filters.",
      }}
    />
  );
}

/* -------------------------------- shared -------------------------------- */

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="p-5">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {title}
      </h3>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const toast = useToast();
  return (
    <div className="group relative">
      <pre className="scrollbar-thin overflow-x-auto bg-[#0d1117] p-3 font-mono text-xs leading-relaxed text-[#e6edf3]">
        {highlightCode(code, lang, TERMINAL_HIGHLIGHT)}
      </pre>
      <button
        onClick={() => {
          void navigator.clipboard?.writeText(code);
          toast({ tone: "success", title: "Copied" });
        }}
        className="absolute right-2 top-2 rounded border border-white/15 bg-white/5 px-2 py-1 text-[10px] font-medium text-white/70 opacity-0 transition-opacity hover:bg-white/10 hover:text-white group-hover:opacity-100"
      >
        Copy
      </button>
    </div>
  );
}
