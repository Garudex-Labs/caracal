// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Organizations & projects: the tenancy hierarchy. Queries are keyed by org
// slug (and project slug) so an org switch never reuses another org's cache.

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { invitations, orgs } from "@/lib/api";
import type { OrgCreateBody, OrgInvitationCreateBody, OrgInvitationListParams, OrgListParams, OrgMemberUpsertBody, ProjectCreateBody, ProjectMemberListParams, ProjectMemberUpsertBody, ResourceRetentionPolicyUpdate } from "@/lib/types";

const ORGS_STALE_MS = 5 * 60 * 1000;

export function useOrgs() {
	return useQuery({
		queryKey: ["orgs"],
		queryFn: orgs.list,
		staleTime: ORGS_STALE_MS,
		refetchOnWindowFocus: "always",
	});
}

export function useOrg(slug?: string) {
	return useQuery({
		queryKey: ["orgs", slug],
		queryFn: () => orgs.get(slug || ""),
		enabled: !!slug,
		staleTime: ORGS_STALE_MS,
	});
}

export function useOrgMembers(slug?: string, params?: OrgListParams) {
	return useQuery({
		queryKey: ["orgs", slug, "members", params ?? {}],
		queryFn: () => orgs.members(slug || "", params),
		enabled: !!slug,
		placeholderData: keepPreviousData,
		refetchOnWindowFocus: "always",
	});
}

/** A member's explicit project access map; admin-only on the server. */
export function useMemberProjects(slug?: string, userId?: string) {
	return useQuery({
		queryKey: ["orgs", slug, "members", userId, "projects"],
		queryFn: () => orgs.memberProjects(slug || "", userId || ""),
		enabled: !!slug && !!userId,
	});
}

export function useOrgAuditLog(slug?: string, params?: Record<string, string>) {
	return useQuery({
		queryKey: ["orgs", slug, "audit-log", params ?? {}],
		queryFn: () => orgs.auditLog(slug || "", params),
		enabled: !!slug,
		placeholderData: keepPreviousData,
		refetchOnWindowFocus: "always",
	});
}

export function useOrgSecurityEvents(slug?: string, params?: Record<string, string>) {
	return useQuery({
		queryKey: ["orgs", slug, "security-events", params ?? {}],
		queryFn: () => orgs.securityEvents(slug || "", params),
		enabled: !!slug,
		placeholderData: keepPreviousData,
		refetchOnWindowFocus: "always",
	});
}

export function useOrgProjects(slug?: string, params?: OrgListParams) {
	return useQuery({
		queryKey: ["orgs", slug, "projects", params ?? {}],
		queryFn: () => orgs.projects(slug || "", params),
		enabled: !!slug,
		placeholderData: params ? keepPreviousData : undefined,
		refetchOnWindowFocus: "always",
	});
}

export function useProjectMembers(slug?: string, project?: string, params?: ProjectMemberListParams) {
	return useQuery({
		queryKey: ["orgs", slug, "projects", project, "members", params ?? {}],
		queryFn: () => orgs.projectMembers(slug || "", project || "", params),
		enabled: !!slug && !!project,
		placeholderData: params ? keepPreviousData : undefined,
		refetchOnWindowFocus: "always",
	});
}

export function useResourceRetentionPolicy(slug?: string, project?: string) {
	return useQuery({
		queryKey: ["orgs", slug, "projects", project, "retention-policy"],
		queryFn: () => orgs.resourceRetentionPolicy(slug || "", project || ""),
		enabled: !!slug && !!project,
		refetchOnWindowFocus: "always",
	});
}

export function useUpdateResourceRetentionPolicy(slug: string, project: string, preview = false) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (body: ResourceRetentionPolicyUpdate) => orgs.updateResourceRetentionPolicy(slug, project, body, preview),
		onSuccess: (data) => {
			if (!preview && data.applied) {
				qc.invalidateQueries({ queryKey: ["orgs", slug, "projects", project, "retention-policy"] });
				qc.invalidateQueries({ queryKey: ["registry", "agents", "deleted"] });
				toast.success("Retention policy updated");
			}
		},
		onError: (err: Error) => toast.error(err.message || "Failed to update retention policy"),
	});
}

export function useCreateOrg() {
	return useOrgMutation((body: OrgCreateBody) => orgs.create(body), {
		success: "Organization created",
		error: "Failed to create organization",
	});
}

export function useUpsertOrgMember(slug: string) {
	return useOrgMutation((body: OrgMemberUpsertBody) => orgs.upsertMember(slug, body), {
		success: "Member saved",
		error: "Failed to save member",
	});
}

export function useRemoveOrgMember(slug: string) {
	return useOrgMutation((userId: string) => orgs.removeMember(slug, userId), {
		success: "Member removed",
		error: "Failed to remove member",
	});
}

export function useCreateProject(slug: string) {
	return useOrgMutation((body: ProjectCreateBody) => orgs.createProject(slug, body), {
		success: "Project created",
		error: "Failed to create project",
	});
}

export function useUpdateProject(slug: string, project: string) {
	return useOrgMutation(
		(body: { name?: string; description?: string }) => orgs.updateProject(slug, project, body),
		{ success: "Project updated", error: "Failed to update project" },
	);
}

export function useDeleteProject(slug: string) {
	return useOrgMutation((projectSlug: string) => orgs.deleteProject(slug, projectSlug), {
		success: "Project deleted",
		error: "Failed to delete project",
	});
}

export function useTransferOwnership(slug: string) {
	return useOrgMutation((userId: string) => orgs.transferOwnership(slug, userId), {
		success: "Ownership transferred",
		error: "Failed to transfer ownership",
	});
}

export function useUpdateOrg(slug: string) {
	return useOrgMutation(
		(body: { name?: string; description?: string; slug?: string }) => orgs.update(slug, body),
		{ success: "Organization updated", error: "Failed to update organization" },
	);
}

export function useDeleteOrg() {
	return useOrgMutation((slug: string) => orgs.delete(slug), {
		success: "Organization deleted",
		error: "Failed to delete organization",
	});
}

export function useUpsertProjectMember(slug: string, project: string) {
	return useOrgMutation(
		(body: ProjectMemberUpsertBody) => orgs.upsertProjectMember(slug, project, body),
		{ success: "Project member saved", error: "Failed to save project member" },
	);
}

export function useRemoveProjectMember(slug: string, project: string) {
	return useOrgMutation(
		(userId: string) => orgs.removeProjectMember(slug, project, userId),
		{ success: "Project member removed", error: "Failed to remove project member" },
	);
}

// ── Organization invitations ────────────────────────────────────────

export function useOrgInvitations(slug?: string, params?: OrgInvitationListParams) {
	return useQuery({
		queryKey: ["orgs", slug, "invitations", params ?? {}],
		queryFn: () => orgs.invitations(slug || "", params),
		enabled: !!slug,
		placeholderData: params ? keepPreviousData : undefined,
		refetchOnWindowFocus: "always",
	});
}

export function useCreateOrgInvitation(slug: string) {
	return useOrgMutation(
		(body: OrgInvitationCreateBody) => orgs.createInvitation(slug, body),
		{ success: "Invitation ready", error: "Failed to create invitation" },
		["orgs", slug, "invitations"],
	);
}

export function useRevokeOrgInvitation(slug: string) {
	return useOrgMutation(
		(id: string) => orgs.revokeInvitation(slug, id),
		{ success: "Invitation revoked", error: "Failed to revoke invitation" },
		["orgs", slug, "invitations"],
	);
}

/** The caller's own pending invitations, listed by account address. */
export function useMyInvitations(enabled = true) {
	return useQuery({
		queryKey: ["invitations", "mine"],
		queryFn: invitations.mine,
		enabled,
		refetchOnWindowFocus: "always",
	});
}

export function useInvitationPreview(token?: string) {
	return useQuery({
		queryKey: ["invitations", "token", token],
		queryFn: () => invitations.previewToken(token || ""),
		enabled: !!token,
		retry: false,
	});
}

export function useAcceptInvitation() {
	return useOrgMutation(
		(args: { id: string } | { token: string }) =>
			"token" in args ? invitations.acceptToken(args.token) : invitations.accept(args.id),
		{ success: "Joined organization", error: "Failed to accept invitation" },
	);
}

/**
 * Shared toast + invalidation plumbing for org/project mutations. The default
 * invalidation is the whole ["orgs"] namespace: membership and project changes
 * ripple into counts and role fields on sibling queries.
 */
function useOrgMutation<TArgs, TData>(
	mutationFn: (args: TArgs) => Promise<TData>,
	messages: { success: string; error: string },
	invalidateKey: readonly unknown[] = ["orgs"],
) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn,
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: invalidateKey });
			// Membership and project changes move the derived onboarding state.
			qc.invalidateQueries({ queryKey: ["onboarding"] });
			qc.invalidateQueries({ queryKey: ["invitations"] });
			toast.success(messages.success);
		},
		onError: (err: Error) => toast.error(err.message || messages.error),
	});
}
