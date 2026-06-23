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
import { Badge, Tabs, useToast, type Column } from "@/components/ui";
import { cx } from "@/lib/cx";
import { ConsoleApiError } from "@/platform/api/client";
import { useApplications } from "@/platform/api/hooks";
import type { Application } from "@/platform/api/types";

export const Route = createFileRoute("/app/control")({
  component: ControlRoute,
});

const CONTROL_INVOKE_TRAIT = "control:invoke";
const SCOPE_PREFIX = "control:scope:";
const MAX_TTL_PREFIX = "control:max-ttl:";
const EXPIRES_PREFIX = "control:expires:";

interface ControlKey {
  id: string;
  name: string;
  scopes: string[];
  maxTtlSeconds?: number;
  expiresAt?: string;
  createdAt: string;
}

function isControlKey(app: Application): boolean {
  return (app.traits ?? []).includes(CONTROL_INVOKE_TRAIT);
}

function toControlKey(app: Application): ControlKey {
  const traits = app.traits ?? [];
  const scopes = traits
    .filter((t) => t.startsWith(SCOPE_PREFIX))
    .map((t) => t.slice(SCOPE_PREFIX.length))
    .sort();
  const ttlTrait = traits.find((t) => t.startsWith(MAX_TTL_PREFIX));
  const expiresTrait = traits.find((t) => t.startsWith(EXPIRES_PREFIX));
  const ttl = ttlTrait ? Number.parseInt(ttlTrait.slice(MAX_TTL_PREFIX.length), 10) : undefined;
  return {
    id: app.id,
    name: app.name,
    scopes,
    maxTtlSeconds: Number.isFinite(ttl) ? ttl : undefined,
    expiresAt: expiresTrait ? expiresTrait.slice(EXPIRES_PREFIX.length) : undefined,
    createdAt: app.created_at,
  };
}

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
  const apps = useApplications(zoneId);

  const keys = useMemo(() => (apps.data ?? []).filter(isControlKey).map(toControlKey), [apps.data]);

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
        loading={apps.isLoading}
        error={apps.isError ? errorMessage(apps.error) : null}
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
    <ResourceWorkspace
      title="Control API"
      description="Programmatic, scoped automation of zone management."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Control API" }]}
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
          "Control keys are issued from the local Caracal console. Once issued, they appear here with their scoped permissions.",
      }}
      detail={{
        title: (k) => k.name,
        description: (k) => k.id,
        width: "max-w-2xl",
        render: (k) => <ControlKeyInspector keyRecord={k} zoneId={zoneId} />,
      }}
    />
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
        <span className="font-medium text-foreground">
          Keys are issued from the local console by design.
        </span>{" "}
        The one-time secret is shown only on the operator&apos;s machine and never travels through a
        browser session. Issue one with <Mono>caracal control key create</Mono>; it appears here
        once created.
      </div>
    </div>
  );
}

function ControlKeyInspector({ keyRecord, zoneId }: { keyRecord: ControlKey; zoneId: string }) {
  return (
    <div className="flex flex-col gap-6">
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
            No scoped permissions — this key can authenticate but invokes nothing.
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
