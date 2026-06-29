/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Applications route.
*/
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import {
  CopyValue,
  DangerZone,
  DetailField,
  DetailGroup,
  DetailHeader,
  DetailSection,
  ResourceWorkspace,
} from "@/components/console/ResourceWorkspace";
import type { FilterGroup } from "@/components/ui";
import { ZoneScopedPage } from "@/components/console/ZoneScope";
import {
  Badge,
  Button,
  ConfirmDialog,
  Field,
  IdentityAvatar,
  Modal,
  useToast,
  type Column,
} from "@/components/ui";
import { ConsoleApiError } from "@/platform/api/client";
import {
  useApplications,
  useCreateApplication,
  useDeleteApplication,
  useUpdateApplication,
} from "@/platform/api/hooks";
import { useCreateDeepLink } from "@/platform/nav/createDeepLink";
import type { Application } from "@/platform/api/types";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/applications")({
  component: ApplicationsRoute,
  validateSearch: (search: Record<string, unknown>): { create?: string; focus?: string } => ({
    create: typeof search.create === "string" ? search.create : undefined,
    focus: typeof search.focus === "string" ? search.focus : undefined,
  }),
});

function ApplicationsRoute() {
  return (
    <ZoneScopedPage
      title="Applications"
      description="Agent identities that can request authority in this zone."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Applications" }]}
    >
      {(zone) => <ApplicationsPage zoneId={zone.id} zoneName={zone.name} />}
    </ZoneScopedPage>
  );
}

type CredentialState = "active" | "expiring" | "expired";

function credentialState(app: Application): CredentialState {
  if (!app.expires_at) return "active";
  const at = Date.parse(app.expires_at);
  const now = Date.now();
  if (at < now) return "expired";
  if (at < now + 7 * 24 * 60 * 60 * 1000) return "expiring";
  return "active";
}

function isManaged(app: Application): boolean {
  return app.registration_method !== "dcr";
}

type TypeFilter = "all" | "managed" | "dynamic";
type CredentialFilter = "all" | "active" | "expiring" | "expired";

// Ranks credential states for sorting so the most urgent (expired) sorts to one end and
// healthy identities to the other.
function credentialRank(app: Application): number {
  const state = credentialState(app);
  return state === "expired" ? 0 : state === "expiring" ? 1 : 2;
}

function errorMessage(error: unknown): string {
  if (error instanceof ConsoleApiError) {
    if (error.notConfigured) return "Control plane not connected.";
    if (error.unreachable) return "Control plane unreachable.";
    return error.code;
  }
  return "Unexpected error.";
}

function ApplicationsPage({ zoneId, zoneName }: { zoneId: string; zoneName: string }) {
  const toast = useToast();
  const query = useApplications(zoneId);
  const createApp = useCreateApplication(zoneId);
  const updateApp = useUpdateApplication(zoneId);
  const deleteApp = useDeleteApplication(zoneId);

  const [createOpen, setCreateOpen] = useState(false);
  useCreateDeepLink({
    to: "/app/applications",
    value: Route.useSearch().create,
    open: () => setCreateOpen(true),
  });
  const [secret, setSecret] = useState<{
    name: string;
    clientSecret: string;
    rotated: boolean;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Application | null>(null);
  const [rotateTarget, setRotateTarget] = useState<Application | null>(null);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [credentialFilter, setCredentialFilter] = useState<CredentialFilter>("all");

  const allRows = useMemo(() => query.data ?? [], [query.data]);

  const counts = useMemo(() => {
    let managed = 0;
    let dynamic = 0;
    let active = 0;
    let expiring = 0;
    let expired = 0;
    for (const app of allRows) {
      if (isManaged(app)) managed += 1;
      else dynamic += 1;
      const state = credentialState(app);
      if (state === "active") active += 1;
      else if (state === "expiring") expiring += 1;
      else expired += 1;
    }
    return { managed, dynamic, active, expiring, expired };
  }, [allRows]);

  const rows = useMemo(
    () =>
      allRows.filter((app) => {
        if (typeFilter === "managed" && !isManaged(app)) return false;
        if (typeFilter === "dynamic" && isManaged(app)) return false;
        if (credentialFilter !== "all" && credentialState(app) !== credentialFilter) return false;
        return true;
      }),
    [allRows, typeFilter, credentialFilter],
  );

  const filters: FilterGroup[] = [
    {
      id: "type",
      label: "Type",
      value: typeFilter,
      onChange: (v) => setTypeFilter(v as TypeFilter),
      options: [
        { id: "all", label: "All types", count: allRows.length },
        { id: "managed", label: "Managed", count: counts.managed },
        { id: "dynamic", label: "Dynamic (DCR)", count: counts.dynamic },
      ],
    },
    {
      id: "credential",
      label: "Credential",
      value: credentialFilter,
      onChange: (v) => setCredentialFilter(v as CredentialFilter),
      options: [
        { id: "all", label: "Any credential", count: allRows.length },
        { id: "active", label: "Active", count: counts.active },
        { id: "expiring", label: "Expiring", count: counts.expiring },
        { id: "expired", label: "Expired", count: counts.expired },
      ],
    },
  ];

  const columns: Column<Application>[] = [
    {
      id: "name",
      header: "Application",
      sortable: true,
      truncate: true,
      cell: (app) => (
        <div className="flex items-center gap-3">
          <IdentityAvatar seed={app.id || app.name} />
          <div className="min-w-0">
            <div className="truncate font-medium text-foreground">{app.name}</div>
            <div className="truncate font-mono text-xs text-muted-foreground">{app.id}</div>
          </div>
        </div>
      ),
    },
    {
      id: "type",
      header: "Type",
      sortable: true,
      cell: (app) => <Badge tone="neutral">{isManaged(app) ? "Managed" : "Dynamic (DCR)"}</Badge>,
    },
    {
      id: "credential",
      header: "Credential",
      sortable: true,
      cell: (app) => <CredentialBadge app={app} />,
    },
    {
      id: "created",
      header: "Created",
      sortable: true,
      align: "right",
      cell: (app) => (
        <span className="text-xs text-muted-foreground">
          {new Date(app.created_at).toLocaleDateString()}
        </span>
      ),
    },
  ];

  return (
    <>
      <ResourceWorkspace
        title="Applications"
        description="Agent identities that can request authority in this zone."
        breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Applications" }]}
        primaryAction={{ label: "New application", onClick: () => setCreateOpen(true) }}
        rows={rows}
        loading={query.isLoading}
        columns={columns}
        rowKey={(app) => app.id}
        filters={allRows.length > 0 ? filters : undefined}
        search={{
          placeholder: "Search applications…",
          match: (app, q) => app.name.toLowerCase().includes(q) || app.id.toLowerCase().includes(q),
        }}
        initialSort={{ column: "created", direction: "desc" }}
        sortValues={{
          name: (app) => app.name.toLowerCase(),
          type: (app) => (isManaged(app) ? "0" : "1"),
          credential: (app) => credentialRank(app),
          created: (app) => Date.parse(app.created_at) || 0,
        }}
        empty={{
          title: query.isError ? "Could not load applications" : "No applications yet",
          description: query.isError
            ? errorMessage(query.error)
            : "Create an application to give an agent a scoped identity in this zone.",
        }}
        detail={{
          title: (app) => app.name,
          description: (app) => app.id,
          width: "max-w-xl",
          icon: (app) => <IdentityAvatar seed={app.id || app.name} size="lg" />,
          render: (app) => (
            <ApplicationDetail
              app={app}
              busy={updateApp.isPending}
              onRename={async (name) => {
                try {
                  await updateApp.mutateAsync({ id: app.id, input: { name } });
                  toast({ tone: "success", title: "Application renamed", description: name });
                } catch (err) {
                  toast({ tone: "error", title: "Rename failed", description: errorMessage(err) });
                  throw err;
                }
              }}
              onRotate={() => setRotateTarget(app)}
              onDelete={() => setDeleteTarget(app)}
            />
          ),
        }}
      />

      <CreateApplicationModal
        open={createOpen}
        zoneName={zoneName}
        busy={createApp.isPending}
        onClose={() => setCreateOpen(false)}
        onSubmit={async (name) => {
          try {
            const app = await createApp.mutateAsync({
              name,
              registration_method: "managed",
            });
            setCreateOpen(false);
            if (app.client_secret) {
              setSecret({ name: app.name, clientSecret: app.client_secret, rotated: false });
            } else {
              toast({ tone: "success", title: "Application created", description: app.name });
            }
          } catch (err) {
            toast({ tone: "error", title: "Create failed", description: errorMessage(err) });
          }
        }}
      />

      <SecretModal
        secret={secret}
        onClose={() => setSecret(null)}
        onCopied={() => toast({ tone: "success", title: "Client secret copied" })}
      />

      <ConfirmDialog
        open={rotateTarget !== null}
        onClose={() => setRotateTarget(null)}
        title="Rotate client secret"
        description={`This immediately invalidates the current secret for "${rotateTarget?.name ?? ""}". Any agent using the old secret will fail to authenticate until updated.`}
        confirmLabel="Rotate secret"
        tone="danger"
        onConfirm={async () => {
          if (!rotateTarget) return;
          const newSecret = generateClientSecret();
          try {
            await updateApp.mutateAsync({
              id: rotateTarget.id,
              input: { client_secret: newSecret },
            });
            setSecret({ name: rotateTarget.name, clientSecret: newSecret, rotated: true });
          } catch (err) {
            toast({ tone: "error", title: "Rotation failed", description: errorMessage(err) });
          }
        }}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete application"
        description={`Archiving "${deleteTarget?.name ?? ""}" revokes its identity: it can no longer obtain tokens, any agent using its credentials stops authenticating, and any resource bound to it as a Gateway application loses that route. The record is retained for audit.`}
        confirmLabel="Delete application"
        tone="danger"
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            await deleteApp.mutateAsync(deleteTarget.id);
            toast({ tone: "info", title: "Application deleted", description: deleteTarget.name });
          } catch (err) {
            toast({ tone: "error", title: "Delete failed", description: errorMessage(err) });
          }
        }}
      />
    </>
  );
}

/* ------------------------------ list cells ------------------------------ */

function CredentialBadge({ app }: { app: Application }) {
  const state = credentialState(app);
  if (state === "expired") return <Badge tone="danger">Expired</Badge>;
  if (state === "expiring") return <Badge tone="warning">Expiring</Badge>;
  return <Badge tone="success">Active</Badge>;
}

/* --------------------------- management drawer --------------------------- */

function ApplicationDetail({
  app,
  busy,
  onRename,
  onRotate,
  onDelete,
}: {
  app: Application;
  busy: boolean;
  onRename: (name: string) => Promise<void>;
  onRotate: () => void;
  onDelete: () => void;
}) {
  const managed = isManaged(app);
  const state = credentialState(app);

  return (
    <div className="flex flex-col gap-6">
      <DetailHeader>
        <CredentialBadge app={app} />
        <Badge tone="neutral">{managed ? "Managed" : "Dynamic (DCR)"}</Badge>
        {app.expires_at ? (
          <span className="text-xs text-muted-foreground">
            {state === "expired" ? "Expired " : "Expires "}
            {new Date(app.expires_at).toLocaleString()}
          </span>
        ) : null}
      </DetailHeader>

      <IdentitySection app={app} busy={busy} onRename={onRename} />

      {managed ? (
        <CredentialsSection onRotate={onRotate} />
      ) : (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Dynamic clients are registered programmatically and expire automatically. Their client
          secret is issued by the registering system and cannot be rotated here.
        </p>
      )}

      <DangerZone
        description={
          managed
            ? "Permanently revoke this identity. This cannot be undone."
            : "Revoke this dynamic client now instead of waiting for it to expire. This cannot be undone."
        }
        actionLabel="Delete"
        onAction={onDelete}
      />
    </div>
  );
}

function IdentitySection({
  app,
  busy,
  onRename,
}: {
  app: Application;
  busy: boolean;
  onRename: (name: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(app.name);

  useEffect(() => {
    setName(app.name);
    setEditing(false);
  }, [app.id, app.name]);

  return (
    <DetailGroup title="Identity">
      <div className="grid grid-cols-1 gap-0.5 px-3 py-2.5 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-3">
        <dt className="text-xs font-medium text-muted-foreground sm:pt-2">Name</dt>
        <dd className="min-w-0">
          {editing ? (
            <div className="flex items-center gap-2">
              <Field
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="flex-1"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && name.trim() && name.trim() !== app.name) {
                    void onRename(name.trim()).then(() => setEditing(false));
                  } else if (e.key === "Escape") {
                    setName(app.name);
                    setEditing(false);
                  }
                }}
              />
              <Button
                size="sm"
                loading={busy}
                mutating
                disabled={!name.trim() || name.trim() === app.name}
                onClick={() => void onRename(name.trim()).then(() => setEditing(false))}
              >
                Save
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setName(app.name);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex min-h-9 items-center justify-between gap-2">
              <span className="min-w-0 break-words text-sm text-foreground">{app.name}</span>
              <Button variant="ghost" size="sm" mutating onClick={() => setEditing(true)}>
                Rename
              </Button>
            </div>
          )}
        </dd>
      </div>
      <DetailField label="Application ID">
        <CopyValue value={app.id} />
      </DetailField>
      <DetailField label="Created">{new Date(app.created_at).toLocaleString()}</DetailField>
    </DetailGroup>
  );
}

function CredentialsSection({ onRotate }: { onRotate: () => void }) {
  return (
    <DetailSection title="Credentials">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-3">
        <p className="min-w-0 text-xs text-muted-foreground">
          The client secret is shown only once. Rotate to issue a new secret and invalidate the old
          one immediately.
        </p>
        <Button variant="secondary" size="sm" mutating onClick={onRotate} className="flex-shrink-0">
          Rotate secret
        </Button>
      </div>
    </DetailSection>
  );
}

/* ------------------------------- modals -------------------------------- */

function CreateApplicationModal({
  open,
  zoneName,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  zoneName: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState("");

  useEffect(() => {
    if (open) setName("");
  }, [open]);

  function submit() {
    if (!name.trim()) return;
    onSubmit(name.trim());
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New application"
      description={`Give an agent a managed identity in ${zoneName}.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={!name.trim()}>
            Create application
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="Name"
          info="Human-readable name for this managed application identity, shown across the console. Use a short operational name, not an internal ID."
          placeholder="billing-worker"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          autoFocus
        />
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Creates a managed identity and reveals its client secret once. The application gains
          authority only when a policy grants it scopes on a resource.
        </p>
      </div>
    </Modal>
  );
}

function SecretModal({
  secret,
  onClose,
  onCopied,
}: {
  secret: { name: string; clientSecret: string; rotated: boolean } | null;
  onClose: () => void;
  onCopied: () => void;
}) {
  return (
    <Modal
      open={secret !== null}
      onClose={onClose}
      title={secret?.rotated ? "Store the new client secret now" : "Store the client secret now"}
      description="This secret is shown once and cannot be retrieved later. Copy it before closing."
      footer={<Button onClick={onClose}>Done</Button>}
    >
      {secret ? (
        <div className="flex flex-col gap-3">
          <div className="text-sm text-muted-foreground">{secret.name}</div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs">
              {secret.clientSecret}
            </code>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void navigator.clipboard?.writeText(secret.clientSecret);
                onCopied();
              }}
            >
              Copy
            </Button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

function generateClientSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64url = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `cs_${base64url}`;
}
