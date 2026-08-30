// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package agents serves the agent read plane: catalog listing, personal and
// lifecycle views, with row visibility shared with the component registry.
package agents

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/registry"
)

// Store answers agent read queries.
type Store struct {
	DB registry.PGQuerier
}

// ListParams are the catalog list filters.
type ListParams struct {
	Search                 string
	Namespace              string
	Category               string
	ProjectID              string
	ComposableForProjectID string
	PublicOnly             bool
	Limit                  int
	Offset                 int
}

// searchFields are the keyword targets in contract order.
var searchFields = []string{
	"a.name", "a.slug", "a.namespace", "a.owner", "a.category",
	"v.description", "v.model_name",
}

// summaryColumns feeds every summary view; component count and creator
// identity are resolved in the same statement.
const summaryColumns = `a.id::text AS id, a.name, a.namespace, a.slug, a.owner,
	a.project_id::text AS project_id, a.is_private, a.ownership_scope, a.category,
	a.created_by::text AS created_by, a.created_at, a.updated_at, a.deleted_at, a.scheduled_purge_at,
	v.version, v.description, v.status, v.rejection_reason,
	v.supported_harnesses, v.model_name, v.download_count,
	(SELECT count(*) FROM agent_components ac WHERE ac.agent_version_id = a.latest_version_id) AS component_count,
	u.email AS created_by_email, u.username AS created_by_username`

const fromJoined = `FROM agents a
	JOIN agent_versions v ON a.latest_version_id = v.id
	LEFT JOIN users u ON u.id = a.created_by`

const fromOptional = `FROM agents a
	LEFT JOIN agent_versions v ON a.latest_version_id = v.id
	LEFT JOIN users u ON u.id = a.created_by`

// buildList renders the catalog statement and its count twin.
func buildList(p ListParams, viewer *registry.Viewer) (listSQL, countSQL string, args []any) {
	where := []string{"v.status = 'approved'", "a.deleted_at IS NULL"}
	where = append(where, registry.ScopeSQL("a", "a.created_by", viewer, &args))
	switch {
	case p.PublicOnly:
		where = append(where, "a.is_private = FALSE")
	case p.ComposableForProjectID != "":
		args = append(args, p.ComposableForProjectID)
		where = append(where, fmt.Sprintf(
			"(a.is_private = FALSE OR (a.is_private = TRUE AND a.project_id = $%d))", len(args)))
	case p.ProjectID != "":
		args = append(args, p.ProjectID)
		where = append(where, fmt.Sprintf("a.project_id = $%d", len(args)))
	}
	if p.Namespace != "" {
		args = append(args, strings.ToLower(strings.TrimSpace(p.Namespace)))
		where = append(where, fmt.Sprintf("a.namespace = $%d", len(args)))
	}
	if p.Category != "" {
		args = append(args, p.Category)
		where = append(where, fmt.Sprintf("a.category = $%d", len(args)))
	}

	order := "a.created_at DESC"
	rankSelect := ""
	if terms := registry.KeywordTerms(p.Search); terms != nil {
		cond, rank := registry.KeywordSQL(terms, "a.name", searchFields, &args)
		where = append(where, cond)
		rankSelect = ", (" + rank + ") AS rank"
		order = "rank DESC, a.created_at DESC"
	}

	condition := strings.Join(where, " AND ")
	countSQL = "SELECT count(a.id) FROM agents a JOIN agent_versions v ON a.latest_version_id = v.id WHERE " + condition

	args = append(args, p.Limit)
	limitArg := len(args)
	args = append(args, p.Offset)
	listSQL = fmt.Sprintf("SELECT %s%s %s WHERE %s ORDER BY %s LIMIT $%d OFFSET $%d",
		summaryColumns, rankSelect, fromJoined, condition, order, limitArg, limitArg+1)
	return listSQL, countSQL, args
}

// List returns the visible approved agents plus the unpaginated total.
func (s *Store) List(ctx context.Context, p ListParams, viewer *registry.Viewer) ([]map[string]any, int, error) {
	listSQL, countSQL, args := buildList(p, viewer)
	var total int
	if err := s.DB.QueryRow(ctx, countSQL, args[:len(args)-2]...).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.DB.Query(ctx, listSQL, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	return registry.CollectRows(rows), total, rows.Err()
}

// Mine returns the caller's non-deleted agents, any status, newest first.
func (s *Store) Mine(ctx context.Context, viewer *registry.Viewer) ([]map[string]any, error) {
	args := []any{}
	scope := registry.ScopeSQL("a", "a.created_by", viewer, &args)
	args = append(args, viewer.ID)
	sql := fmt.Sprintf("SELECT %s %s WHERE a.created_by = $%d AND a.deleted_at IS NULL AND %s ORDER BY a.created_at DESC",
		summaryColumns, fromOptional, len(args), scope)
	rows, err := s.DB.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return registry.CollectRows(rows), rows.Err()
}

// Archived returns every agent whose latest version is archived.
func (s *Store) Archived(ctx context.Context) ([]map[string]any, error) {
	sql := fmt.Sprintf("SELECT %s %s WHERE v.status = 'archived' AND a.deleted_at IS NULL ORDER BY a.created_at DESC",
		summaryColumns, fromJoined)
	rows, err := s.DB.Query(ctx, sql)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return registry.CollectRows(rows), rows.Err()
}

// Deleted returns soft-deleted agents: all of them for admins, otherwise
// only the caller's own.
func (s *Store) Deleted(ctx context.Context, viewer *registry.Viewer, adminView bool, projectID *uuid.UUID) ([]map[string]any, error) {
	args := []any{}
	condition := "a.deleted_at IS NOT NULL"
	if !adminView {
		args = append(args, viewer.ID)
		viewerArg := len(args)
		condition += fmt.Sprintf(` AND (a.created_by = $%[1]d OR (
			a.ownership_scope <> 'private' AND a.project_id IS NOT NULL AND EXISTS (
				SELECT 1 FROM projects p
				LEFT JOIN organization_memberships om
				  ON om.organization_id = p.organization_id AND om.user_id = $%[1]d AND om.role IN ('owner', 'admin')
				LEFT JOIN project_memberships pm
				  ON pm.project_id = p.id AND pm.user_id = $%[1]d AND pm.role = 'lead'
				WHERE p.id = a.project_id AND (om.user_id IS NOT NULL OR pm.user_id IS NOT NULL)
			)
		))`, viewerArg)
	}
	if projectID != nil {
		args = append(args, *projectID)
		condition += fmt.Sprintf(" AND a.project_id = $%d", len(args))
	}
	sql := fmt.Sprintf("SELECT %s %s WHERE %s ORDER BY a.deleted_at DESC",
		summaryColumns, fromOptional, condition)
	rows, err := s.DB.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return registry.CollectRows(rows), rows.Err()
}
