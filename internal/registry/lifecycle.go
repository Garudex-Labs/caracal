// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/tenancy"
)

// apiError carries a contract status and detail through the store layer.
type apiError struct {
	Status int
	Detail string
	// DetailAny carries a structured detail body when the contract uses one.
	DetailAny any
}

func (e *apiError) Error() string { return e.Detail }

func notFoundErr() *apiError { return &apiError{Status: 404, Detail: "Listing not found"} }

// itemLabel names a family in lifecycle error messages; mcp predates the
// naming scheme and reads as "listing".
func itemLabel(f Family) string {
	if f.Prefix == "mcps" {
		return "listing"
	}
	return f.Name
}

// canAdministerListing grants project leads and org owner/admins authority
// over team-scope listings; private-scope rows stay creator-only.
func (s *Store) canAdministerListing(ctx context.Context, row map[string]any, viewer *Viewer) (bool, error) {
	if rowStr(row, "ownership_scope", "") == "private" {
		return false, nil
	}
	projectID, err := uuid.Parse(rowStr(row, "project_id", ""))
	if err != nil {
		return false, nil
	}
	resolver := &tenancy.Resolver{DB: s.DB}
	projectRole, _, err := resolver.ProjectRole(ctx, projectID, viewer.ID)
	if err != nil {
		return false, err
	}
	var orgID uuid.UUID
	if err := s.DB.QueryRow(ctx, "SELECT organization_id FROM projects WHERE id = $1", projectID).Scan(&orgID); err != nil {
		return false, nil
	}
	orgRole, _, err := resolver.OrgRole(ctx, orgID, viewer.ID)
	if err != nil {
		return false, err
	}
	return tenancy.CanAdministerProject(orgRole, projectRole), nil
}

// requireArchiveAuthority is the owner-or-administrator gate on archive state.
func (s *Store) requireArchiveAuthority(ctx context.Context, row map[string]any, viewer *Viewer) error {
	if rowPermission(row, viewer) == "owner" {
		return nil
	}
	ok, err := s.canAdministerListing(ctx, row, viewer)
	if err != nil {
		return err
	}
	if !ok {
		return &apiError{Status: 403, Detail: "Not authorized"}
	}
	return nil
}

// archiveResult is the wire shape of both archive transitions.
type archiveResult struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
}

func (s *Store) setListingStatus(ctx context.Context, f Family, row map[string]any, status string) error {
	_, err := s.DB.Exec(ctx,
		fmt.Sprintf("UPDATE %s SET status = $1 WHERE id = $2", f.VersionTable),
		status, rowStr(row, "latest_version_id", ""))
	return err
}

// Archive moves an approved listing out of circulation.
func (s *Store) Archive(ctx context.Context, f Family, identifier string, viewer *Viewer) (*archiveResult, error) {
	row, err := s.Resolve(ctx, f, identifier, viewer, false)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, notFoundErr()
	}
	if err := s.requireArchiveAuthority(ctx, row, viewer); err != nil {
		return nil, err
	}
	if rowStr(row, "status", "draft") != "approved" {
		return nil, &apiError{Status: 400, Detail: fmt.Sprintf("Only approved %ss can be archived", itemLabel(f))}
	}
	if err := s.setListingStatus(ctx, f, row, "archived"); err != nil {
		return nil, err
	}
	return &archiveResult{ID: rowStr(row, "id", ""), Name: rowStr(row, "name", ""), Status: "archived"}, nil
}

// Unarchive restores an archived listing to circulation.
func (s *Store) Unarchive(ctx context.Context, f Family, identifier string, viewer *Viewer) (*archiveResult, error) {
	row, err := s.Resolve(ctx, f, identifier, viewer, false)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, notFoundErr()
	}
	if err := s.requireArchiveAuthority(ctx, row, viewer); err != nil {
		return nil, err
	}
	if rowStr(row, "status", "draft") != "archived" {
		label := itemLabel(f)
		return nil, &apiError{Status: 400, Detail: fmt.Sprintf("%s is not archived", strings.ToUpper(label[:1])+label[1:])}
	}
	if err := s.setListingStatus(ctx, f, row, "approved"); err != nil {
		return nil, err
	}
	return &archiveResult{ID: rowStr(row, "id", ""), Name: rowStr(row, "name", ""), Status: "approved"}, nil
}

// resolveOwned resolves a listing and requires owner-level permission, the
// shared precondition of every edit-lock mutation.
func (s *Store) resolveOwned(ctx context.Context, f Family, identifier string, viewer *Viewer) (map[string]any, error) {
	row, err := s.Resolve(ctx, f, identifier, viewer, false)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, notFoundErr()
	}
	if rowPermission(row, viewer) != "owner" {
		return nil, &apiError{Status: 403, Detail: "Not the listing owner"}
	}
	if rowStr(row, "latest_version_id", "") == "" {
		return nil, &apiError{Status: 400, Detail: "Listing has no version"}
	}
	return row, nil
}

// editLockTTL matches the stale-lock takeover window.
const editLockTTL = "30 minutes"

// StartEdit acquires the editing lock on the latest version.
func (s *Store) StartEdit(ctx context.Context, f Family, identifier string, viewer *Viewer) error {
	row, err := s.resolveOwned(ctx, f, identifier, viewer)
	if err != nil {
		return err
	}
	status := rowStr(row, "status", "draft")
	switch status {
	case "pending", "draft", "rejected":
	default:
		return &apiError{Status: 400, Detail: fmt.Sprintf("Cannot edit: listing is '%s'", status)}
	}
	// The guard makes acquisition atomic: free, own, or expired locks only.
	tag, err := s.DB.Exec(ctx, fmt.Sprintf(
		`UPDATE %s SET is_editing = TRUE, editing_since = now(), editing_by = $1
		 WHERE id = $2 AND (is_editing = FALSE OR editing_by = $1
		   OR editing_since IS NULL OR editing_since < now() - interval '%s')`,
		f.VersionTable, editLockTTL), viewer.ID, rowStr(row, "latest_version_id", ""))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return &apiError{Status: 409, Detail: "This item is currently being edited by another user. Please try again later."}
	}
	return nil
}

// CancelEdit releases the editing lock; only the holder may release.
func (s *Store) CancelEdit(ctx context.Context, f Family, identifier string, viewer *Viewer) error {
	row, err := s.resolveOwned(ctx, f, identifier, viewer)
	if err != nil {
		return err
	}
	if !rowBool(row, "is_editing") {
		return nil
	}
	if rowStr(row, "editing_by", "") != viewer.ID.String() {
		return &apiError{Status: 403, Detail: "You do not hold the edit lock on this item"}
	}
	_, err = s.DB.Exec(ctx, fmt.Sprintf(
		"UPDATE %s SET is_editing = FALSE, editing_since = NULL, editing_by = NULL WHERE id = $1",
		f.VersionTable), rowStr(row, "latest_version_id", ""))
	return err
}
