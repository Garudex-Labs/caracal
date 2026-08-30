// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/tenancy"
)

// reviewFamilies iterates the component families in the canonical order the
// incumbent's model map declared.
var reviewFamilies = []string{"mcps", "skills", "hooks", "prompts", "sandboxes"}

const reviewEditLockTTL = 30 * time.Minute

// rowActivelyEditing mirrors the editing-lock freshness rule on a version row.
// editing_by arrives as raw uuid bytes under SELECT *, so only nilness counts.
func rowActivelyEditing(row map[string]any) bool {
	if !rowBool(row, "is_editing") {
		return false
	}
	if row["editing_by"] == nil {
		return false
	}
	since, ok := row["editing_since"].(time.Time)
	if !ok {
		return false
	}
	return time.Since(since) <= reviewEditLockTTL
}

// reviewScopeFor resolves the caller's review capability, refusing callers
// who hold none.
func (s *Store) reviewScopeFor(ctx context.Context, viewer *Viewer) (tenancy.ReviewScope, error) {
	resolver := &tenancy.Resolver{DB: s.DB}
	scope, err := resolver.ReviewScopeFor(ctx, tenancy.User{ID: viewer.ID, Role: viewer.Role})
	if err != nil {
		return scope, err
	}
	if scope.IsEmpty() {
		return scope, &apiError{Status: 403, Detail: "Insufficient permissions"}
	}
	return scope, nil
}

// rowProjectID reads an optional project id column.
func rowProjectID(row map[string]any, key string) *uuid.UUID {
	raw := rowNStr(row, key)
	if raw == nil {
		return nil
	}
	parsed, err := uuid.Parse(*raw)
	if err != nil {
		return nil
	}
	return &parsed
}

// authorizeReviewItem answers 404 for hidden project-private items and a scoped
// 403 for public ones, matching the read paths.
func authorizeReviewItem(row map[string]any, scope tenancy.ReviewScope) *apiError {
	if scope.CanReview(rowProjectID(row, "project_id"), rowBool(row, "is_private")) {
		return nil
	}
	if rowBool(row, "is_private") {
		return &apiError{Status: 404, Detail: "Submission not found"}
	}
	return &apiError{Status: 403, Detail: "Public item is outside your review scope"}
}

// inReviewScope is the queue-membership rule with the optional project filter.
func inReviewScope(row map[string]any, scope tenancy.ReviewScope, projectFilter *uuid.UUID) bool {
	if !scope.CanReview(rowProjectID(row, "project_id"), rowBool(row, "is_private")) {
		return false
	}
	if projectFilter == nil {
		return true
	}
	projectID := rowProjectID(row, "project_id")
	return projectID != nil && *projectID == *projectFilter
}

// checkProjectFilter rejects narrowing to a project outside the caller's scope.
func checkProjectFilter(projectFilter *uuid.UUID, scope tenancy.ReviewScope) *apiError {
	if projectFilter == nil || scope.IsGlobalReviewer || scope.ProjectIDs[*projectFilter] {
		return nil
	}
	return &apiError{Status: 403, Detail: "You do not review for this project"}
}

// findReviewListing resolves an id, unique prefix, or exact name across all
// component families, with the incumbent's exact conflict answers.
func (s *Store) findReviewListing(ctx context.Context, identifier string) (Family, map[string]any, error) {
	norm := strings.ToLower(strings.TrimSpace(identifier))
	type hit struct {
		family Family
		row    map[string]any
	}
	hits := []hit{}
	_, isUUID := func() (uuid.UUID, bool) {
		u, err := uuid.Parse(norm)
		return u, err == nil
	}()

	fetch := func(f Family, where string, args ...any) ([]map[string]any, error) {
		rows, err := s.DB.Query(ctx, fmt.Sprintf(
			`SELECT %s FROM %s l LEFT JOIN %s v ON l.latest_version_id = v.id WHERE %s`,
			detailColumns(f), f.ListingTable, f.VersionTable, where), args...)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		return collectRows(rows), rows.Err()
	}

	for _, prefix := range reviewFamilies {
		f := Families[prefix]
		if isUUID {
			matches, err := fetch(f, "l.id = $1", norm)
			if err != nil {
				return Family{}, nil, err
			}
			if len(matches) == 1 {
				hits = append(hits, hit{f, matches[0]})
			}
			continue
		}
		if len(norm) < 4 {
			continue // too short for a prefix; the name fallback still runs
		}
		matches, err := fetch(f, "l.id::text LIKE $1", norm+"%")
		if err != nil {
			return Family{}, nil, err
		}
		if len(matches) == 1 {
			hits = append(hits, hit{f, matches[0]})
		} else if len(matches) > 1 {
			labels := make([]string, 0, 5)
			for i, m := range matches {
				if i == 5 {
					break
				}
				label := rowStr(m, "name", "")
				if label == "" {
					label = "unnamed"
				}
				labels = append(labels, fmt.Sprintf("%s (%s...)", label, rowStr(m, "id", "")[:13]))
			}
			detail := fmt.Sprintf("Ambiguous prefix '%s' matches %d records: %s",
				norm, len(matches), strings.Join(labels, ", "))
			if len(matches) > 5 {
				detail += " and more..."
			}
			return Family{}, nil, &apiError{Status: 400, Detail: detail}
		}
	}

	if len(hits) == 1 {
		return hits[0].family, hits[0].row, nil
	}
	if len(hits) > 1 {
		types := make([]string, 0, len(hits))
		for _, h := range hits {
			types = append(types, h.family.Name)
		}
		return Family{}, nil, &apiError{Status: 400,
			Detail: fmt.Sprintf("Prefix '%s' matches records across multiple types: %s", identifier, strings.Join(types, ", "))}
	}

	for _, prefix := range reviewFamilies {
		f := Families[prefix]
		matches, err := fetch(f, "l.name = $1", identifier)
		if err != nil {
			return Family{}, nil, err
		}
		if len(matches) > 0 {
			return f, matches[0], nil
		}
	}
	return Family{}, nil, nil
}

// usernameMap resolves user ids to display handles (username, else email).
func (s *Store) usernameMap(ctx context.Context, ids map[string]bool) (map[string]string, error) {
	out := map[string]string{}
	if len(ids) == 0 {
		return out, nil
	}
	list := make([]string, 0, len(ids))
	for id := range ids {
		list = append(list, id)
	}
	rows, err := s.DB.Query(ctx,
		`SELECT id::text, COALESCE(NULLIF(username, ''), email) FROM users WHERE id = ANY($1::uuid[])`, list)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		out[id] = name
	}
	return out, rows.Err()
}

// validationResultRows reads an MCP listing's validation history.
func (s *Store) validationResultRows(ctx context.Context, listingID string) ([]map[string]any, error) {
	rows, err := s.DB.Query(ctx,
		`SELECT stage, passed, details, run_at FROM mcp_validation_results
		 WHERE listing_id = $1 ORDER BY run_at`, listingID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var stage string
		var passed bool
		var details *string
		var runAt *time.Time
		if err := rows.Scan(&stage, &passed, &details, &runAt); err != nil {
			return nil, err
		}
		entry := map[string]any{"stage": stage, "passed": passed, "details": details, "run_at": nil}
		if runAt != nil {
			entry["run_at"] = wireTimePlus(*runAt)
		}
		out = append(out, entry)
	}
	return out, rows.Err()
}

// PendingComponents lists the newest pending version of every listing in the
// caller's review scope.
func (s *Store) PendingComponents(ctx context.Context, scope tenancy.ReviewScope, typeFilter string, projectFilter *uuid.UUID) ([]map[string]any, error) {
	families := reviewFamilies
	if typeFilter != "" {
		for _, prefix := range reviewFamilies {
			if Families[prefix].Name == typeFilter {
				families = []string{prefix}
				break
			}
		}
	}
	items := []map[string]any{}
	userIDs := map[string]bool{}
	for _, prefix := range families {
		f := Families[prefix]
		rows, err := s.DB.Query(ctx, fmt.Sprintf(
			`SELECT *, id::text AS id, listing_id::text AS listing_id
			 FROM %s WHERE status = 'pending' ORDER BY released_at DESC`, f.VersionTable))
		if err != nil {
			return nil, err
		}
		pending := collectRows(rows)
		rows.Close()
		newest := map[string]map[string]any{}
		order := []string{}
		for _, pv := range pending {
			lid := rowStr(pv, "listing_id", "")
			if _, seen := newest[lid]; !seen && !rowActivelyEditing(pv) {
				newest[lid] = pv
				order = append(order, lid)
			}
		}
		if len(order) == 0 {
			continue
		}
		lrows, err := s.DB.Query(ctx, fmt.Sprintf(
			`SELECT %s FROM %s l LEFT JOIN %s v ON l.latest_version_id = v.id WHERE l.id = ANY($1::uuid[])`,
			detailColumns(f), f.ListingTable, f.VersionTable), order)
		if err != nil {
			return nil, err
		}
		listings := map[string]map[string]any{}
		for _, row := range collectRows(lrows) {
			if inReviewScope(row, scope, projectFilter) {
				listings[rowStr(row, "id", "")] = row
			}
		}
		lrows.Close()

		for _, lid := range order {
			listing, visible := listings[lid]
			if !visible {
				continue
			}
			pv := newest[lid]
			userIDs[rowStr(listing, "submitted_by", "")] = true
			createdAt := wireTimePlus(pv["created_at"])
			if createdAt == nil {
				createdAt = wireTimePlus(listing["created_at"])
			}
			description := rowStr(pv, "description", "")
			if description == "" {
				description = rowStr(listing, "description", "")
			}
			item := map[string]any{
				"type":         f.Name,
				"id":           lid,
				"name":         rowStr(listing, "name", ""),
				"description":  description,
				"version":      rowStr(pv, "version", ""),
				"owner":        rowStr(listing, "owner", ""),
				"status":       rowStr(pv, "status", ""),
				"submitted_by": rowStr(listing, "submitted_by", ""),
				"created_at":   createdAt,
				"bundle_id":    rowNStr(listing, "bundle_id"),
			}
			if f.Prefix == "mcps" {
				item["mcp_validated"] = rowBool(listing, "mcp_validated")
				results, err := s.validationResultRows(ctx, lid)
				if err != nil {
					return nil, err
				}
				item["validation_results"] = results
			}
			items = append(items, item)
		}
	}

	// Bundle names decorate items that belong to one.
	bundleIDs := map[string]bool{}
	for _, item := range items {
		if b, ok := item["bundle_id"].(*string); ok && b != nil {
			bundleIDs[*b] = true
		}
	}
	if len(bundleIDs) > 0 {
		ids := make([]string, 0, len(bundleIDs))
		for id := range bundleIDs {
			ids = append(ids, id)
		}
		rows, err := s.DB.Query(ctx,
			`SELECT id::text, name FROM component_bundles WHERE id = ANY($1::uuid[])`, ids)
		if err != nil {
			return nil, err
		}
		names := map[string]string{}
		for rows.Next() {
			var id, name string
			if err := rows.Scan(&id, &name); err != nil {
				rows.Close()
				return nil, err
			}
			names[id] = name
		}
		rows.Close()
		for _, item := range items {
			if b, ok := item["bundle_id"].(*string); ok && b != nil {
				item["bundle_name"] = names[*b]
			}
		}
	}

	users, err := s.usernameMap(ctx, userIDs)
	if err != nil {
		return nil, err
	}
	for _, item := range items {
		uid := item["submitted_by"].(string)
		if name, known := users[uid]; known {
			item["submitted_by"] = name
		}
	}
	return items, nil
}

// agentVersionComponents lists one agent version's component links.
func (s *Store) agentVersionComponents(ctx context.Context, versionID string) ([]map[string]any, error) {
	rows, err := s.DB.Query(ctx,
		`SELECT component_type, component_id::text AS component_id, COALESCE(component_name, '') AS component_name
		 FROM agent_components WHERE agent_version_id = $1 ORDER BY order_index`, versionID)
	if err != nil {
		return nil, err
	}
	matches := collectRows(rows)
	rows.Close()
	return matches, nil
}

// agentComponentsReady checks whether every component of an agent version is
// approved, returning the blockers.
func (s *Store) agentComponentsReady(ctx context.Context, components []map[string]any) (bool, []map[string]any, error) {
	blocking := []map[string]any{}
	byType := map[string][]string{}
	for _, comp := range components {
		ctype, _ := comp["component_type"].(string)
		cid, _ := comp["component_id"].(string)
		if ctype != "" && cid != "" {
			byType[ctype] = append(byType[ctype], cid)
		}
	}
	types := make([]string, 0, len(byType))
	for t := range byType {
		types = append(types, t)
	}
	sort.Strings(types)
	for _, ctype := range types {
		var family Family
		found := false
		for _, prefix := range reviewFamilies {
			if Families[prefix].Name == ctype {
				family, found = Families[prefix], true
				break
			}
		}
		if !found {
			continue
		}
		rows, err := s.DB.Query(ctx, fmt.Sprintf(
			`SELECT l.id::text, l.name, COALESCE(v.status::text, 'draft')
			 FROM %s l LEFT JOIN %s v ON l.latest_version_id = v.id
			 WHERE l.id = ANY($1::uuid[])`, family.ListingTable, family.VersionTable), byType[ctype])
		if err != nil {
			return false, nil, err
		}
		for rows.Next() {
			var id, name, status string
			if err := rows.Scan(&id, &name, &status); err != nil {
				rows.Close()
				return false, nil, err
			}
			if status != "approved" {
				blocking = append(blocking, map[string]any{
					"component_type": ctype, "component_id": id, "name": name, "status": status,
				})
			}
		}
		rows.Close()
	}
	return len(blocking) == 0, blocking, nil
}

// PendingAgents lists the newest pending version of every agent in scope.
func (s *Store) PendingAgents(ctx context.Context, scope tenancy.ReviewScope, projectFilter *uuid.UUID) ([]map[string]any, error) {
	rows, err := s.DB.Query(ctx,
		`SELECT *, id::text AS id, agent_id::text AS agent_id, released_by::text AS released_by
		 FROM agent_versions WHERE status = 'pending' ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	pending := collectRows(rows)
	rows.Close()
	if len(pending) == 0 {
		return []map[string]any{}, nil
	}
	newest := map[string]map[string]any{}
	order := []string{}
	for _, pv := range pending {
		aid := rowStr(pv, "agent_id", "")
		if _, seen := newest[aid]; !seen && !rowActivelyEditing(pv) {
			newest[aid] = pv
			order = append(order, aid)
		}
	}
	if len(order) == 0 {
		return []map[string]any{}, nil
	}
	arows, err := s.DB.Query(ctx,
		`SELECT *, id::text AS id, created_by::text AS created_by, project_id::text AS project_id
		 FROM agents WHERE id = ANY($1::uuid[])`, order)
	if err != nil {
		return nil, err
	}
	agents := map[string]map[string]any{}
	for _, row := range collectRows(arows) {
		if inReviewScope(row, scope, projectFilter) {
			agents[rowStr(row, "id", "")] = row
		}
	}
	arows.Close()

	userIDs := map[string]bool{}
	for _, agent := range agents {
		userIDs[rowStr(agent, "created_by", "")] = true
	}
	for aid, pv := range newest {
		if _, visible := agents[aid]; visible {
			userIDs[rowStr(pv, "released_by", "")] = true
		}
	}
	users, err := s.usernameMap(ctx, userIDs)
	if err != nil {
		return nil, err
	}

	items := []map[string]any{}
	for _, aid := range order {
		agent, visible := agents[aid]
		if !visible {
			continue
		}
		pv := newest[aid]
		components, err := s.agentVersionComponents(ctx, rowStr(pv, "id", ""))
		if err != nil {
			return nil, err
		}
		ready, blocking, err := s.agentComponentsReady(ctx, components)
		if err != nil {
			return nil, err
		}
		description := rowStr(pv, "description", "")
		if description == "" {
			description = rowStr(agent, "description", "")
		}
		releasedBy := rowStr(pv, "released_by", "")
		submittedBy := users[releasedBy]
		if submittedBy == "" {
			submittedBy = releasedBy
		}
		createdAt := any("")
		if _, ok := pv["created_at"].(time.Time); ok {
			createdAt = wireTimePlus(pv["created_at"])
		}
		items = append(items, map[string]any{
			"type":                "agent",
			"id":                  aid,
			"name":                rowStr(agent, "name", ""),
			"description":         description,
			"version":             rowStr(pv, "version", ""),
			"owner":               rowStr(agent, "owner", ""),
			"status":              rowStr(pv, "status", ""),
			"submitted_by":        submittedBy,
			"created_at":          createdAt,
			"prompt":              rowStr(pv, "prompt", ""),
			"component_count":     len(components),
			"components_ready":    ready,
			"blocking_components": blocking,
			"gaming_flags":        pv["gaming_flags"],
		})
	}
	return items, nil
}
