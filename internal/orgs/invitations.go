// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Organization invitations: the only path into an organization besides a
// direct admin add. Invitations are email-bound, expire, and accept exactly
// once; retrying any step never mints duplicates.

package orgs

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/garudex-labs/caracal/internal/fernet"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/tenancy"
)

// invitationTTL is how long a fresh or reissued invitation stays valid.
const invitationTTL = 14 * 24 * time.Hour

// Invitation is one org_invitations row.
type Invitation struct {
	ID             uuid.UUID
	OrganizationID uuid.UUID
	Email          string
	Role           string
	TokenEncrypted *string
	InvitedBy      *uuid.UUID
	CreatedAt      time.Time
	ExpiresAt      time.Time
	AcceptedAt     *time.Time
	AcceptedBy     *uuid.UUID
	RevokedAt      *time.Time
}

// State reports the invitation lifecycle phase.
func (i *Invitation) State(now time.Time) string {
	switch {
	case i.AcceptedAt != nil:
		return "accepted"
	case i.RevokedAt != nil:
		return "revoked"
	case !i.ExpiresAt.After(now):
		return "expired"
	default:
		return "pending"
	}
}

const invitationColumns = `id, organization_id, email, role, token_encrypted, invited_by,
	created_at, expires_at, accepted_at, accepted_by, revoked_at`

func scanInvitation(row pgx.Row) (*Invitation, error) {
	var i Invitation
	err := row.Scan(&i.ID, &i.OrganizationID, &i.Email, &i.Role, &i.TokenEncrypted, &i.InvitedBy,
		&i.CreatedAt, &i.ExpiresAt, &i.AcceptedAt, &i.AcceptedBy, &i.RevokedAt)
	if err != nil {
		return nil, err
	}
	return &i, nil
}

func invitationTokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func newInvitationToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

const encPrefix = "enc:"

func (h *Handler) decryptInvitationToken(stored string) string {
	if !strings.HasPrefix(stored, encPrefix) {
		return stored
	}
	pt, err := fernet.Decrypt(h.SecretKey, strings.TrimPrefix(stored, encPrefix))
	if err != nil {
		return ""
	}
	return string(pt)
}

func (h *Handler) encryptInvitationToken(token string) (string, error) {
	ct, err := fernet.Encrypt(h.SecretKey, []byte(token))
	if err != nil {
		return "", err
	}
	return encPrefix + ct, nil
}

// ── Store ────────────────────────────────────────────────────────────────────

// LiveInvitation finds the single non-accepted, non-revoked invitation for an
// address in an organization, regardless of expiry.
func (s *Store) LiveInvitation(ctx context.Context, orgID uuid.UUID, email string) (*Invitation, error) {
	inv, err := scanInvitation(s.DB.QueryRow(ctx,
		`SELECT `+invitationColumns+` FROM org_invitations
		 WHERE organization_id = $1 AND lower(email) = lower($2)
		   AND accepted_at IS NULL AND revoked_at IS NULL`, orgID, email))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return inv, err
}

// CreateInvitation inserts a fresh invitation row.
func (s *Store) CreateInvitation(ctx context.Context, orgID uuid.UUID, email, role, tokenHash, tokenEncrypted string, invitedBy uuid.UUID) (*Invitation, error) {
	inv := Invitation{ID: uuid.New(), OrganizationID: orgID, Email: strings.ToLower(strings.TrimSpace(email)),
		Role: role, TokenEncrypted: &tokenEncrypted, InvitedBy: &invitedBy,
		ExpiresAt: time.Now().UTC().Add(invitationTTL)}
	err := s.DB.QueryRow(ctx,
		`INSERT INTO org_invitations (id, organization_id, email, role, token_hash, token_encrypted,
		   invited_by, created_at, expires_at)
		 VALUES ($1, $2, $3, $4::organization_role, $5, $6, $7, now(), $8) RETURNING created_at`,
		inv.ID, orgID, inv.Email, role, tokenHash, tokenEncrypted, invitedBy, inv.ExpiresAt).
		Scan(&inv.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &inv, nil
}

// ReissueInvitation refreshes an expired invitation with a new token and
// expiry instead of accumulating dead rows for the same address.
func (s *Store) ReissueInvitation(ctx context.Context, inv *Invitation, role, tokenHash, tokenEncrypted string, invitedBy uuid.UUID) error {
	inv.Role = role
	inv.TokenEncrypted = &tokenEncrypted
	inv.InvitedBy = &invitedBy
	inv.ExpiresAt = time.Now().UTC().Add(invitationTTL)
	_, err := execRow(ctx, s.DB,
		`UPDATE org_invitations SET role = $2::organization_role, token_hash = $3, token_encrypted = $4,
		   invited_by = $5, expires_at = $6 WHERE id = $1 RETURNING id`,
		inv.ID, role, tokenHash, tokenEncrypted, invitedBy, inv.ExpiresAt)
	return err
}

// InvitationListQuery carries validated filters for the organization invitation list.
type InvitationListQuery struct {
	Q     string
	Role  string
	State string
}

// ListInvitations returns invitations for an organization, newest first, with
// the inviter's username when the account still exists.
func (s *Store) ListInvitations(ctx context.Context, orgID uuid.UUID, q InvitationListQuery) ([]*Invitation, map[uuid.UUID]string, error) {
	where := []string{"organization_id = $1"}
	args := []any{orgID}
	if q.Q != "" {
		args = append(args, likePattern(q.Q))
		where = append(where, fmt.Sprintf("email ILIKE $%d", len(args)))
	}
	if q.Role != "" {
		args = append(args, q.Role)
		where = append(where, fmt.Sprintf("role = $%d::organization_role", len(args)))
	}
	switch q.State {
	case "pending":
		where = append(where, "accepted_at IS NULL", "revoked_at IS NULL", "expires_at > now()")
	case "accepted":
		where = append(where, "accepted_at IS NOT NULL")
	case "revoked":
		where = append(where, "accepted_at IS NULL", "revoked_at IS NOT NULL")
	case "expired":
		where = append(where, "accepted_at IS NULL", "revoked_at IS NULL", "expires_at <= now()")
	}
	rows, err := s.DB.Query(ctx,
		`SELECT `+invitationColumns+` FROM org_invitations
		 WHERE `+strings.Join(where, " AND ")+` ORDER BY created_at DESC`, args...)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	out := []*Invitation{}
	for rows.Next() {
		inv, err := scanInvitation(rows)
		if err != nil {
			return nil, nil, err
		}
		out = append(out, inv)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	inviters := map[uuid.UUID]string{}
	for _, inv := range out {
		if inv.InvitedBy == nil {
			continue
		}
		if _, seen := inviters[*inv.InvitedBy]; seen {
			continue
		}
		var username string
		if err := s.DB.QueryRow(ctx,
			`SELECT username FROM users WHERE id = $1`, *inv.InvitedBy).Scan(&username); err == nil {
			inviters[*inv.InvitedBy] = username
		}
	}
	return out, inviters, nil
}

// MyInvitations lists the caller's pending, unexpired invitations by address.
func (s *Store) MyInvitations(ctx context.Context, email string) ([]*Invitation, map[uuid.UUID]orgSummary, error) {
	rows, err := s.DB.Query(ctx,
		`SELECT `+invitationColumns+` FROM org_invitations
		 WHERE lower(email) = lower($1) AND accepted_at IS NULL AND revoked_at IS NULL
		   AND expires_at > now() ORDER BY created_at DESC`, email)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	out := []*Invitation{}
	for rows.Next() {
		inv, err := scanInvitation(rows)
		if err != nil {
			return nil, nil, err
		}
		out = append(out, inv)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	orgsByID, err := s.orgSummaries(ctx, out)
	return out, orgsByID, err
}

type orgSummary struct {
	Slug string
	Name string
}

func (s *Store) orgSummaries(ctx context.Context, invs []*Invitation) (map[uuid.UUID]orgSummary, error) {
	out := map[uuid.UUID]orgSummary{}
	for _, inv := range invs {
		if _, seen := out[inv.OrganizationID]; seen {
			continue
		}
		var sum orgSummary
		if err := s.DB.QueryRow(ctx,
			`SELECT slug, name FROM organizations WHERE id = $1`, inv.OrganizationID).
			Scan(&sum.Slug, &sum.Name); err != nil {
			return nil, err
		}
		out[inv.OrganizationID] = sum
	}
	return out, nil
}

// InvitationByID loads one invitation.
func (s *Store) InvitationByID(ctx context.Context, id uuid.UUID) (*Invitation, error) {
	inv, err := scanInvitation(s.DB.QueryRow(ctx,
		`SELECT `+invitationColumns+` FROM org_invitations WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, &tenancy.Error{Status: 404, Detail: "Invitation not found"}
	}
	return inv, err
}

// InvitationByToken resolves an invitation link.
func (s *Store) InvitationByToken(ctx context.Context, token string) (*Invitation, error) {
	inv, err := scanInvitation(s.DB.QueryRow(ctx,
		`SELECT `+invitationColumns+` FROM org_invitations WHERE token_hash = $1`,
		invitationTokenHash(token)))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, &tenancy.Error{Status: 404, Detail: "Invitation not found"}
	}
	return inv, err
}

// RevokeInvitation invalidates a pending invitation; revoking twice is a
// no-op and an accepted invitation can no longer be revoked.
func (s *Store) RevokeInvitation(ctx context.Context, orgID, id uuid.UUID) error {
	var acceptedAt, revokedAt *time.Time
	err := s.DB.QueryRow(ctx,
		`SELECT accepted_at, revoked_at FROM org_invitations WHERE id = $1 AND organization_id = $2`,
		id, orgID).Scan(&acceptedAt, &revokedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return &tenancy.Error{Status: 404, Detail: "Invitation not found"}
	}
	if err != nil {
		return err
	}
	if acceptedAt != nil {
		return &tenancy.Error{Status: 409, Detail: "This invitation was already accepted"}
	}
	if revokedAt != nil {
		return nil
	}
	_, err = execRow(ctx, s.DB,
		`UPDATE org_invitations SET revoked_at = now() WHERE id = $1 RETURNING id`, id)
	return err
}

// AcceptInvitation joins the caller to the organization. The row is locked so
// concurrent accepts settle deterministically, and the membership insert is
// conflict-free, so retries and refreshes never duplicate anything.
func (s *Store) AcceptInvitation(ctx context.Context, tx TxBeginner, inv *Invitation, userID uuid.UUID) error {
	t, err := tx.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = t.Rollback(ctx) }()
	var acceptedAt, revokedAt *time.Time
	var acceptedBy *uuid.UUID
	var expiresAt time.Time
	err = t.QueryRow(ctx,
		`SELECT accepted_at, accepted_by, revoked_at, expires_at FROM org_invitations WHERE id = $1 FOR UPDATE`,
		inv.ID).Scan(&acceptedAt, &acceptedBy, &revokedAt, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return &tenancy.Error{Status: 404, Detail: "Invitation not found"}
	}
	if err != nil {
		return err
	}
	switch {
	case acceptedAt != nil && acceptedBy != nil && *acceptedBy == userID:
		// Retried accept: a no-op only while the membership it granted still
		// stands. A member since removed cannot re-enter through the
		// consumed invitation - that path is a fresh invitation.
		var member bool
		if err := t.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM organization_memberships WHERE organization_id = $1 AND user_id = $2)`,
			inv.OrganizationID, userID).Scan(&member); err != nil {
			return err
		}
		if !member {
			return &tenancy.Error{Status: 409, Detail: "This invitation was already used; ask an organization admin to send a new one"}
		}
		return t.Commit(ctx)
	case acceptedAt != nil:
		return &tenancy.Error{Status: 409, Detail: "This invitation was already used"}
	case revokedAt != nil:
		return &tenancy.Error{Status: 409, Detail: "This invitation was revoked"}
	case !expiresAt.After(time.Now().UTC()):
		return &tenancy.Error{Status: 409, Detail: "This invitation has expired; ask an organization admin to send a new one"}
	}
	if _, err := t.Exec(ctx,
		`INSERT INTO organization_memberships (id, organization_id, user_id, role, created_at)
		 VALUES ($1, $2, $3, $4::organization_role, now())
		 ON CONFLICT (organization_id, user_id) DO NOTHING`,
		uuid.New(), inv.OrganizationID, userID, inv.Role); err != nil {
		return err
	}
	var orgRole string
	if err := t.QueryRow(ctx,
		`SELECT role FROM organization_memberships WHERE organization_id = $1 AND user_id = $2`,
		inv.OrganizationID, userID).Scan(&orgRole); err != nil {
		return err
	}
	if _, err := t.Exec(ctx,
		`INSERT INTO project_memberships (id, project_id, organization_id, user_id, role, created_at)
		 SELECT $1, p.id, p.organization_id, $2, $3::project_role, now()
		 FROM projects p
		 WHERE p.organization_id = $4 AND p.is_default
		 ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
		uuid.New(), userID, defaultProjectMemberRole(orgRole), inv.OrganizationID); err != nil {
		return err
	}
	if _, err := t.Exec(ctx,
		`UPDATE org_invitations SET accepted_at = now(), accepted_by = $2 WHERE id = $1`,
		inv.ID, userID); err != nil {
		return err
	}
	return t.Commit(ctx)
}

// callerEmail reads the caller's authoritative address.
func (s *Store) callerEmail(ctx context.Context, userID uuid.UUID) (string, error) {
	var email string
	err := s.DB.QueryRow(ctx, `SELECT email FROM users WHERE id = $1`, userID).Scan(&email)
	return email, err
}

// OrgByID loads an organization row with the given user's role, if any.
func (s *Store) OrgByID(ctx context.Context, id, userID uuid.UUID) (*Org, error) {
	var org Org
	var role *string
	err := s.DB.QueryRow(ctx,
		`SELECT o.id, o.slug, o.name, o.description, o.created_at, m.role
		 FROM organizations o
		 LEFT JOIN organization_memberships m ON m.organization_id = o.id AND m.user_id = $2
		 WHERE o.id = $1`, id, userID).
		Scan(&org.ID, &org.Slug, &org.Name, &org.Description, &org.CreatedAt, &role)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, &tenancy.Error{Status: 404, Detail: "Organization not found"}
	}
	if err != nil {
		return nil, err
	}
	if role != nil {
		org.Role = *role
	}
	return &org, nil
}

// ── Wire ─────────────────────────────────────────────────────────────────────

type invitationResponse struct {
	ID        string  `json:"id"`
	OrgSlug   string  `json:"org_slug"`
	OrgName   string  `json:"org_name"`
	Email     string  `json:"email"`
	Role      string  `json:"role"`
	URL       *string `json:"url,omitempty"`
	InvitedBy *string `json:"invited_by,omitempty"`
	CreatedAt string  `json:"created_at"`
	ExpiresAt string  `json:"expires_at"`
	State     string  `json:"state"`
}

func (h *Handler) wireInvitation(inv *Invitation, orgSlug, orgName string, invitedBy *string, withURL bool) invitationResponse {
	var url *string
	if withURL && inv.TokenEncrypted != nil && inv.State(time.Now().UTC()) == "pending" {
		if token := h.decryptInvitationToken(*inv.TokenEncrypted); token != "" {
			frontend := strings.TrimRight(h.Settings.String(context.Background(), "deployment.frontend_url", "http://localhost:8000"), "/")
			u := frontend + "/onboarding/organization?invite=" + token
			url = &u
		}
	}
	return invitationResponse{
		ID: inv.ID.String(), OrgSlug: orgSlug, OrgName: orgName, Email: inv.Email, Role: inv.Role,
		URL: url, InvitedBy: invitedBy, CreatedAt: wireTime(inv.CreatedAt),
		ExpiresAt: wireTime(inv.ExpiresAt), State: inv.State(time.Now().UTC()),
	}
}

// ── Handlers ─────────────────────────────────────────────────────────────────

// createInvitation mints (or returns) the live invitation for an address.
func (h *Handler) createInvitation(w http.ResponseWriter, r *http.Request) {
	org, ok := h.org(w, r)
	if !ok || !requireOrgPermission(w, org, tenancy.PermissionOrgMembersManage) {
		return
	}
	actorID, _ := h.caller(w, r)
	req, ok := parseMemberRequest(w, r, [2]string{"admin", "member"}, "member")
	if !ok {
		return
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))
	if email == "" || !strings.Contains(email, "@") || len(email) > 255 {
		write422(w, []fieldError{{Type: "value_error", Loc: []string{"body", "email"},
			Msg: "Value error, Provide a valid email address", Input: req.Email}})
		return
	}
	var alreadyMember bool
	if err := h.Store.DB.QueryRow(r.Context(),
		`SELECT EXISTS (SELECT 1 FROM organization_memberships m JOIN users u ON u.id = m.user_id
		 WHERE m.organization_id = $1 AND lower(u.email) = $2)`, org.ID, email).Scan(&alreadyMember); err != nil {
		writeErr(w, r, err)
		return
	}
	if alreadyMember {
		httpapi.WriteError(w, http.StatusConflict, "That address already belongs to a member of this organization")
		return
	}
	existing, err := h.Store.LiveInvitation(r.Context(), org.ID, email)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if existing != nil && existing.State(time.Now().UTC()) == "pending" {
		httpapi.WriteJSON(w, http.StatusOK, h.wireInvitation(existing, org.Slug, org.Name, nil, true))
		return
	}
	token, err := newInvitationToken()
	if err != nil {
		writeErr(w, r, err)
		return
	}
	encrypted, err := h.encryptInvitationToken(token)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	var inv *Invitation
	if existing != nil {
		// The previous invitation expired unaccepted: reissue it in place.
		if err := h.Store.ReissueInvitation(r.Context(), existing, req.Role, invitationTokenHash(token), encrypted, actorID); err != nil {
			writeErr(w, r, err)
			return
		}
		inv = existing
	} else {
		inv, err = h.Store.CreateInvitation(r.Context(), org.ID, email, req.Role, invitationTokenHash(token), encrypted, actorID)
		if err != nil {
			if isUnique(err) {
				httpapi.WriteError(w, http.StatusConflict, "An invitation for that address already exists; retry")
				return
			}
			writeErr(w, r, err)
			return
		}
	}
	h.emitOrgEvent(r.Context(), "org.invitation.created", actorID, org,
		fmt.Sprintf("Invited %s to '%s' as %s", email, org.Slug, req.Role))
	httpapi.WriteJSON(w, http.StatusCreated, h.wireInvitation(inv, org.Slug, org.Name, nil, true))
}

func (h *Handler) listInvitations(w http.ResponseWriter, r *http.Request) {
	org, ok := h.org(w, r)
	if !ok || !requireOrgPermission(w, org, tenancy.PermissionOrgMembersManage) {
		return
	}
	query, ok := parseInvitationListQuery(w, r)
	if !ok {
		return
	}
	invs, inviters, err := h.Store.ListInvitations(r.Context(), org.ID, query)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	out := []invitationResponse{}
	for _, inv := range invs {
		var invitedBy *string
		if inv.InvitedBy != nil {
			if username, ok := inviters[*inv.InvitedBy]; ok {
				invitedBy = &username
			}
		}
		out = append(out, h.wireInvitation(inv, org.Slug, org.Name, invitedBy, true))
	}
	httpapi.WriteJSON(w, http.StatusOK, out)
}

func (h *Handler) revokeInvitation(w http.ResponseWriter, r *http.Request) {
	org, ok := h.org(w, r)
	if !ok || !requireOrgPermission(w, org, tenancy.PermissionOrgMembersManage) {
		return
	}
	actorID, _ := h.caller(w, r)
	id, err := uuid.Parse(r.PathValue("invitation"))
	if err != nil {
		write422(w, []fieldError{{Type: "uuid_parsing", Loc: []string{"path", "invitation_id"},
			Msg: "Input should be a valid UUID", Input: r.PathValue("invitation")}})
		return
	}
	if err := h.Store.RevokeInvitation(r.Context(), org.ID, id); err != nil {
		writeErr(w, r, err)
		return
	}
	h.emitOrgEvent(r.Context(), "org.invitation.revoked", actorID, org,
		fmt.Sprintf("Revoked an invitation in '%s'", org.Slug))
	w.WriteHeader(http.StatusNoContent)
}

// myInvitations lists the invitations addressed to the caller's account.
func (h *Handler) myInvitations(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.caller(w, r)
	if !ok {
		return
	}
	email, err := h.Store.callerEmail(r.Context(), userID)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	invs, orgsByID, err := h.Store.MyInvitations(r.Context(), email)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	out := []invitationResponse{}
	for _, inv := range invs {
		sum := orgsByID[inv.OrganizationID]
		out = append(out, h.wireInvitation(inv, sum.Slug, sum.Name, nil, false))
	}
	httpapi.WriteJSON(w, http.StatusOK, out)
}

// previewInvitationToken lets a link holder see what they were invited to.
func (h *Handler) previewInvitationToken(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.caller(w, r); !ok {
		return
	}
	inv, err := h.Store.InvitationByToken(r.Context(), r.PathValue("token"))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	var sum orgSummary
	if err := h.Store.DB.QueryRow(r.Context(),
		`SELECT slug, name FROM organizations WHERE id = $1`, inv.OrganizationID).
		Scan(&sum.Slug, &sum.Name); err != nil {
		writeErr(w, r, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, h.wireInvitation(inv, sum.Slug, sum.Name, nil, false))
}

func (h *Handler) acceptInvitationByID(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(r.PathValue("invitation"))
	if err != nil {
		write422(w, []fieldError{{Type: "uuid_parsing", Loc: []string{"path", "invitation_id"},
			Msg: "Input should be a valid UUID", Input: r.PathValue("invitation")}})
		return
	}
	h.acceptInvitation(w, r, func(ctx context.Context) (*Invitation, error) {
		return h.Store.InvitationByID(ctx, id)
	}, false)
}

func (h *Handler) acceptInvitationByToken(w http.ResponseWriter, r *http.Request) {
	h.acceptInvitation(w, r, func(ctx context.Context) (*Invitation, error) {
		return h.Store.InvitationByToken(ctx, r.PathValue("token"))
	}, true)
}

// acceptInvitation joins the caller. Address mismatches 404 on the id path
// (those ids are only ever listed to their addressee) but explain themselves
// on the token path, where holding the link proves the invitation exists.
func (h *Handler) acceptInvitation(w http.ResponseWriter, r *http.Request, load func(context.Context) (*Invitation, error), viaToken bool) {
	userID, ok := h.caller(w, r)
	if !ok {
		return
	}
	inv, err := load(r.Context())
	if err != nil {
		writeErr(w, r, err)
		return
	}
	email, err := h.Store.callerEmail(r.Context(), userID)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	if !strings.EqualFold(strings.TrimSpace(email), strings.TrimSpace(inv.Email)) {
		if viaToken {
			httpapi.WriteError(w, http.StatusConflict,
				"This invitation was issued to a different email address; sign in with the invited account")
			return
		}
		httpapi.WriteError(w, http.StatusNotFound, "Invitation not found")
		return
	}
	if err := h.Store.AcceptInvitation(r.Context(), h.Pool, inv, userID); err != nil {
		writeErr(w, r, err)
		return
	}
	org, err := h.Store.OrgByID(r.Context(), inv.OrganizationID, userID)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	h.emitOrgEvent(r.Context(), "org.invitation.accepted", userID, org,
		fmt.Sprintf("Accepted an invitation to '%s' as %s", org.Slug, inv.Role))
	role := org.Role
	httpapi.WriteJSON(w, http.StatusOK, orgWire(org, &role, nil, nil))
}
