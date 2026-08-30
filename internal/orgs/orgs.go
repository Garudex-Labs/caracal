// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package orgs serves organization and project tenancy reads. Scope keys in
// the path are lookup values only; every handler resolves the caller's
// membership and fails closed with 404 for scopes the caller cannot see.
package orgs

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/garudex-labs/caracal/internal/tenancy"
)

// PGQuerier is the pgx surface the store needs.
type PGQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Setting reads one dynamic string setting with a fallback.
type Setting interface {
	String(ctx context.Context, key, fallback string) string
}

// Store answers tenancy reads.
type Store struct {
	DB PGQuerier
}

var orgSlugRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$`)

var projectSlugRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

// orgHeader is the transport scope header, matched case-insensitively.
const orgHeader = "x-caracal-org"

const projectHeader = "x-caracal-project"

// Org is one organizations row with the caller's membership role.
type Org struct {
	ID          uuid.UUID
	Slug        string
	Name        string
	Description *string
	CreatedAt   time.Time
	Role        string
}

// Project is one projects row plus the caller's project role, if any.
type Project struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	Slug           string
	Name           string
	Description    *string
	CreatedAt      time.Time
	IsDefault      bool
	Role           *string
	OrgRole        string
}

// HostOrgSlug extracts the org scope from the request host when subdomain
// routing is configured; apex and nested hosts carry no org.
func HostOrgSlug(r *http.Request, baseDomain string) string {
	baseDomain = strings.Trim(strings.ToLower(strings.TrimSpace(baseDomain)), ".")
	if baseDomain == "" {
		return ""
	}
	host := strings.ToLower(strings.TrimSpace(strings.Split(r.Host, ":")[0]))
	if host == "" || host == baseDomain || !strings.HasSuffix(host, "."+baseDomain) {
		return ""
	}
	prefix := host[:len(host)-len(baseDomain)-1]
	if prefix == "" || strings.Contains(prefix, ".") {
		return ""
	}
	return prefix
}

// RequestedOrgSlug returns the transport-claimed scope; host and header must
// agree when both are present.
func RequestedOrgSlug(r *http.Request, baseDomain string) (string, error) {
	fromHost := HostOrgSlug(r, baseDomain)
	fromHeader := strings.ToLower(strings.TrimSpace(r.Header.Get(orgHeader)))
	if fromHost != "" && fromHeader != "" && fromHost != fromHeader {
		return "", &tenancy.Error{Status: 409, Detail: "Organization scope mismatch between host and header"}
	}
	if fromHost != "" {
		return fromHost, nil
	}
	return fromHeader, nil
}

// ResolveOrg resolves {org_slug} for the caller, fail-closed: malformed
// slugs, unknown organizations, and non-membership all answer 404.
func (s *Store) ResolveOrg(ctx context.Context, r *http.Request, baseDomain, slug string, userID uuid.UUID) (*Org, error) {
	normalized := strings.ToLower(strings.TrimSpace(slug))
	if !orgSlugRe.MatchString(normalized) {
		return nil, &tenancy.Error{Status: 404, Detail: "Organization not found"}
	}
	transport, err := RequestedOrgSlug(r, baseDomain)
	if err != nil {
		return nil, err
	}
	if transport != "" && transport != normalized {
		return nil, &tenancy.Error{Status: 409, Detail: "Organization scope mismatch between host and path"}
	}
	var org Org
	var suspendedAt *time.Time
	err = s.DB.QueryRow(ctx,
		`SELECT o.id, o.slug, o.name, o.description, o.created_at, o.suspended_at, m.role
		 FROM organizations o
		 JOIN organization_memberships m ON m.organization_id = o.id AND m.user_id = $2
		 WHERE o.slug = $1`, normalized, userID).
		Scan(&org.ID, &org.Slug, &org.Name, &org.Description, &org.CreatedAt, &suspendedAt, &org.Role)
	if errors.Is(err, pgx.ErrNoRows) {
		// Non-members must not learn the organization exists.
		return nil, &tenancy.Error{Status: 404, Detail: "Organization not found"}
	}
	if err != nil {
		return nil, err
	}
	if suspendedAt != nil {
		// Deployment operators can suspend a tenant; members see an
		// explicit lockout rather than a silent 404.
		return nil, &tenancy.Error{Status: 403, Detail: "Organization is suspended"}
	}
	return &org, nil
}

// ResolveProject resolves {project_slug} inside an organization; access
// requires project membership or org owner/admin, else 404.
func (s *Store) ResolveProject(ctx context.Context, org *Org, slug string, userID uuid.UUID) (*Project, error) {
	normalized := strings.ToLower(strings.TrimSpace(slug))
	if !projectSlugRe.MatchString(normalized) {
		return nil, &tenancy.Error{Status: 404, Detail: "Project not found"}
	}
	var p Project
	err := s.DB.QueryRow(ctx,
		`SELECT p.id, p.organization_id, p.slug, p.name, p.description, p.created_at, p.is_default, m.role
		 FROM projects p
		 LEFT JOIN project_memberships m ON m.project_id = p.id AND m.user_id = $3
		 WHERE p.organization_id = $1 AND p.slug = $2`, org.ID, normalized, userID).
		Scan(&p.ID, &p.OrganizationID, &p.Slug, &p.Name, &p.Description, &p.CreatedAt, &p.IsDefault, &p.Role)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, &tenancy.Error{Status: 404, Detail: "Project not found"}
	}
	if err != nil {
		return nil, err
	}
	p.OrgRole = org.Role
	role := ""
	if p.Role != nil {
		role = *p.Role
	}
	if !tenancy.CanAccessProject(org.Role, role) {
		return nil, &tenancy.Error{Status: 404, Detail: "Project not found"}
	}
	return &p, nil
}

// ResolveRequestProject requires an optional transport project header to agree
// with the explicit project path before resolving ownership and access.
func (s *Store) ResolveRequestProject(ctx context.Context, r *http.Request, org *Org, slug string, userID uuid.UUID) (*Project, error) {
	pathSlug := strings.ToLower(strings.TrimSpace(slug))
	headerSlug := strings.ToLower(strings.TrimSpace(r.Header.Get(projectHeader)))
	if headerSlug != "" && headerSlug != pathSlug {
		return nil, &tenancy.Error{Status: http.StatusConflict, Detail: "Project scope mismatch between path and header"}
	}
	return s.ResolveProject(ctx, org, pathSlug, userID)
}

// AmbientProjectResolver validates the organization/project transport scope
// for route families whose URL namespace does not carry both slugs. Host and
// headers are lookup keys only; membership, project ownership, and project
// access are resolved from PostgreSQL on every request.
type AmbientProjectResolver struct {
	Store    *Store
	Settings Setting
}

// ResolveProjectID returns the authorized project UUID for the request.
func (r *AmbientProjectResolver) ResolveProjectID(ctx context.Context, req *http.Request, userID uuid.UUID) (string, error) {
	baseDomain := ""
	if r.Settings != nil {
		baseDomain = r.Settings.String(ctx, "deployment.base_domain", "")
	}
	orgSlug, err := RequestedOrgSlug(req, baseDomain)
	if err != nil {
		return "", err
	}
	if orgSlug == "" {
		return "", &tenancy.Error{Status: http.StatusUnprocessableEntity, Detail: "Project scope requires an organization scope"}
	}
	projectSlug := strings.ToLower(strings.TrimSpace(req.Header.Get(projectHeader)))
	if projectSlug == "" {
		return "", &tenancy.Error{Status: http.StatusUnprocessableEntity, Detail: "Project scope is required"}
	}
	org, err := r.Store.ResolveOrg(ctx, req, baseDomain, orgSlug, userID)
	if err != nil {
		return "", err
	}
	project, err := r.Store.ResolveProject(ctx, org, projectSlug, userID)
	if err != nil {
		return "", err
	}
	return project.ID.String(), nil
}
