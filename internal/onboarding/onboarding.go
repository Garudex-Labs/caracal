// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package onboarding answers "where is this user in setup?" from the
// authoritative tables: profile completion, organization memberships, and
// project access. The snapshot is derived, so refreshing, retrying, or
// resuming a step can never corrupt or duplicate onboarding state.
package onboarding

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/tenancy"
)

// PGQuerier is the pgx surface the store needs.
type PGQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Store derives onboarding snapshots.
type Store struct {
	DB PGQuerier
}

// Steps, in order. "project" covers selection and the no-access state; the
// client decides which to render from the same snapshot.
const (
	StepProfile      = "profile"
	StepOrganization = "organization"
	StepProject      = "project"
	StepDone         = "done"
)

type profileState struct {
	Completed bool    `json:"completed"`
	Name      string  `json:"name"`
	Username  string  `json:"username"`
	Email     string  `json:"email"`
	AvatarURL *string `json:"avatar_url"`
}

type projectState struct {
	Slug      string  `json:"slug"`
	Name      string  `json:"name"`
	IsDefault bool    `json:"is_default"`
	Role      *string `json:"role"`
}

type orgState struct {
	Slug     string         `json:"slug"`
	Name     string         `json:"name"`
	Role     string         `json:"role"`
	Projects []projectState `json:"projects"`
}

type invitationState struct {
	ID        string `json:"id"`
	OrgSlug   string `json:"org_slug"`
	OrgName   string `json:"org_name"`
	Role      string `json:"role"`
	ExpiresAt string `json:"expires_at"`
}

// Snapshot is the authoritative onboarding state for one user.
type Snapshot struct {
	Profile       profileState      `json:"profile"`
	Organizations []orgState        `json:"organizations"`
	Invitations   []invitationState `json:"invitations"`
	NextStep      string            `json:"next_step"`
}

func wireTime(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05Z")
}

// Snapshot assembles the state. Projects listed per org are only those the
// user can actually enter: their memberships, or all of them for org
// owners/admins.
func (s *Store) Snapshot(ctx context.Context, userID uuid.UUID) (*Snapshot, error) {
	snap := &Snapshot{Organizations: []orgState{}, Invitations: []invitationState{}}
	var completedAt *time.Time
	err := s.DB.QueryRow(ctx,
		`SELECT name, username, email, avatar_url, profile_completed_at FROM users WHERE id = $1`, userID).
		Scan(&snap.Profile.Name, &snap.Profile.Username, &snap.Profile.Email,
			&snap.Profile.AvatarURL, &completedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, &tenancy.Error{Status: 401, Detail: "Missing credentials"}
	}
	if err != nil {
		return nil, err
	}
	snap.Profile.Completed = completedAt != nil

	// Accessibility lives in the project join, not the WHERE clause: an org
	// whose projects are all inaccessible must still appear (with none).
	rows, err := s.DB.Query(ctx,
		`SELECT o.slug, o.name, m.role, p.slug, p.name, p.is_default, pm.role
		 FROM organization_memberships m
		 JOIN organizations o ON o.id = m.organization_id
		 LEFT JOIN projects p ON p.organization_id = o.id
		   AND (m.role IN ('owner', 'admin') OR EXISTS (
		     SELECT 1 FROM project_memberships x WHERE x.project_id = p.id AND x.user_id = m.user_id))
		 LEFT JOIN project_memberships pm ON pm.project_id = p.id AND pm.user_id = m.user_id
		 WHERE m.user_id = $1
		 ORDER BY o.name, o.slug, p.name`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	index := map[string]int{}
	for rows.Next() {
		var orgSlug, orgName, orgRole string
		var pSlug, pName *string
		var pDefault *bool
		var pRole *string
		if err := rows.Scan(&orgSlug, &orgName, &orgRole, &pSlug, &pName, &pDefault, &pRole); err != nil {
			return nil, err
		}
		at, seen := index[orgSlug]
		if !seen {
			at = len(snap.Organizations)
			index[orgSlug] = at
			snap.Organizations = append(snap.Organizations, orgState{
				Slug: orgSlug, Name: orgName, Role: orgRole, Projects: []projectState{},
			})
		}
		if pSlug != nil {
			snap.Organizations[at].Projects = append(snap.Organizations[at].Projects, projectState{
				Slug: *pSlug, Name: *pName, IsDefault: pDefault != nil && *pDefault, Role: pRole,
			})
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	invRows, err := s.DB.Query(ctx,
		`SELECT i.id, o.slug, o.name, i.role, i.expires_at
		 FROM org_invitations i JOIN organizations o ON o.id = i.organization_id
		 WHERE lower(i.email) = lower($1) AND i.accepted_at IS NULL AND i.revoked_at IS NULL
		   AND i.expires_at > now() ORDER BY i.created_at DESC`, snap.Profile.Email)
	if err != nil {
		return nil, err
	}
	defer invRows.Close()
	for invRows.Next() {
		var inv invitationState
		var expires time.Time
		if err := invRows.Scan(&inv.ID, &inv.OrgSlug, &inv.OrgName, &inv.Role, &expires); err != nil {
			return nil, err
		}
		inv.ExpiresAt = wireTime(expires)
		snap.Invitations = append(snap.Invitations, inv)
	}
	if err := invRows.Err(); err != nil {
		return nil, err
	}

	snap.NextStep = nextStep(snap)
	return snap, nil
}

func nextStep(snap *Snapshot) string {
	if !snap.Profile.Completed {
		return StepProfile
	}
	if len(snap.Organizations) == 0 {
		return StepOrganization
	}
	for _, org := range snap.Organizations {
		if len(org.Projects) > 0 {
			return StepDone
		}
	}
	return StepProject
}

// CompleteProfile stamps the profile stage once the account actually carries
// a usable identity; repeat calls are no-ops.
func (s *Store) CompleteProfile(ctx context.Context, userID uuid.UUID) error {
	var name, username string
	var completedAt *time.Time
	err := s.DB.QueryRow(ctx,
		`SELECT name, username, profile_completed_at FROM users WHERE id = $1`, userID).
		Scan(&name, &username, &completedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return &tenancy.Error{Status: 401, Detail: "Missing credentials"}
	}
	if err != nil {
		return err
	}
	if completedAt != nil {
		return nil
	}
	if strings.TrimSpace(name) == "" {
		return &tenancy.Error{Status: 422, Detail: "Set a display name before completing your profile"}
	}
	if _, err := tenancy.ValidateNamespace(username, false); err != nil {
		return &tenancy.Error{Status: 422, Detail: "Pick a valid username before completing your profile"}
	}
	var id uuid.UUID
	err = s.DB.QueryRow(ctx,
		`UPDATE users SET profile_completed_at = now()
		 WHERE id = $1 AND profile_completed_at IS NULL RETURNING id`, userID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		// A concurrent call completed it first; same outcome.
		return nil
	}
	return err
}

// Handler serves the onboarding routes.
type Handler struct {
	Store *Store
}

// Register mounts the onboarding surface.
func (h *Handler) Register(mux *http.ServeMux, withAuth func(http.Handler) http.Handler) {
	mux.Handle("GET /api/v1/onboarding", withAuth(http.HandlerFunc(h.snapshot)))
	mux.Handle("POST /api/v1/onboarding/profile/complete", withAuth(http.HandlerFunc(h.completeProfile)))
}

func (h *Handler) caller(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	claims, ok := httpapi.ClaimsFrom(r.Context())
	if !ok {
		httpapi.WriteError(w, http.StatusUnauthorized, "Missing credentials")
		return uuid.UUID{}, false
	}
	return claims.UserID, true
}

func writeErr(w http.ResponseWriter, r *http.Request, err error) {
	var te *tenancy.Error
	if errors.As(err, &te) {
		httpapi.WriteError(w, te.Status, te.Detail)
		return
	}
	httpapi.WriteInternalError(w, r, err)
}

func (h *Handler) snapshot(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.caller(w, r)
	if !ok {
		return
	}
	snap, err := h.Store.Snapshot(r.Context(), userID)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, snap)
}

func (h *Handler) completeProfile(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.caller(w, r)
	if !ok {
		return
	}
	if err := h.Store.CompleteProfile(r.Context(), userID); err != nil {
		writeErr(w, r, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]bool{"completed": true})
}
