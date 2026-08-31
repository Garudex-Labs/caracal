// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"fmt"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/inbox"
)

// reviewersFor lists the users notified when this listing awaits review.
// Project-scoped work notifies that project's leads; public work notifies
// global reviewers plus the owning project's leads; a private item without
// a project falls back to deployment operators.
func (s *Store) reviewersFor(ctx context.Context, projectID *uuid.UUID, isPrivate bool) ([]uuid.UUID, error) {
	collect := func(sql string, args ...any) ([]uuid.UUID, error) {
		rows, err := s.DB.Query(ctx, sql, args...)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		out := []uuid.UUID{}
		for rows.Next() {
			var id uuid.UUID
			if err := rows.Scan(&id); err != nil {
				return nil, err
			}
			out = append(out, id)
		}
		return out, rows.Err()
	}
	if isPrivate {
		if projectID == nil {
			return collect(`SELECT id FROM users WHERE role = 'operator'`)
		}
		return collect(
			`SELECT user_id FROM project_memberships WHERE project_id = $1 AND role = 'lead'`, *projectID)
	}
	global, err := inbox.GlobalReviewers(ctx, s.DB)
	if err != nil {
		return nil, err
	}
	if projectID == nil {
		return global, nil
	}
	leads, err := collect(
		`SELECT user_id FROM project_memberships WHERE project_id = $1 AND role = 'lead'`, *projectID)
	if err != nil {
		return nil, err
	}
	seen := map[uuid.UUID]bool{}
	out := []uuid.UUID{}
	for _, id := range append(global, leads...) {
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out, nil
}

// subjectFromRow builds an inbox subject from a listing detail row.
func subjectFromRow(row map[string]any, subjectType string) inbox.Subject {
	subject := inbox.Subject{
		Type:      subjectType,
		Name:      rowStr(row, "name", ""),
		Namespace: rowNStr(row, "namespace"),
		Slug:      rowNStr(row, "slug"),
		IsPrivate: rowBool(row, "is_private"),
	}
	if id, err := uuid.Parse(rowStr(row, "id", "")); err == nil {
		subject.ID = &id
	}
	if projectStr := rowNStr(row, "project_id"); projectStr != nil {
		if projectID, err := uuid.Parse(*projectStr); err == nil {
			subject.ProjectID = &projectID
		}
	}
	if version := rowStr(row, "version", ""); version != "" {
		subject.Version = &version
	}
	return subject
}

// notifyReviewRequested fans the pending item out to everyone who can clear
// it, inside the caller's transaction.
func (s *Store) notifyReviewRequested(ctx context.Context, tx pgx.Tx, row map[string]any, subjectType string, actor uuid.UUID) error {
	var projectID *uuid.UUID
	if projectStr := rowNStr(row, "project_id"); projectStr != nil {
		if parsed, err := uuid.Parse(*projectStr); err == nil {
			projectID = &parsed
		}
	}
	recipients, err := s.reviewersFor(ctx, projectID, rowBool(row, "is_private"))
	if err != nil {
		return err
	}
	subject := subjectFromRow(row, subjectType)
	_, err = inbox.Deliver(ctx, tx, "review_requested", recipients, subject, &actor, nil, nil, true)
	return err
}

// familySubmitGate validates the per-family required fields before a listing
// may enter review.
func familySubmitGate(f Family, row map[string]any) *apiError {
	if rowStr(row, "description", "") == "" {
		return &apiError{Status: 400, Detail: "Description is required before submitting"}
	}
	switch f.Prefix {
	case "mcps":
		if rowStr(row, "git_url", "") == "" && rowStr(row, "command", "") == "" && rowStr(row, "url", "") == "" {
			return &apiError{Status: 400, Detail: "At least one of git_url, command, or url is required"}
		}
	case "prompts":
		if rowStr(row, "template", "") == "" {
			return &apiError{Status: 400, Detail: "Template is required before submitting"}
		}
	}
	return nil
}

// SubmitForReview moves a draft or rejected listing into the review queue and
// notifies its reviewers.
func (s *Store) SubmitForReview(ctx context.Context, f Family, identifier string, viewer *Viewer) (map[string]any, error) {
	row, err := s.Resolve(ctx, f, identifier, viewer, false)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, &apiError{Status: 404, Detail: "Listing not found"}
	}
	if rowPermission(row, viewer) != "owner" {
		return nil, &apiError{Status: 403, Detail: "Not the listing owner"}
	}
	status := rowStr(row, "status", "")
	if status != "draft" && status != "rejected" {
		return nil, &apiError{Status: 400, Detail: "Listing is not a draft"}
	}

	// The skill family re-validates its stored SKILL.md before publication and
	// adopts a frontmatter slash command over the stored one.
	var skillSlashUpdate *string
	if f.Prefix == "skills" {
		latest := rowNStr(row, "latest_version_id")
		if latest == nil {
			return nil, &apiError{Status: 400, Detail: "Listing has no version"}
		}
		normalized, aerr := analyzeSkillMD(rowStr(row, "skill_md_content", ""), rowStr(row, "slash_command", ""))
		if aerr != nil {
			return nil, aerr
		}
		if normalized != "" {
			skillSlashUpdate = &normalized
		}
	}
	if gateErr := familySubmitGate(f, row); gateErr != nil {
		return nil, gateErr
	}

	listingID := rowStr(row, "id", "")
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if latest := rowNStr(row, "latest_version_id"); latest != nil {
		if skillSlashUpdate != nil {
			if _, err := tx.Exec(ctx,
				`UPDATE skill_versions SET status = 'pending', slash_command = $2 WHERE id = $1`,
				*latest, *skillSlashUpdate); err != nil {
				return nil, err
			}
		} else if _, err := tx.Exec(ctx, fmt.Sprintf(
			`UPDATE %s SET status = 'pending' WHERE id = $1`, f.VersionTable), *latest); err != nil {
			return nil, err
		}
	}
	if err := s.notifyReviewRequested(ctx, tx, row, f.Name, viewer.ID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	fresh, err := s.Resolve(ctx, f, listingID, viewer, false)
	if err != nil {
		return nil, err
	}
	return fresh, nil
}

// submitForReview is the route handler shared by the five families.
func (h *Handler) submitForReview(f Family) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		row, err := h.Store.SubmitForReview(r.Context(), f, r.PathValue("listing_id"), viewer)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, detail(f, row, nil, nil))
	})
}
