/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file exposes React Query hooks and active-zone state for the control-plane console screens.
*/
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore, useState } from "react";

import { getActiveZoneId, setActiveZoneId } from "@/platform/state/localInstall";
import { isSystemZone } from "@/platform/state/zones";
import { clearSystemZoneViewLatch, isSystemZoneViewTab } from "@/platform/state/systemZoneView";
import { systemZoneViewPath } from "@/platform/nav/appLink";
import { config } from "@/platform/config";

export { systemZoneViewPath };

import { ConsoleApiError, consoleApi } from "./client";
import type {
  Application,
  ApplicationInput,
  ApplicationPatchInput,
  AdminAuditQuery,
  SessionQuery,
  ApprovalQuery,
  AuditQuery,
  ControlKeyCreateInput,
  ControlTokenInput,
  DiagnosticsReport,
  DiagnosticStatus,
  NotificationSinkInput,
  OperatorConversationMode,
  OperatorAiProviderInput,
  OperatorAiProviderPatch,
  OperatorPlanInput,
  OperatorProgressStage,
  Policy,
  PolicyInput,
  PolicyManifestEntry,
  PolicySet,
  Provider,
  ProviderConnectionAuthorizeInput,
  ProviderConnectionRevokeInput,
  ProviderInput,
  ProviderPatchInput,
  Resource,
  ResourceInput,
  ResourcePatchInput,
  AuthorityRecordQuery,
  SubjectQuery,
  Workload,
  WorkloadUpdateInput,
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
  overview: (zoneId: string | null) => ["console", "overview", zoneId] as const,
  applications: (zoneId: string | null) => ["console", "applications", zoneId] as const,
  workloads: (zoneId: string | null) => ["console", "workloads", zoneId] as const,
  resources: (zoneId: string | null) => ["console", "resources", zoneId] as const,
  providers: (zoneId: string | null) => ["console", "providers", zoneId] as const,
  policies: (zoneId: string | null) => ["console", "policies", zoneId] as const,
  policy: (zoneId: string | null, id: string | null) => ["console", "policy", zoneId, id] as const,
  policySets: (zoneId: string | null) => ["console", "policy-sets", zoneId] as const,
  authorityRecords: (zoneId: string | null) => ["console", "authority-records", zoneId] as const,
  subjects: (zoneId: string | null) => ["console", "subjects", zoneId] as const,
  approvals: (zoneId: string | null) => ["console", "approvals", zoneId] as const,
  approvalCounts: (zoneId: string | null) => ["console", "approval-counts", zoneId] as const,
  notificationSinks: (zoneId: string | null) => ["console", "notification-sinks", zoneId] as const,
  sinkDeliveries: (zoneId: string | null, sinkId: string | null) =>
    ["console", "sink-deliveries", zoneId, sinkId] as const,
  audit: (zoneId: string | null) => ["console", "audit", zoneId] as const,
  auditRetention: ["console", "audit-retention"] as const,
  mintRateLimit: ["console", "mint-rate-limit"] as const,
  auditExplain: (zoneId: string | null, requestId: string | null) =>
    ["console", "audit-explain", zoneId, requestId] as const,
  adminAudit: (zoneId: string | null) => ["console", "admin-audit", zoneId] as const,
  sessions: (zoneId: string | null) => ["console", "sessions", zoneId] as const,
  session: (zoneId: string | null, id: string | null) =>
    ["console", "session", zoneId, id] as const,
  delegationsActive: (zoneId: string | null) => ["console", "delegations-active", zoneId] as const,
  operatorCapabilities: ["console", "operator-capabilities"] as const,
  operatorStatus: ["console", "operator-status"] as const,
  operatorAiStatus: ["console", "operator-ai-status"] as const,
  operatorAiProviders: ["console", "operator-ai-providers"] as const,
  operatorConversations: (zoneId: string | null) =>
    ["console", "operator-conversations", zoneId] as const,
  operatorTurns: (zoneId: string | null, conversationId: string | null) =>
    ["console", "operator-turns", zoneId, conversationId] as const,
  operatorContext: (zoneId: string | null, conversationId: string | null) =>
    ["console", "operator-context", zoneId, conversationId] as const,
  operatorPlanSecrets: (
    zoneId: string | null,
    conversationId: string | null,
    planSeq: number | null,
  ) => ["console", "operator-plan-secrets", zoneId, conversationId, planSeq] as const,
};

export function useConsoleStatus() {
  return useQuery({ queryKey: keys.status, queryFn: () => consoleApi.status() });
}

// Reflects whether the optional Operator service is enabled on this deployment.
// Static for the process lifetime, so it is held for the session rather than polled.
export function useOperatorStatus() {
  return useQuery({
    queryKey: keys.operatorStatus,
    queryFn: ({ signal }) => consoleApi.operator.status(signal),
    staleTime: Infinity,
  });
}

// Whether Caracal-governed autopilot is available on this deployment, so the console only offers
// the per-conversation engage toggle when there is a policy that could approve something.
export function useOperatorAutopilotAvailable() {
  return useQuery({
    queryKey: [...keys.operatorStatus, "autopilot"] as const,
    queryFn: ({ signal }) => consoleApi.operator.autopilotAvailable(signal),
    staleTime: Infinity,
  });
}

// Reflects which AI providers are configured for the Operator, in failover order.
// Provider configuration is static per deployment, so it is held for the session.
export function useOperatorAiStatus(enabled: boolean) {
  return useQuery({
    queryKey: keys.operatorAiStatus,
    queryFn: ({ signal }) => consoleApi.operator.aiStatus(signal),
    enabled,
    staleTime: Infinity,
  });
}

// Runs the explicit connectivity probe: one real completion through the failover chain.
// Exposed as a mutation since it is an operator-triggered action, not background state.
export function useOperatorAiCheck() {
  return useMutation({
    mutationFn: () => consoleApi.operator.aiCheck(),
  });
}

// The governed model providers managed from the console, with whether the deployment can seal
// keys (governed execution configured). Refetched on focus so a change applied elsewhere shows.
export function useOperatorAiProviders() {
  return useQuery({
    queryKey: keys.operatorAiProviders,
    queryFn: ({ signal }) => consoleApi.operator.aiProviders.list(signal),
  });
}

export function useCreateOperatorAiProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: OperatorAiProviderInput) => consoleApi.operator.aiProviders.create(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.operatorAiProviders });
      qc.invalidateQueries({ queryKey: keys.operatorAiStatus });
    },
  });
}

export function useUpdateOperatorAiProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, patch }: { slug: string; patch: OperatorAiProviderPatch }) =>
      consoleApi.operator.aiProviders.update(slug, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.operatorAiProviders });
      qc.invalidateQueries({ queryKey: keys.operatorAiStatus });
    },
  });
}

export function useRotateOperatorAiProviderKey() {
  return useMutation({
    mutationFn: ({ slug, apiKey }: { slug: string; apiKey: string }) =>
      consoleApi.operator.aiProviders.rotateKey(slug, apiKey),
  });
}

export function useDeleteOperatorAiProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => consoleApi.operator.aiProviders.remove(slug),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.operatorAiProviders });
      qc.invalidateQueries({ queryKey: keys.operatorAiStatus });
    },
  });
}

// The capability catalog is static for a deployment, so it is fetched once and held
// for the session rather than polled.
export function useOperatorCapabilities() {
  return useQuery({
    queryKey: keys.operatorCapabilities,
    queryFn: ({ signal }) => consoleApi.operator.capabilities(signal),
    staleTime: Infinity,
  });
}

export function useOperatorConversations(
  zoneId: string | null,
  q?: string,
  status: "active" | "archived" | "all" = "active",
) {
  const term = q?.trim() || undefined;
  return useQuery({
    queryKey: [...keys.operatorConversations(zoneId), term ?? "", status],
    queryFn: ({ signal }) =>
      consoleApi.operator.conversations.list(zoneId as string, { q: term, status, signal }),
    enabled: !!zoneId,
  });
}

export function useCreateOperatorConversation(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      input: string | { title: string; mode?: OperatorConversationMode; autopilot?: boolean },
    ) => {
      const { title, mode, autopilot } =
        typeof input === "string" ? { title: input, mode: undefined, autopilot: undefined } : input;
      return consoleApi.operator.conversations.create(zoneId as string, title, { mode, autopilot });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.operatorConversations(zoneId) }),
  });
}

export function useRenameOperatorConversation(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; title: string }) =>
      consoleApi.operator.conversations.rename(zoneId as string, input.id, input.title),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.operatorConversations(zoneId) }),
  });
}

export function useSetOperatorConversationMode(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; mode: OperatorConversationMode }) =>
      consoleApi.operator.conversations.setMode(zoneId as string, input.id, input.mode),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.operatorConversations(zoneId) }),
  });
}

export function useSetOperatorConversationAutopilot(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; autopilot: boolean }) =>
      consoleApi.operator.conversations.setAutopilot(zoneId as string, input.id, input.autopilot),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.operatorConversations(zoneId) }),
  });
}

export function useArchiveOperatorConversation(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => consoleApi.operator.conversations.archive(zoneId as string, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.operatorConversations(zoneId) }),
  });
}

export function useRestoreOperatorConversation(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => consoleApi.operator.conversations.restore(zoneId as string, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.operatorConversations(zoneId) }),
  });
}

export function useDeleteOperatorConversation(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => consoleApi.operator.conversations.delete(zoneId as string, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.operatorConversations(zoneId) }),
  });
}

export function useOperatorTurns(zoneId: string | null, conversationId: string | null) {
  return useQuery({
    queryKey: keys.operatorTurns(zoneId, conversationId),
    queryFn: ({ signal }) =>
      consoleApi.operator.listTurns(zoneId as string, conversationId as string, signal),
    enabled: !!zoneId && !!conversationId,
    // The transcript is the durable ledger, and a message sent just before leaving the page is
    // recorded server-side even though its send was aborted on unmount. Under the global 15s
    // staleTime the cache would be served without that turn when the operator returns quickly,
    // hiding their own message and any plan left awaiting approval. Reload on every mount so
    // reopening a conversation always reflects the authoritative ledger.
    refetchOnMount: "always",
  });
}

// The compressed session memory and working-memory snapshot for a conversation,
// used to show continuity (applied changes, operations the operator has rejected)
// without scrolling the whole timeline.
export function useOperatorContext(zoneId: string | null, conversationId: string | null) {
  return useQuery({
    queryKey: keys.operatorContext(zoneId, conversationId),
    queryFn: ({ signal }) =>
      consoleApi.operator.context(zoneId as string, conversationId as string, signal),
    enabled: !!zoneId && !!conversationId,
  });
}

// A turn-producing action refreshes both the timeline and the compressed session
// memory, so the two never disagree about what has happened.
function invalidateConversation(
  qc: ReturnType<typeof useQueryClient>,
  zoneId: string | null,
  conversationId: string | null,
) {
  qc.invalidateQueries({ queryKey: keys.operatorTurns(zoneId, conversationId) });
  qc.invalidateQueries({ queryKey: keys.operatorContext(zoneId, conversationId) });
}

// Sending a message can append several turns (the message plus a plan or note), so a
// success refreshes the timeline rather than trying to patch it locally.
export function useSendOperatorMessage(zoneId: string | null, conversationId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      message: string;
      provider?: string;
      clientMessageId?: string;
      correlationId?: string;
      signal?: AbortSignal;
      onStage?: (stage: OperatorProgressStage) => void;
      onToken?: (text: string) => void;
      onReasoning?: (text: string) => void;
    }) =>
      consoleApi.operator.sendMessage(
        zoneId as string,
        conversationId as string,
        input.message,
        input.provider,
        input.onStage ?? (() => {}),
        input.onToken,
        input.onReasoning,
        {
          signal: input.signal,
          clientMessageId: input.clientMessageId,
          correlationId: input.correlationId,
        },
      ),
    onSuccess: () => invalidateConversation(qc, zoneId, conversationId),
  });
}

// Cancelling settles the in-flight run server-side so the deliberating turn discards its outputs;
// the timeline is refreshed so the stream lands on the ledger as the cancellation left it.
export function useCancelOperatorRun(zoneId: string | null, conversationId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (clientMessageId: string) =>
      consoleApi.operator.cancelRun(zoneId as string, conversationId as string, clientMessageId),
    onSettled: () => invalidateConversation(qc, zoneId, conversationId),
  });
}

// A governed action button on a policy draft proposes its change as a plan turn through the same
// path a natural-language plan takes: the plan is validated and recorded, then decided and applied
// under the existing approval gate. The button never applies anything directly, so the draft's
// create, version, and activate actions stay auditable and gated.
export function useCreateOperatorPlan(zoneId: string | null, conversationId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (plan: OperatorPlanInput) =>
      consoleApi.operator.createPlan(zoneId as string, conversationId as string, plan),
    onSuccess: () => invalidateConversation(qc, zoneId, conversationId),
  });
}

// A failed plan action whose error names a state the server already moved past - the plan was
// decided or executed elsewhere, vanished, or the conversation was archived - means the local
// timeline is stale. Re-reading it lets the card settle on the authoritative outcome instead of
// stranding the operator on a control that can no longer apply, which also defuses a duplicate
// submission racing a first one.
const STALE_PLAN_CODES = new Set([
  "plan_already_decided",
  "plan_already_executed",
  "plan_not_approved",
  "plan_rejected",
  "plan_not_found",
  "conversation_archived",
  "conversation_not_found",
  // A step failed mid-apply: the server has already recorded the failed execution turn and the
  // ledger error turn, so re-reading the timeline settles the card on the real, audited failure
  // detail and surfaces that error through the same notice channel as every other failure.
  "execution_failed",
]);

function resyncOnStalePlan(
  qc: ReturnType<typeof useQueryClient>,
  zoneId: string | null,
  conversationId: string | null,
  error: unknown,
) {
  if (error instanceof ConsoleApiError && STALE_PLAN_CODES.has(error.code)) {
    invalidateConversation(qc, zoneId, conversationId);
  }
}

export function useDecideOperatorPlan(zoneId: string | null, conversationId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (decision: {
      plan_seq: number;
      decision: "approved" | "rejected";
      reason?: string;
    }) => consoleApi.operator.decidePlan(zoneId as string, conversationId as string, decision),
    onSuccess: () => invalidateConversation(qc, zoneId, conversationId),
    onError: (error) => resyncOnStalePlan(qc, zoneId, conversationId, error),
  });
}

export function useExecuteOperatorPlan(zoneId: string | null, conversationId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (planSeq: number) =>
      consoleApi.operator.executePlan(zoneId as string, conversationId as string, planSeq),
    onSuccess: () => invalidateConversation(qc, zoneId, conversationId),
    onError: (error) => resyncOnStalePlan(qc, zoneId, conversationId, error),
  });
}

// Which steps of a pending plan collect credentials through the secure prompt and whether the
// sealed vault holds them. Enabled only while a plan actually needs credentials, so ordinary
// plans add no traffic.
export function useOperatorPlanSecrets(
  zoneId: string | null,
  conversationId: string | null,
  planSeq: number | null,
) {
  return useQuery({
    queryKey: keys.operatorPlanSecrets(zoneId, conversationId, planSeq),
    queryFn: ({ signal }) =>
      consoleApi.operator.planSecrets(
        zoneId as string,
        conversationId as string,
        planSeq as number,
        signal,
      ),
    enabled: Boolean(zoneId && conversationId && planSeq),
  });
}

// Submits one step's pasted credentials to the sealed vault. Success re-reads the secrets status
// and, because the server may complete a deferred autopilot approval, the conversation itself.
export function useProvidePlanSecrets(zoneId: string | null, conversationId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { planSeq: number; stepId: string; values: Record<string, string> }) =>
      consoleApi.operator.providePlanSecrets(
        zoneId as string,
        conversationId as string,
        input.planSeq,
        input.stepId,
        input.values,
      ),
    onSuccess: (_result, input) => {
      qc.invalidateQueries({
        queryKey: keys.operatorPlanSecrets(zoneId, conversationId, input.planSeq),
      });
      invalidateConversation(qc, zoneId, conversationId);
    },
    onError: (error) => resyncOnStalePlan(qc, zoneId, conversationId, error),
  });
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
  return useQuery({
    queryKey: keys.zones,
    queryFn: ({ signal }) => consoleApi.zones.list(signal),
    // The reserved system zone is Caracal's own internal infrastructure and is never a
    // selectable, manageable zone. The control plane already excludes it from this list; the
    // client filter is defense-in-depth so it can never surface in any zone selector or list,
    // including the profile active-zone switcher. The read-only viewer resolves it by id
    // separately, so hiding it here never blocks the transparency view.
    select: (zones) => zones.filter((zone) => !isSystemZone(zone)),
  });
}

// Zone create/update/delete change the zone inventory the diagnostics report walks, so
// refresh both the zones list and the diagnostics report rather than leaving Diagnostics
// showing a stale "no zones are visible" warning until the next poll.
function invalidateZonesAndDiagnostics(qc: ReturnType<typeof useQueryClient>): void {
  qc.invalidateQueries({ queryKey: keys.zones });
  qc.invalidateQueries({ queryKey: keys.diagnostics });
}

export function useCreateZone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ZoneInput) => consoleApi.zones.create(input),
    onSuccess: (zone) => {
      invalidateZonesAndDiagnostics(qc);
      if (!getActiveZoneId()) selectZone(zone.id);
    },
  });
}

export function useUpdateZone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ZonePatchInput }) =>
      consoleApi.zones.patch(id, input),
    onSuccess: () => invalidateZonesAndDiagnostics(qc),
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
    onSettled: () => invalidateZonesAndDiagnostics(qc),
  });
}

export function useApplications(zoneId: string | null, status: "active" | "archived" = "active") {
  return useQuery({
    queryKey: [...keys.applications(zoneId), status],
    queryFn: ({ signal }) => consoleApi.applications.list(zoneId as string, signal, status),
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

export function useRotateApplicationSecret(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => consoleApi.applications.rotateSecret(zoneId as string, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.applications(zoneId) }),
  });
}

// A reveal is a mutation, not a query: every call is an audited credential access
// that must reach the server, never a cached read.
export function useRevealApplicationSecret(zoneId: string | null) {
  return useMutation({
    mutationFn: (id: string) => consoleApi.applications.revealSecret(zoneId as string, id),
  });
}

export function useWorkloads(zoneId: string | null) {
  return useQuery({
    queryKey: keys.workloads(zoneId),
    queryFn: ({ signal }) => consoleApi.workloads.list(zoneId as string, signal),
    enabled: Boolean(zoneId),
  });
}

export function useCreateWorkload(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string }) => consoleApi.workloads.create(zoneId as string, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.workloads(zoneId) }),
  });
}

export function useUpdateWorkload(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: WorkloadUpdateInput }) =>
      consoleApi.workloads.update(zoneId as string, id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.workloads(zoneId) }),
  });
}

export function useRotateWorkloadSecret(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => consoleApi.workloads.rotateSecret(zoneId as string, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.workloads(zoneId) }),
  });
}

// A reveal is a mutation, not a query: every call is an audited credential access
// that must reach the server, never a cached read.
export function useRevealWorkloadSecret(zoneId: string | null) {
  return useMutation({
    mutationFn: (id: string) => consoleApi.workloads.revealSecret(zoneId as string, id),
  });
}

export function useDeleteWorkload(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => consoleApi.workloads.delete(zoneId as string, id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: keys.workloads(zoneId) });
      const previous = qc.getQueryData<Workload[]>(keys.workloads(zoneId));
      qc.setQueryData<Workload[]>(keys.workloads(zoneId), (old) =>
        old?.filter((workload) => workload.id !== id),
      );
      return { previous };
    },
    onError: (_error, _id, context) => {
      if (context?.previous) qc.setQueryData(keys.workloads(zoneId), context.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.workloads(zoneId) }),
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

export function useResources(zoneId: string | null, status: "active" | "archived" = "active") {
  return useQuery({
    queryKey: [...keys.resources(zoneId), status],
    queryFn: ({ signal }) => consoleApi.resources.list(zoneId as string, signal, status),
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

// Side-effect-free upstream verification probe for a Caracal-mandate-backed resource. The
// outcome is not persisted on the resource row, so no query needs invalidating.
export function useTestResource(zoneId: string | null) {
  return useMutation({
    mutationFn: (id: string) => consoleApi.resources.test(zoneId as string, id),
  });
}

export function useProviders(zoneId: string | null, status: "active" | "archived" = "active") {
  return useQuery({
    queryKey: [...keys.providers(zoneId), status],
    queryFn: ({ signal }) => consoleApi.providers.list(zoneId as string, signal, status),
    enabled: Boolean(zoneId),
  });
}

// Providers supply the credential routing that resources bind to, so any provider mutation
// must also refresh the resources view to avoid showing a stale binding state.
function invalidateProviderAndBindings(
  qc: ReturnType<typeof useQueryClient>,
  zoneId: string | null,
): void {
  qc.invalidateQueries({ queryKey: keys.providers(zoneId) });
  qc.invalidateQueries({ queryKey: keys.resources(zoneId) });
}

export function useCreateProvider(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ProviderInput) => consoleApi.providers.create(zoneId as string, input),
    onSuccess: () => invalidateProviderAndBindings(qc, zoneId),
  });
}

export function useUpdateProvider(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ProviderPatchInput }) =>
      consoleApi.providers.patch(zoneId as string, id, input),
    onSuccess: () => invalidateProviderAndBindings(qc, zoneId),
  });
}

export function useTestProvider(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => consoleApi.providers.test(zoneId as string, id),
    // The check outcome is persisted on the provider row, so refresh it to keep the
    // failed badge in step with the server.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.providers(zoneId) });
    },
  });
}

export function useDiscoverProvider(zoneId: string | null) {
  return useMutation({
    mutationFn: (issuer: string) => consoleApi.providers.discover(zoneId as string, issuer),
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
    // A provider change alters credential routing for every bound resource, so refresh the
    // resources view too instead of leaving it showing a stale binding.
    onSettled: () => invalidateProviderAndBindings(qc, zoneId),
  });
}

export function usePolicies(zoneId: string | null) {
  return useQuery({
    queryKey: keys.policies(zoneId),
    queryFn: ({ signal }) => consoleApi.policies.list(zoneId as string, signal),
    enabled: Boolean(zoneId),
  });
}

export function usePolicySets(zoneId: string | null) {
  return useQuery({
    queryKey: keys.policySets(zoneId),
    queryFn: ({ signal }) => consoleApi.policySets.list(zoneId as string, signal),
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

export function usePolicySetVersions(zoneId: string | null, id: string | null) {
  return useQuery({
    queryKey: ["console", "policy-set-versions", zoneId, id],
    queryFn: ({ signal }) =>
      consoleApi.policySets.listVersions(zoneId as string, id as string, signal),
    enabled: Boolean(zoneId && id),
  });
}

function invalidatePolicies(qc: ReturnType<typeof useQueryClient>, zoneId: string | null) {
  qc.invalidateQueries({ queryKey: keys.policies(zoneId) });
}

function invalidatePolicySets(qc: ReturnType<typeof useQueryClient>, zoneId: string | null) {
  qc.invalidateQueries({ queryKey: keys.policySets(zoneId) });
  qc.invalidateQueries({ queryKey: ["console", "policy-set", zoneId] });
  qc.invalidateQueries({ queryKey: ["console", "policy-set-versions", zoneId] });
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
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: keys.policies(zoneId) });
      const previous = qc.getQueryData<Policy[]>(keys.policies(zoneId));
      qc.setQueryData<Policy[]>(keys.policies(zoneId), (old) =>
        old?.filter((policy) => policy.id !== id),
      );
      return { previous };
    },
    onError: (_error, _id, context) => {
      if (context?.previous) qc.setQueryData(keys.policies(zoneId), context.previous);
    },
    onSettled: () => invalidatePolicies(qc, zoneId),
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
    mutationFn: ({ id, versionId }: { id: string; versionId: string }) =>
      consoleApi.policySets.activate(zoneId as string, id, versionId),
    onSuccess: () => invalidatePolicySets(qc, zoneId),
  });
}

export function useDeletePolicySet(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => consoleApi.policySets.delete(zoneId as string, id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: keys.policySets(zoneId) });
      const previous = qc.getQueryData<PolicySet[]>(keys.policySets(zoneId));
      qc.setQueryData<PolicySet[]>(keys.policySets(zoneId), (old) =>
        old?.filter((set) => set.id !== id),
      );
      return { previous };
    },
    onError: (_error, _id, context) => {
      if (context?.previous) qc.setQueryData(keys.policySets(zoneId), context.previous);
    },
    onSettled: () => invalidatePolicySets(qc, zoneId),
  });
}

// Aggregated dashboard read model: one request carries every count and the recent
// activity page, so the dashboard never fans out into per-entity list queries.
export function useZoneOverview(zoneId: string | null) {
  return useQuery({
    queryKey: keys.overview(zoneId),
    queryFn: ({ signal }) => consoleApi.zones.overview(zoneId as string, signal),
    enabled: Boolean(zoneId),
    refetchInterval: LIVE_MS,
  });
}

// Filtered, cursor-paginated session feed for the Sessions workspace. Server-side
// filters keep enterprise-scale zones searchable instead of scanning the first page.
export function useAuthorityRecordsFeed(zoneId: string | null, query: AuthorityRecordQuery) {
  return useInfiniteQuery({
    queryKey: [...keys.authorityRecords(zoneId), "feed", query],
    queryFn: ({ pageParam }) =>
      consoleApi.authorityRecords.list(zoneId as string, {
        ...query,
        cursor: pageParam ?? undefined,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(zoneId),
    refetchInterval: LIVE_MS,
  });
}

// One aggregate row per subject: the identities work is done for, ranked by most
// recent authority, with server-side kind and search filters.
export function useSubjectsFeed(zoneId: string | null, query: SubjectQuery) {
  return useInfiniteQuery({
    queryKey: [...keys.subjects(zoneId), "feed", query],
    queryFn: ({ pageParam }) =>
      consoleApi.subjects.list(zoneId as string, { ...query, cursor: pageParam ?? undefined }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(zoneId),
    refetchInterval: LIVE_MS,
  });
}

// The investigation bundle for one subject: identity provenance, governed sessions,
// approvals raised under it, and upstream connections, in one request.
export function useSubjectOverview(zoneId: string | null, subjectId: string | null) {
  return useQuery({
    queryKey: [...keys.subjects(zoneId), "overview", subjectId],
    queryFn: () => consoleApi.subjects.overview(zoneId as string, subjectId as string),
    enabled: Boolean(zoneId && subjectId),
    refetchInterval: LIVE_MS,
  });
}

// The subject kill switch: cuts every authority path the subject holds. The
// cascade touches sessions, governed sessions, delegations, and connections,
// so every subject- and session-scoped read refreshes on success.
export function useRevokeSubject(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { subjectId: string; reason?: string }) =>
      consoleApi.subjects.revoke(zoneId as string, input.subjectId, input.reason),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.subjects(zoneId) });
      qc.invalidateQueries({ queryKey: keys.authorityRecords(zoneId) });
      qc.invalidateQueries({ queryKey: keys.sessions(zoneId) });
      qc.invalidateQueries({ queryKey: keys.delegationsActive(zoneId) });
    },
  });
}

// Resolves one authority record to its subject so a link that only knows the record
// id can land on the owning subject.
export function useAuthorityRecord(zoneId: string | null, recordId: string | null) {
  return useQuery({
    queryKey: [...keys.authorityRecords(zoneId), "record", recordId],
    queryFn: async () => {
      const page = await consoleApi.authorityRecords.list(zoneId as string, {
        id: recordId as string,
        limit: 1,
      });
      return page.rows[0] ?? null;
    },
    enabled: Boolean(zoneId && recordId),
  });
}

// Cursor-paginated feed of human-approval holds. Live polling keeps pending holds visible
// the moment a Session parks on one, since approval latency is the whole user experience.
// State filtering happens server-side so a filtered page is a true page, not a sieve over
// whatever happened to be in the first hundred rows.
export function useApprovalsFeed(zoneId: string | null, query: ApprovalQuery = {}) {
  return useInfiniteQuery({
    queryKey: [...keys.approvals(zoneId), "feed", query.state ?? "all"],
    queryFn: ({ pageParam }) =>
      consoleApi.approvals.list(zoneId as string, { ...query, cursor: pageParam ?? undefined }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(zoneId),
    refetchInterval: LIVE_MS,
  });
}

// One cheap aggregate that powers every pending-approval indicator: the sidebar badge,
// the dashboard summary, and the workspace filter counts all read the same numbers.
export function useApprovalCounts(zoneId: string | null) {
  return useQuery({
    queryKey: keys.approvalCounts(zoneId),
    queryFn: ({ signal }) => consoleApi.approvals.counts(zoneId as string, signal),
    enabled: Boolean(zoneId),
    refetchInterval: LIVE_MS,
  });
}

// Decides one live hold on the operator plane. The control plane enforces every guard
// (liveness, approver class, single decision), so this only carries the verdict across.
export function useDecideApproval(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; decision: "approve" | "reject"; reason?: string }) =>
      input.decision === "approve"
        ? consoleApi.approvals.approve(zoneId as string, input.id, input.reason)
        : consoleApi.approvals.reject(zoneId as string, input.id, input.reason),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.approvals(zoneId) });
      qc.invalidateQueries({ queryKey: keys.approvalCounts(zoneId) });
    },
  });
}

export function useNotificationSinks(zoneId: string | null) {
  return useQuery({
    queryKey: keys.notificationSinks(zoneId),
    queryFn: () => consoleApi.notificationSinks.list(zoneId as string),
    enabled: Boolean(zoneId),
    refetchInterval: LIVE_MS,
  });
}

export function useSinkDeliveries(zoneId: string | null, sinkId: string | null) {
  return useQuery({
    queryKey: keys.sinkDeliveries(zoneId, sinkId),
    queryFn: () => consoleApi.notificationSinks.deliveries(zoneId as string, sinkId as string),
    enabled: Boolean(zoneId) && Boolean(sinkId),
    refetchInterval: LIVE_MS,
  });
}

export function useCreateNotificationSink(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: NotificationSinkInput) =>
      consoleApi.notificationSinks.create(zoneId as string, input),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.notificationSinks(zoneId) });
    },
  });
}

export function useUpdateNotificationSink(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; patch: Partial<NotificationSinkInput> }) =>
      consoleApi.notificationSinks.update(zoneId as string, input.id, input.patch),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.notificationSinks(zoneId) });
    },
  });
}

export function useRotateSinkSecret(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => consoleApi.notificationSinks.rotateSecret(zoneId as string, id),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.notificationSinks(zoneId) });
    },
  });
}

export function useDeleteNotificationSink(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => consoleApi.notificationSinks.remove(zoneId as string, id),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.notificationSinks(zoneId) });
    },
  });
}

// Filtered, cursor-paginated audit feed for the Audit workspace. Polling always stays
// on so the tamper-evident stream can never be silently frozen in the console.
export function useAuditFeed(zoneId: string | null, query: AuditQuery) {
  return useInfiniteQuery({
    queryKey: [...keys.audit(zoneId), "feed", query],
    queryFn: ({ pageParam }) =>
      consoleApi.audit.list(zoneId as string, { ...query, cursor: pageParam ?? undefined }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(zoneId),
    refetchInterval: LIVE_MS,
  });
}

// Cursor-paginated admin audit feed: the tamper-evident record of every admin
// mutation (who changed what), with server-side filters for actor/entity/method.
export function useAdminAuditFeed(zoneId: string | null, query: AdminAuditQuery) {
  return useInfiniteQuery({
    queryKey: [...keys.adminAudit(zoneId), "feed", query],
    queryFn: ({ pageParam }) =>
      consoleApi.adminAudit.list(zoneId as string, { ...query, cursor: pageParam ?? undefined }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(zoneId),
    refetchInterval: LIVE_MS,
  });
}

// Platform-wide audit retention window: how many days of audit events are kept
// before the audit service drops the partitions holding them.
export function useAuditRetention() {
  return useQuery({
    queryKey: keys.auditRetention,
    queryFn: ({ signal }) => consoleApi.auditRetention.get(signal),
  });
}

export function useUpdateAuditRetention() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (days: number) => consoleApi.auditRetention.update(days),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.auditRetention });
    },
  });
}

// Platform-wide STS mint rate working limit: how many mandate mints per minute
// each zone, resource, and acting application combination is allowed before the
// STS denies with rate_limited.
export function useMintRateLimit() {
  return useQuery({
    queryKey: keys.mintRateLimit,
    queryFn: ({ signal }) => consoleApi.mintRateLimit.get(signal),
  });
}

export function useUpdateMintRateLimit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (limitPerMinute: number) => consoleApi.mintRateLimit.update(limitPerMinute),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.mintRateLimit });
    },
  });
}

export function useDecisionTrace(zoneId: string | null, requestId: string | null) {
  return useQuery({
    queryKey: keys.auditExplain(zoneId, requestId),
    queryFn: () => consoleApi.audit.explain(zoneId as string, requestId as string),
    enabled: Boolean(zoneId && requestId),
  });
}

// Cursor-paginated Session feed with server-side filters, so large zones stay searchable.
export function useSessionsFeed(zoneId: string | null, query: SessionQuery, enabled = true) {
  return useInfiniteQuery({
    queryKey: [...keys.sessions(zoneId), "feed", query],
    queryFn: ({ pageParam }) =>
      consoleApi.sessions.list(zoneId as string, { ...query, cursor: pageParam ?? undefined }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(zoneId) && enabled,
    refetchInterval: LIVE_MS,
  });
}

export function useSession(zoneId: string | null, id: string | null) {
  return useQuery({
    queryKey: keys.session(zoneId, id),
    queryFn: () => consoleApi.sessions.get(zoneId as string, id as string),
    enabled: Boolean(zoneId && id),
  });
}

export function useSessionEffectiveAuthority(zoneId: string | null, id: string | null) {
  return useQuery({
    queryKey: [...keys.session(zoneId, id), "authority"],
    queryFn: () => consoleApi.sessions.effectiveAuthority(zoneId as string, id as string),
    enabled: Boolean(zoneId && id),
  });
}

export function useSessionChildren(zoneId: string | null, id: string | null) {
  return useQuery({
    queryKey: [...keys.session(zoneId, id), "children"],
    queryFn: () => consoleApi.sessions.children(zoneId as string, id as string),
    enabled: Boolean(zoneId && id),
  });
}

// Per-session delegations. Delegations connect sessions, so inbound/outbound
// delegation views are keyed by agent_session_id.
export function useSessionInboundDelegations(zoneId: string | null, sessionId: string | null) {
  return useQuery({
    queryKey: ["console", "delegations-inbound", zoneId, sessionId],
    queryFn: () => consoleApi.delegations.inbound(zoneId as string, sessionId as string),
    enabled: Boolean(zoneId && sessionId),
  });
}

export function useSessionOutboundDelegations(zoneId: string | null, sessionId: string | null) {
  return useQuery({
    queryKey: ["console", "delegations-outbound", zoneId, sessionId],
    queryFn: () => consoleApi.delegations.outbound(zoneId as string, sessionId as string),
    enabled: Boolean(zoneId && sessionId),
  });
}

// Read-only execution visibility: invocations targeting or originating from this Session, and
// the registered services in the zone. Mutations remain runtime-identity gated.
export function useSessionInvocations(zoneId: string | null, sessionId: string | null) {
  return useQuery({
    queryKey: ["console", "invocations", zoneId, sessionId],
    queryFn: () =>
      consoleApi.execution.invocations(zoneId as string, {
        session_id: sessionId as string,
        limit: 50,
      }),
    enabled: Boolean(zoneId && sessionId),
    refetchInterval: LIVE_MS,
  });
}

export function useSessionServices(zoneId: string | null, application_id: string | null) {
  return useQuery({
    queryKey: ["console", "session-services", zoneId, application_id],
    queryFn: async () => {
      const services = await consoleApi.execution.services(zoneId as string);
      return application_id
        ? services.filter((s) => s.application_id === application_id)
        : services;
    },
    enabled: Boolean(zoneId && application_id),
  });
}

// Per-Session activity timeline: the durable audit events (token exchanges, resource calls,
// denials) recorded for this session, newest first. This is the authoritative record
// of what the Session actually did, correlated by the wire `agent_session_id` field.
export function useSessionActivity(zoneId: string | null, sessionId: string | null) {
  return useQuery({
    queryKey: ["console", "session-activity", zoneId, sessionId],
    queryFn: () =>
      consoleApi.audit.list(zoneId as string, {
        agent_session_id: sessionId as string,
        limit: 50,
      }),
    enabled: Boolean(zoneId && sessionId),
    refetchInterval: LIVE_MS,
  });
}

export function useAuthorityRecordActivity(zoneId: string | null, recordId: string | null) {
  return useQuery({
    queryKey: ["console", "authority-record-activity", zoneId, recordId],
    queryFn: () =>
      consoleApi.audit.list(zoneId as string, {
        session_id: recordId as string,
        limit: 50,
      }),
    enabled: Boolean(zoneId && recordId),
    refetchInterval: LIVE_MS,
  });
}

export function useSessionLifecycle(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      action,
    }: {
      id: string;
      action: "suspend" | "resume" | "terminate";
    }) => {
      if (action === "suspend") await consoleApi.sessions.suspend(zoneId as string, id);
      else if (action === "resume") await consoleApi.sessions.resume(zoneId as string, id);
      else await consoleApi.sessions.terminate(zoneId as string, id);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.sessions(zoneId) }),
  });
}

// Cursor-paginated active delegation feed.
export function useDelegationsFeed(zoneId: string | null, enabled = true) {
  return useInfiniteQuery({
    queryKey: [...keys.delegationsActive(zoneId), "feed"],
    queryFn: ({ pageParam }) =>
      consoleApi.delegations.active(zoneId as string, { cursor: pageParam ?? undefined }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(zoneId) && enabled,
    refetchInterval: LIVE_MS,
  });
}

export function useRevokeDelegation(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => consoleApi.delegations.revoke(zoneId as string, id),
    onSuccess: () => {
      // Revocation cascades downstream, so refresh the active feed plus every per-session
      // inbound/outbound list and Session authority envelope that may be stale.
      qc.invalidateQueries({ queryKey: keys.delegationsActive(zoneId) });
      qc.invalidateQueries({
        predicate: (q) => {
          const k = q.queryKey;
          if (!Array.isArray(k) || k[0] !== "console" || k[2] !== zoneId) return false;
          return (
            k[1] === "delegations-inbound" ||
            k[1] === "delegations-outbound" ||
            k[1] === "session" ||
            k[1] === "sessions"
          );
        },
      });
    },
  });
}

/* --------------------------- Provider connections --------------------------- */

export function useProviderConnections(zoneId: string | null, providerId: string | null) {
  return useQuery({
    queryKey: ["console", "provider-connections", zoneId, providerId],
    queryFn: () =>
      consoleApi.providerConnections.list(zoneId as string, { provider_id: providerId as string }),
    enabled: Boolean(zoneId && providerId),
  });
}

export function useAuthorizeProviderConnection(zoneId: string | null) {
  return useMutation({
    mutationFn: (input: ProviderConnectionAuthorizeInput) =>
      consoleApi.providerConnections.authorize(zoneId as string, input),
  });
}

export function useRevokeProviderConnection(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ProviderConnectionRevokeInput) =>
      consoleApi.providerConnections.revoke(zoneId as string, input),
    onSuccess: (_data, vars) =>
      qc.invalidateQueries({
        queryKey: ["console", "provider-connections", zoneId, vars.provider_id],
      }),
  });
}

/* -------------------------------- Control API ------------------------------- */

const controlKeysKey = (zoneId: string | null) => ["console", "control-keys", zoneId] as const;

export function useControlKeys(zoneId: string | null) {
  return useQuery({
    queryKey: controlKeysKey(zoneId),
    queryFn: () => consoleApi.control.list(zoneId as string),
    enabled: Boolean(zoneId),
  });
}

export function useCreateControlKey(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ControlKeyCreateInput) =>
      consoleApi.control.create(zoneId as string, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: controlKeysKey(zoneId) });
      qc.invalidateQueries({ queryKey: keys.applications(zoneId) });
    },
  });
}

export function useRotateControlKey(zoneId: string | null) {
  return useMutation({
    mutationFn: (id: string) => consoleApi.control.rotate(zoneId as string, id),
  });
}

export function useRevokeControlKey(zoneId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => consoleApi.control.revoke(zoneId as string, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: controlKeysKey(zoneId) });
      qc.invalidateQueries({ queryKey: keys.applications(zoneId) });
    },
  });
}

const controlStatusKey = ["console", "control-status"] as const;

export function useControlStatus() {
  return useQuery({
    queryKey: controlStatusKey,
    queryFn: () => consoleApi.control.status(),
  });
}

export function useEnableControl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => consoleApi.control.enable(),
    onSuccess: () => qc.invalidateQueries({ queryKey: controlStatusKey }),
  });
}

export function useDisableControl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => consoleApi.control.disable(),
    onSuccess: () => qc.invalidateQueries({ queryKey: controlStatusKey }),
  });
}

export function useIssueControlToken(zoneId: string | null) {
  return useMutation({
    mutationFn: (input: ControlTokenInput) =>
      consoleApi.control.issueToken(zoneId as string, input),
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

// Whether this tab is the read-only system-zone viewer. Stable for the tab's lifetime, so the
// shell can render the whole Console read-only and pin the active zone to the system zone.
export function useSystemZoneView(): boolean {
  return useState(isSystemZoneViewTab)[0];
}

// Leaves the read-only system-zone viewer and lands on the given Console path as a normal tab.
// The viewer flag is latched per tab and read once on mount, so clearing it is paired with a
// full navigation: the destination loads without the flag and resolves to the normal Console,
// where the operator can pick and manage their own zones again.
export function exitSystemZoneView(to: string): void {
  if (typeof window === "undefined") return;
  clearSystemZoneViewLatch();
  window.location.assign(to);
}

const noopSelectZone = (): void => {};

// The id of the reserved system zone, resolved from the Operator status probe. Static per
// deployment, so it is held for the session. Used both by the Settings button that opens the
// viewer and, in a viewer tab, to resolve the zone the read-only Console is scoped to.
export function useSystemZoneId() {
  return useQuery({
    queryKey: [...keys.operatorStatus, "system-zone-id"] as const,
    queryFn: ({ signal }) => consoleApi.operator.systemZoneId(signal),
    staleTime: Infinity,
  });
}

function useSystemZone(enabled: boolean) {
  return useQuery({
    queryKey: ["console", "system-zone"] as const,
    enabled,
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const id = await consoleApi.operator.systemZoneId(signal);
      if (!id) return null;
      return consoleApi.zones.get(id, signal);
    },
  });
}

// The release version of the web binary serving this console, reported by the
// backend-for-frontend. Static per deployment, so it is held for the session.
export function useConsoleVersion() {
  return useQuery({
    queryKey: ["console", "version"] as const,
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const response = await fetch(`${config.authBaseUrl}/version`, { signal });
      if (!response.ok) return null;
      const body = (await response.json()) as { version?: unknown };
      return typeof body.version === "string" ? body.version : null;
    },
  });
}

// Resolves the persisted active zone against the live zone list, falling back to
// the first available zone so screens always have a coherent zone context. In a read-only
// system-zone viewer tab the active zone is instead pinned to the reserved system zone,
// resolved by id (it is excluded from the normal zone list), and zone switching is disabled.
export function useActiveZone(): {
  zones: Zone[];
  activeZone: Zone | null;
  selectZone: (id: string) => void;
} {
  const systemView = useState(isSystemZoneViewTab)[0];
  const zonesQuery = useZones();
  const persistedId = useSyncExternalStore(subscribeZone, getActiveZoneId, () => null);
  const systemZoneQuery = useSystemZone(systemView);

  if (systemView) {
    const zone = systemZoneQuery.data ?? null;
    return { zones: zone ? [zone] : [], activeZone: zone, selectZone: noopSelectZone };
  }

  const zones = zonesQuery.data ?? [];
  const activeZone = zones.find((zone) => zone.id === persistedId) ?? zones[0] ?? null;
  return { zones, activeZone, selectZone };
}
