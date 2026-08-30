// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/google/uuid"
)

// entityLabel is the 404 subject derived from the plural route segment; the
// derivation is part of the wire contract ("sandboxes" reads "Sandboxe").
func entityLabel(f Family) string {
	trimmed := strings.TrimSuffix(f.Prefix, "s")
	return strings.ToUpper(trimmed[:1]) + trimmed[1:]
}

// coAuthorUser is the collaborator wire shape.
type coAuthorUser struct {
	ID       string  `json:"id"`
	Email    string  `json:"email"`
	Username *string `json:"username"`
	IsActive bool    `json:"is_active"`
}

// UserRef selects a collaborator by exactly one identifier.
type UserRef struct {
	UserID   string
	Email    string
	Username string
}

func (s *Store) usersByIDs(ctx context.Context, ids []string) ([]coAuthorUser, error) {
	if len(ids) == 0 {
		return []coAuthorUser{}, nil
	}
	rows, err := s.DB.Query(ctx,
		"SELECT id::text AS id, email, username, auth_provider FROM users WHERE id = ANY($1::uuid[])", ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []coAuthorUser{}
	for _, row := range collectRows(rows) {
		out = append(out, coAuthorUser{
			ID:       rowStr(row, "id", ""),
			Email:    rowStr(row, "email", ""),
			Username: rowNStr(row, "username"),
			IsActive: rowStr(row, "auth_provider", "") != "deactivated",
		})
	}
	return out, rows.Err()
}

// resolveTargetUser finds the referenced collaborator: explicit id first,
// then email, then handle.
func (s *Store) resolveTargetUser(ctx context.Context, ref UserRef) (*coAuthorUser, error) {
	var where string
	var arg any
	switch {
	case ref.UserID != "":
		id, err := uuid.Parse(ref.UserID)
		if err != nil {
			return nil, &apiError{Status: 422, Detail: "Invalid user ID"}
		}
		where, arg = "id = $1", id
	case ref.Email != "":
		where, arg = "email = $1", strings.ToLower(strings.TrimSpace(ref.Email))
	case ref.Username != "":
		where, arg = "username = $1", strings.TrimLeft(strings.TrimSpace(ref.Username), "@")
	default:
		return nil, &apiError{Status: 422, Detail: "Provide a user"}
	}
	rows, err := s.DB.Query(ctx,
		"SELECT id::text AS id, email, username, auth_provider FROM users WHERE "+where, arg)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	matches := collectRows(rows)
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(matches) == 0 {
		return nil, &apiError{Status: 404, Detail: "User not found"}
	}
	row := matches[0]
	return &coAuthorUser{
		ID:       rowStr(row, "id", ""),
		Email:    rowStr(row, "email", ""),
		Username: rowNStr(row, "username"),
		IsActive: rowStr(row, "auth_provider", "") != "deactivated",
	}, nil
}

func rowCoAuthors(row map[string]any) []string {
	out := []string{}
	for _, v := range rowList(row, "co_authors") {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// CoAuthors lists a visible listing's collaborators.
func (s *Store) CoAuthors(ctx context.Context, f Family, entityID uuid.UUID, viewer *Viewer) ([]coAuthorUser, error) {
	row, err := s.Resolve(ctx, f, entityID.String(), viewer, false)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, &apiError{Status: 404, Detail: entityLabel(f) + " not found"}
	}
	return s.usersByIDs(ctx, rowCoAuthors(row))
}

// resolveManaged loads a listing the viewer may manage collaborators on.
func (s *Store) resolveManaged(ctx context.Context, f Family, entityID uuid.UUID, viewer *Viewer) (map[string]any, error) {
	row, err := s.Resolve(ctx, f, entityID.String(), viewer, false)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, &apiError{Status: 404, Detail: entityLabel(f) + " not found"}
	}
	if rowPermission(row, viewer) != "owner" {
		return nil, &apiError{Status: 403, Detail: "You don't have permission to manage co-authors"}
	}
	return row, nil
}

func (s *Store) writeCoAuthors(ctx context.Context, f Family, listingID string, coAuthors []string) error {
	blob, err := json.Marshal(coAuthors)
	if err != nil {
		return err
	}
	_, err = s.DB.Exec(ctx,
		fmt.Sprintf("UPDATE %s SET co_authors = $1::json, updated_at = now() WHERE id = $2", f.ListingTable),
		string(blob), listingID)
	return err
}

// AddCoAuthor grants a collaborator owner-level access.
func (s *Store) AddCoAuthor(ctx context.Context, f Family, entityID uuid.UUID, viewer *Viewer, ref UserRef) (*coAuthorUser, error) {
	row, err := s.resolveManaged(ctx, f, entityID, viewer)
	if err != nil {
		return nil, err
	}
	target, err := s.resolveTargetUser(ctx, ref)
	if err != nil {
		return nil, err
	}
	if target.ID == rowStr(row, "submitted_by", "") {
		return nil, &apiError{Status: 422, Detail: "Owner is already implicit - no need to add as co-author"}
	}
	coAuthors := rowCoAuthors(row)
	for _, id := range coAuthors {
		if id == target.ID {
			return nil, &apiError{Status: 409, Detail: "User is already a co-author"}
		}
	}
	if err := s.writeCoAuthors(ctx, f, rowStr(row, "id", ""), append(coAuthors, target.ID)); err != nil {
		return nil, err
	}
	return target, nil
}

// RemoveCoAuthor revokes a collaborator.
func (s *Store) RemoveCoAuthor(ctx context.Context, f Family, entityID, userID uuid.UUID, viewer *Viewer) error {
	row, err := s.resolveManaged(ctx, f, entityID, viewer)
	if err != nil {
		return err
	}
	coAuthors := rowCoAuthors(row)
	kept := make([]string, 0, len(coAuthors))
	found := false
	for _, id := range coAuthors {
		if id == userID.String() {
			found = true
			continue
		}
		kept = append(kept, id)
	}
	if !found {
		return &apiError{Status: 404, Detail: "User is not a co-author"}
	}
	return s.writeCoAuthors(ctx, f, rowStr(row, "id", ""), kept)
}

// Editors lists every user who has released a version of the listing.
func (s *Store) Editors(ctx context.Context, f Family, entityID uuid.UUID) ([]coAuthorUser, error) {
	rows, err := s.DB.Query(ctx, fmt.Sprintf(
		"SELECT DISTINCT released_by::text AS id FROM %s WHERE listing_id = $1", f.VersionTable), entityID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for _, row := range collectRows(rows) {
		ids = append(ids, rowStr(row, "id", ""))
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return s.usersByIDs(ctx, ids)
}
