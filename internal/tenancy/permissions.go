// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package tenancy

// Permission is a stable customer-facing capability. Deployment roles such as
// operator are intentionally excluded from these org/project grants.
type Permission string

const (
	PermissionOrgView              Permission = "org.view"
	PermissionOrgUpdate            Permission = "org.update"
	PermissionOrgDelete            Permission = "org.delete"
	PermissionOrgOwnershipTransfer Permission = "org.ownership.transfer"
	PermissionOrgMembersManage     Permission = "org.members.manage"
	PermissionOrgProjectsManage    Permission = "org.projects.manage"
	PermissionOrgAuditRead         Permission = "org.audit.read"
	PermissionOrgSecurityRead      Permission = "org.security.read"

	PermissionProjectView           Permission = "project.view"
	PermissionProjectUpdate         Permission = "project.update"
	PermissionProjectDelete         Permission = "project.delete"
	PermissionProjectMembersManage  Permission = "project.members.manage"
	PermissionProjectResourcesRead  Permission = "project.resources.read"
	PermissionProjectResourcesWrite Permission = "project.resources.write"
	PermissionProjectAuditRead      Permission = "project.audit.read"
	PermissionProjectSecurityRead   Permission = "project.security.read"
)

// PermissionSet is the effective set of grants for one scope.
type PermissionSet map[Permission]struct{}

func newPermissionSet(perms ...Permission) PermissionSet {
	set := PermissionSet{}
	set.Add(perms...)
	return set
}

// Add inserts permissions into the set.
func (s PermissionSet) Add(perms ...Permission) {
	for _, perm := range perms {
		if perm != "" {
			s[perm] = struct{}{}
		}
	}
}

// Has reports whether the permission is present.
func (s PermissionSet) Has(perm Permission) bool {
	_, ok := s[perm]
	return ok
}

// Strings returns permissions in canonical order for API responses.
func (s PermissionSet) Strings() []string {
	out := []string{}
	for _, perm := range allPermissions {
		if s.Has(perm) {
			out = append(out, string(perm))
		}
	}
	return out
}

var allPermissions = []Permission{
	PermissionOrgView,
	PermissionOrgUpdate,
	PermissionOrgDelete,
	PermissionOrgOwnershipTransfer,
	PermissionOrgMembersManage,
	PermissionOrgProjectsManage,
	PermissionOrgAuditRead,
	PermissionOrgSecurityRead,
	PermissionProjectView,
	PermissionProjectUpdate,
	PermissionProjectDelete,
	PermissionProjectMembersManage,
	PermissionProjectResourcesRead,
	PermissionProjectResourcesWrite,
	PermissionProjectAuditRead,
	PermissionProjectSecurityRead,
}

var orgRolePermissions = map[string]PermissionSet{
	"owner": newPermissionSet(
		PermissionOrgView,
		PermissionOrgUpdate,
		PermissionOrgDelete,
		PermissionOrgOwnershipTransfer,
		PermissionOrgMembersManage,
		PermissionOrgProjectsManage,
		PermissionOrgAuditRead,
		PermissionOrgSecurityRead,
	),
	"admin": newPermissionSet(
		PermissionOrgView,
		PermissionOrgUpdate,
		PermissionOrgMembersManage,
		PermissionOrgProjectsManage,
		PermissionOrgAuditRead,
		PermissionOrgSecurityRead,
	),
	"member": newPermissionSet(PermissionOrgView),
}

var projectRolePermissions = map[string]PermissionSet{
	"lead": newPermissionSet(
		PermissionProjectView,
		PermissionProjectUpdate,
		PermissionProjectDelete,
		PermissionProjectMembersManage,
		PermissionProjectResourcesRead,
		PermissionProjectResourcesWrite,
		PermissionProjectAuditRead,
		PermissionProjectSecurityRead,
	),
	"user": newPermissionSet(
		PermissionProjectView,
		PermissionProjectResourcesRead,
		PermissionProjectResourcesWrite,
	),
}

var orgAdminProjectPermissions = newPermissionSet(
	PermissionProjectView,
	PermissionProjectUpdate,
	PermissionProjectDelete,
	PermissionProjectMembersManage,
	PermissionProjectResourcesRead,
	PermissionProjectResourcesWrite,
	PermissionProjectAuditRead,
	PermissionProjectSecurityRead,
)

// EffectiveOrgPermissions resolves the customer's organization capabilities for
// an organization role. Unknown deployment roles receive no customer grants.
func EffectiveOrgPermissions(orgRole string, customPerms ...Permission) PermissionSet {
	return copyWithCustom(orgRolePermissions[orgRole], customPerms...)
}

// EffectiveProjectPermissions resolves project capabilities. Organization owner
// and admin roles inherit project administration across the organization even
// when no project membership row exists.
func EffectiveProjectPermissions(orgRole, projectRole string, customPerms ...Permission) PermissionSet {
	if EffectiveOrgPermissions(orgRole).Has(PermissionOrgProjectsManage) {
		return copyWithCustom(orgAdminProjectPermissions, customPerms...)
	}
	return copyWithCustom(projectRolePermissions[projectRole], customPerms...)
}

func copyWithCustom(base PermissionSet, customPerms ...Permission) PermissionSet {
	out := PermissionSet{}
	for perm := range base {
		out.Add(perm)
	}
	out.Add(customPerms...)
	return out
}
