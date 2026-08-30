// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0


import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import {
  admin,
  insights,
} from "@/lib/api";

// ── AI engine models ─────────────────────────────────────────────────

export function useAiEngineModelProviders() {
  return useQuery({
    queryKey: ["ai-engine", "models", "providers"],
    queryFn: () => admin.aiEngineModelProviders(),
    staleTime: 60 * 60_000,
  });
}

export function useAiEngineModels(provider: string) {
  return useQuery({
    queryKey: ["ai-engine", "models", provider],
    queryFn: () => admin.aiEngineModels(provider),
    enabled: provider !== "",
    staleTime: 60 * 60_000,
  });
}

// ── Insights ───────────────────────────────────────────────────────

export function useInsightsStatus() {
  return useQuery({
    queryKey: ["insights", "status"],
    queryFn: () => insights.status(),
    staleTime: 0,
  });
}

export function useInsightSessionCount(agentId: string | undefined, agentVersion?: string | null) {
  return useQuery({
    queryKey: ["insights", "session-count", agentId, agentVersion],
    queryFn: () => insights.sessionCount(agentId!, agentVersion ?? undefined),
    enabled: !!agentId,
    refetchInterval: 30_000,
  });
}

export function useInsightReports(agentId: string | undefined) {
  return useQuery({
    queryKey: ["insights", "reports", agentId],
    queryFn: () => insights.listReports(agentId!),
    enabled: !!agentId,
    refetchInterval: (query) => {
      const reports = query.state.data;
      if (Array.isArray(reports) && reports.some((r: { status: string }) => r.status === "pending" || r.status === "running")) {
        return 3000;
      }
      return false;
    },
  });
}

export function useInsightReport(agentId: string, reportId: string) {
  return useQuery({
    queryKey: ["insights", "report", agentId, reportId],
    queryFn: () => insights.getReport(agentId, reportId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === "pending" || status === "running") return 3000;
      return false;
    },
  });
}

export function useGenerateInsight() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { agentId: string; periodDays?: number; agentVersion?: string; comparisonAgentVersion?: string }) =>
      insights.generate(vars.agentId, vars.periodDays, vars.agentVersion, vars.comparisonAgentVersion),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["insights", "reports", vars.agentId] });
      toast.success("Insight report queued");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to generate insight");
    },
  });
}

export function useApplyInsightSuggestions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { agentId: string; reportId: string; selection?: { config_indices?: number[]; feature_indices?: number[]; pattern_indices?: number[] } }) =>
      insights.applySuggestions(vars.agentId, vars.reportId, vars.selection),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["insights", "report", vars.agentId, vars.reportId] });
      toast.success("Suggestions applied: items added to review queue");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to apply suggestions");
    },
  });
}
