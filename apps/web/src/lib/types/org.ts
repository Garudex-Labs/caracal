// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// ── Organizations & projects (org/project tenancy model) ───────────

export type OrgRole = "owner" | "admin" | "member";

export type ProjectRole = "lead" | "user";

export type Permission =
	| "org.view"
	| "org.update"
	| "org.delete"
	| "org.ownership.transfer"
	| "org.members.manage"
	| "org.projects.manage"
	| "org.audit.read"
	| "org.security.read"
	| "project.view"
	| "project.update"
	| "project.delete"
	| "project.members.manage"
	| "project.resources.read"
	| "project.resources.write"
	| "project.audit.read"
	| "project.security.read";

export interface Organization {
	id: string;
	slug: string;
	name: string;
	description?: string | null;
	role?: OrgRole | null;
	permissions?: Permission[];
	member_count?: number | null;
	project_count?: number | null;
	created_at?: string | null;
	/** Present on the creation response: the org's protected default project. */
	default_project?: Project | null;
}

export interface OrgMember {
	id: string;
	email: string;
	username?: string | null;
	name?: string | null;
	role: OrgRole;
	created_at?: string | null;
	/** Explicit project memberships inside this organization (roster listing only). */
	project_count?: number | null;
}

/** Server-validated controls for the paginated roster/project listings. */
export interface OrgListParams {
	q?: string;
	role?: OrgRole;
	sort?: string;
	dir?: "asc" | "desc";
	page?: number;
	page_size?: number;
}

export interface OrgMembersPage {
	members: OrgMember[];
	total: number;
	page: number;
	page_size: number;
}

/** One project a member can access through explicit project membership. */
export interface MemberProject {
	id: string;
	slug: string;
	name: string;
	is_default: boolean;
	role: ProjectRole;
	created_at: string;
}

export interface Project {
	id: string;
	organization_id: string;
	slug: string;
	name: string;
	description?: string | null;
	is_default?: boolean;
	role?: ProjectRole | null;
	permissions?: Permission[];
	member_count?: number | null;
	created_at?: string | null;
}

export interface OrgProjectsPage {
	projects: Project[];
	total: number;
	page: number;
	page_size: number;
}

export interface ProjectMember {
	id: string;
	email: string;
	username?: string | null;
	name?: string | null;
	role: ProjectRole;
	created_at?: string | null;
}

export interface ProjectResourceItem {
	id: string;
	type: string;
	name: string;
	qualified_name: string;
	visibility: string;
}

export interface ProjectResources {
	total: number;
	items: ProjectResourceItem[];
}

export interface ResourceRetentionBounds {
	min_days: number;
	max_days: number;
}

export interface ResourceRetentionConflict {
	id: string;
	name: string;
	namespace: string;
	slug: string;
	qualified_name: string;
	visibility: "private" | "project" | string;
	deleted_at: string;
	scheduled_purge_at?: string | null;
	proposed_scheduled_purge_at: string;
	eligible_at_apply: boolean;
}

export interface ResourceRetentionPolicy {
	private_retention_days: number;
	project_retention_days: number;
	bounds: Record<"private" | "project", ResourceRetentionBounds>;
	can_update: boolean;
	requires_confirmation?: boolean;
	applied?: boolean;
	conflicts?: ResourceRetentionConflict[];
}

export interface ResourceRetentionPolicyUpdate {
	private_retention_days?: number;
	project_retention_days?: number;
	confirm?: boolean;
	confirmed_conflict_ids?: string[];
}

export interface OrgCreateBody {
	name: string;
	slug: string;
	description?: string;
}

export interface OrgMemberUpsertBody {
	user_id?: string;
	email?: string;
	username?: string;
	role: "admin" | "member";
}

export interface ProjectCreateBody {
	name: string;
	slug?: string;
	description?: string;
}

export interface ProjectMemberUpsertBody {
	user_id?: string;
	email?: string;
	username?: string;
	role: ProjectRole;
}

// ── Organization invitations ────────────────────────────────────────

export type OrgInvitationState = "pending" | "accepted" | "expired" | "revoked";

export interface OrgInvitation {
	id: string;
	org_slug: string;
	org_name: string;
	email: string;
	role: "admin" | "member";
	url?: string | null;
	invited_by?: string | null;
	created_at: string;
	expires_at: string;
	state: OrgInvitationState;
}

export interface OrgInvitationCreateBody {
	email: string;
	role: "admin" | "member";
}

// ── Onboarding (server-derived setup state) ─────────────────────────

export type OnboardingStep = "profile" | "organization" | "project" | "done";

export interface OnboardingProfile {
	completed: boolean;
	name: string;
	username: string;
	email: string;
	avatar_url?: string | null;
}

export interface OnboardingProject {
	slug: string;
	name: string;
	is_default: boolean;
	role?: ProjectRole | null;
}

export interface OnboardingOrg {
	slug: string;
	name: string;
	role: OrgRole;
	/** Projects the user can actually enter (membership or org owner/admin). */
	projects: OnboardingProject[];
}

export interface OnboardingInvitation {
	id: string;
	org_slug: string;
	org_name: string;
	role: "admin" | "member";
	expires_at: string;
}

export interface OnboardingSnapshot {
	profile: OnboardingProfile;
	organizations: OnboardingOrg[];
	invitations: OnboardingInvitation[];
	next_step: OnboardingStep;
}
