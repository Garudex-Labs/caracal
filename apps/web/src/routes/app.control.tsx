/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Control API developer workspace: keys, scopes, authentication, and usage.
*/
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";

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
  ConfirmDialog,
  Field,
  Modal,
  Tabs,
  useToast,
  type Column,
} from "@/components/ui";
import { cx } from "@/lib/cx";
import {
  CONTROL_MAX_TTL_SECONDS,
  CONTROL_MIN_TTL_SECONDS,
  CONTROL_PERMISSIONS,
  ConsoleApiError,
} from "@/platform/api/client";
import {
  useControlKeys,
  useCreateControlKey,
  useRevokeControlKey,
  useRotateControlKey,
} from "@/platform/api/hooks";
import type { ControlKey, ControlKeyCreateResult } from "@/platform/api/types";

export const Route = createFileRoute("/app/control")({
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

type TabId = "keys" | "auth" | "reference";

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

  return (
    <ResourceWorkspaceShell headerExtra={tabs}>
      {tab === "auth" ? <AuthTab zoneId={zoneId} /> : <ReferenceTab zoneSlug={zoneSlug} />}
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
    <div className="animate-fade-in">
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">Control API</h1>
        <p className="mt-1 max-w-4xl text-sm text-muted-foreground">
          Programmatic, scoped automation of zone management.
        </p>
      </div>
      <div className="mb-4">{headerExtra}</div>
      {children}
    </div>
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
        headerExtra={
          <div className="flex flex-col gap-4">
            {headerExtra}
            <IssuanceNotice />
          </div>
        }
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
              zoneId={zoneId}
              onRotate={() => setRotateTarget(k)}
              onRevoke={() => setRevokeTarget(k)}
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
    </>
  );
}

function IssuanceNotice() {
  return (
    <div className="flex items-start gap-3 border border-border bg-muted/30 px-4 py-3">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        className="mt-0.5 shrink-0 text-muted-foreground"
      >
        <rect x="5" y="11" width="14" height="9" rx="2" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </svg>
      <div className="min-w-0 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">The client secret is shown only once.</span>{" "}
        It is generated in your browser, never stored, and cannot be retrieved later, so copy it
        before closing the dialog. The same key is also issuable with{" "}
        <Mono>caracal control key create</Mono>.
      </div>
    </div>
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
  zoneId,
  onRotate,
  onRevoke,
}: {
  keyRecord: ControlKey;
  zoneId: string;
  onRotate: () => void;
  onRevoke: () => void;
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
        <CodeBlock
          code={`curl -s https://sts.caracal.run/token \\
  -d grant_type=client_credentials \\
  -d client_id=${keyRecord.id} \\
  -d client_secret=$CARACAL_CONTROL_SECRET \\
  -d 'scope=${keyRecord.scopes[0] ?? "control:agent:read"}' \\
  -d zone=${zoneId}`}
        />
      </section>
    </div>
  );
}

/* --------------------------- Authentication tab --------------------------- */

function AuthTab({ zoneId }: { zoneId: string }) {
  return (
    <div className="grid gap-px border border-border bg-border lg:grid-cols-2 [&>*]:bg-background">
      <Panel title="How control authentication works">
        <ol className="flex flex-col gap-3 text-sm text-muted-foreground">
          <Step n={1}>
            Issue a control key locally with <Mono>caracal control key create</Mono>. The one-time
            secret stays on your machine.
          </Step>
          <Step n={2}>
            Exchange the key for a short-lived, least-privilege STS token scoped as{" "}
            <Mono>control:&lt;noun&gt;:&lt;verb&gt;</Mono>.
          </Step>
          <Step n={3}>
            Call the Control API with the STS token. Every call is zone-bound and recorded in Audit.
          </Step>
        </ol>
      </Panel>
      <Panel title="Invoke an endpoint">
        <CodeBlock
          code={`# 1. Exchange key -> STS token (see Keys tab)
TOKEN=$(caracal control token --zone ${zoneId})

# 2. Call the Control API
curl -s https://gateway.caracal.run/v1/control/invoke \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"noun":"agent","verb":"read","zone":"${zoneId}"}'`}
        />
      </Panel>
      <Panel title="Node SDK">
        <CodeBlock
          code={`import { ControlClient } from "@caracalai/sdk";

const control = new ControlClient({
  zone: "${zoneId}",
  clientId: process.env.CARACAL_CONTROL_ID,
  clientSecret: process.env.CARACAL_CONTROL_SECRET,
});

const agents = await control.agents.list();`}
        />
      </Panel>
      <Panel title="Python SDK">
        <CodeBlock
          code={`from caracalai import ControlClient

control = ControlClient(
    zone="${zoneId}",
    client_id=os.environ["CARACAL_CONTROL_ID"],
    client_secret=os.environ["CARACAL_CONTROL_SECRET"],
)

agents = control.agents.list()`}
        />
      </Panel>
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

interface SurfaceGroup {
  noun: string;
  description: string;
  actions: { verb: string; scope: string; summary: string }[];
}

const SURFACE: SurfaceGroup[] = [
  {
    noun: "agent",
    description: "Inspect and manage agent sessions.",
    actions: [
      { verb: "read", scope: "control:agent:read", summary: "List and inspect agent sessions." },
      { verb: "write", scope: "control:agent:write", summary: "Suspend and resume sessions." },
      { verb: "delete", scope: "control:agent:delete", summary: "Terminate agent sessions." },
    ],
  },
  {
    noun: "app",
    description: "Manage agent application identities.",
    actions: [
      { verb: "read", scope: "control:app:read", summary: "List and inspect applications." },
      { verb: "write", scope: "control:app:write", summary: "Create and update applications." },
      { verb: "delete", scope: "control:app:delete", summary: "Delete applications." },
    ],
  },
  {
    noun: "resource",
    description: "Manage protected resources.",
    actions: [
      { verb: "read", scope: "control:resource:read", summary: "List and inspect resources." },
      { verb: "write", scope: "control:resource:write", summary: "Create and update resources." },
      { verb: "delete", scope: "control:resource:delete", summary: "Delete resources." },
    ],
  },
  {
    noun: "delegation",
    description: "Manage delegated authority edges.",
    actions: [
      { verb: "read", scope: "control:delegation:read", summary: "Inspect delegation edges." },
      { verb: "delete", scope: "control:delegation:delete", summary: "Revoke delegation edges." },
    ],
  },
];

function ReferenceTab({ zoneSlug }: { zoneSlug: string }) {
  return (
    <div className="flex flex-col gap-6">
      <p className="max-w-3xl text-sm text-muted-foreground">
        The Control API exposes zone management as <Mono>noun:verb</Mono> permissions. A control key
        is granted a subset of these scopes; its STS tokens can never exceed them. Operating on zone{" "}
        <Mono>{zoneSlug}</Mono>.
      </p>
      <div className="border border-border">
        {SURFACE.map((group, index) => (
          <div key={group.noun} className={cx(index > 0 && "border-t border-border")}>
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border bg-muted/30 px-4 py-2.5">
              <span className="font-mono text-sm font-semibold text-foreground">{group.noun}</span>
              <span className="text-xs text-muted-foreground">{group.description}</span>
            </div>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border">
                {group.actions.map((action) => (
                  <tr key={action.scope}>
                    <td className="w-24 px-4 py-2.5 align-top">
                      <Badge tone="neutral">{action.verb}</Badge>
                    </td>
                    <td className="px-4 py-2.5 align-top font-mono text-xs text-foreground">
                      {action.scope}
                    </td>
                    <td className="px-4 py-2.5 align-top text-xs text-muted-foreground">
                      {action.summary}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------- shared -------------------------------- */

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="p-6">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {title}
      </h3>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function CodeBlock({ code }: { code: string }) {
  const toast = useToast();
  return (
    <div className="group relative">
      <pre className="scrollbar-thin overflow-x-auto border border-border bg-[#0d1117] p-3 font-mono text-xs leading-relaxed text-[#e6edf3]">
        {code}
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
