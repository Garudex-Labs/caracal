// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package accounts serves the application-profile routes for the
// authenticated user: whoami, the registry username (namespace identity),
// avatars, and telemetry-hook credentials. Authentication itself lives in
// the identity service under /api/auth/*.
package accounts

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/garudex-labs/caracal/internal/tenancy"
)

// DB is the pool surface the store needs, including transactions.
type DB interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Profile is the users row as the profile routes see it.
type Profile struct {
	ID            string
	Email         string
	Username      string
	Name          string
	Role          string
	AvatarURL     *string
	CreatedAt     time.Time
	AuthSubjectID *string
}

// Store answers profile reads and writes.
type Store struct {
	DB DB
}

// Load returns the profile row for a local user id.
func (s *Store) Load(ctx context.Context, userID uuid.UUID) (*Profile, error) {
	var p Profile
	err := s.DB.QueryRow(ctx,
		`SELECT id::text, email, username, name, role, avatar_url, created_at, auth_subject_id
		 FROM users WHERE id = $1`, userID).
		Scan(&p.ID, &p.Email, &p.Username, &p.Name, &p.Role, &p.AvatarURL, &p.CreatedAt, &p.AuthSubjectID)
	if err != nil {
		return nil, err
	}
	return &p, nil
}

// resourceTables list every registry table whose namespace and owner columns
// address the user by their personal handle, so both must move when the handle
// changes. Rows are keyed by user id (created_by/submitted_by, co_authors), so
// only the display handle changes - ownership and permissions are untouched.
var resourceTables = []string{
	"agents",
	"mcp_listings",
	"skill_listings",
	"hook_listings",
	"prompt_listings",
}

// SetUsername runs the username-change flow and returns the fresh profile.
// The new handle and every published Agent/component the user owns move
// atomically to the new personal namespace so nothing is orphaned.
// Rejections carry the API error contract via tenancy.Error.
func (s *Store) SetUsername(ctx context.Context, current *Profile, username string) (*Profile, error) {
	userID := uuid.MustParse(current.ID)

	var takenBy uuid.UUID
	err := s.DB.QueryRow(ctx,
		`SELECT id FROM users WHERE username = $1 AND id != $2 LIMIT 1`, username, userID).Scan(&takenBy)
	if err == nil {
		return nil, &tenancy.Error{Status: 409, Detail: "Username already taken"}
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}

	// Reserve the slugified handle so it never collides with another user's.
	if err := s.reserveHandle(ctx, username, userID); err != nil {
		return nil, err
	}

	old := current.Username

	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`UPDATE users SET username = $1 WHERE id = $2`, username, userID); err != nil {
		if isUniqueViolation(err) {
			return nil, &tenancy.Error{Status: 409, Detail: "Username already taken"}
		}
		return nil, err
	}

	// Move every resource published under the old personal namespace to the new
	// one so ownership, permissions, and namespace/slug URLs keep resolving.
	// Resources under an organization namespace never match old, so they stay.
	if old != "" {
		for _, t := range resourceTables {
			if _, err := tx.Exec(ctx,
				"UPDATE "+t+" SET namespace = $1, owner = $1, updated_at = now() WHERE namespace = $2",
				username, old); err != nil {
				if isUniqueViolation(err) {
					return nil, &tenancy.Error{Status: 409,
						Detail: "A resource named the same already exists under '" + username + "'"}
				}
				return nil, err
			}
		}
	}

	if err := tx.Commit(ctx); err != nil {
		if isUniqueViolation(err) {
			return nil, &tenancy.Error{Status: 409, Detail: "Username already taken"}
		}
		return nil, err
	}
	return s.Load(ctx, userID)
}

// reserveHandle mirrors the handle reservation: the slugified variant must be
// free across usernames.
func (s *Store) reserveHandle(ctx context.Context, handle string, excludeUser uuid.UUID) error {
	value, err := tenancy.SlugifyHandle(handle, "user")
	if err != nil {
		return &tenancy.Error{Status: 409, Detail: err.Error()}
	}
	value, err = tenancy.ValidateNamespace(value, false)
	if err != nil {
		return &tenancy.Error{Status: 409, Detail: err.Error()}
	}
	var id uuid.UUID
	err = s.DB.QueryRow(ctx,
		`SELECT id FROM users WHERE username = $1 AND id != $2 LIMIT 1`, value, excludeUser).Scan(&id)
	if err == nil {
		return &tenancy.Error{Status: 409, Detail: "Handle '" + value + "' is already taken"}
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	return nil
}

// SetAvatar stores or clears the avatar data URL and returns the fresh profile.
func (s *Store) SetAvatar(ctx context.Context, userID uuid.UUID, avatarURL *string) (*Profile, error) {
	if _, err := s.DB.Exec(ctx,
		`UPDATE users SET avatar_url = $1 WHERE id = $2`, avatarURL, userID); err != nil {
		return nil, err
	}
	return s.Load(ctx, userID)
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
