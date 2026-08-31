// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package orgs

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/garudex-labs/caracal/internal/tenancy"
)

// TxBeginner extends the read surface with transactions for the write plane.
type TxBeginner interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// orgSlugRuleText is the shared human-readable shape rule.
const orgSlugRuleText = "Organization ids must be 3-32 characters using lowercase letters, numbers, " +
	"and hyphens, and must start and end with a letter or number"

// reservedOrgSlugs can never become a customer organization or subdomain.
var reservedOrgSlugs = func() map[string]bool {
	out := map[string]bool{}
	for _, s := range []string{
		// Registry handles that collide with API path segments.
		"admin", "api", "auth", "registry", "root", "system", "teams", "users",
		// Brand.
		"caracal", "caracalai", "caracalrun", "caracal-ai", "caracal-run",
		// Infrastructure and protocol hostnames.
		"app", "assets", "cdn", "console", "dashboard", "dev", "docs", "download",
		"downloads", "email", "ftp", "gateway", "grafana", "help", "imap", "ingest",
		"internal", "lb", "localhost", "mail", "metrics", "monitoring", "mx", "ns1",
		"ns2", "ops", "prod", "production", "prometheus", "proxy", "smtp", "staging",
		"static", "status", "telemetry", "test", "vpn", "web", "wiki", "www",
		// Product terms that would be ambiguous in URLs and support.
		"billing", "legal", "login", "logout", "org", "orgs", "organization",
		"organizations", "platform", "privacy", "project", "projects", "security",
		"settings", "signup", "sso", "support", "terms",
	} {
		out[s] = true
	}
	return out
}()

// ValidateOrgSlug normalizes and validates against shape and reservations.
func ValidateOrgSlug(slug string) (string, error) {
	value := strings.ToLower(strings.TrimSpace(slug))
	if !orgSlugRe.MatchString(value) {
		return "", fmt.Errorf("%s", orgSlugRuleText)
	}
	if reservedOrgSlugs[value] {
		return "", fmt.Errorf("Organization id '%s' is reserved", value)
	}
	return value, nil
}

func isUnique(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// TargetUser is a resolved member-management subject.
type TargetUser struct {
	ID       uuid.UUID
	Email    string
	Username *string
	Name     *string
}

// ResolveUser finds the subject by id, email, or username; 404 otherwise.
func (s *Store) ResolveUser(ctx context.Context, userID *uuid.UUID, email, username string) (*TargetUser, error) {
	var row pgx.Row
	switch {
	case userID != nil:
		row = s.DB.QueryRow(ctx, `SELECT id, email, username, name FROM users WHERE id = $1`, *userID)
	case email != "":
		row = s.DB.QueryRow(ctx, `SELECT id, email, username, name FROM users WHERE email = $1`,
			strings.ToLower(strings.TrimSpace(email)))
	default:
		row = s.DB.QueryRow(ctx, `SELECT id, email, username, name FROM users WHERE username = $1`,
			strings.TrimLeft(strings.TrimSpace(username), "@"))
	}
	var t TargetUser
	if err := row.Scan(&t.ID, &t.Email, &t.Username, &t.Name); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, &tenancy.Error{Status: 404, Detail: "User not found"}
		}
		return nil, err
	}
	return &t, nil
}

// CreateOrg creates an organization; the creator becomes its sole owner and
// the protected default project is created alongside it. The default project
// starts with a real membership row so roster counts and access maps reflect
// the protected project's initial membership state.
func (s *Store) CreateOrg(ctx context.Context, tx TxBeginner, userID uuid.UUID, slug, name string, description *string) (*Org, *Project, error) {
	var taken uuid.UUID
	err := s.DB.QueryRow(ctx, `SELECT id FROM organizations WHERE slug = $1`, slug).Scan(&taken)
	if err == nil {
		return nil, nil, &tenancy.Error{Status: 409, Detail: fmt.Sprintf("Organization id '%s' is already taken", slug)}
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, err
	}
	t, err := tx.Begin(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = t.Rollback(ctx) }()
	org := Org{ID: uuid.New(), Slug: slug, Name: strings.TrimSpace(name), Description: description, Role: "owner"}
	err = t.QueryRow(ctx,
		`INSERT INTO organizations (id, slug, name, description, created_by, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, now(), now()) RETURNING created_at`,
		org.ID, org.Slug, org.Name, org.Description, userID).Scan(&org.CreatedAt)
	if err == nil {
		_, err = t.Exec(ctx,
			`INSERT INTO organization_memberships (id, organization_id, user_id, role, created_at)
			 VALUES ($1, $2, $3, 'owner', now())`, uuid.New(), org.ID, userID)
	}
	role := "lead"
	def := Project{ID: uuid.New(), OrganizationID: org.ID, Slug: org.Slug, Name: org.Name, IsDefault: true, Role: &role}
	if err == nil {
		err = t.QueryRow(ctx,
			`INSERT INTO projects (id, organization_id, slug, name, created_by, is_default, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, true, now(), now()) RETURNING created_at`,
			def.ID, org.ID, def.Slug, def.Name, userID).Scan(&def.CreatedAt)
	}
	if err == nil {
		_, err = t.Exec(ctx,
			`INSERT INTO project_memberships (id, project_id, organization_id, user_id, role, created_at)
			 VALUES ($1, $2, $3, $4, 'lead', now())`, uuid.New(), def.ID, org.ID, userID)
	}
	if err == nil {
		err = t.Commit(ctx)
	}
	if err != nil {
		if isUnique(err) {
			return nil, nil, &tenancy.Error{Status: 409, Detail: fmt.Sprintf("Organization id '%s' is already taken", slug)}
		}
		return nil, nil, err
	}
	return &org, &def, nil
}

// UpdateOrg applies name/description/slug changes; slug moves are owner-only.
func (s *Store) UpdateOrg(ctx context.Context, org *Org, userRole string, slug, name, description *string) (renamedFrom string, err error) {
	sets := []string{"updated_at = now()"}
	args := []any{}
	if slug != nil && strings.ToLower(strings.TrimSpace(*slug)) != org.Slug {
		if org.Role != "owner" {
			return "", &tenancy.Error{Status: 403, Detail: "Only the organization owner can change the organization id"}
		}
		newSlug, err := ValidateOrgSlug(*slug)
		if err != nil {
			return "", &tenancy.Error{Status: 422, Detail: err.Error()}
		}
		var taken uuid.UUID
		err = s.DB.QueryRow(ctx,
			`SELECT id FROM organizations WHERE slug = $1 AND id != $2`, newSlug, org.ID).Scan(&taken)
		if err == nil {
			return "", &tenancy.Error{Status: 409, Detail: fmt.Sprintf("Organization id '%s' is already taken", newSlug)}
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return "", err
		}
		renamedFrom = org.Slug
		org.Slug = newSlug
		args = append(args, newSlug)
		sets = append(sets, fmt.Sprintf("slug = $%d", len(args)))
	}
	if name != nil {
		org.Name = strings.TrimSpace(*name)
		args = append(args, org.Name)
		sets = append(sets, fmt.Sprintf("name = $%d", len(args)))
	}
	if description != nil {
		org.Description = description
		args = append(args, *description)
		sets = append(sets, fmt.Sprintf("description = $%d", len(args)))
	}
	args = append(args, org.ID)
	_, err = execRow(ctx, s.DB, fmt.Sprintf("UPDATE organizations SET %s WHERE id = $%d RETURNING id",
		strings.Join(sets, ", "), len(args)), args...)
	if isUnique(err) {
		return "", &tenancy.Error{Status: 409, Detail: "Organization id is already taken"}
	}
	if err != nil {
		return "", err
	}
	_ = userRole
	return renamedFrom, nil
}

// execRow runs a statement through QueryRow so the read-only PGQuerier
// surface suffices for single-row writes.
func execRow(ctx context.Context, db PGQuerier, sql string, args ...any) (uuid.UUID, error) {
	var id uuid.UUID
	err := db.QueryRow(ctx, sql, args...).Scan(&id)
	return id, err
}

// DeleteOrg removes an organization once only its default project remains
// and that project owns nothing; the default project is deleted with it.
func (s *Store) DeleteOrg(ctx context.Context, tx TxBeginner, org *Org) error {
	return s.deleteOrg(ctx, tx, org, false)
}

// DeleteSuspendedOrg applies the same emptiness guarantees as DeleteOrg and
// additionally requires the organization to remain suspended at the final
// DELETE statement. If a concurrent operator reinstates it, the transaction
// rolls back every deletion.
func (s *Store) DeleteSuspendedOrg(ctx context.Context, tx TxBeginner, org *Org) error {
	return s.deleteOrg(ctx, tx, org, true)
}

func (s *Store) deleteOrg(ctx context.Context, tx TxBeginner, org *Org, requireSuspended bool) error {
	var otherCount int
	if err := s.DB.QueryRow(ctx,
		`SELECT count(*) FROM projects WHERE organization_id = $1 AND NOT is_default`, org.ID).Scan(&otherCount); err != nil {
		return err
	}
	if otherCount > 0 {
		return &tenancy.Error{Status: 409,
			Detail: fmt.Sprintf("Organization still contains %d project(s); delete or migrate them first", otherCount)}
	}
	var defaultID uuid.UUID
	hasDefault := true
	err := s.DB.QueryRow(ctx,
		`SELECT id FROM projects WHERE organization_id = $1 AND is_default`, org.ID).Scan(&defaultID)
	if errors.Is(err, pgx.ErrNoRows) {
		hasDefault = false
	} else if err != nil {
		return err
	}
	if hasDefault {
		total, err := s.projectResourceCount(ctx, defaultID)
		if err != nil {
			return err
		}
		if total > 0 {
			return &tenancy.Error{Status: 409,
				Detail: fmt.Sprintf("The default project still owns %d resource(s); move or delete them first", total)}
		}
	}
	t, err := tx.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = t.Rollback(ctx) }()
	if hasDefault {
		if _, err := t.Exec(ctx, `DELETE FROM project_memberships WHERE project_id = $1`, defaultID); err != nil {
			return err
		}
		if _, err := t.Exec(ctx, `DELETE FROM projects WHERE id = $1`, defaultID); err != nil {
			return err
		}
	}
	deleteSQL := `DELETE FROM organizations WHERE id = $1`
	if requireSuspended {
		deleteSQL += ` AND suspended_at IS NOT NULL`
	}
	tag, err := t.Exec(ctx, deleteSQL, org.ID)
	if err != nil {
		return err
	}
	if requireSuspended && tag.RowsAffected() == 0 {
		return &tenancy.Error{Status: 409, Detail: "Organization is no longer suspended; retry"}
	}
	if err := t.Commit(ctx); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" {
			return &tenancy.Error{Status: 409, Detail: "Organization gained projects or resources concurrently; retry"}
		}
		return err
	}
	return nil
}

func defaultProjectMemberRole(orgRole string) string {
	if tenancy.IsOrgAdmin(orgRole) {
		return "lead"
	}
	return "user"
}

func (s *Store) ensureDefaultProjectMembership(ctx context.Context, orgID, userID uuid.UUID, orgRole string) error {
	_, err := execRow(ctx, s.DB,
		`INSERT INTO project_memberships (id, project_id, organization_id, user_id, role, created_at)
		 SELECT $1, p.id, p.organization_id, $2, $3::project_role, now()
		 FROM projects p
		 WHERE p.organization_id = $4 AND p.is_default
		 ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role
		 RETURNING id`, uuid.New(), userID, defaultProjectMemberRole(orgRole), orgID)
	return err
}

// UpsertOrgMember adds a member or changes a role; the owner row is
// untouchable here.
func (s *Store) UpsertOrgMember(ctx context.Context, orgID uuid.UUID, target *TargetUser, role string) error {
	var current string
	err := s.DB.QueryRow(ctx,
		`SELECT role FROM organization_memberships WHERE organization_id = $1 AND user_id = $2`,
		orgID, target.ID).Scan(&current)
	switch {
	case err == nil && current == "owner":
		return &tenancy.Error{Status: 409, Detail: "The organization owner's role changes only via ownership transfer"}
	case err == nil:
		_, err = execRow(ctx, s.DB,
			`UPDATE organization_memberships SET role = $1 WHERE organization_id = $2 AND user_id = $3 RETURNING id`,
			role, orgID, target.ID)
		if err != nil {
			return err
		}
		return s.ensureDefaultProjectMembership(ctx, orgID, target.ID, role)
	case errors.Is(err, pgx.ErrNoRows):
		_, err = execRow(ctx, s.DB,
			`INSERT INTO organization_memberships (id, organization_id, user_id, role, created_at)
			 VALUES ($1, $2, $3, $4, now()) RETURNING id`, uuid.New(), orgID, target.ID, role)
		if err != nil {
			return err
		}
		return s.ensureDefaultProjectMembership(ctx, orgID, target.ID, role)
	default:
		return err
	}
}

// RemoveOrgMember removes a membership and revokes every project membership
// inside the organization; the owner can never be removed.
func (s *Store) RemoveOrgMember(ctx context.Context, tx TxBeginner, orgID, userID uuid.UUID) (int64, error) {
	var role string
	err := s.DB.QueryRow(ctx,
		`SELECT role FROM organization_memberships WHERE organization_id = $1 AND user_id = $2`,
		orgID, userID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, &tenancy.Error{Status: 404, Detail: "Membership not found"}
	}
	if err != nil {
		return 0, err
	}
	if role == "owner" {
		return 0, &tenancy.Error{Status: 409, Detail: "The organization owner cannot be removed; transfer ownership first"}
	}
	t, err := tx.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = t.Rollback(ctx) }()
	tag, err := t.Exec(ctx,
		`DELETE FROM project_memberships WHERE organization_id = $1 AND user_id = $2`, orgID, userID)
	if err != nil {
		return 0, err
	}
	if _, err := t.Exec(ctx,
		`DELETE FROM organization_memberships WHERE organization_id = $1 AND user_id = $2`, orgID, userID); err != nil {
		return 0, err
	}
	return tag.RowsAffected(), t.Commit(ctx)
}

// TransferOwnership atomically demotes the owner and promotes the target,
// keeping the one-owner invariant satisfied at every point.
func (s *Store) TransferOwnership(ctx context.Context, tx TxBeginner, orgID, ownerID, targetID uuid.UUID) (*TargetUser, error) {
	t, err := tx.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = t.Rollback(ctx) }()
	var currentRole string
	err = t.QueryRow(ctx,
		`SELECT role FROM organization_memberships WHERE organization_id = $1 AND user_id = $2 FOR UPDATE`,
		orgID, ownerID).Scan(&currentRole)
	if err != nil || currentRole != "owner" {
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		return nil, &tenancy.Error{Status: 409, Detail: "Ownership changed concurrently; retry"}
	}
	var targetRole string
	err = t.QueryRow(ctx,
		`SELECT role FROM organization_memberships WHERE organization_id = $1 AND user_id = $2 FOR UPDATE`,
		orgID, targetID).Scan(&targetRole)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, &tenancy.Error{Status: 404, Detail: "Target user is not a member of this organization"}
	}
	if err != nil {
		return nil, err
	}
	target := &TargetUser{ID: targetID}
	_ = s.DB.QueryRow(ctx, `SELECT email, username, name FROM users WHERE id = $1`, targetID).
		Scan(&target.Email, &target.Username, &target.Name)
	if _, err := t.Exec(ctx,
		`UPDATE organization_memberships SET role = 'admin' WHERE organization_id = $1 AND user_id = $2`,
		orgID, ownerID); err != nil {
		return nil, err
	}
	if _, err := t.Exec(ctx,
		`UPDATE organization_memberships SET role = 'owner' WHERE organization_id = $1 AND user_id = $2`,
		orgID, targetID); err != nil {
		if isUnique(err) {
			return nil, &tenancy.Error{Status: 409, Detail: "Ownership changed concurrently; retry"}
		}
		return nil, err
	}
	for _, id := range []uuid.UUID{ownerID, targetID} {
		if _, err := t.Exec(ctx,
			`INSERT INTO project_memberships (id, project_id, organization_id, user_id, role, created_at)
			 SELECT $1, p.id, p.organization_id, $2, 'lead', now()
			 FROM projects p
			 WHERE p.organization_id = $3 AND p.is_default
			 ON CONFLICT (project_id, user_id) DO UPDATE SET role = 'lead'`,
			uuid.New(), id, orgID); err != nil {
			return nil, err
		}
	}
	if err := t.Commit(ctx); err != nil {
		if isUnique(err) {
			return nil, &tenancy.Error{Status: 409, Detail: "Ownership changed concurrently; retry"}
		}
		return nil, err
	}
	return target, nil
}

// CreateProject creates a project; the creator becomes its first lead.
func (s *Store) CreateProject(ctx context.Context, tx TxBeginner, org *Org, userID uuid.UUID, slugInput, name string, description *string) (*Project, error) {
	slug, err := tenancy.Slugify(slugInput)
	if err != nil {
		return nil, &tenancy.Error{Status: 422, Detail: err.Error()}
	}
	t, err := tx.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = t.Rollback(ctx) }()
	role := "lead"
	p := Project{ID: uuid.New(), OrganizationID: org.ID, Slug: slug, Name: strings.TrimSpace(name),
		Description: description, Role: &role}
	err = t.QueryRow(ctx,
		`INSERT INTO projects (id, organization_id, slug, name, description, created_by, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, now(), now()) RETURNING created_at`,
		p.ID, org.ID, p.Slug, p.Name, p.Description, userID).Scan(&p.CreatedAt)
	if err == nil {
		_, err = t.Exec(ctx,
			`INSERT INTO project_memberships (id, project_id, organization_id, user_id, role, created_at)
			 VALUES ($1, $2, $3, $4, 'lead', now())`, uuid.New(), p.ID, org.ID, userID)
	}
	if err == nil {
		err = t.Commit(ctx)
	}
	if err != nil {
		if isUnique(err) {
			return nil, &tenancy.Error{Status: 409,
				Detail: fmt.Sprintf("Project id '%s' already exists in this organization", slug)}
		}
		return nil, err
	}
	return &p, nil
}

// UpdateProject applies name/description changes.
func (s *Store) UpdateProject(ctx context.Context, p *Project, name, description *string) error {
	sets := []string{"updated_at = now()"}
	args := []any{}
	if name != nil {
		p.Name = strings.TrimSpace(*name)
		args = append(args, p.Name)
		sets = append(sets, fmt.Sprintf("name = $%d", len(args)))
	}
	if description != nil {
		p.Description = description
		args = append(args, *description)
		sets = append(sets, fmt.Sprintf("description = $%d", len(args)))
	}
	args = append(args, p.ID)
	_, err := execRow(ctx, s.DB, fmt.Sprintf("UPDATE projects SET %s WHERE id = $%d RETURNING id",
		strings.Join(sets, ", "), len(args)), args...)
	return err
}

// projectResourceCount totals the registry resources a project still owns.
func (s *Store) projectResourceCount(ctx context.Context, projectID uuid.UUID) (int, error) {
	total := 0
	for _, t := range resourceTables {
		var n int
		if err := s.DB.QueryRow(ctx,
			"SELECT count(*) FROM "+t.table+" WHERE project_id = $1", projectID).Scan(&n); err != nil {
			return 0, err
		}
		total += n
	}
	var n int
	if err := s.DB.QueryRow(ctx,
		`SELECT count(*) FROM component_sources WHERE project_id = $1`, projectID).Scan(&n); err != nil {
		return 0, err
	}
	return total + n, nil
}

// DeleteProject deletes an empty, non-default project and its
// memberships. The default project only ever leaves with its organization.
func (s *Store) DeleteProject(ctx context.Context, tx TxBeginner, p *Project) error {
	if p.IsDefault {
		return &tenancy.Error{Status: 409, Detail: "The organization's default project cannot be deleted"}
	}
	total, err := s.projectResourceCount(ctx, p.ID)
	if err != nil {
		return err
	}
	if total > 0 {
		return &tenancy.Error{Status: 409,
			Detail: fmt.Sprintf("Project still owns %d resource(s); move or delete them first", total)}
	}
	t, err := tx.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = t.Rollback(ctx) }()
	if _, err := t.Exec(ctx, `DELETE FROM project_memberships WHERE project_id = $1`, p.ID); err != nil {
		return err
	}
	if _, err := t.Exec(ctx, `DELETE FROM projects WHERE id = $1`, p.ID); err != nil {
		return err
	}
	if err := t.Commit(ctx); err != nil {
		// A resource landed in the project concurrently; the FK held the line.
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" {
			return &tenancy.Error{Status: 409, Detail: "Project gained resources concurrently; retry"}
		}
		return err
	}
	return nil
}

// UpsertProjectMember adds or re-roles a member; the target must already
// belong to the organization.
func (s *Store) UpsertProjectMember(ctx context.Context, p *Project, target *TargetUser, role string) error {
	var orgRole string
	err := s.DB.QueryRow(ctx,
		`SELECT role FROM organization_memberships WHERE organization_id = $1 AND user_id = $2`,
		p.OrganizationID, target.ID).Scan(&orgRole)
	if errors.Is(err, pgx.ErrNoRows) {
		return &tenancy.Error{Status: 409, Detail: "User must be a member of the organization first"}
	}
	if err != nil {
		return err
	}
	if tenancy.IsOrgAdmin(orgRole) && role != "lead" {
		return &tenancy.Error{Status: 409, Detail: "Organization owners and admins inherit project lead access"}
	}
	var existing string
	err = s.DB.QueryRow(ctx,
		`SELECT role FROM project_memberships WHERE project_id = $1 AND user_id = $2`,
		p.ID, target.ID).Scan(&existing)
	switch {
	case err == nil:
		_, err = execRow(ctx, s.DB,
			`UPDATE project_memberships SET role = $1 WHERE project_id = $2 AND user_id = $3 RETURNING id`,
			role, p.ID, target.ID)
		return err
	case errors.Is(err, pgx.ErrNoRows):
		_, err = execRow(ctx, s.DB,
			`INSERT INTO project_memberships (id, project_id, organization_id, user_id, role, created_at)
			 VALUES ($1, $2, $3, $4, $5, now()) RETURNING id`, uuid.New(), p.ID, p.OrganizationID, target.ID, role)
		return err
	default:
		return err
	}
}

// RemoveProjectMember removes one membership row.
func (s *Store) RemoveProjectMember(ctx context.Context, p *Project, userID uuid.UUID) error {
	var orgRole string
	err := s.DB.QueryRow(ctx,
		`SELECT role FROM organization_memberships WHERE organization_id = $1 AND user_id = $2`,
		p.OrganizationID, userID).Scan(&orgRole)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if tenancy.IsOrgAdmin(orgRole) {
		return &tenancy.Error{Status: 409, Detail: "Organization owner/admin project access is inherited and cannot be removed"}
	}
	_, err = execRow(ctx, s.DB,
		`DELETE FROM project_memberships WHERE project_id = $1 AND user_id = $2 RETURNING id`, p.ID, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return &tenancy.Error{Status: 404, Detail: "Membership not found"}
	}
	return err
}
