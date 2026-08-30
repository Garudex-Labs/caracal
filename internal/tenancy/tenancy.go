// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package tenancy resolves publish targets, namespaces, and membership
// authority for the registry and agent platforms. It is the single Go home
// of the organization/project ownership rules.
package tenancy

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// PGQuerier is the pgx surface the resolvers need; both a pool and a
// transaction satisfy it, so callers choose their own atomicity.
type PGQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// User is the authenticated principal as the tenancy rules see it.
type User struct {
	ID       uuid.UUID
	Username string
	Email    string
	Role     string
}

// DisplayHandle is the identity recorded as a personal listing's owner.
func (u User) DisplayHandle() string {
	if u.Username != "" {
		return u.Username
	}
	return u.Email
}

// Error carries the HTTP status and detail string of a tenancy rejection.
type Error struct {
	Status int
	Detail string
}

func (e *Error) Error() string { return fmt.Sprintf("%d: %s", e.Status, e.Detail) }

func reject(status int, detail string) *Error { return &Error{Status: status, Detail: detail} }

// IsOperator reports whether a deployment role can operate the instance.
func IsOperator(role string) bool { return role == "operator" }

// IsGlobalReviewer reports deployment-wide public registry review authority.
func IsGlobalReviewer(role string) bool {
	return role == "reviewer" || role == "operator"
}

// Organization and project role floors; lower rank = more authority.
var orgRoleOrder = map[string]int{"owner": 0, "admin": 1, "member": 2}

var projectRoleOrder = map[string]int{"lead": 0, "user": 1}

// HasMinOrgRole reports whether role meets the floor. Unknown/absent → false.
func HasMinOrgRole(role, minRole string) bool {
	r, ok := orgRoleOrder[role]
	m, mok := orgRoleOrder[minRole]
	return ok && mok && r <= m
}

// HasMinProjectRole reports whether role meets the floor.
func HasMinProjectRole(role, minRole string) bool {
	r, ok := projectRoleOrder[role]
	m, mok := projectRoleOrder[minRole]
	return ok && mok && r <= m
}

// IsOrgAdmin reports org-wide administrative authority (owner or admin).
func IsOrgAdmin(role string) bool {
	return EffectiveOrgPermissions(role).Has(PermissionOrgMembersManage)
}

// CanAdministerProject grants a project's leads, plus the org's owner and admins.
func CanAdministerProject(orgRole, projectRole string) bool {
	return EffectiveProjectPermissions(orgRole, projectRole).Has(PermissionProjectMembersManage)
}

// CanAccessProject grants members of the project, plus org owner/admins.
// Plain org membership is deliberately not enough - the project roster is
// the access mechanism.
func CanAccessProject(orgRole, projectRole string) bool {
	return EffectiveProjectPermissions(orgRole, projectRole).Has(PermissionProjectView)
}
