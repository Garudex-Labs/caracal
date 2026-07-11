/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the unified Policies workspace covering policy sets and the policy library.
*/
import { appLink } from "@/platform/nav/appLink";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { PolicyEditorModal } from "@/components/console/PolicyEditor";
import { CreatedBy } from "@/components/console/CreatedBy";
import { PolicySetComposer, type ComposerResult } from "@/components/console/PolicySetComposer";
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
  Modal,
  Skeleton,
  Spinner,
  Tabs,
  useToast,
  type Column,
} from "@/components/ui";
import { highlightCode, TERMINAL_HIGHLIGHT } from "@/lib/codeHighlight";
import { cx } from "@/lib/cx";
import { consoleApi, ConsoleApiError } from "@/platform/api/client";
import {
  useActivatePolicySet,
  useAddPolicySetVersion,
  useAddPolicyVersion,
  useCreatePolicy,
  useCreatePolicySet,
  useDeletePolicy,
  useDeletePolicySet,
  usePolicies,
  usePolicy,
  usePolicySets,
  usePolicySetVersions,
} from "@/platform/api/hooks";
import type {
  ActivationStatus,
  Policy,
  PolicySet,
  PolicySetVersion,
  PolicyVersion,
  SimulateResult,
} from "@/platform/api/types";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/policies")({
  component: PolicyWorkspaceRoute,
  validateSearch: (
    search: Record<string, unknown>,
  ): { create?: string; focus?: string; tab?: string } => ({
    create: typeof search.create === "string" ? search.create : undefined,
    focus: typeof search.focus === "string" ? search.focus : undefined,
    tab: search.tab === "policies" || search.tab === "sets" ? search.tab : undefined,
  }),
});

type TabId = "sets" | "policies";

interface SimulateTarget {
  set: PolicySet;
  versionId: string | null;
  version?: number;
}

interface ActivateTarget {
  set: PolicySet;
  versionId: string;
  versionNumber?: number;
}

interface QuickDeployTarget {
  policyId: string;
  policyVersionId: string;
  policyName: string;
  set: PolicySet | null;
}

function PolicyWorkspaceRoute() {
  return (
    <ZoneScopedPage
      title="Policies"
      description="Author authorization rules and the policy sets that enforce them."
      breadcrumbs={[{ label: "Console", to: appLink() }, { label: "Policies" }]}
    >
      {(zone) => <PolicyWorkspace zoneId={zone.id} />}
    </ZoneScopedPage>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ConsoleApiError) {
    if (error.notConfigured) return "Control plane not connected.";
    if (error.unreachable) return "Control plane unreachable.";
    if (error.code === "policy_set_name_conflict")
      return "A policy set with this name already exists in this zone.";
    return error.code.replace(/_/g, " ");
  }
  return "Unexpected error.";
}

// Mirrors the backend OPA input contract (OPA_INPUT_SCHEMA_VERSION). The simulate
// endpoint warns when principal.zone_id, resource, action, or context are missing, so
// the scaffold below seeds a shape that validates instead of one that always warns.
const INPUT_SCHEMA_VERSION = "2026-05-20";

function exampleSimulationInput(zoneId: string): string {
  return JSON.stringify(
    {
      schema_version: INPUT_SCHEMA_VERSION,
      principal: { zone_id: zoneId, id: "app-anton", traits: ["pipernet-operator"] },
      resource: { identifier: "resource://pipernet" },
      action: { scopes: ["pipernet:read"] },
      context: {},
    },
    null,
    2,
  );
}

function PolicyWorkspace({ zoneId }: { zoneId: string }) {
  const { create, tab: tabParam } = Route.useSearch();
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabId>(tabParam === "policies" ? "policies" : "sets");
  // Guided setup deep links here with ?create=policy to teach policy authoring first.
  // Switch to the Policies tab and hand the tab a one-shot signal to open the editor, then
  // strip the param so the form does not reopen on refresh.
  const [autoCreatePolicy, setAutoCreatePolicy] = useState(false);
  const [autoCreateSet, setAutoCreateSet] = useState(false);
  const deepLinkFired = useRef(false);
  useEffect(() => {
    if (!create || deepLinkFired.current) return;
    deepLinkFired.current = true;
    if (create === "policy" || create === "1") {
      setTab("policies");
      setAutoCreatePolicy(true);
    }
    navigate({ to: appLink("/policies"), search: {}, replace: true });
  }, [create, navigate]);

  const policies = usePolicies(zoneId);
  const policySets = usePolicySets(zoneId);

  const tabsNode = (
    <Tabs
      tabs={[
        { id: "sets", label: "Policy Sets", count: policySets.data?.length },
        { id: "policies", label: "Policies", count: policies.data?.length },
      ]}
      active={tab}
      onChange={(id) => setTab(id as TabId)}
    />
  );

  return tab === "sets" ? (
    <PolicySetsTab
      zoneId={zoneId}
      policies={policies.data ?? []}
      headerExtra={tabsNode}
      autoCreate={autoCreateSet}
      onAutoCreateHandled={() => setAutoCreateSet(false)}
    />
  ) : (
    <PoliciesTab
      zoneId={zoneId}
      policySets={policySets.data ?? []}
      headerExtra={tabsNode}
      autoCreate={autoCreatePolicy}
      onAutoCreateHandled={() => setAutoCreatePolicy(false)}
      onSetupEnforcement={() => {
        setTab("sets");
        setAutoCreateSet(true);
      }}
    />
  );
}

/* ============================ Policy Sets tab ============================ */

function PolicySetsTab({
  zoneId,
  policies,
  headerExtra,
  autoCreate = false,
  onAutoCreateHandled,
}: {
  zoneId: string;
  policies: Policy[];
  headerExtra: ReactNode;
  autoCreate?: boolean;
  onAutoCreateHandled?: () => void;
}) {
  const toast = useToast();
  const query = usePolicySets(zoneId);
  const createSet = useCreatePolicySet(zoneId);
  const addVersion = useAddPolicySetVersion(zoneId);
  const deleteSet = useDeletePolicySet(zoneId);

  const [composer, setComposer] = useState<{ mode: "create" | "version"; set?: PolicySet } | null>(
    null,
  );
  const [simulateTarget, setSimulateTarget] = useState<SimulateTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PolicySet | null>(null);
  const [activateTarget, setActivateTarget] = useState<ActivateTarget | null>(null);

  // Honor the setup-enforcement handoff once: open the set composer, then clear the
  // one-shot flag so the form does not reopen on the next render.
  useEffect(() => {
    if (!autoCreate) return;
    setComposer({ mode: "create" });
    onAutoCreateHandled?.();
  }, [autoCreate, onAutoCreateHandled]);

  const rows = query.data ?? [];
  const busy = createSet.isPending || addVersion.isPending;

  // Saving a version and activating it are separate steps by design: the version is
  // durable once saved, and every activation flows through one dialog that dry-runs
  // the exact version before it can govern the zone.
  async function runCompose(result: ComposerResult) {
    try {
      let set: PolicySet;
      if (composer?.mode === "create") {
        set = await createSet.mutateAsync({
          name: result.name!,
          description: result.description,
        });
      } else if (composer?.set) {
        set = composer.set;
      } else {
        return;
      }
      const version = await addVersion.mutateAsync({ id: set.id, manifest: result.manifest });
      setComposer(null);
      if (result.deploy === "activate") {
        setActivateTarget({ set, versionId: version.version_id });
      } else {
        toast({ tone: "success", title: "Version saved", description: set.name });
      }
    } catch (err) {
      toast({ tone: "error", title: "Save failed", description: errorMessage(err) });
    }
  }

  const columns: Column<PolicySet>[] = [
    {
      id: "name",
      header: "Policy set",
      sortable: true,
      cell: (ps) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-foreground">{ps.name}</div>
          {ps.description ? (
            <div className="truncate text-xs text-muted-foreground">{ps.description}</div>
          ) : null}
        </div>
      ),
    },
    {
      id: "status",
      header: "Enforcement",
      cell: (ps) =>
        ps.active_version_id ? (
          <Badge tone="success">Enforcing</Badge>
        ) : (
          <Badge tone="warning">Not enforcing</Badge>
        ),
    },
    {
      id: "created",
      header: "Created",
      sortable: true,
      align: "right",
      cell: (ps) => (
        <span className="text-xs text-muted-foreground">
          {new Date(ps.created_at).toLocaleDateString()}
        </span>
      ),
    },
  ];

  return (
    <>
      <ResourceWorkspace
        title="Policies"
        description="Author authorization rules and the policy sets that enforce them."
        breadcrumbs={[{ label: "Console", to: appLink() }, { label: "Policies" }]}
        headerExtra={headerExtra}
        primaryAction={{
          label: "New policy set",
          onClick: () => setComposer({ mode: "create" }),
        }}
        rows={rows}
        loading={query.isLoading}
        columns={columns}
        rowKey={(ps) => ps.id}
        search={{
          placeholder: "Search policy sets…",
          match: (ps, q) =>
            ps.name.toLowerCase().includes(q) ||
            (ps.description ?? "").toLowerCase().includes(q) ||
            ps.id.toLowerCase().includes(q),
        }}
        sortOptions={[
          { id: "name", label: "Name" },
          { id: "recent", label: "Newest" },
        ]}
        empty={{
          title: query.isError ? "Could not load policy sets" : "No policy sets yet",
          description: query.isError
            ? errorMessage(query.error)
            : "Without an active policy set, every request in this zone denies by default. Create and activate one to authorize traffic.",
        }}
        detail={{
          title: (ps) => ps.name,
          description: (ps) => ps.id,
          width: "max-w-2xl",
          render: (ps) => (
            <PolicySetInspector
              zoneId={zoneId}
              policySet={ps}
              policies={policies}
              onNewVersion={() => setComposer({ mode: "version", set: ps })}
              onSimulate={(version) =>
                setSimulateTarget({
                  set: ps,
                  versionId: version?.id ?? ps.active_version_id,
                  version: version?.version,
                })
              }
              onActivateVersion={(version) =>
                setActivateTarget({
                  set: ps,
                  versionId: version.id,
                  versionNumber: version.version,
                })
              }
              onDelete={() => setDeleteTarget(ps)}
            />
          ),
        }}
      />

      <PolicySetComposer
        open={composer !== null}
        mode={composer?.mode ?? "create"}
        zoneId={zoneId}
        policies={policies}
        policySetName={composer?.set?.name}
        busy={busy}
        onClose={() => setComposer(null)}
        onSubmit={runCompose}
      />

      <SimulateModal
        zoneId={zoneId}
        target={simulateTarget}
        onClose={() => setSimulateTarget(null)}
      />

      <ActivateVersionDialog
        zoneId={zoneId}
        target={activateTarget}
        onClose={() => setActivateTarget(null)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete policy set"
        description={
          deleteTarget?.active_version_id
            ? `"${deleteTarget.name}" is currently enforcing authority in this zone. Deleting it immediately drops the zone to deny-all, so every request is denied until another set is activated. This cannot be undone.`
            : `Deleting "${deleteTarget?.name ?? ""}" removes it from this zone. It is not currently enforcing, so live decisions are unaffected. This cannot be undone.`
        }
        confirmLabel="Delete policy set"
        tone="danger"
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            await deleteSet.mutateAsync(deleteTarget.id);
            toast({ tone: "info", title: "Policy set deleted", description: deleteTarget.name });
          } catch (err) {
            toast({ tone: "error", title: "Delete failed", description: errorMessage(err) });
          }
        }}
      />
    </>
  );
}

function PolicySetInspector({
  zoneId,
  policySet,
  policies,
  onNewVersion,
  onSimulate,
  onActivateVersion,
  onDelete,
}: {
  zoneId: string;
  policySet: PolicySet;
  policies: Policy[];
  onNewVersion: () => void;
  onSimulate: (version?: PolicySetVersion) => void;
  onActivateVersion: (version: PolicySetVersion) => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        {policySet.active_version_id ? (
          <Badge tone="success">Enforcing: governs this zone</Badge>
        ) : (
          <Badge tone="warning">Not enforcing: requests deny</Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => onSimulate()}>
            Simulate
          </Button>
          <Button size="sm" mutating onClick={onNewVersion}>
            New version
          </Button>
        </div>
      </div>

      <DetailGroup title="Policy set">
        <DetailField label="Name">{policySet.name}</DetailField>
        <DetailField label="Description">{policySet.description ?? "-"}</DetailField>
        <DetailField label="Created by">
          <CreatedBy id={policySet.created_by} coAuthored={policySet.created_via_operator} />
        </DetailField>
        <DetailField label="Created">{new Date(policySet.created_at).toLocaleString()}</DetailField>
        {policySet.updated_by ? (
          <DetailField label="Updated by">
            <CreatedBy id={policySet.updated_by} coAuthored={policySet.updated_via_operator} />
          </DetailField>
        ) : null}
      </DetailGroup>

      <ActiveManifest zoneId={zoneId} policySet={policySet} policies={policies} />

      <SetVersionHistory
        zoneId={zoneId}
        policySet={policySet}
        onActivateVersion={onActivateVersion}
        onSimulateVersion={(version) => onSimulate(version)}
      />

      {policySet.active_version_id ? (
        <EnforcementStatus
          zoneId={zoneId}
          policySetId={policySet.id}
          versionId={policySet.active_version_id}
        />
      ) : null}

      <section className="border-t border-border pt-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-destructive">
          Danger zone
        </h3>
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Remove this policy set. An active set falling away leaves the zone deny-all.
          </p>
          <Button variant="danger" size="sm" mutating onClick={onDelete}>
            Delete
          </Button>
        </div>
      </section>
    </div>
  );
}

function ActiveManifest({
  zoneId,
  policySet,
  policies,
}: {
  zoneId: string;
  policySet: PolicySet;
  policies: Policy[];
}) {
  const versionId = policySet.active_version_id;
  const version = usePolicySetVersion(zoneId, policySet.id, versionId);
  const names = usePolicyVersionNames(zoneId, policies, Boolean(versionId));

  return (
    <section className="border-t border-border pt-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        Active manifest
      </h3>
      {!versionId ? (
        <p className="mt-2 text-sm text-muted-foreground">
          No version is active. Save a version and activate it to enforce rules.
        </p>
      ) : version.loading ? (
        <Skeleton className="mt-3 h-16 w-full" />
      ) : version.error ? (
        <p className="mt-2 text-sm text-muted-foreground">Could not load the active manifest.</p>
      ) : version.data ? (
        <div className="mt-3">
          <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Badge tone="neutral">v{version.data.version}</Badge>
            <Mono>{(version.data.manifest_sha256 ?? "").slice(0, 12)}…</Mono>
            <span>
              {(version.data.policies ?? []).length} polic
              {(version.data.policies ?? []).length === 1 ? "y" : "ies"}
            </span>
          </div>
          <div className="overflow-hidden border border-border">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border">
                {(version.data.policies ?? []).map((policyVersionId) => {
                  const resolved = names.map.get(policyVersionId);
                  return (
                    <tr key={policyVersionId}>
                      <td className="px-3 py-2">
                        {resolved ? (
                          <span className="flex items-center gap-2">
                            <span className="text-sm text-foreground">{resolved.name}</span>
                            <Badge tone="neutral">v{resolved.version}</Badge>
                          </span>
                        ) : names.ready ? (
                          <span className="flex items-center gap-2" title={policyVersionId}>
                            <Badge tone="warning">Removed policy</Badge>
                            <span className="font-mono text-[11px] text-muted-foreground">
                              {policyVersionId.slice(0, 8)}…
                            </span>
                          </span>
                        ) : (
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {policyVersionId.slice(0, 8)}…
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {(version.data.policies ?? []).length === 0 ? (
                  <tr>
                    <td className="px-3 py-2 text-sm text-muted-foreground">Empty manifest.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// Full version history for a policy set. Every version is immutable and stays
// activatable, so re-activating an earlier one is the rollback path: one click,
// confirmed, using the same activation flow as a fresh deploy.
function SetVersionHistory({
  zoneId,
  policySet,
  onActivateVersion,
  onSimulateVersion,
}: {
  zoneId: string;
  policySet: PolicySet;
  onActivateVersion: (version: PolicySetVersion) => void;
  onSimulateVersion: (version: PolicySetVersion) => void;
}) {
  const versions = usePolicySetVersions(zoneId, policySet.id);
  const rows = versions.data ?? [];

  return (
    <section className="border-t border-border pt-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        Version history
      </h3>
      {versions.isLoading ? (
        <Skeleton className="mt-3 h-16 w-full" />
      ) : versions.isError ? (
        <p className="mt-2 text-sm text-muted-foreground">Could not load versions.</p>
      ) : rows.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          No versions yet. Save one to define what this set enforces.
        </p>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {rows.map((version) => {
            const isActive = version.id === policySet.active_version_id;
            return (
              <div
                key={version.id}
                className="flex flex-wrap items-center gap-3 border border-border px-3 py-2"
              >
                <Badge tone="neutral">v{version.version}</Badge>
                <span
                  className="flex-1 truncate font-mono text-xs text-muted-foreground"
                  title={version.manifest_sha256}
                >
                  {version.manifest_sha256.slice(0, 12)}…
                </span>
                {version.created_by ? (
                  <CreatedBy
                    id={version.created_by}
                    coAuthored={version.created_via_operator}
                    className="text-xs text-muted-foreground"
                  />
                ) : null}
                <span className="text-xs text-muted-foreground">
                  {new Date(version.created_at).toLocaleDateString()}
                </span>
                {isActive ? (
                  <Badge tone="success">Enforcing</Badge>
                ) : (
                  <span className="flex items-center gap-1.5">
                    <Button variant="ghost" size="sm" onClick={() => onSimulateVersion(version)}>
                      Simulate
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      mutating
                      onClick={() => onActivateVersion(version)}
                    >
                      Activate
                    </Button>
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
      {rows.length > 1 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Activating an earlier version rolls the zone back to exactly the policy versions it pins.
        </p>
      ) : null}
    </section>
  );
}

// Surfaces how far an activation has propagated: the binding flips immediately, but
// enforcement only changes once the outbox dispatches the invalidation and the STS
// runtime reloads the bundle. Polls until the rollout is loaded or has failed so an
// operator sees real enforcement state, not just a database write.
function usePolicyActivationStatus(zoneId: string, policySetId: string, versionId: string) {
  const [status, setStatus] = useState<ActivationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        const next = await consoleApi.policySets.activationStatus(zoneId, policySetId, versionId);
        if (cancelled) return;
        setStatus(next);
        setError(null);
        const settled =
          next.propagation_status === "loaded" || next.propagation_status === "failed";
        if (!settled) timer = setTimeout(poll, 2500);
      } catch (err) {
        if (cancelled) return;
        setError(errorMessage(err));
        timer = setTimeout(poll, 5000);
      }
    }

    setStatus(null);
    setError(null);
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [zoneId, policySetId, versionId]);

  return { status, error };
}

const PROPAGATION_COPY: Record<string, { label: string; tone: "success" | "warning" | "danger" }> =
  {
    loaded: { label: "Enforcing", tone: "success" },
    waiting_for_activation: { label: "Activating…", tone: "warning" },
    waiting_for_outbox: { label: "Dispatching…", tone: "warning" },
    waiting_for_sts: { label: "Loading into runtime…", tone: "warning" },
    failed: { label: "Propagation failed", tone: "danger" },
  };

function EnforcementStatus({
  zoneId,
  policySetId,
  versionId,
}: {
  zoneId: string;
  policySetId: string;
  versionId: string;
}) {
  const { status, error } = usePolicyActivationStatus(zoneId, policySetId, versionId);

  return (
    <section className="border-t border-border pt-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        Enforcement status
      </h3>
      {!status && !error ? (
        <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Checking propagation…
        </div>
      ) : error ? (
        <p className="mt-2 text-sm text-muted-foreground">Could not load enforcement status.</p>
      ) : status ? (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {(() => {
              const copy = PROPAGATION_COPY[status.propagation_status] ?? {
                label: status.propagation_status,
                tone: "muted" as const,
              };
              return <Badge tone={copy.tone}>{copy.label}</Badge>;
            })()}
            {status.propagation_status !== "loaded" && status.propagation_status !== "failed" ? (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Spinner /> live
              </span>
            ) : null}
          </div>
          <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1.5 text-xs">
            <dt className="text-muted-foreground">Dispatch</dt>
            <dd className="text-foreground">{describeOutbox(status.outbox.state)}</dd>
            <dt className="text-muted-foreground">Runtime (STS)</dt>
            <dd className="text-foreground">{describeSts(status.sts.state)}</dd>
            <dt className="text-muted-foreground">Manifest</dt>
            <dd>
              <Mono>{(status.manifest_sha256 ?? "").slice(0, 12) || "-"}…</Mono>
            </dd>
          </dl>
          {status.propagation_status === "failed" ? (
            <p className="border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {typeof status.outbox.last_error === "string" && status.outbox.last_error
                ? `Dispatch error: ${status.outbox.last_error}`
                : "The runtime did not load this version. Re-activate, or check platform health in Diagnostics."}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function describeOutbox(state: string): string {
  switch (state) {
    case "dispatched":
      return "Delivered to runtime stream";
    case "pending":
      return "Queued for delivery";
    case "dead":
      return "Failed: exhausted retries";
    case "mismatch":
      return "Superseded by a newer activation";
    case "missing":
      return "No dispatch record found";
    default:
      return state;
  }
}

function describeSts(state: string): string {
  switch (state) {
    case "loaded":
      return "Bundle loaded and enforcing";
    case "not_loaded":
      return "Bundle not yet loaded";
    case "not_configured":
      return "Runtime status not configured";
    case "unreachable":
      return "Runtime unreachable";
    case "failed":
      return "Runtime reported a failure";
    default:
      return state;
  }
}

// Resolves policy_version_id -> { policy name, version number } by loading each
// policy's versions, so the manifest reads as policies rather than opaque UUIDs.
// Reports readiness so unresolved entries only surface as removed once the library
// has actually been checked.
function usePolicyVersionNames(zoneId: string, policies: Policy[], enabled: boolean) {
  const [state, setState] = useState<{
    map: Map<string, { name: string; version: number }>;
    ready: boolean;
  }>({ map: new Map(), ready: false });
  const key = enabled ? policies.map((p) => p.id).join(",") : "";
  const [seed, setSeed] = useState("");

  if (enabled && key && seed !== key) {
    setSeed(key);
    Promise.all(policies.map((policy) => consoleApi.policies.get(zoneId, policy.id)))
      .then((details) => {
        const next = new Map<string, { name: string; version: number }>();
        for (const detail of details) {
          for (const version of detail.versions ?? []) {
            next.set(version.id, { name: detail.name, version: version.version });
          }
        }
        setState({ map: next, ready: true });
      })
      .catch(() => undefined);
  }

  return state;
}

function usePolicySetVersion(zoneId: string, policySetId: string, versionId: string | null) {
  const [state, setState] = useState<{
    loading: boolean;
    error: boolean;
    data: PolicySetVersion | null;
    key: string;
  }>({ loading: false, error: false, data: null, key: "" });

  const key = `${policySetId}:${versionId}`;
  if (versionId && state.key !== key) {
    setState({ loading: true, error: false, data: null, key });
    consoleApi.policySets
      .getVersion(zoneId, policySetId, versionId)
      .then((data) => setState({ loading: false, error: false, data, key }))
      .catch(() => setState({ loading: false, error: true, data: null, key }));
  }

  return state;
}

// One-click follow-up after a policy is saved: roll it into the zone's enforcing set and
// review the activation, or set up enforcement when nothing governs the zone yet. Skippable,
// so the policy library stays usable without ever touching enforcement.
function QuickDeployDialog({
  target,
  busy,
  onClose,
  onDeploy,
  onSetupEnforcement,
}: {
  target: QuickDeployTarget | null;
  busy: boolean;
  onClose: () => void;
  onDeploy: () => void;
  onSetupEnforcement: () => void;
}) {
  const hasSet = Boolean(target?.set);
  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      title={hasSet ? "Enforce this policy now?" : "Policy saved"}
      description={
        hasSet
          ? `"${target?.set?.name ?? ""}" is enforcing this zone. One click saves a set version that includes "${target?.policyName ?? ""}" and reviews its activation.`
          : `"${target?.policyName ?? ""}" is saved to the library, but no policy set is enforcing this zone yet, so every request still denies.`
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Not now
          </Button>
          {hasSet ? (
            <Button mutating loading={busy} onClick={onDeploy}>
              Add to "{target?.set?.name ?? ""}" & activate
            </Button>
          ) : (
            <Button onClick={onSetupEnforcement}>Set up enforcement</Button>
          )}
        </>
      }
    >
      <p className="text-sm text-muted-foreground">
        {hasSet
          ? "The set's next version pins the current manifest with this policy updated. A dry run verifies it before anything changes."
          : "Create a policy set with this policy and activate it to start authorizing traffic."}
      </p>
    </Modal>
  );
}

// Every activation flows through this dialog: it dry-runs the exact version on open and
// blocks the confirm until the run passes, so verification is ambient rather than a step
// the operator has to remember. A failed dry run (contract or bundle rejection) cannot be
// activated from here at all.
function ActivateVersionDialog({
  zoneId,
  target,
  onClose,
  onActivated,
}: {
  zoneId: string;
  target: ActivateTarget | null;
  onClose: () => void;
  onActivated?: () => void;
}) {
  const toast = useToast();
  const activate = useActivatePolicySet(zoneId);
  const [activateError, setActivateError] = useState<string | null>(null);
  const [check, setCheck] = useState<
    | { status: "running" }
    | { status: "passed"; result: SimulateResult }
    | { status: "failed"; message: string }
  >({ status: "running" });
  const targetSetId = target?.set.id ?? null;
  const targetVersionId = target?.versionId ?? null;
  useEffect(() => {
    if (!targetSetId || !targetVersionId) return;
    setCheck({ status: "running" });
    setActivateError(null);
    let cancelled = false;
    consoleApi.policySets
      .simulate(zoneId, targetSetId, targetVersionId)
      .then((result) => {
        if (!cancelled) setCheck({ status: "passed", result });
      })
      .catch((err) => {
        if (!cancelled) setCheck({ status: "failed", message: errorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [zoneId, targetSetId, targetVersionId]);

  const replacing =
    Boolean(target?.set.active_version_id) && target?.set.active_version_id !== target?.versionId;
  const versionLabel = target?.versionNumber ? `Version ${target.versionNumber}` : "This version";

  async function runActivation() {
    if (!target) return;
    setActivateError(null);
    try {
      await activate.mutateAsync({ id: target.set.id, versionId: target.versionId });
      toast({
        tone: "success",
        title: target.versionNumber
          ? `Version ${target.versionNumber} activated`
          : "Version activated",
        description: target.set.name,
      });
      onClose();
      onActivated?.();
    } catch (err) {
      setActivateError(errorMessage(err));
    }
  }

  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      title="Activate version"
      description={
        replacing
          ? `${versionLabel} of "${target?.set.name ?? ""}" replaces the currently enforcing version for every request in this zone.`
          : `${versionLabel} of "${target?.set.name ?? ""}" starts enforcing immediately, switching the zone from deny-all to the rules it pins.`
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            mutating
            loading={activate.isPending}
            disabled={check.status !== "passed"}
            onClick={() => void runActivation()}
          >
            Activate version
          </Button>
          {check.status === "failed" ? (
            <button
              type="button"
              className="basis-full text-right text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline disabled:pointer-events-none disabled:opacity-50"
              onClick={() => void runActivation()}
              disabled={activate.isPending}
            >
              Activate anyway
            </button>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {check.status === "running" ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Verifying this version compiles and satisfies the rollout contract…
          </div>
        ) : check.status === "failed" ? (
          <div className="border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <div className="font-medium">Dry run failed</div>
            <div className="mt-0.5">{check.message}</div>
            <div className="mt-1 text-destructive/80">
              Fix the policies this version pins and save a new version, or activate anyway if the
              check itself is wrong.
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="success">Dry run passed</Badge>
              <span className="font-mono text-[11px] text-muted-foreground">
                {check.result.policies.length} polic
                {check.result.policies.length === 1 ? "y" : "ies"}
              </span>
              <Mono>{(check.result.manifest_sha256 ?? "").slice(0, 12)}…</Mono>
            </div>
            {check.result.warnings.length > 0 ? (
              <div className="border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                {check.result.warnings.map((warning, index) => (
                  <div key={index}>{warning}</div>
                ))}
              </div>
            ) : null}
          </div>
        )}
        {activateError ? (
          <div className="border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <div className="font-medium">Activation failed</div>
            <div className="mt-0.5">{activateError}</div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function SimulateModal({
  zoneId,
  target,
  onClose,
}: {
  zoneId: string;
  target: SimulateTarget | null;
  onClose: () => void;
}) {
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SimulateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seedKey, setSeedKey] = useState("");

  const versionId = target?.versionId ?? null;
  const open = target !== null && versionId !== null;
  const noVersion = target !== null && versionId === null;

  const key = target ? `${target.set.id}:${versionId ?? ""}` : "";
  if (target && seedKey !== key) {
    setSeedKey(key);
    setInput("");
    setResult(null);
    setError(null);
  }

  async function run() {
    if (!target || !versionId) return;
    setError(null);
    let parsed: Record<string, unknown> | undefined;
    if (input.trim()) {
      try {
        parsed = JSON.parse(input);
      } catch {
        setError("Input must be valid JSON.");
        return;
      }
    }
    setRunning(true);
    try {
      const res = await consoleApi.policySets.simulate(zoneId, target.set.id, versionId, parsed);
      setResult(res);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <Modal
      open={open || noVersion}
      onClose={onClose}
      title={
        target?.version
          ? `Simulate v${target.version} · ${target.set.name}`
          : `Simulate · ${target?.set.name ?? ""}`
      }
      description={
        target?.version
          ? "Dry-run this version against an input before activating it. Nothing is mutated."
          : "Dry-run the enforcing version against an input. Nothing is mutated."
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button onClick={() => void run()} loading={running} disabled={noVersion}>
            Run simulation
          </Button>
        </>
      }
    >
      {noVersion ? (
        <p className="text-sm text-muted-foreground">
          This policy set has no active version to simulate. Activate a version first.
        </p>
      ) : (
        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto pr-1">
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-sm font-medium text-foreground">Input (optional JSON)</span>
              <button
                type="button"
                onClick={() => setInput(exampleSimulationInput(zoneId))}
                className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
              >
                Load example
              </button>
            </div>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              spellCheck={false}
              rows={10}
              placeholder={exampleSimulationInput(zoneId)}
              className="scrollbar-thin w-full resize-y rounded-md border border-border bg-[#0d1117] px-3 py-2.5 font-mono text-xs leading-relaxed text-[#e6edf3] outline-none focus:border-ring"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Expected fields: <span className="font-mono">principal.zone_id</span> (this zone),{" "}
              <span className="font-mono">resource</span>, <span className="font-mono">action</span>
              , <span className="font-mono">context</span>, and{" "}
              <span className="font-mono">schema_version</span>. Leave blank to validate the rollout
              contract only.
            </p>
          </div>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {result ? <SimulationResult result={result} /> : null}
        </div>
      )}
    </Modal>
  );
}

function SimulationResult({ result }: { result: SimulateResult }) {
  const decision =
    result.result && typeof result.result === "object" && "decision" in result.result
      ? String((result.result as { decision: unknown }).decision)
      : null;

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4">
      <div className="flex flex-wrap items-center gap-2">
        {decision ? (
          <Badge tone={decision === "allow" ? "success" : "danger"}>{decision}</Badge>
        ) : (
          <Badge tone="muted">{result.explanation.evaluation}</Badge>
        )}
        <Badge tone={result.would_activate ? "success" : "warning"}>
          {result.would_activate ? "Contract valid" : "Has warnings"}
        </Badge>
        <span className="font-mono text-[11px] text-muted-foreground">
          {result.policies.length} policies
        </span>
      </div>

      {result.warnings.length > 0 ? (
        <div className="border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          {result.warnings.map((warning, index) => (
            <div key={index}>{warning}</div>
          ))}
        </div>
      ) : null}

      {result.explanation.reason ? (
        <p className="text-xs text-muted-foreground">{result.explanation.reason}</p>
      ) : null}

      {result.result ? (
        <pre className="scrollbar-thin max-h-48 overflow-auto border border-border bg-muted/40 p-3 font-mono text-xs text-foreground">
          {JSON.stringify(result.result, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

/* ============================== Policies tab ============================== */

function PoliciesTab({
  zoneId,
  policySets,
  headerExtra,
  autoCreate = false,
  onAutoCreateHandled,
  onSetupEnforcement,
}: {
  zoneId: string;
  policySets: PolicySet[];
  headerExtra: ReactNode;
  autoCreate?: boolean;
  onAutoCreateHandled?: () => void;
  onSetupEnforcement: () => void;
}) {
  const toast = useToast();
  const query = usePolicies(zoneId);
  const createPolicy = useCreatePolicy(zoneId);
  const addVersion = useAddPolicyVersion(zoneId);
  const addSetVersion = useAddPolicySetVersion(zoneId);
  const deletePolicy = useDeletePolicy(zoneId);

  const [editor, setEditor] = useState<{ mode: "create" | "version"; policy?: Policy } | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<Policy | null>(null);
  const [quickDeploy, setQuickDeploy] = useState<QuickDeployTarget | null>(null);
  const [activateTarget, setActivateTarget] = useState<ActivateTarget | null>(null);

  // Honor the guided-setup deep link once: open the create editor, then notify the parent
  // so the one-shot flag clears and the form does not reopen on the next render.
  useEffect(() => {
    if (!autoCreate) return;
    setEditor({ mode: "create" });
    onAutoCreateHandled?.();
  }, [autoCreate, onAutoCreateHandled]);

  const rows = query.data ?? [];
  const busy = createPolicy.isPending || addVersion.isPending;
  // At most one set can be enforcing the zone; it is the target of the one-click
  // "add and activate" follow-up after a policy is saved.
  const enforcingSet = policySets.find((set) => set.active_version_id) ?? null;

  async function handleSubmit(values: { name?: string; description?: string; content: string }) {
    try {
      if (editor?.mode === "create") {
        const created = await createPolicy.mutateAsync({
          name: values.name!,
          description: values.description,
          content: values.content,
        });
        toast({ tone: "success", title: "Policy created", description: values.name });
        setQuickDeploy({
          policyId: created.id,
          policyVersionId: created.version_id,
          policyName: values.name!,
          set: enforcingSet,
        });
      } else if (editor?.policy) {
        const version = await addVersion.mutateAsync({
          id: editor.policy.id,
          content: values.content,
        });
        toast({ tone: "success", title: "Version added", description: editor.policy.name });
        setQuickDeploy({
          policyId: editor.policy.id,
          policyVersionId: version.version_id,
          policyName: editor.policy.name,
          set: enforcingSet,
        });
      }
      setEditor(null);
    } catch (err) {
      toast({ tone: "error", title: "Save failed", description: errorMessage(err) });
    }
  }

  // Rolls the saved policy version into the enforcing set: the set's next version pins
  // the active manifest with this policy's entry replaced (or appended), so "make my
  // change live" is one action instead of re-selecting every policy in the composer.
  async function quickDeployToSet(target: QuickDeployTarget) {
    const set = target.set;
    if (!set?.active_version_id) return;
    try {
      const [active, detail] = await Promise.all([
        consoleApi.policySets.getVersion(zoneId, set.id, set.active_version_id),
        consoleApi.policies.get(zoneId, target.policyId),
      ]);
      const ownVersions = new Set((detail.versions ?? []).map((version) => version.id));
      const manifest = (active.policies ?? [])
        .filter((versionId) => !ownVersions.has(versionId))
        .map((policy_version_id) => ({ policy_version_id }));
      manifest.push({ policy_version_id: target.policyVersionId });
      const version = await addSetVersion.mutateAsync({ id: set.id, manifest });
      setQuickDeploy(null);
      setActivateTarget({ set, versionId: version.version_id });
    } catch (err) {
      toast({ tone: "error", title: "Save failed", description: errorMessage(err) });
    }
  }

  const columns: Column<Policy>[] = [
    {
      id: "name",
      header: "Policy",
      sortable: true,
      cell: (p) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-foreground">{p.name}</div>
          {p.description ? (
            <div className="truncate text-xs text-muted-foreground">{p.description}</div>
          ) : null}
        </div>
      ),
    },
    {
      id: "created",
      header: "Created",
      sortable: true,
      align: "right",
      cell: (p) => (
        <span className="text-xs text-muted-foreground">
          {new Date(p.created_at).toLocaleDateString()}
        </span>
      ),
    },
  ];

  return (
    <>
      <ResourceWorkspace
        title="Policies"
        description="Author authorization rules and the policy sets that enforce them."
        breadcrumbs={[{ label: "Console", to: appLink() }, { label: "Policies" }]}
        headerExtra={headerExtra}
        primaryAction={{ label: "New policy", onClick: () => setEditor({ mode: "create" }) }}
        rows={rows}
        loading={query.isLoading}
        columns={columns}
        rowKey={(p) => p.id}
        search={{
          placeholder: "Search policies…",
          match: (p, q) =>
            p.name.toLowerCase().includes(q) ||
            (p.description ?? "").toLowerCase().includes(q) ||
            p.id.toLowerCase().includes(q),
        }}
        sortOptions={[
          { id: "name", label: "Name" },
          { id: "recent", label: "Newest" },
        ]}
        empty={{
          title: query.isError ? "Could not load policies" : "No policies yet",
          description: query.isError
            ? errorMessage(query.error)
            : "Policies are the Rego rules that authorize requests. Create one, then add it to a policy set.",
        }}
        detail={{
          title: (p) => p.name,
          description: (p) => p.id,
          width: "max-w-2xl",
          render: (p) => (
            <PolicyInspector
              zoneId={zoneId}
              policy={p}
              onNewVersion={() => setEditor({ mode: "version", policy: p })}
              onDelete={() => setDeleteTarget(p)}
            />
          ),
        }}
      />

      <PolicyEditorModal
        open={editor !== null}
        mode={editor?.mode ?? "create"}
        policyName={editor?.policy?.name}
        busy={busy}
        onClose={() => setEditor(null)}
        onSubmit={handleSubmit}
      />

      <QuickDeployDialog
        target={quickDeploy}
        busy={addSetVersion.isPending}
        onClose={() => setQuickDeploy(null)}
        onDeploy={() => quickDeploy && void quickDeployToSet(quickDeploy)}
        onSetupEnforcement={() => {
          setQuickDeploy(null);
          onSetupEnforcement();
        }}
      />

      <ActivateVersionDialog
        zoneId={zoneId}
        target={activateTarget}
        onClose={() => setActivateTarget(null)}
      />

      <DeletePolicyDialog
        zoneId={zoneId}
        policy={deleteTarget}
        busy={deletePolicy.isPending}
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            await deletePolicy.mutateAsync(deleteTarget.id);
            toast({ tone: "info", title: "Policy deleted", description: deleteTarget.name });
            setDeleteTarget(null);
          } catch (err) {
            toast({ tone: "error", title: "Delete failed", description: errorMessage(err) });
          }
        }}
      />
    </>
  );
}

function PolicyInspector({
  zoneId,
  policy,
  onNewVersion,
  onDelete,
}: {
  zoneId: string;
  policy: Policy;
  onNewVersion: () => void;
  onDelete: () => void;
}) {
  const detail = usePolicy(zoneId, policy.id);
  const versions = useMemo(
    () => [...(detail.data?.versions ?? [])].sort((a, b) => b.version - a.version),
    [detail.data],
  );
  const [openVersion, setOpenVersion] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <div className="ml-auto">
          <Button size="sm" mutating onClick={onNewVersion}>
            New version
          </Button>
        </div>
      </div>

      <DetailGroup title="Policy">
        <DetailField label="Name">{policy.name}</DetailField>
        <DetailField label="Description">{policy.description ?? "-"}</DetailField>
        <DetailField label="Created by">
          <CreatedBy id={policy.created_by} coAuthored={policy.created_via_operator} />
        </DetailField>
        <DetailField label="Created">{new Date(policy.created_at).toLocaleString()}</DetailField>
        {policy.updated_by ? (
          <DetailField label="Updated by">
            <CreatedBy id={policy.updated_by} coAuthored={policy.updated_via_operator} />
          </DetailField>
        ) : null}
      </DetailGroup>

      <section className="border-t border-border pt-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Versions
        </h3>
        {detail.isLoading ? (
          <Skeleton className="mt-3 h-16 w-full" />
        ) : versions.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No versions.</p>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {versions.map((version) => (
              <VersionRow
                key={version.id}
                version={version}
                open={openVersion === version.id}
                onToggle={() =>
                  setOpenVersion((current) => (current === version.id ? null : version.id))
                }
              />
            ))}
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          Versions are immutable. Each change adds a new version rather than editing an existing
          one.
        </p>
      </section>

      <section className="border-t border-border pt-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-destructive">
          Danger zone
        </h3>
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">Remove this policy and all its versions.</p>
          <Button variant="danger" size="sm" mutating onClick={onDelete}>
            Delete
          </Button>
        </div>
      </section>
    </div>
  );
}

function VersionRow({
  version,
  open,
  onToggle,
}: {
  version: PolicyVersion;
  open: boolean;
  onToggle: () => void;
}) {
  const highlighted = useMemo(
    () => (version.content ? highlightCode(version.content, "Rego", TERMINAL_HIGHLIGHT) : null),
    [version.content],
  );
  return (
    <div className="border border-border">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-surface"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          className={cx(
            "flex-shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
        <Badge tone="neutral">v{version.version}</Badge>
        <span className="flex-1 truncate font-mono text-xs text-muted-foreground">
          {version.content_sha256.slice(0, 16)}…
        </span>
        {version.created_by ? (
          <CreatedBy
            id={version.created_by}
            coAuthored={version.created_via_operator}
            className="flex-shrink-0 text-xs text-muted-foreground"
          />
        ) : null}
        <span className="flex-shrink-0 text-xs text-muted-foreground">
          {new Date(version.created_at).toLocaleDateString()}
        </span>
      </button>
      {open ? (
        version.content ? (
          <pre className="scrollbar-thin max-h-72 overflow-auto border-t border-border bg-[#0d1117] p-3 font-mono text-xs leading-relaxed text-[#e6edf3]">
            <code>{highlighted}</code>
          </pre>
        ) : (
          <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
            Source unavailable.
          </p>
        )
      ) : null}
    </div>
  );
}

// Reference-aware policy delete: a policy's versions can be pinned inside active policy
// sets that are currently enforcing the zone. Deleting the policy archives it (live sets
// keep enforcing their pinned versions), but it disappears from the library and can no
// longer be composed into new versions. Surface the real references so the operator sees
// the blast radius instead of a generic "must be recomposed" string.
function DeletePolicyDialog({
  zoneId,
  policy,
  busy,
  onClose,
  onConfirm,
}: {
  zoneId: string;
  policy: Policy | null;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [refs, setRefs] = useState<{ id: string; name: string }[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!policy) return;
    setRefs(null);
    setLoadError(null);
    setLoading(true);
    let cancelled = false;
    (async () => {
      try {
        const [detail, sets] = await Promise.all([
          consoleApi.policies.get(zoneId, policy.id),
          consoleApi.policySets.list(zoneId),
        ]);
        const versionIds = new Set((detail.versions ?? []).map((v) => v.id));
        const activeSets = sets.filter((s) => s.active_version_id);
        const manifests = await Promise.all(
          activeSets.map((s) =>
            consoleApi.policySets
              .getVersion(zoneId, s.id, s.active_version_id as string)
              .then((version) => ({ set: s, policies: version.policies ?? [] }))
              .catch(() => ({ set: s, policies: [] as string[] })),
          ),
        );
        if (cancelled) return;
        const referencing = manifests
          .filter((m) => m.policies.some((pid) => versionIds.has(pid)))
          .map((m) => ({ id: m.set.id, name: m.set.name }));
        setRefs(referencing);
      } catch (err) {
        if (!cancelled) setLoadError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [zoneId, policy]);

  return (
    <Modal
      open={policy !== null}
      onClose={onClose}
      title="Delete policy"
      description={`Deleting "${policy?.name ?? ""}" archives it and all its versions. This cannot be undone.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={busy} disabled={loading}>
            Delete policy
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Checking references…
          </div>
        ) : loadError ? (
          <p className="border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
            Could not check which policy sets reference this policy: {loadError}. Deleting still
            works; referencing sets keep enforcing their pinned versions.
          </p>
        ) : refs && refs.length > 0 ? (
          <div className="border border-amber-500/40 bg-amber-500/10 px-3 py-3 text-xs text-amber-700 dark:text-amber-400">
            <div className="font-medium">
              {refs.length} active policy set{refs.length === 1 ? "" : "s"} enforce a version of
              this policy
            </div>
            <ul className="mt-2 flex flex-col gap-1">
              {refs.map((r) => (
                <li key={r.id} className="font-medium text-foreground">
                  {r.name}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-amber-700/90 dark:text-amber-400/90">
              Those sets keep enforcing their pinned versions, but this policy leaves the library
              and can no longer be composed into new policy-set versions.
            </p>
          </div>
        ) : refs ? (
          <p className="text-sm text-muted-foreground">
            No active policy set references this policy.
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
