// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/registry"
	"github.com/garudex-labs/caracal/internal/tenancy"
)

// ErrAmbiguous reports a bare-name reference matching several agents.
type ErrAmbiguous struct {
	Label   string
	Choices []string
}

func (e *ErrAmbiguous) Error() string {
	return fmt.Sprintf("'%s' is ambiguous; use one of: %s", e.Label, strings.Join(e.Choices, ", "))
}

var (
	agentNamespaceRE = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,30}[a-z0-9]$`)
	agentSlugRE      = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
)

func namespaceSlugParts(identifier string) (string, string, bool) {
	value := strings.ToLower(strings.TrimSpace(identifier))
	if strings.Count(value, "/") != 1 {
		return "", "", false
	}
	parts := strings.SplitN(value, "/", 2)
	ns, slug := parts[0], parts[1]
	if strings.Contains(ns, "..") || !agentNamespaceRE.MatchString(ns) || !agentSlugRE.MatchString(slug) {
		return "", "", false
	}
	return ns, slug, true
}

// detailColumns carries every response input: the agent row, the latest
// version delegates, the newest approved version, creator identity, and the
// caller's row visibility evaluated in the same statement.
func detailColumns(viewer *registry.Viewer, args *[]any) string {
	visible := registry.ScopeSQL("a", "a.created_by", viewer, args)
	return `a.id::text AS id, a.name, a.namespace, a.slug, a.owner,
	a.project_id::text AS project_id, a.is_private, a.ownership_scope, a.co_authors,
	a.created_by::text AS created_by, a.created_at, a.updated_at, a.deleted_at, a.scheduled_purge_at,
	a.latest_version_id::text AS latest_version_id,
	v.version, v.description, v.prompt, v.model_name, v.model_config_json,
	v.models_by_harness, v.external_mcps, v.supported_harnesses,
	v.required_capabilities, v.inferred_supported_harnesses, v.success_criteria,
	v.status, v.rejection_reason,
	(SELECT v2.version FROM agent_versions v2
		WHERE v2.agent_id = a.id AND v2.status = 'approved'
		ORDER BY v2.created_at DESC LIMIT 1) AS latest_approved_version,
	u.email AS created_by_email, u.username AS created_by_username,
	(` + visible + `) AS row_visible`
}

// permission mirrors the effective agent permission: creator, co-authors,
// and admins own; everyone else views.
func permission(row map[string]any, viewer *registry.Viewer) string {
	if viewer == nil {
		return "view"
	}
	if rowStr(row, "created_by", "") == viewer.ID.String() {
		return "owner"
	}
	for _, id := range rowList(row, "co_authors") {
		if s, ok := id.(string); ok && s == viewer.ID.String() {
			return "owner"
		}
	}
	return "view"
}

func mayViewUnapproved(perm string, viewer *registry.Viewer) bool {
	return perm == "owner" || (viewer != nil && tenancy.IsGlobalReviewer(viewer.Role))
}

// LoadOpts tune the identity gate for lifecycle routes.
type LoadOpts struct {
	// PreferOwner lets the creator reach their own unapproved agent.
	PreferOwner bool
	// AllStatuses skips the approved gate (unarchive, delete, restore).
	AllStatuses bool
	// IncludeDeleted also finds soft-deleted agents (restore).
	IncludeDeleted bool
}

// Load resolves an agent by UUID, unique id prefix, canonical
// namespace/slug, or legacy bare name, applying the caller's visibility and
// the unapproved-content gate. A nil row means not found.
func (s *Store) Load(ctx context.Context, identifier string, viewer *registry.Viewer, preferOwner bool) (map[string]any, error) {
	return s.LoadWith(ctx, identifier, viewer, LoadOpts{PreferOwner: preferOwner})
}

func (s *Store) LoadWith(ctx context.Context, identifier string, viewer *registry.Viewer, opts LoadOpts) (map[string]any, error) {
	norm := strings.ToLower(strings.TrimSpace(identifier))
	deletedFilter := " AND a.deleted_at IS NULL"
	if opts.IncludeDeleted {
		deletedFilter = ""
	}

	// Direct identity: exact UUID, or a unique id prefix of at least four
	// characters. Failed resolution falls through to name identity.
	var idCondition string
	idArgs := []any{}
	if _, err := uuid.Parse(norm); err == nil {
		idArgs = append(idArgs, norm)
		idCondition = "a.id = $%d"
	} else if len(norm) >= 4 && !strings.Contains(norm, "/") {
		idArgs = append(idArgs, likePrefix(norm))
		idCondition = "a.id::text LIKE $%d"
	}
	if idCondition != "" {
		args := []any{}
		cols := detailColumns(viewer, &args)
		args = append(args, idArgs...)
		sql := fmt.Sprintf(`SELECT %s FROM agents a
			LEFT JOIN agent_versions v ON a.latest_version_id = v.id
			LEFT JOIN users u ON u.id = a.created_by
			WHERE `+idCondition+deletedFilter+` LIMIT 2`, cols, len(args))
		rows, err := s.DB.Query(ctx, sql, args...)
		if err != nil {
			return nil, err
		}
		matches := registry.CollectRows(rows)
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		if len(matches) == 1 {
			row := matches[0]
			if !rowBool(row, "row_visible") {
				return nil, nil
			}
			if !opts.AllStatuses && rowStr(row, "status", "draft") != "approved" {
				perm := permission(row, viewer)
				ownerException := opts.PreferOwner && viewer != nil && rowStr(row, "created_by", "") == viewer.ID.String()
				if !mayViewUnapproved(perm, viewer) && !ownerException {
					return nil, nil
				}
			}
			return row, nil
		}
	}

	// Name identity: canonical namespace/slug, else bare slug or exact name
	// with the ambiguity guard.
	args := []any{}
	cols := detailColumns(viewer, &args)
	var identity string
	if ns, slug, ok := namespaceSlugParts(identifier); ok {
		args = append(args, ns, slug)
		identity = fmt.Sprintf("(a.namespace = $%d AND a.slug = $%d)", len(args)-1, len(args))
	} else {
		args = append(args, norm, identifier)
		identity = fmt.Sprintf("(a.slug = $%d OR a.name = $%d)", len(args)-1, len(args))
	}
	statusGate := "v.status = 'approved'"
	if opts.AllStatuses {
		statusGate = "TRUE"
	} else if opts.PreferOwner {
		args = append(args, viewer.ID)
		statusGate = fmt.Sprintf("(v.status = 'approved' OR a.created_by = $%d)", len(args))
	}
	visibleArgs := []any{}
	scope := registry.ScopeSQL("a", "a.created_by", viewer, &visibleArgs)
	if len(visibleArgs) > 0 {
		args = append(args, viewer.ID)
		// The scope binding must share the statement's placeholder numbering.
		scope = strings.ReplaceAll(scope, "$1", fmt.Sprintf("$%d", len(args)))
	}
	sql := fmt.Sprintf(`SELECT %s FROM agents a
		JOIN agent_versions v ON a.latest_version_id = v.id
		LEFT JOIN users u ON u.id = a.created_by
		WHERE %s AND %s%s AND %s LIMIT 2`,
		cols, identity, statusGate, deletedFilter, scope)
	rows, err := s.DB.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	matches := registry.CollectRows(rows)
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if _, _, canonical := namespaceSlugParts(identifier); !canonical && len(matches) > 1 {
		choices := make([]string, 0, len(matches))
		for _, m := range matches {
			choices = append(choices, rowStr(m, "namespace", "")+"/"+rowStr(m, "slug", ""))
		}
		return nil, &ErrAmbiguous{Label: identifier, Choices: choices}
	}
	if len(matches) == 0 {
		return nil, nil
	}
	return matches[0], nil
}

func likePrefix(s string) string {
	// The incumbent matches the raw prefix, wildcards included.
	return s + "%"
}

// Components returns the latest version's component links in order, plus
// resolved name, identity, and current status per referenced listing.
func (s *Store) Components(ctx context.Context, latestVersionID string) ([]map[string]any, error) {
	if latestVersionID == "" {
		return []map[string]any{}, nil
	}
	rows, err := s.DB.Query(ctx, `SELECT component_type, component_id::text AS component_id,
		component_name, resolved_version, order_index, config_override
		FROM agent_components WHERE agent_version_id = $1
		ORDER BY order_index, created_at, id`, latestVersionID)
	if err != nil {
		return nil, err
	}
	links := registry.CollectRows(rows)
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	byType := map[string][]string{}
	for _, link := range links {
		t := rowStr(link, "component_type", "")
		byType[t] = append(byType[t], rowStr(link, "component_id", ""))
	}
	for _, f := range registry.Families {
		ids := byType[f.Name]
		if len(ids) == 0 {
			continue
		}
		sql := fmt.Sprintf(`SELECT l.id::text AS id, l.name, l.namespace, l.slug, v.status
			FROM %s l LEFT JOIN %s v ON l.latest_version_id = v.id
			WHERE l.id = ANY($1)`, f.ListingTable, f.VersionTable)
		refRows, err := s.DB.Query(ctx, sql, ids)
		if err != nil {
			return nil, err
		}
		refs := registry.CollectRows(refRows)
		refRows.Close()
		if err := refRows.Err(); err != nil {
			return nil, err
		}
		byID := map[string]map[string]any{}
		for _, ref := range refs {
			byID[rowStr(ref, "id", "")] = ref
		}
		for _, link := range links {
			if rowStr(link, "component_type", "") != f.Name {
				continue
			}
			if ref, ok := byID[rowStr(link, "component_id", "")]; ok {
				link["ref_name"] = ref["name"]
				link["ref_namespace"] = ref["namespace"]
				link["ref_slug"] = ref["slug"]
				link["ref_status"] = ref["status"]
			}
		}
	}
	return links, nil
}
