// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/garudex-labs/caracal/internal/tenancy"
)

// reviewDetailFields are the incumbent's per-type detail keys; absent columns
// serialize as null.
var reviewDetailFields = map[string][]string{
	"mcps": {"git_url", "git_ref", "category", "transport", "framework", "docker_image", "command",
		"args", "url", "headers", "auto_approve", "tools_schema", "environment_variables",
		"supported_harnesses", "setup_instructions", "changelog", "rejection_reason", "bundle_id"},
	"skills": {"git_url", "git_ref", "skill_path", "target_agents", "task_type", "triggers",
		"slash_command", "has_scripts", "has_templates", "is_power", "power_md", "mcp_server_config",
		"activation_keywords", "supported_harnesses", "rejection_reason", "bundle_id"},
	"hooks": {"git_url", "git_ref", "event", "execution_mode", "priority", "handler_type",
		"handler_config", "input_schema", "output_schema", "scope", "tool_filter", "file_pattern",
		"supported_harnesses", "rejection_reason", "bundle_id"},
	"prompts": {"git_url", "git_ref", "category", "template", "variables", "tags",
		"supported_harnesses", "rejection_reason", "bundle_id"},
}

// safeSerialize mirrors the incumbent's ad-hoc value coercion.
func safeSerialize(v any) any {
	switch value := v.(type) {
	case time.Time:
		return wireTimePlus(value)
	case [16]byte:
		return uuid.UUID(value).String()
	}
	return v
}

// ReviewDetail renders one listing for the review screen, favouring the
// pending version's content.
func (s *Store) ReviewDetail(ctx context.Context, f Family, listing map[string]any) (map[string]any, error) {
	listingID := rowStr(listing, "id", "")
	pending, err := s.newestPendingAnyEdit(ctx, f, listingID)
	if err != nil {
		return nil, err
	}
	source := listing
	if pending != nil {
		source = pending
	}
	description := rowStr(source, "description", "")
	version := rowStr(source, "version", "")
	status := rowStr(source, "status", "")
	if status == "" {
		status = rowStr(listing, "status", "")
	}
	out := map[string]any{
		"type":         f.Name,
		"id":           listingID,
		"name":         rowStr(listing, "name", ""),
		"description":  description,
		"version":      version,
		"owner":        rowStr(listing, "owner", ""),
		"status":       status,
		"submitted_by": rowStr(listing, "submitted_by", ""),
		"created_at":   wireTimePlus(listing["created_at"]),
		"updated_at":   wireTimePlus(listing["updated_at"]),
	}
	for _, field := range reviewDetailFields[f.Prefix] {
		value, present := source[field]
		if !present || value == nil {
			value = listing[field]
		}
		out[field] = safeSerialize(value)
	}
	if f.Prefix == "mcps" {
		out["mcp_validated"] = rowBool(listing, "mcp_validated")
		results, err := s.validationResultRows(ctx, listingID)
		if err != nil {
			return nil, err
		}
		out["validation_results"] = results
	}
	if name, err := s.displayName(ctx, rowStr(listing, "submitted_by", "")); err == nil && name != "" {
		out["submitted_by"] = name
	}
	return out, nil
}

// newestPendingAnyEdit is the freshest pending version regardless of editing
// state; the detail view shows in-edit submissions too.
func (s *Store) newestPendingAnyEdit(ctx context.Context, f Family, listingID string) (map[string]any, error) {
	rows, err := s.DB.Query(ctx, fmt.Sprintf(
		`SELECT *, id::text AS id, released_by::text AS released_by FROM %s
		 WHERE listing_id = $1 AND status = 'pending' ORDER BY released_at DESC LIMIT 1`, f.VersionTable), listingID)
	if err != nil {
		return nil, err
	}
	matches := collectRows(rows)
	rows.Close()
	if len(matches) == 0 {
		return nil, nil
	}
	return matches[0], nil
}

func (s *Store) displayName(ctx context.Context, userID string) (string, error) {
	if userID == "" {
		return "", nil
	}
	var name string
	err := s.DB.QueryRow(ctx,
		`SELECT COALESCE(NULLIF(username, ''), email) FROM users WHERE id = $1`, userID).Scan(&name)
	if err != nil {
		return "", err
	}
	return name, nil
}

// reviewsUpdated announces a decision on the live channel.
func (s *Store) reviewsUpdated(ctx context.Context, projectID, listingID, action string) {
	if s.Publish != nil && projectID != "" {
		s.Publish.Publish(ctx, "reviews:"+projectID+":updated", map[string]string{"listing_id": listingID, "action": action})
	}
}

// DecideListing approves or rejects one listing's pending submission.
func (s *Store) DecideListing(ctx context.Context, identifier string, approve bool, reason string, viewer *Viewer) (map[string]any, error) {
	scope, err := s.reviewScopeFor(ctx, viewer)
	if err != nil {
		return nil, err
	}
	f, listing, err := s.findReviewListing(ctx, identifier)
	if err != nil {
		return nil, err
	}
	if listing == nil {
		return nil, &apiError{Status: 404, Detail: "Listing not found"}
	}
	if aerr := authorizeReviewItem(listing, scope); aerr != nil {
		return nil, aerr
	}
	listingID := rowStr(listing, "id", "")
	pending, err := s.newestPendingAnyEdit(ctx, f, listingID)
	if err != nil {
		return nil, err
	}

	verb := "reject"
	if approve {
		verb = "approve"
	}
	target := pending
	if target == nil {
		// Legacy path: act on the latest version directly.
		if latest := rowNStr(listing, "latest_version_id"); latest != nil {
			rows, qerr := s.DB.Query(ctx, fmt.Sprintf(
				`SELECT *, id::text AS id, released_by::text AS released_by FROM %s WHERE id = $1`,
				f.VersionTable), *latest)
			if qerr != nil {
				return nil, qerr
			}
			matches := collectRows(rows)
			rows.Close()
			if len(matches) > 0 {
				target = matches[0]
			}
		}
	}
	if target != nil && rowActivelyEditing(target) {
		return nil, &apiError{Status: 409,
			Detail: fmt.Sprintf("Cannot %s: the owner is currently editing this item", verb)}
	}

	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	newStatus := "rejected"
	var storedReason *string
	if approve {
		newStatus = "approved"
	} else if reason != "" {
		storedReason = &reason
	}
	if target != nil {
		if _, err := tx.Exec(ctx, fmt.Sprintf(
			`UPDATE %s SET status = $2, rejection_reason = $3, reviewed_by = $4, reviewed_at = now()
			 WHERE id = $1`, f.VersionTable),
			rowStr(target, "id", ""), newStatus, storedReason, viewer.ID); err != nil {
			return nil, err
		}
		if approve && pending != nil {
			if _, err := tx.Exec(ctx, fmt.Sprintf(
				`UPDATE %s SET latest_version_id = $1, updated_at = now() WHERE id = $2`, f.ListingTable),
				rowStr(target, "id", ""), listingID); err != nil {
				return nil, err
			}
		}
	}

	var submitter *uuid.UUID
	var version *string
	if target != nil {
		if rb := rowNStr(target, "released_by"); rb != nil {
			if parsed, perr := uuid.Parse(*rb); perr == nil {
				submitter = &parsed
			}
		}
		if v := rowStr(target, "version", ""); v != "" {
			version = &v
		}
	}
	versionLabel := ""
	if version != nil {
		versionLabel = *version
	}
	if err := s.notifyReviewDecided(ctx, tx, listing, f.Name, versionLabel, approve, storedReason, submitter, viewer.ID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	if !approve {
		// The self-learn cascade is best-effort: the rejection is committed.
		if err := s.selfLearnRejectionCascade(ctx, listingID); err != nil {
			_ = err
		}
	}

	// The response reads the listing's own (latest-version) status.
	finalStatus := newStatus
	var latestStatus *string
	if err := s.DB.QueryRow(ctx, fmt.Sprintf(
		`SELECT v.status::text FROM %s l JOIN %s v ON l.latest_version_id = v.id WHERE l.id = $1`,
		f.ListingTable, f.VersionTable), listingID).Scan(&latestStatus); err == nil && latestStatus != nil {
		finalStatus = *latestStatus
	}
	s.reviewsUpdated(ctx, rowStr(listing, "project_id", ""), listingID, newStatus)
	return map[string]any{
		"type": f.Name, "id": listingID, "name": rowStr(listing, "name", ""), "status": finalStatus,
	}, nil
}

// selfLearnRejectionCascade removes a rejected component from insight report
// applied_items and withdraws pending agent versions that depended on it.
func (s *Store) selfLearnRejectionCascade(ctx context.Context, componentID string) error {
	rows, err := s.DB.Query(ctx,
		`SELECT id::text, applied_items FROM insight_reports WHERE applied_items IS NOT NULL`)
	if err != nil {
		return err
	}
	reports := collectRows(rows)
	rows.Close()
	for _, report := range reports {
		items, ok := report["applied_items"].(map[string]any)
		if !ok {
			continue
		}
		modified := false
		for _, category := range []string{"skills", "hooks", "prompts"} {
			entries, _ := items[category].([]any)
			kept := make([]any, 0, len(entries))
			for _, raw := range entries {
				entry, isMap := raw.(map[string]any)
				if isMap {
					if id, _ := entry["id"].(string); id == componentID {
						modified = true
						continue
					}
				}
				kept = append(kept, raw)
			}
			if items[category] != nil {
				items[category] = kept
			}
		}
		if !modified {
			continue
		}
		blob, err := jsonParam(items)
		if err != nil {
			return err
		}
		if _, err := s.DB.Exec(ctx,
			`UPDATE insight_reports SET applied_items = $2::json WHERE id = $1`,
			rowStr(report, "id", ""), blob); err != nil {
			return err
		}
		if versionInfo, ok := items["agent_version"].(map[string]any); ok {
			if versionID, _ := versionInfo["id"].(string); versionID != "" {
				if _, err := s.DB.Exec(ctx,
					`UPDATE agent_versions
					 SET status = 'rejected',
					     description = COALESCE(description, '') || ' [auto-withdrawn: linked component rejected]'
					 WHERE id = $1 AND status = 'pending'`, versionID); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// agentRow loads one agent with its review-relevant columns.
func (s *Store) agentRow(ctx context.Context, agentID uuid.UUID) (map[string]any, error) {
	rows, err := s.DB.Query(ctx,
		`SELECT *, id::text AS id, created_by::text AS created_by, project_id::text AS project_id,
		        latest_version_id::text AS latest_version_id
		 FROM agents WHERE id = $1`, agentID)
	if err != nil {
		return nil, err
	}
	matches := collectRows(rows)
	rows.Close()
	if len(matches) == 0 {
		return nil, nil
	}
	return matches[0], nil
}

// pendingAgentVersions lists an agent's pending versions newest-first.
func (s *Store) pendingAgentVersions(ctx context.Context, agentID string) ([]map[string]any, error) {
	rows, err := s.DB.Query(ctx,
		`SELECT *, id::text AS id, released_by::text AS released_by FROM agent_versions
		 WHERE agent_id = $1 AND status = 'pending' ORDER BY created_at DESC`, agentID)
	if err != nil {
		return nil, err
	}
	matches := collectRows(rows)
	rows.Close()
	return matches, nil
}

// agentSubject builds the inbox subject for an agent row.
func agentSubjectRow(agent map[string]any) map[string]any {
	return map[string]any{
		"id": agent["id"], "name": agent["name"], "namespace": agent["namespace"],
		"slug": agent["slug"], "project_id": agent["project_id"], "is_private": agent["is_private"],
	}
}

// DecideAgent approves or rejects an agent's pending versions.
func (s *Store) DecideAgent(ctx context.Context, agentID uuid.UUID, approve bool, reason, category string, viewer *Viewer) (map[string]any, error) {
	scope, err := s.reviewScopeFor(ctx, viewer)
	if err != nil {
		return nil, err
	}
	agent, err := s.agentRow(ctx, agentID)
	if err != nil {
		return nil, err
	}
	if agent == nil {
		return nil, &apiError{Status: 404, Detail: "Agent not found"}
	}
	if aerr := authorizeReviewItem(agent, scope); aerr != nil {
		return nil, aerr
	}
	pending, err := s.pendingAgentVersions(ctx, rowStr(agent, "id", ""))
	if err != nil {
		return nil, err
	}
	if len(pending) == 0 {
		// The agent's own status is its latest version's status.
		status := "draft"
		if latest := rowNStr(agent, "latest_version_id"); latest != nil {
			_ = s.DB.QueryRow(ctx,
				`SELECT status::text FROM agent_versions WHERE id = $1`, *latest).Scan(&status)
		}
		return nil, &apiError{Status: 400,
			Detail: fmt.Sprintf("Agent has no pending versions (latest is '%s')", status)}
	}
	verb := "reject"
	if approve {
		verb = "approve"
	}
	for _, pv := range pending {
		if rowActivelyEditing(pv) {
			return nil, &apiError{Status: 409,
				Detail: fmt.Sprintf("Cannot %s: the owner is currently editing this agent", verb)}
		}
	}

	newest := pending[0]
	if approve {
		components, err := s.agentVersionComponents(ctx, rowStr(newest, "id", ""))
		if err != nil {
			return nil, err
		}
		ready, blocking, err := s.agentComponentsReady(ctx, components)
		if err != nil {
			return nil, err
		}
		if !ready {
			return nil, &apiError{Status: 422, DetailAny: map[string]any{
				"message":             "Cannot approve: some components are not approved yet",
				"blocking_components": blocking,
			}}
		}
	}

	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	subject := agentSubjectRow(agent)
	notify := func(pv map[string]any, approved bool, why *string) error {
		var submitter *uuid.UUID
		if rb := rowNStr(pv, "released_by"); rb != nil {
			if parsed, perr := uuid.Parse(*rb); perr == nil {
				submitter = &parsed
			}
		}
		return s.notifyReviewDecided(ctx, tx, subject, "agent", rowStr(pv, "version", ""), approved, why, submitter, viewer.ID)
	}

	if approve {
		if _, err := tx.Exec(ctx,
			`UPDATE agent_versions SET status = 'approved', rejection_reason = NULL,
			        reviewed_by = $2, reviewed_at = now() WHERE id = $1`,
			rowStr(newest, "id", ""), viewer.ID); err != nil {
			return nil, err
		}
		superseded := "Superseded by newer version"
		for _, pv := range pending[1:] {
			if _, err := tx.Exec(ctx,
				`UPDATE agent_versions SET status = 'rejected', rejection_reason = $2,
				        reviewed_by = $3, reviewed_at = now() WHERE id = $1`,
				rowStr(pv, "id", ""), superseded, viewer.ID); err != nil {
				return nil, err
			}
		}
		// Latest only moves forward by semver.
		bump := true
		if latest := rowNStr(agent, "latest_version_id"); latest != nil {
			var current string
			if err := tx.QueryRow(ctx,
				`SELECT version FROM agent_versions WHERE id = $1`, *latest).Scan(&current); err == nil {
				bump = semverGTE(parseSemverTuple(rowStr(newest, "version", "")), parseSemverTuple(current))
			}
		}
		if bump {
			if _, err := tx.Exec(ctx,
				`UPDATE agents SET latest_version_id = $1, updated_at = now() WHERE id = $2`,
				rowStr(newest, "id", ""), rowStr(agent, "id", "")); err != nil {
				return nil, err
			}
		}
		if category != "" {
			if _, err := tx.Exec(ctx,
				`UPDATE agents SET category = $1, updated_at = now() WHERE id = $2`,
				category, rowStr(agent, "id", "")); err != nil {
				return nil, err
			}
		}
		if err := notify(newest, true, nil); err != nil {
			return nil, err
		}
		superReason := superseded
		for _, pv := range pending[1:] {
			if err := notify(pv, false, &superReason); err != nil {
				return nil, err
			}
		}
	} else {
		for _, pv := range pending {
			if _, err := tx.Exec(ctx,
				`UPDATE agent_versions SET status = 'rejected', rejection_reason = $2,
				        reviewed_by = $3, reviewed_at = now() WHERE id = $1`,
				rowStr(pv, "id", ""), reason, viewer.ID); err != nil {
				return nil, err
			}
		}
		why := reason
		for _, pv := range pending {
			if err := notify(pv, false, &why); err != nil {
				return nil, err
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	action := "rejected"
	status := "rejected"
	if approve {
		action, status = "approved", "approved"
	}
	s.reviewsUpdated(ctx, rowStr(agent, "project_id", ""), rowStr(agent, "id", ""), action)
	return map[string]any{
		"id": rowStr(agent, "id", ""), "name": rowStr(agent, "name", ""),
		"status": status, "version": rowStr(newest, "version", ""),
	}, nil
}

// bundleListings loads every listing in a bundle, refusing the bundle when
// one member is outside the caller's scope.
func (s *Store) bundleListings(ctx context.Context, bundleID uuid.UUID, scope tenancy.ReviewScope) ([]struct {
	Family Family
	Row    map[string]any
}, *apiError, error) {
	out := []struct {
		Family Family
		Row    map[string]any
	}{}
	for _, prefix := range reviewFamilies {
		f := Families[prefix]
		rows, err := s.DB.Query(ctx, fmt.Sprintf(
			`SELECT %s FROM %s l LEFT JOIN %s v ON l.latest_version_id = v.id WHERE l.bundle_id = $1`,
			detailColumns(f), f.ListingTable, f.VersionTable), bundleID)
		if err != nil {
			return nil, nil, err
		}
		matches := collectRows(rows)
		rows.Close()
		for _, row := range matches {
			if aerr := authorizeReviewItem(row, scope); aerr != nil {
				return nil, aerr, nil
			}
			out = append(out, struct {
				Family Family
				Row    map[string]any
			}{f, row})
		}
	}
	return out, nil, nil
}

// DecideBundle atomically approves or rejects every listing in a bundle.
func (s *Store) DecideBundle(ctx context.Context, bundleID uuid.UUID, approve bool, reason string, viewer *Viewer) (map[string]any, error) {
	scope, err := s.reviewScopeFor(ctx, viewer)
	if err != nil {
		return nil, err
	}
	var bundleName string
	err = s.DB.QueryRow(ctx, `SELECT name FROM component_bundles WHERE id = $1`, bundleID).Scan(&bundleName)
	if err != nil {
		return nil, &apiError{Status: 404, Detail: "Bundle not found"}
	}
	members, aerr, err := s.bundleListings(ctx, bundleID, scope)
	if err != nil {
		return nil, err
	}
	if aerr != nil {
		return nil, aerr
	}
	verb := "reject"
	newStatus := "rejected"
	if approve {
		verb, newStatus = "approve", "approved"
	}

	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	count := 0
	for _, member := range members {
		if rowBool(member.Row, "is_editing") && rowActivelyEditing(member.Row) {
			return nil, &apiError{Status: 409,
				Detail: fmt.Sprintf("Cannot %s: '%s' is currently being edited by its owner", verb, rowStr(member.Row, "name", ""))}
		}
		var storedReason *string
		if !approve && reason != "" {
			storedReason = &reason
		}
		if latest := rowNStr(member.Row, "latest_version_id"); latest != nil {
			if _, err := tx.Exec(ctx, fmt.Sprintf(
				`UPDATE %s SET status = $2, rejection_reason = $3 WHERE id = $1`, member.Family.VersionTable),
				*latest, newStatus, storedReason); err != nil {
				return nil, err
			}
		}
		var submitter *uuid.UUID
		if approve {
			if rb := rowNStr(member.Row, "released_by"); rb != nil {
				if parsed, perr := uuid.Parse(*rb); perr == nil {
					submitter = &parsed
				}
			}
		}
		version := rowStr(member.Row, "version", "")
		if err := s.notifyReviewDecided(ctx, tx, member.Row, member.Family.Name, version, approve, storedReason, submitter, viewer.ID); err != nil {
			return nil, err
		}
		count++
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	key := "rejected_count"
	if approve {
		key = "approved_count"
	}
	return map[string]any{"bundle_id": bundleID.String(), "name": bundleName, key: count}, nil
}

// RelatedSkills lists pending skills whose MCP config references the listing.
func (s *Store) RelatedSkills(ctx context.Context, identifier string, viewer *Viewer) (map[string]any, error) {
	scope, err := s.reviewScopeFor(ctx, viewer)
	if err != nil {
		return nil, err
	}
	f, listing, err := s.findReviewListing(ctx, identifier)
	if err != nil {
		return nil, err
	}
	if listing == nil || f.Prefix != "mcps" {
		return map[string]any{"skills": []any{}}, nil
	}
	if !scope.CanReview(rowProjectID(listing, "project_id"), rowBool(listing, "is_private")) {
		return nil, &apiError{Status: 404, Detail: "Listing not found"}
	}
	name := rowStr(listing, "name", "")
	id := rowStr(listing, "id", "")
	skills := Families["skills"]
	rows, err := s.DB.Query(ctx, fmt.Sprintf(
		`SELECT %s, v.task_type, v.target_agents, v.mcp_server_config
		 FROM skill_listings l JOIN skill_versions v ON l.latest_version_id = v.id
		 WHERE v.status = 'pending' AND v.mcp_server_config IS NOT NULL
		   AND (v.mcp_server_config::text LIKE '%%' || $1 || '%%'
		        OR v.mcp_server_config::text LIKE '%%' || $2 || '%%')
		 ORDER BY l.created_at DESC`, detailColumns(skills)), name, id)
	if err != nil {
		return nil, err
	}
	matches := collectRows(rows)
	rows.Close()

	visible := []map[string]any{}
	userIDs := map[string]bool{}
	for _, row := range matches {
		if scope.CanReview(rowProjectID(row, "project_id"), rowBool(row, "is_private")) {
			visible = append(visible, row)
			userIDs[rowStr(row, "submitted_by", "")] = true
		}
	}
	users, err := s.usernameMap(ctx, userIDs)
	if err != nil {
		return nil, err
	}
	items := []any{}
	for _, row := range visible {
		submitter := rowStr(row, "submitted_by", "")
		if known := users[submitter]; known != "" {
			submitter = known
		}
		items = append(items, map[string]any{
			"id":                rowStr(row, "id", ""),
			"type":              "skill",
			"name":              rowStr(row, "name", ""),
			"version":           rowStr(row, "version", ""),
			"description":       rowStr(row, "description", ""),
			"task_type":         row["task_type"],
			"target_agents":     rowList(row, "target_agents"),
			"mcp_server_config": row["mcp_server_config"],
			"status":            rowStr(row, "status", ""),
			"submitted_by":      submitter,
			"created_at":        wireTimePlus(row["created_at"]),
		})
	}
	return map[string]any{"skills": items}, nil
}

// ApproveWithSkills approves an MCP plus a caller-chosen set of skills.
func (s *Store) ApproveWithSkills(ctx context.Context, identifier string, skillIDs []string, viewer *Viewer) (map[string]any, error) {
	scope, err := s.reviewScopeFor(ctx, viewer)
	if err != nil {
		return nil, err
	}
	f, listing, err := s.findReviewListing(ctx, identifier)
	if err != nil {
		return nil, err
	}
	if listing == nil {
		return nil, &apiError{Status: 404, Detail: "Listing not found"}
	}
	if f.Prefix != "mcps" {
		return nil, &apiError{Status: 400, Detail: "Only MCP listings support bulk skill approve"}
	}
	if aerr := authorizeReviewItem(listing, scope); aerr != nil {
		return nil, aerr
	}

	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	approveLatest := func(family Family, row map[string]any) error {
		latest := rowNStr(row, "latest_version_id")
		if latest == nil {
			return nil
		}
		_, err := tx.Exec(ctx, fmt.Sprintf(
			`UPDATE %s SET status = 'approved', rejection_reason = NULL WHERE id = $1`, family.VersionTable), *latest)
		return err
	}
	notifyLatest := func(family Family, row map[string]any) error {
		var submitter *uuid.UUID
		if rb := rowNStr(row, "released_by"); rb != nil {
			if parsed, perr := uuid.Parse(*rb); perr == nil {
				submitter = &parsed
			}
		}
		return s.notifyReviewDecided(ctx, tx, row, family.Name, rowStr(row, "version", ""), true, nil, submitter, viewer.ID)
	}
	if err := approveLatest(f, listing); err != nil {
		return nil, err
	}
	if err := notifyLatest(f, listing); err != nil {
		return nil, err
	}

	skillsFamily := Families["skills"]
	approved := []string{}
	for _, sid := range skillIDs {
		if _, perr := uuid.Parse(sid); perr != nil {
			continue
		}
		rows, qerr := s.DB.Query(ctx, fmt.Sprintf(
			`SELECT %s FROM skill_listings l LEFT JOIN skill_versions v ON l.latest_version_id = v.id
			 WHERE l.id = $1`, detailColumns(skillsFamily)), sid)
		if qerr != nil {
			return nil, qerr
		}
		matches := collectRows(rows)
		rows.Close()
		if len(matches) == 0 {
			continue
		}
		skill := matches[0]
		if aerr := authorizeReviewItem(skill, scope); aerr != nil {
			return nil, aerr
		}
		if rowStr(skill, "status", "") != "pending" {
			continue
		}
		if err := approveLatest(skillsFamily, skill); err != nil {
			return nil, err
		}
		if err := notifyLatest(skillsFamily, skill); err != nil {
			return nil, err
		}
		approved = append(approved, rowStr(skill, "id", ""))
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return map[string]any{
		"mcp":             map[string]any{"id": rowStr(listing, "id", ""), "name": rowStr(listing, "name", ""), "status": "approved"},
		"approved_skills": len(approved),
		"skill_ids":       approved,
	}, nil
}

var _ = pgx.ErrNoRows
