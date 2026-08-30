// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package identity maps identity-service subjects to registry accounts and
// answers whether an authenticated principal may act: the account must
// exist and be active. Identities without an account are provisioned on
// first contact: an existing row carrying the token's e-mail is adopted,
// otherwise a fresh account is created with a generated username. The
// identity service is authoritative for e-mail and display name; those are
// mirrored onto the local row whenever they drift. Role is deliberately not
// mirrored: role changes flow the other way (admin route → identity
// service), and a stale token must never rewrite a fresh promotion.
package identity

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/tenancy"
)

var (
	// ErrUnknownUser means the token subject has no account row and none
	// could be provisioned.
	ErrUnknownUser = errors.New("identity: unknown user")
	// ErrDeactivated marks accounts disabled by an administrator or directory sync.
	ErrDeactivated = errors.New("identity: account deactivated")
	// ErrUnavailable means account state could not be checked; callers must
	// fail closed with a retryable status.
	ErrUnavailable = errors.New("identity: account state unavailable")
)

// DB is the pgx surface the directory needs; both a pool and a transaction
// satisfy it.
type DB interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Directory verifies account standing against Postgres.
type Directory struct {
	DB DB
}

// ResolveActive maps a verified identity to the registry user id,
// provisioning the account on first contact.
func (d *Directory) ResolveActive(ctx context.Context, claims auth.Claims) (uuid.UUID, error) {
	subject := claims.UserID.String()
	var (
		localID         uuid.UUID
		provider, email string
		name            string
		role            string
	)
	err := d.DB.QueryRow(
		ctx,
		`SELECT id, auth_provider, email, name, role FROM users WHERE auth_subject_id = $1`,
		subject,
	).Scan(&localID, &provider, &email, &name, &role)
	switch {
	case err == nil:
		if provider == "deactivated" {
			return uuid.Nil, ErrDeactivated
		}
		d.mirrorIdentity(ctx, localID, email, name, role, claims)
		return localID, nil
	case !errors.Is(err, pgx.ErrNoRows):
		return uuid.Nil, fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	if claims.Email == "" {
		// Without an e-mail the identity can be neither adopted nor provisioned.
		return uuid.Nil, ErrUnknownUser
	}
	if id, done, err := d.adoptByEmail(ctx, subject, claims.Email, claims.Role); done {
		return id, err
	}
	return d.provision(ctx, claims)
}

// mirrorIdentity copies drifted identity fields onto the local row.
// Best-effort: a mirror failure never blocks an otherwise valid request.
func (d *Directory) mirrorIdentity(ctx context.Context, id uuid.UUID, email, name, role string, claims auth.Claims) {
	newEmail := email
	if claims.Email != "" && claims.Email != email {
		newEmail = claims.Email
	}
	newName := name
	if claims.Name != "" && claims.Name != name {
		newName = claims.Name
	}
	newRole := role
	if validDeploymentRole(claims.Role) && claims.Role != role {
		newRole = claims.Role
	}
	if newEmail == email && newName == name && newRole == role {
		return
	}
	if _, err := d.DB.Exec(ctx,
		`UPDATE users SET email = $1, name = $2, role = $3 WHERE id = $4`, newEmail, newName, newRole, id); err != nil {
		slog.Warn("identity mirror failed", "user", id, "error", err)
	}
}

func validDeploymentRole(role string) bool {
	switch role {
	case "operator", "reviewer", "user":
		return true
	default:
		return false
	}
}

// adoptByEmail links a pre-identity account carrying the token's e-mail.
// done reports whether adoption settled the resolution; done=false means no
// such account exists and provisioning should proceed.
func (d *Directory) adoptByEmail(ctx context.Context, subject, email, role string) (uuid.UUID, bool, error) {
	var (
		id       uuid.UUID
		provider string
		linked   *string
	)
	err := d.DB.QueryRow(
		ctx,
		`SELECT id, auth_provider, auth_subject_id FROM users WHERE email = $1`,
		email,
	).Scan(&id, &provider, &linked)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return uuid.Nil, false, nil
	case err != nil:
		return uuid.Nil, true, fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	if linked != nil && *linked != "" && *linked != subject {
		slog.Warn("account with this e-mail is linked to a different identity subject; refusing", "user", id)
		return uuid.Nil, true, ErrUnknownUser
	}
	if provider == "deactivated" {
		return uuid.Nil, true, ErrDeactivated
	}
	if validDeploymentRole(role) {
		if _, err := d.DB.Exec(ctx,
			`UPDATE users SET auth_subject_id = $1, role = $3 WHERE id = $2`, subject, id, role); err != nil {
			return uuid.Nil, true, fmt.Errorf("%w: %w", ErrUnavailable, err)
		}
		return id, true, nil
	}
	if _, err := d.DB.Exec(ctx,
		`UPDATE users SET auth_subject_id = $1 WHERE id = $2`, subject, id); err != nil {
		return uuid.Nil, true, fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	return id, true, nil
}

// provision creates the registry account for a first-contact identity.
func (d *Directory) provision(ctx context.Context, claims auth.Claims) (uuid.UUID, error) {
	subject := claims.UserID.String()
	name := claims.Name
	if name == "" {
		name = claims.Email
	}
	role := claims.Role
	switch role {
	case "operator", "reviewer", "user":
	default:
		role = "user"
	}
	id := uuid.New()
	for _, username := range usernameCandidates(claims.Email) {
		taken, err := d.handleTaken(ctx, username)
		if err != nil {
			return uuid.Nil, fmt.Errorf("%w: %w", ErrUnavailable, err)
		}
		if taken {
			continue
		}
		tag, err := d.DB.Exec(ctx,
			`INSERT INTO users (id, email, username, name, role, auth_provider, auth_subject_id, created_at)
			 VALUES ($1, $2, $3, $4, $5::userrole, 'better-auth', $6, now())
			 ON CONFLICT (auth_subject_id) DO NOTHING`,
			id, claims.Email, username, name, role, subject)
		var pgErr *pgconn.PgError
		switch {
		case errors.As(err, &pgErr) && pgErr.ConstraintName == "users_username_key":
			// Lost a username race; try the next candidate.
			continue
		case errors.As(err, &pgErr) && pgErr.ConstraintName == "users_email_key":
			// Raced with an adoption or a concurrent provisioning of the
			// same e-mail; the winner's row carries our subject or refuses.
			return d.resolveBySubject(ctx, subject)
		case err != nil:
			return uuid.Nil, fmt.Errorf("%w: %w", ErrUnavailable, err)
		case tag.RowsAffected() == 0:
			// Another request provisioned this subject first.
			return d.resolveBySubject(ctx, subject)
		}
		// Organization membership is never implicit: new accounts join an
		// organization by creating one or by accepting an invitation.
		return id, nil
	}
	return uuid.Nil, fmt.Errorf("%w: no free username for %q", ErrUnavailable, claims.Email)
}

func (d *Directory) resolveBySubject(ctx context.Context, subject string) (uuid.UUID, error) {
	var (
		id       uuid.UUID
		provider string
	)
	err := d.DB.QueryRow(
		ctx,
		`SELECT id, auth_provider FROM users WHERE auth_subject_id = $1`,
		subject,
	).Scan(&id, &provider)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return uuid.Nil, ErrUnknownUser
	case err != nil:
		return uuid.Nil, fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	if provider == "deactivated" {
		return uuid.Nil, ErrDeactivated
	}
	return id, nil
}

// handleTaken reports whether the handle is claimed by a user; a handle is the
// namespace identity, so it must resolve unambiguously.
func (d *Directory) handleTaken(ctx context.Context, handle string) (bool, error) {
	var taken bool
	err := d.DB.QueryRow(
		ctx,
		`SELECT EXISTS (SELECT 1 FROM users WHERE username = $1)`,
		handle,
	).Scan(&taken)
	return taken, err
}

var (
	handleClean = regexp.MustCompile(`[^a-z0-9-]+`)
	dashRuns    = regexp.MustCompile(`-+`)
)

// usernameCandidates derives deterministic username candidates from an
// e-mail: the cleaned local part first, then hash-suffixed variants, then a
// last-resort opaque handle. Candidates outside the namespace rules are
// dropped, so a generated username is always a valid publish namespace.
func usernameCandidates(email string) []string {
	lower := strings.ToLower(strings.TrimSpace(email))
	base := lower
	if at := strings.Index(lower, "@"); at >= 0 {
		base = lower[:at]
	}
	base = strings.Trim(dashRuns.ReplaceAllString(handleClean.ReplaceAllString(base, "-"), "-"), "-")
	if len(base) > 20 {
		base = strings.TrimRight(base[:20], "-")
	}
	if base == "" {
		base = "user"
	}

	candidates := make([]string, 0, 12)
	add := func(raw string) {
		if v, err := tenancy.ValidateNamespace(raw, false); err == nil {
			candidates = append(candidates, v)
		}
	}
	add(base)
	for attempt := 0; attempt < 10; attempt++ {
		sum := sha256.Sum256(fmt.Appendf(nil, "%s-%d", lower, attempt))
		c := base + "-" + hex.EncodeToString(sum[:3])
		if len(c) > 32 {
			c = c[:32]
		}
		add(c)
	}
	sum := sha256.Sum256([]byte(lower + "-fallback"))
	add("user-" + hex.EncodeToString(sum[:4]))
	return candidates
}
