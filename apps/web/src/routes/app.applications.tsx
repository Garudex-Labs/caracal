/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Applications route.
*/
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import {
  DetailField,
  DetailGroup,
  Mono,
  ResourceWorkspace,
} from "@/components/console/ResourceWorkspace";
import { ZoneScopedPage } from "@/components/console/ZoneScope";
import { Badge, Button, ConfirmDialog, Field, Modal, useToast, type Column } from "@/components/ui";
import { ConsoleApiError } from "@/platform/api/client";
import {
  useApplications,
  useCreateApplication,
  useDeleteApplication,
  useUpdateApplication,
} from "@/platform/api/hooks";
import { useCreateDeepLink } from "@/platform/nav/createDeepLink";
import type { Application } from "@/platform/api/types";

export const Route = createFileRoute("/app/applications")({
  component: ApplicationsRoute,
  validateSearch: (search: Record<string, unknown>): { create?: string } => ({
    create: typeof search.create === "string" ? search.create : undefined,
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

  const rows = query.data ?? [];

  const columns: Column<Application>[] = [
    {
      id: "name",
      header: "Application",
      sortable: true,
      truncate: true,
      cell: (app) => (
        <div className="flex items-center gap-3">
          <span className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-md bg-muted text-xs font-semibold text-muted-foreground">
            {app.name.slice(0, 2).toUpperCase()}
          </span>
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
      cell: (app) => <Badge tone="neutral">{isManaged(app) ? "Managed" : "Dynamic (DCR)"}</Badge>,
    },
    {
      id: "credential",
      header: "Credential",
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
        search={{
          placeholder: "Search applications…",
          match: (app, q) => app.name.toLowerCase().includes(q) || app.id.toLowerCase().includes(q),
        }}
        sortOptions={[
          { id: "recent", label: "Recently created" },
          { id: "name", label: "Name" },
        ]}
        empty={{
          title: query.isError ? "Could not load applications" : "No applications yet",
          description: query.isError
            ? errorMessage(query.error)
            : "Create an application to give an agent a scoped identity in this zone.",
          actionLabel: query.isError ? undefined : "New application",
          onAction: query.isError ? undefined : () => setCreateOpen(true),
        }}
        detail={{
          title: (app) => app.name,
          description: (app) => app.id,
          width: "max-w-xl",
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
      <div className="flex flex-wrap items-center gap-2">
        <CredentialBadge app={app} />
        <Badge tone="neutral">{managed ? "Managed" : "Dynamic (DCR)"}</Badge>
        {app.expires_at ? (
          <span className="text-xs text-muted-foreground">
            {state === "expired" ? "Expired " : "Expires "}
            {new Date(app.expires_at).toLocaleString()}
          </span>
        ) : null}
      </div>

      {managed ? (
        <IdentitySection app={app} busy={busy} onRename={onRename} />
      ) : (
        <DetailGroup title="Identity">
          <DetailField label="Name">{app.name}</DetailField>
          <DetailField label="Application ID">
            <Mono>{app.id}</Mono>
          </DetailField>
          <DetailField label="Created">{new Date(app.created_at).toLocaleString()}</DetailField>
        </DetailGroup>
      )}

      {managed ? (
        <CredentialsSection onRotate={onRotate} />
      ) : (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Dynamic clients are registered programmatically and expire automatically. Their identity
          and credentials are managed by the issuing system and are read-only here.
        </p>
      )}

      {managed ? (
        <section className="border-t border-border pt-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-destructive">
            Danger zone
          </h3>
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Permanently revoke this identity. This cannot be undone.
            </p>
            <Button variant="danger" size="sm" onClick={onDelete}>
              Delete
            </Button>
          </div>
        </section>
      ) : null}
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
      <div className="flex flex-col gap-1 py-2.5">
        <dt className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          Name
        </dt>
        <dd>
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
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-foreground">{app.name}</span>
              <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                Rename
              </Button>
            </div>
          )}
        </dd>
      </div>
      <DetailField label="Application ID">
        <Mono>{app.id}</Mono>
      </DetailField>
      <DetailField label="Created">{new Date(app.created_at).toLocaleString()}</DetailField>
    </DetailGroup>
  );
}

function CredentialsSection({ onRotate }: { onRotate: () => void }) {
  return (
    <section className="border-t border-border pt-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        Credentials
      </h3>
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          The client secret is shown only once. Rotate to issue a new secret and invalidate the old
          one immediately.
        </p>
        <Button variant="secondary" size="sm" onClick={onRotate}>
          Rotate secret
        </Button>
      </div>
    </section>
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
