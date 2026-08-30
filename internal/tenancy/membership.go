// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package tenancy

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ProjectRole returns the caller's role in a project and whether they belong.
func (r *Resolver) ProjectRole(ctx context.Context, projectID, userID uuid.UUID) (string, bool, error) {
	var role string
	err := r.DB.QueryRow(ctx,
		`SELECT role FROM project_memberships WHERE project_id = $1 AND user_id = $2`, projectID, userID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) || isMissingSchema(err) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return role, true, nil
}

// IsProjectMember reports membership in a project.
func (r *Resolver) IsProjectMember(ctx context.Context, projectID, userID uuid.UUID) (bool, error) {
	_, ok, err := r.ProjectRole(ctx, projectID, userID)
	return ok, err
}

// OrgRole returns the caller's role in an organization and whether they belong.
func (r *Resolver) OrgRole(ctx context.Context, orgID, userID uuid.UUID) (string, bool, error) {
	var role string
	err := r.DB.QueryRow(ctx,
		`SELECT role FROM organization_memberships WHERE organization_id = $1 AND user_id = $2`, orgID, userID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) || isMissingSchema(err) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return role, true, nil
}

// ReviewScope is what one caller is allowed to review. Operators review
// everything; ProjectIDs are projects the caller leads, granting review over
// that project's member-shared content.
type ReviewScope struct {
	IsOperator       bool
	IsGlobalReviewer bool
	ProjectIDs       map[uuid.UUID]bool
}

// IsEmpty reports whether the caller may not review anything at all.
func (s ReviewScope) IsEmpty() bool { return !s.IsGlobalReviewer && len(s.ProjectIDs) == 0 }

// ReviewScopeFor resolves the caller's review capability once, so the queue
// and the approve/reject actions agree on what a caller may touch.
func (r *Resolver) ReviewScopeFor(ctx context.Context, user User) (ReviewScope, error) {
	if IsOperator(user.Role) {
		return ReviewScope{IsOperator: true, IsGlobalReviewer: true, ProjectIDs: map[uuid.UUID]bool{}}, nil
	}
	scope := ReviewScope{
		IsGlobalReviewer: IsGlobalReviewer(user.Role),
		ProjectIDs:       map[uuid.UUID]bool{},
	}
	rows, err := r.DB.Query(ctx,
		`SELECT project_id FROM project_memberships WHERE user_id = $1 AND role = 'lead'`, user.ID)
	if err != nil {
		if isMissingSchema(err) {
			return scope, nil
		}
		return ReviewScope{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var projectID uuid.UUID
		if err := rows.Scan(&projectID); err != nil {
			return ReviewScope{}, err
		}
		scope.ProjectIDs[projectID] = true
	}
	return scope, rows.Err()
}

// CanReview decides from the item's own visibility, never from what the
// caller asked for: a project-shared item belongs to its project's leads
// plus operators; public items clear for global reviewers.
func (s ReviewScope) CanReview(projectID *uuid.UUID, isPrivate bool) bool {
	if s.IsOperator {
		return true
	}
	if isPrivate {
		return projectID != nil && s.ProjectIDs[*projectID]
	}
	return s.IsGlobalReviewer
}
