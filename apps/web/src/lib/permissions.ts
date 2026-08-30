// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import type { Permission } from "./types";

type PermissionScope = {
	permissions?: readonly Permission[] | readonly string[] | null;
	role?: string | null;
};

export const PERMISSIONS = {
	orgView: "org.view",
	orgUpdate: "org.update",
	orgDelete: "org.delete",
	orgOwnershipTransfer: "org.ownership.transfer",
	orgMembersManage: "org.members.manage",
	orgProjectsManage: "org.projects.manage",
	orgAuditRead: "org.audit.read",
	orgSecurityRead: "org.security.read",
	projectView: "project.view",
	projectUpdate: "project.update",
	projectDelete: "project.delete",
	projectMembersManage: "project.members.manage",
	projectResourcesRead: "project.resources.read",
	projectResourcesWrite: "project.resources.write",
	projectAuditRead: "project.audit.read",
	projectSecurityRead: "project.security.read",
} as const satisfies Record<string, Permission>;

export function hasPermission(
	scope: PermissionScope | null | undefined,
	permission: Permission,
) {
	const permissions = scope?.permissions ?? legacyOrgPermissions(scope?.role);
	return permissions?.includes(permission) ?? false;
}

export function hasAnyPermission(
	scope: PermissionScope | null | undefined,
	permissions: readonly Permission[],
) {
	return permissions.some((permission) => hasPermission(scope, permission));
}

export function canManageOrganization(
	org: PermissionScope | null | undefined,
) {
	return hasAnyPermission(org, [
		PERMISSIONS.orgUpdate,
		PERMISSIONS.orgMembersManage,
		PERMISSIONS.orgProjectsManage,
	]);
}

function legacyOrgPermissions(role?: string | null): readonly Permission[] | undefined {
	switch (role) {
		case "owner":
			return [
				PERMISSIONS.orgView,
				PERMISSIONS.orgUpdate,
				PERMISSIONS.orgDelete,
				PERMISSIONS.orgOwnershipTransfer,
				PERMISSIONS.orgMembersManage,
				PERMISSIONS.orgProjectsManage,
			];
		case "admin":
			return [
				PERMISSIONS.orgView,
				PERMISSIONS.orgUpdate,
				PERMISSIONS.orgMembersManage,
				PERMISSIONS.orgProjectsManage,
			];
		case "member":
			return [PERMISSIONS.orgView];
		default:
			return undefined;
	}
}
