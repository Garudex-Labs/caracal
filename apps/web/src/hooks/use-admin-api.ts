// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0


import { useCallback, useEffect, useRef, useState } from "react";
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import {
  auth,
  admin,
  config,
  operator,
  telemetry,
  getUserRole,
} from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { hasMinRole } from "@/hooks/use-role-guard";

// ── Auth ────────────────────────────────────────────────────────────

export function useWhoami() {
  return useQuery({
    queryKey: ["auth", "whoami"],
    queryFn: () => auth.whoami(),
    retry: false,
  });
}

// ── Admin ───────────────────────────────────────────────────────────

export function useAdminUsers(params?: Parameters<typeof admin.users>[0]) {
  return useQuery({
    queryKey: ["admin", "users", params ?? {}],
    queryFn: () => admin.users(params),
    placeholderData: (prev) => prev,
  });
}

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    // User creation is an identity operation: it goes to Better Auth's admin
    // API (requires the caller's admin session). The registry row is
    // JIT-provisioned on the new user's first authenticated request.
    mutationFn: async (body: { email: string; name: string; password: string; role?: string }) => {
      const { data, error } = await authClient.admin.createUser({
        email: body.email,
        name: body.name,
        password: body.password,
        // The stock admin plugin types don't know the operator role set;
        // the auth server validates the value.
        role: (body.role ?? "user") as never,
      });
      if (error) throw new Error(error.message || "Failed to create user");
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      toast.success("User created");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to create user");
    },
  });
}

export function useUpdateUserRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; role: string }) =>
      admin.updateRole(vars.id, { role: vars.role }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      toast.success("Role updated");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to update role");
    },
  });
}

export function useUpdateUserDepartment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; department: string | null }) =>
      admin.updateDepartment(vars.id, { department: vars.department }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      toast.success("Department updated");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to update department");
    },
  });
}

export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => admin.deleteUser(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      toast.success("User deleted");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to delete user");
    },
  });
}

export function useAdminSettings() {
  return useQuery({ queryKey: ["admin", "settings"], queryFn: admin.settings });
}

export function useAdminSettingsSchema() {
  return useQuery({ queryKey: ["admin", "settings", "schema"], queryFn: admin.settingsSchema });
}

export function useRestartStatus() {
  return useQuery({
    queryKey: ["admin", "restart-status"],
    queryFn: admin.restartStatus,
    refetchInterval: 30_000,
  });
}

const RESTART_POLL_TIMEOUT_MS = 120_000;
const RESTART_POLL_INTERVAL_MS = 2_000;
const RESTART_POLL_INITIAL_DELAY_MS = 3_000;

export function useRestartApi(onRestarted?: () => void) {
  const [restarting, setRestarting] = useState(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const restartApi = useCallback(async () => {
    if (!confirm("Restart the API? In-flight requests will be interrupted while the process restarts.")) return;
    setRestarting(true);
    try {
      await admin.restartApi();
      toast.info("API restart initiated. Waiting for it to come back.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to trigger API restart");
      setRestarting(false);
      return;
    }

    const deadline = Date.now() + RESTART_POLL_TIMEOUT_MS;
    const poll = async () => {
      if (cancelledRef.current) return;
      if (Date.now() > deadline) {
        toast.error("API did not return within 2 minutes. Check the container logs.");
        setRestarting(false);
        return;
      }
      try {
        await config.version();
        if (cancelledRef.current) return;
        toast.success("API is back up");
        setRestarting(false);
        onRestarted?.();
      } catch {
        window.setTimeout(poll, RESTART_POLL_INTERVAL_MS);
      }
    };
    window.setTimeout(poll, RESTART_POLL_INITIAL_DELAY_MS);
  }, [onRestarted]);

  return { restarting, restartApi };
}

// ── Audit & Security ────────────────────────────────────────────────

export function useAuditLog(filters?: Record<string, string>) {
  return useQuery({
    queryKey: ["admin", "audit-log", filters],
    queryFn: () => admin.auditLog(filters),
  });
}

export function useSecurityEvents(filters?: Record<string, string>) {
  return useQuery({
    queryKey: ["admin", "security-events", filters],
    queryFn: () => admin.securityEvents(filters),
  });
}

export function useSystemStatus(options?: { refetchInterval?: number; enabled?: boolean }) {
  return useQuery({
    queryKey: ["admin", "system-status"],
    queryFn: admin.systemStatus,
    staleTime: 10_000,
    refetchInterval: options?.refetchInterval ?? 60_000,
    enabled: options?.enabled ?? true,
    refetchOnWindowFocus: "always",
  });
}

export function useSystemWarnings() {
  return useQuery({
    queryKey: ["admin", "system-warnings"],
    queryFn: admin.systemWarnings,
    refetchInterval: 60_000,
  });
}

// ── Retention ────────────────────────────────────────────────────────

export function useRetentionStats() {
  const role = getUserRole("operator");
  return useQuery({
    queryKey: ["admin", "retention", "stats"],
    queryFn: admin.getRetentionStats,
    enabled: hasMinRole(role, "operator"),
  });
}

export function useRetentionWarnings() {
  const role = getUserRole("operator");
  return useQuery({
    queryKey: ["admin", "retention", "warnings"],
    queryFn: admin.getRetentionWarnings,
    enabled: hasMinRole(role, "operator"),
  });
}

// ── Telemetry ───────────────────────────────────────────────────────

export function useTelemetryStatus() {
  return useQuery({
    queryKey: ["telemetry", "status"],
    queryFn: telemetry.status,
  });
}

// ── Migration ────────────────────────────────────────────────────────

export function useStartMigrationExport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (scope: string) => admin.migrateExport(scope),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "migration", "jobs"] });
      toast.success("Export job started");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to start export");
    },
  });
}

export function useStartMigrationImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (formData: FormData) => admin.migrateImport(formData),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "migration", "jobs"] });
      toast.success("Import job started");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to start import");
    },
  });
}

export function useStartMigrationValidate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (formData: FormData) => admin.migrateValidate(formData),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "migration", "jobs"] });
      toast.success("Validation job started");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to start validation");
    },
  });
}

export function useMigrationJob(id: string | null) {
  return useQuery({
    queryKey: ["admin", "migration", "job", id],
    queryFn: () => admin.migrateJob(id!),
    enabled: !!id,
    refetchInterval: 1500,
  });
}

export function useMigrationJobs() {
  return useQuery({
    queryKey: ["admin", "migration", "jobs"],
    queryFn: admin.migrateJobs,
  });
}

export function useMigrationDownloadToken() {
  return useMutation({
    mutationFn: (vars: { jobId: string; name: string }) =>
      admin.migrateDownloadToken(vars.jobId, vars.name),
    onError: (err: Error) => {
      toast.error(err.message || "Failed to get download token");
    },
  });
}

// ── Operator control plane ──────────────────────────────────────────

export function useOperatorOverview() {
  return useQuery({ queryKey: ["operator", "overview"], queryFn: operator.overview });
}

export function useOperatorOrgs(params?: Parameters<typeof operator.orgs>[0]) {
  return useQuery({
    queryKey: ["operator", "orgs", params ?? {}],
    queryFn: () => operator.orgs(params),
    placeholderData: (prev) => prev,
  });
}

export function useOperatorSuspendOrg() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; confirm: string }) =>
      operator.suspendOrg(vars.id, vars.confirm),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["operator"] });
      toast.success(`Organization ${data.slug} suspended`);
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to suspend organization");
    },
  });
}

export function useOperatorReinstateOrg() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; confirm: string }) =>
      operator.reinstateOrg(vars.id, vars.confirm),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["operator"] });
      toast.success(`Organization ${data.slug} reinstated`);
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to reinstate organization");
    },
  });
}

export function useOperatorDeleteOrg() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; confirm: string }) =>
      operator.deleteOrg(vars.id, vars.confirm),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["operator"] });
      toast.success("Organization deleted");
    },
    onError: (err: Error) => {
      toast.error(err.message || "Failed to delete organization");
    },
  });
}
