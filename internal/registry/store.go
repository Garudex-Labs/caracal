// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// PGQuerier is the subset of a pgx pool the registry needs.
type PGQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Store answers registry read queries.
type Store struct {
	DB PGQuerier
	// CH answers the profile-mining queries behind recommendations.
	CH CHQuerier
	// Publish announces review decisions on the live channel.
	Publish EventPublisher
}

// EventPublisher is the live-event fan-out surface the store needs.
type EventPublisher interface {
	Publish(ctx context.Context, channel string, payload map[string]string)
}

// ListParams are the shared list filters.
type ListParams struct {
	Namespace              string
	Search                 string
	ComposableForProjectID string // uuid; publish-scope filter
	PublicOnly             bool
	Limit                  int
	Offset                 int
	// Extra holds family-specific equality filters keyed by parameter name.
	Extra map[string]string
	// Harness is the skill-only JSON containment filter.
	Harness string
	// TargetAgent is the skill-only keyword filter.
	TargetAgent string
}

// selectColumns lists every column the summaries need; per-family extras are
// resolved by name from the scanned row.
func selectColumns(f Family) string {
	cols := []string{
		"l.id::text AS id", "l.name", "l.namespace", "l.slug", "l.owner", "l.project_id::text AS project_id",
		"l.is_private", "l.ownership_scope", "l.updated_at", "l.created_at",
		"v.version", "v.description", "v.status", "v.rejection_reason", "v.supported_harnesses",
	}
	switch f.Prefix {
	case "mcps":
		cols = append(cols, "l.category")
	case "skills":
		cols = append(cols, "v.task_type", "v.target_agents")
	case "hooks":
		cols = append(cols, "v.event", "v.scope")
	case "prompts":
		cols = append(cols, "v.category")
	case "sandboxes":
		cols = append(cols, "v.runtime_type", "v.image", "v.resource_limits", "v.network_policy",
			"v.entrypoint", "v.runtime_config", "v.source_url", "v.source_ref", "v.sandbox_path")
	}
	return strings.Join(cols, ", ")
}

// buildListQuery renders the filtered list statement and its count twin.
func buildListQuery(f Family, p ListParams, viewer *Viewer) (listSQL, countSQL string, args []any) {
	where := []string{"v.status = 'approved'"}

	where = append(where, visibilitySQL("l", viewer, &args))
	switch {
	case p.PublicOnly:
		where = append(where, "l.is_private = FALSE")
	case p.ComposableForProjectID != "":
		args = append(args, p.ComposableForProjectID)
		where = append(where, fmt.Sprintf(
			"(l.is_private = FALSE OR (l.is_private = TRUE AND l.ownership_scope != 'private' AND l.project_id = $%d))", len(args)))
	}
	if p.Namespace != "" {
		args = append(args, strings.ToLower(strings.TrimSpace(p.Namespace)))
		where = append(where, fmt.Sprintf("l.namespace = $%d", len(args)))
	}
	for param, template := range f.ListFilters {
		if value := p.Extra[param]; value != "" {
			args = append(args, value)
			where = append(where, fmt.Sprintf(template, fmt.Sprintf("$%d", len(args))))
		}
	}
	if f.Prefix == "skills" {
		if p.Harness != "" {
			args = append(args, `%"`+escapeLike(p.Harness)+`"%`)
			where = append(where, fmt.Sprintf("v.supported_harnesses::text ILIKE $%d", len(args)))
		}
		if p.TargetAgent != "" {
			if terms := searchTerms(p.TargetAgent); terms != nil {
				cond, _ := searchSQL(terms, "l.name", []string{"v.target_agents::text"}, &args)
				where = append(where, cond)
			}
		}
	}

	order := "l.created_at DESC"
	rankSelect := ""
	if terms := searchTerms(p.Search); terms != nil {
		cond, rank := searchSQL(terms, "l.name", f.SearchFields, &args)
		where = append(where, cond)
		rankSelect = ", (" + rank + ") AS rank"
		order = "rank DESC, l.created_at DESC"
	}

	from := fmt.Sprintf("FROM %s l JOIN %s v ON l.latest_version_id = v.id WHERE %s",
		f.ListingTable, f.VersionTable, strings.Join(where, " AND "))
	countSQL = "SELECT count(*) " + from

	args = append(args, p.Limit)
	limitArg := len(args)
	args = append(args, p.Offset)
	listSQL = fmt.Sprintf("SELECT %s%s %s ORDER BY %s LIMIT $%d OFFSET $%d",
		selectColumns(f), rankSelect, from, order, limitArg, limitArg+1)
	return listSQL, countSQL, args
}

// List returns the visible approved rows plus the unpaginated total.
func (s *Store) List(ctx context.Context, f Family, p ListParams, viewer *Viewer) ([]map[string]any, int, error) {
	listSQL, countSQL, args := buildListQuery(f, p, viewer)

	var total int
	if err := s.DB.QueryRow(ctx, countSQL, args[:len(args)-2]...).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.DB.Query(ctx, listSQL, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	return collectRows(rows), total, rows.Err()
}

// Mine returns everything the caller submitted, any status, newest first.
func (s *Store) Mine(ctx context.Context, f Family, viewer *Viewer) ([]map[string]any, error) {
	args := []any{}
	visibility := visibilitySQL("l", viewer, &args)
	args = append(args, viewer.ID)
	sql := fmt.Sprintf(`SELECT %s FROM %s l
		LEFT JOIN %s v ON l.latest_version_id = v.id
		WHERE l.submitted_by = $%d AND %s
		ORDER BY l.created_at DESC`,
		selectColumns(f), f.ListingTable, f.VersionTable, len(args), visibility)
	rows, err := s.DB.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return collectRows(rows), rows.Err()
}

// collectRows materializes pgx rows into column-keyed maps.
func collectRows(rows pgx.Rows) []map[string]any {
	fields := rows.FieldDescriptions()
	out := []map[string]any{}
	for rows.Next() {
		values, err := rows.Values()
		if err != nil {
			continue
		}
		row := make(map[string]any, len(fields))
		for i, fd := range fields {
			row[fd.Name] = values[i]
		}
		out = append(out, row)
	}
	return out
}
