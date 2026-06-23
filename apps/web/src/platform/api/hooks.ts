/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file exposes React Query hooks and active-zone state for the control-plane console screens.
*/
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import { getActiveZoneId, setActiveZoneId } from "@/platform/state/localInstall";

import { consoleApi } from "./client";
import type { Application, ApplicationInput, Zone, ZoneInput } from "./types";

// Operational data that benefits from staying live while the tab is focused.
const LIVE_MS = 10_000;

const keys = {
  status: ["console", "status"] as const,
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
};

export function useConsoleStatus() {
  return useQuery({ queryKey: keys.status, queryFn: () => consoleApi.status() });
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

export function useProviders(zoneId: string | null) {
  return useQuery({
    queryKey: keys.providers(zoneId),
    queryFn: () => consoleApi.providers.list(zoneId as string),
    enabled: Boolean(zoneId),
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
