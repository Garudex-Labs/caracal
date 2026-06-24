/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file exposes React Query hooks and active-zone state for the control-plane console screens.
*/
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import { getActiveZoneId, setActiveZoneId } from "@/platform/state/localInstall";

import { consoleApi } from "./client";
import type {
  Application,
  ApplicationInput,
  ApplicationPatchInput,
  DiagnosticsReport,
  DiagnosticStatus,
  PolicyInput,
  PolicyManifestEntry,
  Provider,
  ProviderInput,
  ProviderPatchInput,
  Resource,
  ResourceInput,
  ResourcePatchInput,
  Zone,
  ZoneInput,
  ZonePatchInput,
} from "./types";

// Operational data that benefits from staying live while the tab is focused.
const LIVE_MS = 10_000;
// Platform health drives the always-visible navbar indicator; poll on a calm cadence
// while the tab is focused. The backend caches the report, so this never stampedes the
// control plane, and React Query pauses the interval while the tab is hidden.
const DIAGNOSTICS_POLL_MS = 20_000;

export type PlatformHealth = "healthy" | "attention" | "unhealthy" | "unknown";

/** Collapse a diagnostics report into the three-state platform health signal. */
export function platformHealthOf(report: DiagnosticsReport | undefined): PlatformHealth {
  if (!report) return "unknown";
  if (report.summary.fail > 0) return "unhealthy";
  if (report.summary.warn > 0) return "attention";
  return "healthy";
}

/** Severity ranking so failing checks always sort above warnings above healthy ones. */
export function diagnosticSeverityRank(status: DiagnosticStatus): number {
  return status === "fail" ? 0 : status === "warn" ? 1 : 2;
}

const keys = {
  status: ["console", "status"] as const,
  diagnostics: ["console", "diagnostics"] as const,
  zones: ["console", "zones"] as const,
  applications: (zoneId: string | null) => ["console", "applications", zoneId] as const,
  resources: (zoneId: string | null) => ["console", "resources", zoneId] as const,
  providers: (zoneId: string | null) => ["console", "providers", zoneId] as const,
  policies: (zoneId: string | null) => ["console", "policies", zoneId] as const,
  policy: (zoneId: string | null, id: string | null) => ["console", "policy", zoneId, id] as const,
  policySets: (zoneId: string | null) => ["console", "policy-sets", zoneId] as const,
  sessions: (zoneId: string | null) => ["console", "sessions", zoneId] as const,
  audit: (zoneId: string | null) => ["console", "audit", zoneId] as const,
  auditExplain: (zoneId: string | null, requestId: string | null) =>
    ["console", "audit-explain", zoneId, requestId] as const,
  agents: (zoneId: string | null) => ["console", "agents", zoneId] as const,
  agent: (zoneId: string | null, id: string | null) => ["console", "agent", zoneId, id] as const,
  delegationsActive: (zoneId: string | null) => ["console", "delegations-active", zoneId] as const,
};

export function useConsoleStatus() {
  return useQuery({ queryKey: keys.status, queryFn: () => consoleApi.status() });
}

export function useDiagnostics() {
  return useQuery<DiagnosticsReport>({
    queryKey: keys.diagnostics,
    queryFn: () => consoleApi.diagnostics(),
    refetchInterval: DIAGNOSTICS_POLL_MS,
    staleTime: DIAGNOSTICS_POLL_MS / 2,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

export function useZones() {
  return useQuery({ queryKey: keys.zones, queryFn: () => consoleApi.zones.list() });
}

export function useCreateZone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ZoneInput) => consoleApi.zones.create(input),
    onSuccess: (zone) => {
      qc.invalidateQueries({ queryKey: keys.zones });
      if (!getActiveZoneId()) selectZone(zone.id);
    },
  });
}

export function useUpdateZone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ZonePatchInput }) =>
      consoleApi.zones.patch(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.zones }),
  });
}

export function useZoneDcrStatus(zoneId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["console", "zone-dcr", zoneId],
    queryFn: () => consoleApi.zones.dcrStatus(zoneId as string),
    enabled: Boolean(zoneId) && enabled,
  });
}

export function useDeleteZone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => consoleApi.zones.delete(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: keys.zones });
      const previous = qc.getQueryData<Zone[]>(keys.zones);
      qc.setQueryData<Zone[]>(keys.zones, (old) => old?.filter((zone) => zone.id !== id));
      return { previous };
    },
    onError: (_error, _id, context) => {
      if (context?.previous) qc.setQueryData(keys.zones, context.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.zones }),
  });
}

export function useApplications(zoneId: string | null) {
  return useQuery({
    queryKey: keys.applications(zoneId),
    queryFn: () => consoleApi.applications.list(zoneId as string),
    enabled: Boolean(zoneId),
  });
}

export function useCreateApplication(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ApplicationInput) =>
      consoleApi.applications.create(zoneId as string, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.applications(zoneId) }),
  });
}

export function useUpdateApplication(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ApplicationPatchInput }) =>
      consoleApi.applications.patch(zoneId as string, id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.applications(zoneId) }),
  });
}

export function useDeleteApplication(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => consoleApi.applications.delete(zoneId as string, id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: keys.applications(zoneId) });
      const previous = qc.getQueryData<Application[]>(keys.applications(zoneId));
      qc.setQueryData<Application[]>(keys.applications(zoneId), (old) =>
        old?.filter((app) => app.id !== id),
      );
      return { previous };
    },
    onError: (_error, _id, context) => {
      if (context?.previous) qc.setQueryData(keys.applications(zoneId), context.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.applications(zoneId) }),
  });
}

export function useResources(zoneId: string | null) {
  return useQuery({
    queryKey: keys.resources(zoneId),
    queryFn: () => consoleApi.resources.list(zoneId as string),
    enabled: Boolean(zoneId),
  });
}

export function useCreateResource(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ResourceInput) => consoleApi.resources.create(zoneId as string, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.resources(zoneId) }),
  });
}

export function useUpdateResource(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ResourcePatchInput }) =>
      consoleApi.resources.patch(zoneId as string, id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.resources(zoneId) }),
  });
}

export function useDeleteResource(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => consoleApi.resources.delete(zoneId as string, id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: keys.resources(zoneId) });
      const previous = qc.getQueryData<Resource[]>(keys.resources(zoneId));
      qc.setQueryData<Resource[]>(keys.resources(zoneId), (old) =>
        old?.filter((resource) => resource.id !== id),
      );
      return { previous };
    },
    onError: (_error, _id, context) => {
      if (context?.previous) qc.setQueryData(keys.resources(zoneId), context.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.resources(zoneId) }),
  });
}

export function useProviders(zoneId: string | null) {
  return useQuery({
    queryKey: keys.providers(zoneId),
    queryFn: () => consoleApi.providers.list(zoneId as string),
    enabled: Boolean(zoneId),
  });
}

export function useCreateProvider(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ProviderInput) => consoleApi.providers.create(zoneId as string, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.providers(zoneId) }),
  });
}

export function useUpdateProvider(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ProviderPatchInput }) =>
      consoleApi.providers.patch(zoneId as string, id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.providers(zoneId) }),
  });
}

export function useDeleteProvider(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => consoleApi.providers.delete(zoneId as string, id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: keys.providers(zoneId) });
      const previous = qc.getQueryData<Provider[]>(keys.providers(zoneId));
      qc.setQueryData<Provider[]>(keys.providers(zoneId), (old) =>
        old?.filter((provider) => provider.id !== id),
      );
      return { previous };
    },
    onError: (_error, _id, context) => {
      if (context?.previous) qc.setQueryData(keys.providers(zoneId), context.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.providers(zoneId) }),
  });
}

export function usePolicies(zoneId: string | null) {
  return useQuery({
    queryKey: keys.policies(zoneId),
    queryFn: () => consoleApi.policies.list(zoneId as string),
    enabled: Boolean(zoneId),
  });
}

export function usePolicySets(zoneId: string | null) {
  return useQuery({
    queryKey: keys.policySets(zoneId),
    queryFn: () => consoleApi.policySets.list(zoneId as string),
    enabled: Boolean(zoneId),
  });
}

export function usePolicy(zoneId: string | null, id: string | null) {
  return useQuery({
    queryKey: keys.policy(zoneId, id),
    queryFn: () => consoleApi.policies.get(zoneId as string, id as string),
    enabled: Boolean(zoneId && id),
  });
}

export function usePolicySet(zoneId: string | null, id: string | null) {
  return useQuery({
    queryKey: ["console", "policy-set", zoneId, id],
    queryFn: () => consoleApi.policySets.get(zoneId as string, id as string),
    enabled: Boolean(zoneId && id),
  });
}

function invalidatePolicies(qc: ReturnType<typeof useQueryClient>, zoneId: string | null) {
  qc.invalidateQueries({ queryKey: keys.policies(zoneId) });
}

function invalidatePolicySets(qc: ReturnType<typeof useQueryClient>, zoneId: string | null) {
  qc.invalidateQueries({ queryKey: keys.policySets(zoneId) });
  qc.invalidateQueries({ queryKey: ["console", "policy-set", zoneId] });
}

export function useCreatePolicy(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PolicyInput) => consoleApi.policies.create(zoneId as string, input),
    onSuccess: () => invalidatePolicies(qc, zoneId),
  });
}

export function useAddPolicyVersion(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, content }: { id: string; content: string }) =>
      consoleApi.policies.addVersion(zoneId as string, id, content),
    onSuccess: (_data, vars) => {
      invalidatePolicies(qc, zoneId);
      qc.invalidateQueries({ queryKey: keys.policy(zoneId, vars.id) });
    },
  });
}

export function useDeletePolicy(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => consoleApi.policies.delete(zoneId as string, id),
    onSuccess: () => invalidatePolicies(qc, zoneId),
  });
}

export function useCreatePolicySet(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, description }: { name: string; description?: string }) =>
      consoleApi.policySets.create(zoneId as string, name, description),
    onSuccess: () => invalidatePolicySets(qc, zoneId),
  });
}

export function useAddPolicySetVersion(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, manifest }: { id: string; manifest: PolicyManifestEntry[] }) =>
      consoleApi.policySets.addVersion(zoneId as string, id, manifest),
    onSuccess: () => invalidatePolicySets(qc, zoneId),
  });
}

export function useActivatePolicySet(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      versionId,
      shadowVersionId,
    }: {
      id: string;
      versionId: string;
      shadowVersionId?: string;
    }) => consoleApi.policySets.activate(zoneId as string, id, versionId, shadowVersionId),
    onSuccess: () => invalidatePolicySets(qc, zoneId),
  });
}

export function useDeletePolicySet(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => consoleApi.policySets.delete(zoneId as string, id),
    onSuccess: () => invalidatePolicySets(qc, zoneId),
  });
}

export function useSessions(zoneId: string | null) {
  return useQuery({
    queryKey: keys.sessions(zoneId),
    queryFn: () => consoleApi.sessions.list(zoneId as string),
    enabled: Boolean(zoneId),
    refetchInterval: LIVE_MS,
  });
}

export function useAudit(zoneId: string | null) {
  return useQuery({
    queryKey: keys.audit(zoneId),
    queryFn: () => consoleApi.audit.list(zoneId as string),
    enabled: Boolean(zoneId),
    refetchInterval: LIVE_MS,
  });
}

export function useDecisionTrace(zoneId: string | null, requestId: string | null) {
  return useQuery({
    queryKey: keys.auditExplain(zoneId, requestId),
    queryFn: () => consoleApi.audit.explain(zoneId as string, requestId as string),
    enabled: Boolean(zoneId && requestId),
  });
}

export function useAgents(zoneId: string | null, enabled = true) {
  return useQuery({
    queryKey: keys.agents(zoneId),
    queryFn: () => consoleApi.agents.list(zoneId as string),
    enabled: Boolean(zoneId) && enabled,
    refetchInterval: LIVE_MS,
  });
}

export function useAgentEffectiveAuthority(zoneId: string | null, id: string | null) {
  return useQuery({
    queryKey: [...keys.agent(zoneId, id), "authority"],
    queryFn: () => consoleApi.agents.effectiveAuthority(zoneId as string, id as string),
    enabled: Boolean(zoneId && id),
  });
}

export function useAgentChildren(zoneId: string | null, id: string | null) {
  return useQuery({
    queryKey: [...keys.agent(zoneId, id), "children"],
    queryFn: () => consoleApi.agents.children(zoneId as string, id as string),
    enabled: Boolean(zoneId && id),
  });
}

export function useAgentLifecycle(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      action,
    }: {
      id: string;
      action: "suspend" | "resume" | "terminate";
    }) => {
      if (action === "suspend") await consoleApi.agents.suspend(zoneId as string, id);
      else if (action === "resume") await consoleApi.agents.resume(zoneId as string, id);
      else await consoleApi.agents.terminate(zoneId as string, id);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.agents(zoneId) }),
  });
}

export function useActiveDelegations(zoneId: string | null, enabled = true) {
  return useQuery({
    queryKey: keys.delegationsActive(zoneId),
    queryFn: () => consoleApi.delegations.active(zoneId as string),
    enabled: Boolean(zoneId) && enabled,
    refetchInterval: LIVE_MS,
  });
}

export function useRevokeDelegation(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => consoleApi.delegations.revoke(zoneId as string, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.delegationsActive(zoneId) }),
  });
}

const zoneListeners = new Set<() => void>();

function emitZoneChange(): void {
  for (const listener of zoneListeners) listener();
}

export function selectZone(id: string): void {
  setActiveZoneId(id);
  emitZoneChange();
}

function subscribeZone(listener: () => void): () => void {
  zoneListeners.add(listener);
  return () => zoneListeners.delete(listener);
}

// Resolves the persisted active zone against the live zone list, falling back to
// the first available zone so screens always have a coherent zone context.
export function useActiveZone(): {
  zones: Zone[];
  activeZone: Zone | null;
  selectZone: (id: string) => void;
} {
  const zonesQuery = useZones();
  const persistedId = useSyncExternalStore(subscribeZone, getActiveZoneId, () => null);
  const zones = zonesQuery.data ?? [];
  const activeZone = zones.find((zone) => zone.id === persistedId) ?? zones[0] ?? null;
  return { zones, activeZone, selectZone };
}
