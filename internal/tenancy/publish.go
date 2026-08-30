// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package tenancy

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// PublishTarget is the resolved, authorized destination for a new listing.
type PublishTarget struct {
	Namespace   string
	Slug        string
	Visibility  string
	Owner       string
	AutoApprove bool
	// ProjectID is the owning project; nil only on pre-organization schemas.
	ProjectID *uuid.UUID
}

// Scope is the ownership_scope column value: 'private' is creator-only
// inside its project.
func (t PublishTarget) Scope() string {
	if t.Visibility == "private" {
		return "private"
	}
	return "project"
}

// IsPrivate reports whether the listing row is stored as private.
func (t PublishTarget) IsPrivate() bool {
	return t.Visibility == "project" || t.Visibility == "private"
}

// PublishOptions are the caller-supplied targeting inputs.
type PublishOptions struct {
	Visibility string
	ProjectID  *uuid.UUID
}

// Resolver answers tenancy questions against the relational store.
type Resolver struct {
	DB PGQuerier
}

// RegistryProjectSlug names the default org's catch-all project that owns
// personal registry publishes.
const RegistryProjectSlug = "registry"

// ResolvePublishTarget resolves and authorizes the namespace, visibility, and
// owning project for a new listing. Rejections carry the API error contract.
func (r *Resolver) ResolvePublishTarget(ctx context.Context, user User, name string, opts PublishOptions) (*PublishTarget, error) {
	visibility := strings.ToLower(strings.TrimSpace(opts.Visibility))
	if visibility == "" {
		visibility = "public"
	}
	if visibility != "public" && visibility != "project" && visibility != "private" {
		return nil, reject(422, "visibility must be 'public', 'project', or 'private'")
	}

	if visibility == "private" {
		// Private items never enter the registry or a review queue: approval
		// here publishes to an audience of one.
		return r.personalTarget(ctx, user, name, "private", true, opts.ProjectID)
	}

	if visibility == "project" {
		// Project visibility shares with the owning project's members; the
		// submission enters the review queue so approval is a recorded
		// decision by a project lead.
		if opts.ProjectID == nil {
			return nil, reject(422, "Project visibility requires a project context")
		}
		return r.personalTarget(ctx, user, name, "project", false, opts.ProjectID)
	}

	return r.personalTarget(ctx, user, name, "public", false, opts.ProjectID)
}

func (r *Resolver) personalTarget(ctx context.Context, user User, name, visibility string, autoApprove bool, explicitProject *uuid.UUID) (*PublishTarget, error) {
	namespace, err := NamespaceForUser(user)
	if err != nil {
		return nil, reject(422, err.Error())
	}
	slug, err := Slugify(name)
	if err != nil {
		return nil, reject(422, err.Error())
	}
	projectID, err := r.resolveOwningProjectID(ctx, user, explicitProject)
	if err != nil {
		return nil, err
	}
	return &PublishTarget{
		Namespace:   namespace,
		Slug:        slug,
		Visibility:  visibility,
		Owner:       user.DisplayHandle(),
		AutoApprove: autoApprove,
		ProjectID:   projectID,
	}, nil
}

// resolveOwningProjectID picks the project owning a personal submission.
// An explicit project is a selector, never an authority: non-members get the
// same 404 a nonexistent project would. Without one, the submission lands in
// the default organization's registry catch-all project.
func (r *Resolver) resolveOwningProjectID(ctx context.Context, user User, explicit *uuid.UUID) (*uuid.UUID, error) {
	if explicit != nil {
		// Access follows CanAccessProject (project membership, or org
		// owner/admin); anyone else gets the nonexistent-project 404.
		var orgRole, projectRole string
		err := r.DB.QueryRow(ctx,
			`SELECT COALESCE(m.role::text, ''), COALESCE(pm.role::text, '')
			 FROM projects p
			 JOIN organization_memberships m ON m.organization_id = p.organization_id AND m.user_id = $2
			 LEFT JOIN project_memberships pm ON pm.project_id = p.id AND pm.user_id = $2
			 WHERE p.id = $1`,
			*explicit, user.ID).Scan(&orgRole, &projectRole)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && !CanAccessProject(orgRole, projectRole)) {
			return nil, reject(404, "Project not found")
		}
		if isMissingSchema(err) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		return explicit, nil
	}

	var orgID uuid.UUID
	err := r.DB.QueryRow(ctx, `SELECT id FROM organizations ORDER BY created_at LIMIT 1`).Scan(&orgID)
	if errors.Is(err, pgx.ErrNoRows) || isMissingSchema(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	var projectID uuid.UUID
	err = r.DB.QueryRow(ctx,
		`SELECT id FROM projects WHERE organization_id = $1 AND slug = $2`, orgID, RegistryProjectSlug).
		Scan(&projectID)
	if err == nil {
		return &projectID, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}

	created := uuid.New()
	err = r.DB.QueryRow(ctx,
		`INSERT INTO projects (id, organization_id, slug, name, description, created_by, created_at, updated_at)
		 VALUES ($1, $2, $3, 'Registry', 'Catch-all project owning personal registry publishes.', $4, now(), now())
		 RETURNING id`, created, orgID, RegistryProjectSlug, user.ID).Scan(&projectID)
	if err != nil {
		// Concurrent creation: the row exists now, use it.
		if pgErr := (*pgconn.PgError)(nil); errors.As(err, &pgErr) && pgErr.Code == "23505" {
			err = r.DB.QueryRow(ctx,
				`SELECT id FROM projects WHERE organization_id = $1 AND slug = $2`, orgID, RegistryProjectSlug).
				Scan(&projectID)
			if err != nil {
				return nil, err
			}
			return &projectID, nil
		}
		return nil, err
	}
	return &projectID, nil
}

// isMissingSchema detects pre-organization databases (undefined table); every
// other database error propagates so mirrors can never silently diverge.
func isMissingSchema(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "42P01"
}
