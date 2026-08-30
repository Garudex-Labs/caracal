// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0


import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import {
  registry,
  projectResources,
  type ProjectResourcesQuery,
  type RegistryType,
} from "@/lib/api";
import { useCurrentOrg } from "@/hooks/use-current-org";
import { useCurrentProject } from "@/hooks/use-current-project";

// ── Component Draft/Submit (generic) ──────────────────────────────

/** One visibility-filtered, server-paginated listing across agents and every component type. */
export function useProjectResources(
  params?: ProjectResourcesQuery,
  options: { enabled?: boolean } = {},
) {
  const { currentOrg } = useCurrentOrg();
  const { currentProject } = useCurrentProject();
  return useQuery({
    queryKey: ["resources", currentOrg?.slug, currentProject?.slug, params ?? {}],
    queryFn: () => projectResources.list(params),
    enabled: options.enabled !== false && !!currentOrg && !!currentProject,
  });
}

export function useComponentSubmit(type: RegistryType) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: unknown) => registry.submit(type, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["registry", type] });
      qc.invalidateQueries({ queryKey: ["review"] });
      toast.success("Submitted for review");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to submit");
    },
  });
}

export function useComponentSaveDraft(type: RegistryType) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: unknown) => registry.draft(body, type),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["registry", type] });
      toast.success("Draft saved");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to save draft");
    },
  });
}

export function useComponentUpdateDraft(type: RegistryType) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; body: unknown }) =>
      registry.updateDraft(vars.id, vars.body, type),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["registry", type] });
      toast.success("Draft updated");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to update draft");
    },
  });
}

export function useComponentSubmitDraft(type: RegistryType) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => registry.submitDraft(id, type),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["registry", type] });
      qc.invalidateQueries({ queryKey: ["review"] });
      toast.success("Submitted for review");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to submit");
    },
  });
}

export function useStartEdit(type: RegistryType) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => registry.startEdit(id, type),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["review"] });
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to start editing");
    },
  });
}

export function useCancelEdit(type: RegistryType) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => registry.cancelEdit(id, type),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["review"] });
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to cancel editing");
    },
  });
}

export function useComponentArchive(type: RegistryType) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => registry.archiveComponent(type, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["registry", type] });
      toast.success("Component archived");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to archive component");
    },
  });
}

export function useComponentUnarchive(type: RegistryType) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => registry.unarchiveComponent(type, id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["registry", type] });
      toast.success("Component restored");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to restore component");
    },
  });
}

// ── Component Versions ─────────────────────────────────────────────

export function useComponentVersions(type: RegistryType | undefined, listingId: string | undefined) {
  return useQuery({
    queryKey: ["component-versions", type, listingId],
    enabled: !!type && !!listingId,
    queryFn: () => registry.listComponentVersions(type!, listingId!),
  });
}

export function useComponentVersionDetail(type: RegistryType | undefined, listingId: string | undefined, version: string | null) {
  return useQuery({
    queryKey: ["component-version-detail", type, listingId, version],
    enabled: !!type && !!listingId && !!version,
    queryFn: () => registry.getComponentVersion(type!, listingId!, version!),
  });
}

export function usePublishComponentVersion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ type, listingId, body }: { type: RegistryType; listingId: string; body: unknown }) =>
      registry.publishComponentVersion(type, listingId, body),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["component-versions", variables.type, variables.listingId] });
      qc.invalidateQueries({ queryKey: ["registry", variables.type, variables.listingId] });
      toast.success("Version published successfully");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to publish version");
    },
  });
}

export function useComponentVersionSuggestions(type: RegistryType | undefined, listingId: string | undefined) {
  return useQuery({
    queryKey: ["component-version-suggestions", type, listingId],
    enabled: !!type && !!listingId,
    queryFn: () => registry.componentVersionSuggestions(type!, listingId!),
  });
}

// ── Resource lifecycle: derived history, attribution, controlled rollback ──

export function useResourceActivity(subjectId: string | undefined, limit = 100) {
  return useQuery({
    queryKey: ["resource-activity", subjectId, limit],
    enabled: !!subjectId,
    queryFn: () => registry.resourceActivity(subjectId!, limit),
  });
}

export function useResourceContributors(subjectId: string | undefined) {
  return useQuery({
    queryKey: ["resource-contributors", subjectId],
    enabled: !!subjectId,
    queryFn: () => registry.resourceContributors(subjectId!),
  });
}

function invalidateResourceLifecycle(qc: ReturnType<typeof useQueryClient>, subjectId: string) {
  qc.invalidateQueries({ queryKey: ["resource-activity", subjectId] });
  qc.invalidateQueries({ queryKey: ["resource-contributors", subjectId] });
  qc.invalidateQueries({ queryKey: ["review"] });
}

export function useRestoreAgentVersion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, version, reason }: { agentId: string; version: string; reason?: string }) =>
      registry.restoreAgentVersion(agentId, version, reason),
    onSuccess: (data, variables) => {
      qc.invalidateQueries({ queryKey: ["agent-versions", variables.agentId] });
      qc.invalidateQueries({ queryKey: ["registry", "agents", variables.agentId] });
      invalidateResourceLifecycle(qc, variables.agentId);
      toast.success(`v${data.version} proposed from v${variables.version} - pending review`);
    },
    onError: (err: Error) => toast.error(err.message || "Failed to restore version"),
  });
}

export function useRestoreComponentVersion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      type,
      listingId,
      version,
      reason,
    }: {
      type: RegistryType;
      listingId: string;
      version: string;
      reason?: string;
    }) => registry.restoreComponentVersion(type, listingId, version, reason),
    onSuccess: (data, variables) => {
      qc.invalidateQueries({ queryKey: ["component-versions", variables.type, variables.listingId] });
      qc.invalidateQueries({ queryKey: ["registry", variables.type, variables.listingId] });
      invalidateResourceLifecycle(qc, variables.listingId);
      toast.success(`v${data.version} proposed from v${variables.version} - pending review`);
    },
    onError: (err: Error) => toast.error(err.message || "Failed to restore version"),
  });
}
