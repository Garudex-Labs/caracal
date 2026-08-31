// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/garudex-labs/caracal/internal/tenancy"
)

// sourceWire is the component-source wire shape.
type sourceWire struct {
	ID               string  `json:"id"`
	URL              string  `json:"url"`
	Provider         string  `json:"provider"`
	ComponentType    string  `json:"component_type"`
	ProjectID        *string `json:"project_id"`
	Visibility       string  `json:"visibility"`
	AutoSyncInterval *string `json:"auto_sync_interval"`
	LastSyncedAt     any     `json:"last_synced_at"`
	SyncStatus       *string `json:"sync_status"`
	SyncError        *string `json:"sync_error"`
	CreatedAt        any     `json:"created_at"`
}

// isoDuration renders an interval the way the models serialize timedeltas.
func isoDuration(v any) *string {
	d, ok := v.(time.Duration)
	if !ok {
		return nil
	}
	s := fmt.Sprintf("PT%dS", int64(d.Seconds()))
	return &s
}

func sourceWireOf(row map[string]any) sourceWire {
	return sourceWire{
		ID:               rowStr(row, "id", ""),
		URL:              rowStr(row, "url", ""),
		Provider:         rowStr(row, "provider", ""),
		ComponentType:    rowStr(row, "component_type", ""),
		ProjectID:        rowNStr(row, "project_id"),
		Visibility:       "project",
		AutoSyncInterval: isoDuration(row["auto_sync_interval"]),
		LastSyncedAt:     wireTimeZ(row["last_synced_at"]),
		SyncStatus:       rowNStr(row, "sync_status"),
		SyncError:        rowNStr(row, "sync_error"),
		CreatedAt:        wireTimeZ(row["created_at"]),
	}
}

const sourceColumns = `id::text AS id, url, provider, component_type,
	project_id::text AS project_id, auto_sync_interval, last_synced_at, sync_status,
	sync_error, created_at`

// detectProvider infers the forge from the URL, defaulting to github.
func detectProvider(url string) string {
	lower := strings.ToLower(url)
	switch {
	case strings.Contains(lower, "gitlab"):
		return "gitlab"
	case strings.Contains(lower, "bitbucket"):
		return "bitbucket"
	}
	return "github"
}

// SourceCreate carries a validated add-source request.
type SourceCreate struct {
	URL           string
	ComponentType string
	Visibility    string
}

// AddSource registers a git source under the caller's publish target.
func (s *Store) AddSource(ctx context.Context, viewer *Viewer, req SourceCreate, ambient *uuid.UUID) (*sourceWire, error) {
	user, err := s.userFor(ctx, viewer)
	if err != nil {
		return nil, err
	}
	resolver := &tenancy.Resolver{DB: s.DB}
	target, err := resolver.ResolvePublishTarget(ctx, user, "source", tenancy.PublishOptions{
		Visibility: req.Visibility, ProjectID: ambient,
	})
	var tErr *tenancy.Error
	if errors.As(err, &tErr) {
		return nil, &apiError{Status: tErr.Status, Detail: tErr.Detail}
	}
	if err != nil {
		return nil, err
	}
	rows, err := s.DB.Query(ctx, `INSERT INTO component_sources
		(id, url, provider, component_type, project_id, created_at, updated_at)
		VALUES (gen_random_uuid(), $1, $2, $3, $4, now(), now())
		RETURNING `+sourceColumns,
		req.URL, detectProvider(req.URL), req.ComponentType, target.ProjectID)
	if err != nil {
		if isUniqueViolation(err) {
			return nil, &apiError{Status: 409, Detail: "Source with this URL and component type already exists"}
		}
		return nil, err
	}
	defer rows.Close()
	matches := collectRows(rows)
	if err := rows.Err(); err != nil {
		if isUniqueViolation(err) {
			return nil, &apiError{Status: 409, Detail: "Source with this URL and component type already exists"}
		}
		return nil, err
	}
	wire := sourceWireOf(matches[0])
	return &wire, nil
}

// ListSources returns public sources plus the caller's project-scoped ones;
// admins see everything.
func (s *Store) ListSources(ctx context.Context, viewer *Viewer, componentType string) ([]sourceWire, error) {
	args := []any{}
	where := []string{"TRUE"}
	if viewer != nil && viewer.ProjectID != "" {
		args = append(args, viewer.ProjectID)
		where = append(where, fmt.Sprintf("project_id = $%d", len(args)))
	}
	if componentType != "" {
		args = append(args, componentType)
		where = append(where, fmt.Sprintf("component_type = $%d", len(args)))
	}
	if !viewer.seesPrivateListings() {
		args = append(args, viewer.ID)
		where = append(where, fmt.Sprintf(`EXISTS (
			SELECT 1 FROM project_memberships pm WHERE pm.project_id = component_sources.project_id AND pm.user_id = $%d)`, len(args)))
	}
	rows, err := s.DB.Query(ctx, fmt.Sprintf(
		"SELECT %s FROM component_sources WHERE %s ORDER BY created_at DESC",
		sourceColumns, strings.Join(where, " AND ")), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []sourceWire{}
	for _, row := range collectRows(rows) {
		out = append(out, sourceWireOf(row))
	}
	return out, rows.Err()
}

// GetSource returns one source with the row-level visibility rule.
func (s *Store) GetSource(ctx context.Context, viewer *Viewer, sourceID uuid.UUID) (*sourceWire, error) {
	rows, err := s.DB.Query(ctx, fmt.Sprintf(
		"SELECT %s FROM component_sources WHERE id = $1", sourceColumns), sourceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	matches := collectRows(rows)
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(matches) == 0 {
		return nil, &apiError{Status: 404, Detail: "Source not found"}
	}
	row := matches[0]
	visible, err := s.sourceVisible(ctx, row, viewer)
	if err != nil {
		return nil, err
	}
	if !visible {
		return nil, &apiError{Status: 404, Detail: "Source not found"}
	}
	wire := sourceWireOf(row)
	return &wire, nil
}

func (s *Store) sourceVisible(ctx context.Context, row map[string]any, viewer *Viewer) (bool, error) {
	if viewer != nil && viewer.ProjectID != "" {
		projectID := rowNStr(row, "project_id")
		if projectID == nil || *projectID != viewer.ProjectID {
			return false, nil
		}
	}
	if viewer.seesPrivateListings() {
		return true, nil
	}
	projectID := rowNStr(row, "project_id")
	if projectID == nil {
		return false, nil
	}
	pid, perr := uuid.Parse(*projectID)
	if perr != nil {
		return false, nil
	}
	var membership uuid.UUID
	err := s.DB.QueryRow(ctx,
		"SELECT user_id FROM project_memberships WHERE project_id = $1 AND user_id = $2", pid, viewer.ID).Scan(&membership)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// DeleteSource removes a source; project-scoped sources require a project
// lead, and everything else an administrator.
func (s *Store) DeleteSource(ctx context.Context, viewer *Viewer, sourceID uuid.UUID) error {
	rows, err := s.DB.Query(ctx, fmt.Sprintf(
		"SELECT %s FROM component_sources WHERE id = $1", sourceColumns), sourceID)
	if err != nil {
		return err
	}
	defer rows.Close()
	matches := collectRows(rows)
	if err := rows.Err(); err != nil {
		return err
	}
	if len(matches) == 0 {
		return &apiError{Status: 404, Detail: "Source not found"}
	}
	row := matches[0]
	visible, err := s.sourceVisible(ctx, row, viewer)
	if err != nil {
		return err
	}
	if !visible {
		return &apiError{Status: 404, Detail: "Source not found"}
	}
	if !viewer.seesPrivateListings() {
		role := ""
		if projectID := rowNStr(row, "project_id"); projectID != nil {
			resolver := &tenancy.Resolver{DB: s.DB}
			id, _ := uuid.Parse(*projectID)
			role, _, err = resolver.ProjectRole(ctx, id, viewer.ID)
			if err != nil {
				return err
			}
		}
		if role != "lead" {
			return &apiError{Status: 403, Detail: "Only project leads and admins can delete this source"}
		}
	}
	_, err = s.DB.Exec(ctx, "DELETE FROM component_sources WHERE id = $1", sourceID)
	return err
}
