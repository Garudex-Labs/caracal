// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/google/uuid"
)

var (
	namespaceRE = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,30}[a-z0-9]$`)
	slugRE      = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
)

// maxBareNameMatches caps legacy bare-name candidates named in a 409.
const maxBareNameMatches = 6

// ErrAmbiguous carries the legacy bare-name collision report.
type ErrAmbiguous struct {
	Label   string
	Choices []string
}

func (e *ErrAmbiguous) Error() string {
	return fmt.Sprintf("'%s' is ambiguous; use one of: %s", e.Label, strings.Join(e.Choices, ", "))
}

// namespaceSlugParts splits a canonical namespace/slug reference, reserved
// names allowed on the read path.
func namespaceSlugParts(identifier string) (string, string, bool) {
	value := strings.ToLower(strings.TrimSpace(identifier))
	if strings.Count(value, "/") != 1 {
		return "", "", false
	}
	parts := strings.SplitN(value, "/", 2)
	ns, slug := parts[0], parts[1]
	if strings.Contains(ns, "..") || !namespaceRE.MatchString(ns) || !slugRE.MatchString(slug) {
		return "", "", false
	}
	return ns, slug, true
}

// detailColumns is the show/resolve select list: everything the family's
// detail shape needs, plus the permission inputs.
func detailColumns(f Family) string {
	cols := []string{
		"l.id::text AS id", "l.name", "l.namespace", "l.slug", "l.owner",
		"l.is_private", "l.ownership_scope", "l.submitted_by::text AS submitted_by", "l.co_authors",
		"l.created_at", "l.updated_at", "l.latest_version_id::text AS latest_version_id",
		"l.project_id::text AS project_id", "l.bundle_id::text AS bundle_id",
		"v.version", "v.description", "v.status", "v.rejection_reason", "v.supported_harnesses",
		"v.download_count", "v.is_editing", "v.editing_by::text AS editing_by", "v.editing_since",
	}
	switch f.Prefix {
	case "mcps":
		cols = append(cols, "l.category", "v.source_url", "v.environment_variables", "v.setup_instructions",
			"v.changelog", "v.framework", "v.docker_image", "v.command", "v.args", "v.url",
			"v.headers", "v.auto_approve", "v.mcp_validated")
	case "skills":
		cols = append(cols, "v.task_type", "v.target_agents", "v.skill_path", "v.git_url", "v.git_ref",
			"v.skill_md_content", "v.delivery_mode", "v.script_content", "v.script_filename",
			"v.validated", "v.slash_command")
	case "hooks":
		cols = append(cols, "v.event", "v.execution_mode", "v.priority", "v.handler_type",
			"v.handler_config", "v.scope", "v.script_content", "v.script_filename")
	case "prompts":
		cols = append(cols, "v.category", "v.template", "v.variables", "v.tags")
	}
	return strings.Join(cols, ", ")
}

// Resolve finds one visible listing by UUID, canonical namespace/slug, or
// unambiguous legacy bare name. A listing the viewer may not see resolves to
// nil exactly as a nonexistent one does; a bare-name collision among visible
// listings returns ErrAmbiguous naming only what the viewer may see.
func (s *Store) Resolve(ctx context.Context, f Family, identifier string, viewer *Viewer, approvedOnly bool) (map[string]any, error) {
	value := strings.TrimSpace(identifier)
	args := []any{}
	where := []string{}
	bare := false

	if id, err := uuid.Parse(value); err == nil {
		args = append(args, id.String())
		where = append(where, fmt.Sprintf("l.id = $%d", len(args)))
	} else if ns, slug, ok := namespaceSlugParts(value); ok {
		args = append(args, ns)
		where = append(where, fmt.Sprintf("l.namespace = $%d", len(args)))
		args = append(args, slug)
		where = append(where, fmt.Sprintf("l.slug = $%d", len(args)))
	} else {
		bare = true
		args = append(args, strings.ToLower(value))
		lower := len(args)
		args = append(args, value)
		where = append(where, fmt.Sprintf("(l.slug = $%d OR l.name = $%d)", lower, len(args)))
	}

	join := "LEFT JOIN"
	if approvedOnly {
		join = "JOIN"
		where = append(where, "v.status = 'approved'")
	}
	where = append(where, visibilitySQL("l", viewer, &args))

	limit := 2
	if bare {
		limit = maxBareNameMatches
	}
	sql := fmt.Sprintf("SELECT %s FROM %s l %s %s v ON l.latest_version_id = v.id WHERE %s LIMIT %d",
		detailColumns(f), f.ListingTable, join, f.VersionTable, strings.Join(where, " AND "), limit)

	rows, err := s.DB.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	matches := collectRows(rows)
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if bare && len(matches) > 1 {
		choices := make([]string, 0, len(matches))
		for _, m := range matches {
			choices = append(choices, rowStr(m, "namespace", "")+"/"+rowStr(m, "slug", ""))
		}
		return nil, &ErrAmbiguous{Label: value, Choices: choices}
	}
	if len(matches) == 0 {
		return nil, nil
	}
	return matches[0], nil
}

// ErrNotFound reports a listing the viewer cannot resolve.
var ErrNotFound = errors.New("listing not found")

// Show resolves the detail row with the approved-first, unapproved-fallback
// gate and computes the viewer's effective permission.
func (s *Store) Show(ctx context.Context, f Family, identifier string, viewer *Viewer) (map[string]any, string, error) {
	row, err := s.Resolve(ctx, f, identifier, viewer, true)
	if err != nil {
		return nil, "", err
	}
	if row == nil {
		row, err = s.Resolve(ctx, f, identifier, viewer, false)
		if err != nil {
			return nil, "", err
		}
		if row == nil {
			return nil, "", ErrNotFound
		}
		if !mayViewUnapproved(rowPermission(row, viewer), viewer) {
			return nil, "", ErrNotFound
		}
	}
	return row, rowPermission(row, viewer), nil
}

// rowPermission adapts a scanned row to the effective-permission contract.
func rowPermission(row map[string]any, viewer *Viewer) string {
	submittedBy, _ := uuid.Parse(rowStr(row, "submitted_by", ""))
	coAuthors := []string{}
	for _, v := range rowList(row, "co_authors") {
		if s, ok := v.(string); ok {
			coAuthors = append(coAuthors, s)
		}
	}
	return EffectivePermission(submittedBy, coAuthors, viewer)
}

// ValidationResults returns the mcp validation history rows for show.
func (s *Store) ValidationResults(ctx context.Context, listingID string) ([]map[string]any, error) {
	rows, err := s.DB.Query(ctx,
		"SELECT stage, passed, details, run_at FROM mcp_validation_results WHERE listing_id = $1", listingID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return collectRows(rows), rows.Err()
}
