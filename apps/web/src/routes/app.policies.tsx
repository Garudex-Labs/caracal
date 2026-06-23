/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the unified Policies workspace covering policy sets and the policy library.
*/
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";

import { PolicyEditorModal } from "@/components/console/PolicyEditor";
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
  Tabs,
  useToast,
  type Column,
} from "@/components/ui";
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
} from "@/platform/api/hooks";
import type {
  Policy,
  PolicySet,
  PolicySetVersion,
  PolicyVersion,
  SimulateResult,
} from "@/platform/api/types";

export const Route = createFileRoute("/app/policies")({
  component: PolicyWorkspaceRoute,
});

type TabId = "sets" | "policies";

function PolicyWorkspaceRoute() {
  return (
    <ZoneScopedPage
      title="Policies"
      description="Author authorization rules and the policy sets that enforce them."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Policies" }]}
    >
      {(zone) => <PolicyWorkspace zoneId={zone.id} />}
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

function PolicyWorkspace({ zoneId }: { zoneId: string }) {
  const [tab, setTab] = useState<TabId>("sets");
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
    <PolicySetsTab zoneId={zoneId} policies={policies.data ?? []} headerExtra={tabsNode} />
  ) : (
    <PoliciesTab zoneId={zoneId} headerExtra={tabsNode} />
  );
}

/* ============================ Policy Sets tab ============================ */

function PolicySetsTab({
  zoneId,
  policies,
  headerExtra,
}: {
  zoneId: string;
  policies: Policy[];
  headerExtra: ReactNode;
}) {
  const toast = useToast();
  const query = usePolicySets(zoneId);
  const createSet = useCreatePolicySet(zoneId);
  const addVersion = useAddPolicySetVersion(zoneId);
  const activate = useActivatePolicySet(zoneId);
  const deleteSet = useDeletePolicySet(zoneId);

  const [composer, setComposer] = useState<{ mode: "create" | "version"; set?: PolicySet } | null>(
    null,
  );
  const [simulateTarget, setSimulateTarget] = useState<PolicySet | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PolicySet | null>(null);

  const rows = query.data ?? [];
  const busy = createSet.isPending || addVersion.isPending || activate.isPending;

  async function handleCompose(result: ComposerResult) {
    try {
      if (composer?.mode === "create") {
        const set = await createSet.mutateAsync({
          name: result.name!,
          description: result.description,
        });
        const version = await addVersion.mutateAsync({ id: set.id, manifest: result.manifest });
        if (result.activateNow) {
          await activate.mutateAsync({ id: set.id, versionId: version.version_id });
        }
        toast({ tone: "success", title: "Policy set created", description: set.name });
      } else if (composer?.set) {
        const version = await addVersion.mutateAsync({
          id: composer.set.id,
          manifest: result.manifest,
        });
        if (result.activateNow) {
          await activate.mutateAsync({ id: composer.set.id, versionId: version.version_id });
        }
        toast({
          tone: "success",
          title: result.activateNow ? "Version composed and activated" : "Version composed",
          description: composer.set.name,
        });
      }
      setComposer(null);
    } catch (err) {
      toast({ tone: "error", title: "Compose failed", description: errorMessage(err) });
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
          <Badge tone="success">Active</Badge>
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
        breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Policies" }]}
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
            ps.name.toLowerCase().includes(q) || (ps.description ?? "").toLowerCase().includes(q),
        }}
        sortOptions={[
          { id: "name", label: "Name" },
          { id: "recent", label: "Newest" },
        ]}
        empty={{
          title: query.isError ? "Could not load policy sets" : "No policy sets yet",
          description: query.isError
            ? errorMessage(query.error)
            : "Without an active policy set, every request in this zone denies by default. Compose and activate one to authorize traffic.",
          actionLabel: query.isError ? undefined : "New policy set",
          onAction: query.isError ? undefined : () => setComposer({ mode: "create" }),
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
              onSimulate={() => setSimulateTarget(ps)}
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
        onSubmit={handleCompose}
      />

      <SimulateModal
        zoneId={zoneId}
        policySet={simulateTarget}
        onClose={() => setSimulateTarget(null)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete policy set"
        description={`Deleting "${deleteTarget?.name ?? ""}" removes it from this zone. If it is active, the zone falls back to deny-all. This cannot be undone.`}
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
  onDelete,
}: {
  zoneId: string;
  policySet: PolicySet;
  policies: Policy[];
  onNewVersion: () => void;
  onSimulate: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        {policySet.active_version_id ? (
          <Badge tone="success">Active — governs this zone</Badge>
        ) : (
          <Badge tone="warning">Not enforcing — requests deny</Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={onSimulate}>
            Simulate
          </Button>
          <Button size="sm" onClick={onNewVersion}>
            New version
          </Button>
        </div>
      </div>

      <DetailGroup title="Policy set">
        <DetailField label="Name">{policySet.name}</DetailField>
        <DetailField label="Description">{policySet.description ?? "—"}</DetailField>
        <DetailField label="Created">{new Date(policySet.created_at).toLocaleString()}</DetailField>
      </DetailGroup>

      <ActiveManifest zoneId={zoneId} policySet={policySet} policies={policies} />

      <section className="border-t border-border pt-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-destructive">
          Danger zone
        </h3>
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Remove this policy set. An active set falling away leaves the zone deny-all.
          </p>
          <Button variant="danger" size="sm" onClick={onDelete}>
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
          No version is active. Compose a version and activate it to enforce rules.
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
                  const resolved = names.get(policyVersionId);
                  return (
                    <tr key={policyVersionId}>
                      <td className="px-3 py-2">
                        {resolved ? (
                          <span className="flex items-center gap-2">
                            <span className="text-sm text-foreground">{resolved.name}</span>
                            <Badge tone="neutral">v{resolved.version}</Badge>
                          </span>
                        ) : (
                          <span className="font-mono text-xs text-muted-foreground">
                            {policyVersionId}
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

// Resolves policy_version_id -> { policy name, version number } by loading each
// policy's versions, so the manifest reads as policies rather than opaque UUIDs.
function usePolicyVersionNames(zoneId: string, policies: Policy[], enabled: boolean) {
  const [map, setMap] = useState<Map<string, { name: string; version: number }>>(new Map());
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
        setMap(next);
      })
      .catch(() => undefined);
  }

  return map;
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

function SimulateModal({
  zoneId,
  policySet,
  onClose,
}: {
  zoneId: string;
  policySet: PolicySet | null;
  onClose: () => void;
}) {
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SimulateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seedKey, setSeedKey] = useState("");

  const open = policySet !== null && Boolean(policySet.active_version_id);
  const noActive = policySet !== null && !policySet.active_version_id;

  if (policySet && seedKey !== policySet.id) {
    setSeedKey(policySet.id);
    setInput("");
    setResult(null);
    setError(null);
  }

  async function run() {
    if (!policySet?.active_version_id) return;
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
      const res = await consoleApi.policySets.simulate(
        zoneId,
        policySet.id,
        policySet.active_version_id,
        parsed,
      );
      setResult(res);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <Modal
      open={open || noActive}
      onClose={onClose}
      title={`Simulate · ${policySet?.name ?? ""}`}
      description="Dry-run the active version against an input. Nothing is mutated."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button onClick={() => void run()} loading={running} disabled={noActive}>
            Run simulation
          </Button>
        </>
      }
    >
      {noActive ? (
        <p className="text-sm text-muted-foreground">
          This policy set has no active version to simulate. Activate a version first.
        </p>
      ) : (
        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto pr-1">
          <div>
            <div className="mb-1.5 text-sm font-medium text-foreground">Input (optional JSON)</div>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              spellCheck={false}
              rows={8}
              placeholder='{"subject": {"traits": ["billing:read"]}, "resource": {"identifier": "resource://payments"}}'
              className="scrollbar-thin w-full resize-y rounded-md border border-border bg-[#0d1117] px-3 py-2.5 font-mono text-xs leading-relaxed text-[#e6edf3] outline-none focus:border-ring"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Leave blank to validate the rollout contract only.
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

function PoliciesTab({ zoneId, headerExtra }: { zoneId: string; headerExtra: ReactNode }) {
  const toast = useToast();
  const query = usePolicies(zoneId);
  const createPolicy = useCreatePolicy(zoneId);
  const addVersion = useAddPolicyVersion(zoneId);
  const deletePolicy = useDeletePolicy(zoneId);

  const [editor, setEditor] = useState<{ mode: "create" | "version"; policy?: Policy } | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<Policy | null>(null);

  const rows = query.data ?? [];
  const busy = createPolicy.isPending || addVersion.isPending;

  async function handleSubmit(values: { name?: string; description?: string; content: string }) {
    try {
      if (editor?.mode === "create") {
        await createPolicy.mutateAsync({
          name: values.name!,
          description: values.description,
          content: values.content,
        });
        toast({ tone: "success", title: "Policy created", description: values.name });
      } else if (editor?.policy) {
        await addVersion.mutateAsync({ id: editor.policy.id, content: values.content });
        toast({ tone: "success", title: "Version added", description: editor.policy.name });
      }
      setEditor(null);
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
      id: "owner",
      header: "Owner",
      cell: (p) => <Badge tone="neutral">{p.owner_type}</Badge>,
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
        breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Policies" }]}
        headerExtra={headerExtra}
        primaryAction={{ label: "New policy", onClick: () => setEditor({ mode: "create" }) }}
        rows={rows}
        loading={query.isLoading}
        columns={columns}
        rowKey={(p) => p.id}
        search={{
          placeholder: "Search policies…",
          match: (p, q) =>
            p.name.toLowerCase().includes(q) || (p.description ?? "").toLowerCase().includes(q),
        }}
        sortOptions={[
          { id: "name", label: "Name" },
          { id: "recent", label: "Newest" },
        ]}
        empty={{
          title: query.isError ? "Could not load policies" : "No policies yet",
          description: query.isError
            ? errorMessage(query.error)
            : "Policies are the Rego rules that authorize requests. Create one, then compose it into a policy set.",
          actionLabel: query.isError ? undefined : "New policy",
          onAction: query.isError ? undefined : () => setEditor({ mode: "create" }),
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

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete policy"
        description={`Deleting "${deleteTarget?.name ?? ""}" removes it and all its versions. Policy sets referencing it must be recomposed. This cannot be undone.`}
        confirmLabel="Delete policy"
        tone="danger"
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            await deletePolicy.mutateAsync(deleteTarget.id);
            toast({ tone: "info", title: "Policy deleted", description: deleteTarget.name });
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
        <Badge tone="neutral">{policy.owner_type}</Badge>
        <div className="ml-auto">
          <Button size="sm" onClick={onNewVersion}>
            New version
          </Button>
        </div>
      </div>

      <DetailGroup title="Policy">
        <DetailField label="Name">{policy.name}</DetailField>
        <DetailField label="Description">{policy.description ?? "—"}</DetailField>
        <DetailField label="Created by">{policy.created_by}</DetailField>
        <DetailField label="Created">{new Date(policy.created_at).toLocaleString()}</DetailField>
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
          <Button variant="danger" size="sm" onClick={onDelete}>
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
        <span className="flex-shrink-0 text-xs text-muted-foreground">
          {new Date(version.created_at).toLocaleDateString()}
        </span>
      </button>
      {open ? (
        version.content ? (
          <pre className="scrollbar-thin max-h-72 overflow-auto border-t border-border bg-[#0d1117] p-3 font-mono text-xs leading-relaxed text-[#e6edf3]">
            {version.content}
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
