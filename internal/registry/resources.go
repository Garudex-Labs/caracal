// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/httpapi"
)

// resourceSpec describes one arm of the unified resource tree.
type resourceSpec struct {
	wire    string // plural wire name and type facet key
	subject string // singular lifecycle subject type
	listing string
	version string
	creator string
	isAgent bool
}

// resourceSpecs is in wire facet order; merge stability depends on it.
var resourceSpecs = []resourceSpec{
	{"agents", "agent", "agents", "agent_versions", "created_by", true},
	{"mcps", "mcp", "mcp_listings", "mcp_versions", "submitted_by", false},
	{"skills", "skill", "skill_listings", "skill_versions", "submitted_by", false},
	{"hooks", "hook", "hook_listings", "hook_versions", "submitted_by", false},
	{"prompts", "prompt", "prompt_listings", "prompt_versions", "submitted_by", false},
}

var resourceSorts = []string{"updated", "created", "name", "name_desc", "downloads"}
var resourceScopes = []string{"project", "private"}
var resourceStatuses = []string{"draft", "pending", "approved", "rejected", "archived"}

// Deep offsets degrade into sequential scans; the UI never needs them.
const resourceMaxWindow = 5000

// resourceListQuery carries the validated list parameters.
type resourceListQuery struct {
	Type, Search, Scope, Status, Owner, Sort string
	Mine, IncludeUnpublished                 bool
	UpdatedAfter, CreatedAfter               *time.Time
	Page, PageSize                           int
}

// resourceItem is one serialized row plus its merge-sort keys.
type resourceItem struct {
	wire       map[string]any
	typ, id    string
	nameLower  string
	createdISO string
	updatedISO string
	downloads  int64
}

// resourceFilterSQL renders the shared WHERE clause for one type arm.
func resourceFilterSQL(spec resourceSpec, q *resourceListQuery, viewer *Viewer, projectID *uuid.UUID, args *[]any) string {
	creator := "l." + spec.creator
	var conds []string
	if spec.isAgent {
		conds = append(conds, "l.deleted_at IS NULL")
	}
	conds = append(conds, visibilitySQLCreator("l", creator, viewer, args))

	if q.Status != "" {
		*args = append(*args, q.Status)
		conds = append(conds, fmt.Sprintf("v.status::text = $%d", len(*args)))
	}
	// Unpublished work is never shown through the aggregation unless the
	// caller created it or may review everything.
	wantsUnpublished := q.IncludeUnpublished || (q.Status != "" && q.Status != "approved")
	if !wantsUnpublished {
		conds = append(conds, "v.status = 'approved'")
	} else if !viewer.seesPrivateListings() {
		if viewer == nil {
			conds = append(conds, "v.status = 'approved'")
		} else {
			*args = append(*args, viewer.ID)
			conds = append(conds, fmt.Sprintf("(v.status = 'approved' OR %s = $%d)", creator, len(*args)))
		}
	}

	if projectID != nil {
		*args = append(*args, *projectID)
		conds = append(conds, fmt.Sprintf("l.project_id = $%d", len(*args)))
	}
	if q.Search != "" {
		*args = append(*args, "%"+escapeLike(q.Search)+"%")
		n := len(*args)
		conds = append(conds, fmt.Sprintf(
			"(l.name ILIKE $%d OR l.slug ILIKE $%d OR l.namespace ILIKE $%d OR l.owner ILIKE $%d)", n, n, n, n))
	}
	if q.Mine {
		if viewer == nil {
			conds = append(conds, "FALSE")
		} else {
			*args = append(*args, viewer.ID)
			conds = append(conds, fmt.Sprintf("%s = $%d", creator, len(*args)))
		}
	}
	switch q.Scope {
	case "project":
		conds = append(conds, "COALESCE(l.ownership_scope, 'project') != 'private'")
	case "private":
		conds = append(conds, "l.ownership_scope = 'private'")
	}
	if q.Owner != "" {
		*args = append(*args, strings.ToLower(strings.TrimSpace(q.Owner)))
		conds = append(conds, fmt.Sprintf("LOWER(l.owner) = $%d", len(*args)))
	}
	if q.UpdatedAfter != nil {
		*args = append(*args, *q.UpdatedAfter)
		conds = append(conds, fmt.Sprintf("l.updated_at >= $%d", len(*args)))
	}
	if q.CreatedAfter != nil {
		*args = append(*args, *q.CreatedAfter)
		conds = append(conds, fmt.Sprintf("l.created_at >= $%d", len(*args)))
	}
	return strings.Join(conds, " AND ")
}

func resourceOrderSQL(sortKey string) string {
	switch sortKey {
	case "created":
		return "ORDER BY l.created_at DESC, l.id DESC"
	case "name":
		return "ORDER BY LOWER(l.name) ASC, l.id ASC"
	case "name_desc":
		return "ORDER BY LOWER(l.name) DESC, l.id DESC"
	case "downloads":
		return "ORDER BY COALESCE(v.download_count, 0) DESC, l.id DESC"
	default:
		return "ORDER BY l.updated_at DESC, l.id DESC"
	}
}

// resourceRows runs one filtered page query for a type arm.
func (s *Store) resourceRows(ctx context.Context, spec resourceSpec, where, order string, args []any, limit, offset int) ([]resourceItem, error) {
	sql := fmt.Sprintf(
		`SELECT l.id::text AS id, l.name, l.namespace, l.slug, l.owner,
		        l.is_private, l.ownership_scope, l.project_id::text AS project_id,
		        l.created_at, l.updated_at,
		        v.description AS v_description, v.status::text AS v_status,
		        v.version AS v_version, v.download_count AS v_downloads
		 FROM %s l LEFT JOIN %s v ON l.latest_version_id = v.id
		 WHERE %s %s LIMIT %d OFFSET %d`,
		spec.listing, spec.version, where, order, limit, offset)
	rows, err := s.DB.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []resourceItem
	for _, row := range collectRows(rows) {
		out = append(out, serializeResource(spec, row))
	}
	return out, rows.Err()
}

func serializeResource(spec resourceSpec, row map[string]any) resourceItem {
	id := rowStr(row, "id", "")
	name := rowStr(row, "name", "")
	namespace := rowStr(row, "namespace", "")
	slug := rowStr(row, "slug", "")
	// Listing description delegates to the latest version, empty when absent.
	description := rowStr(row, "v_description", "")
	var downloads int64
	var downloadsWire any
	if n, ok := row["v_downloads"].(int64); ok {
		downloads, downloadsWire = n, n
	} else if n, ok := row["v_downloads"].(int32); ok {
		downloads, downloadsWire = int64(n), int64(n)
	}
	createdISO, _ := wireTimePlus(row["created_at"]).(string)
	updatedISO, _ := wireTimePlus(row["updated_at"]).(string)
	scope := "project"
	var scopeWire any = "project"
	if s, ok := row["ownership_scope"].(string); ok {
		scope, scopeWire = s, s
	}
	visibility := "project"
	if scope == "private" {
		visibility = "private"
	}
	wire := map[string]any{
		"id":              id,
		"resource_type":   spec.wire,
		"name":            name,
		"namespace":       namespace,
		"slug":            slug,
		"qualified_name":  namespace + "/" + slug,
		"description":     description,
		"status":          row["v_status"],
		"version":         row["v_version"],
		"visibility":      visibility,
		"ownership_scope": scopeWire,
		"owner":           row["owner"],
		"project_id":      row["project_id"],
		"downloads":       downloadsWire,
		"created_at":      nilIfEmptyStr(createdISO),
		"updated_at":      nilIfEmptyStr(updatedISO),
	}
	return resourceItem{
		wire: wire, typ: spec.wire, id: id, nameLower: strings.ToLower(name),
		createdISO: createdISO, updatedISO: updatedISO, downloads: downloads,
	}
}

func nilIfEmptyStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// resourceCompare mirrors the merge key tuples; reverse applies to the
// whole tuple exactly as a reversed tuple sort would.
func resourceCompare(sortKey string, a, b resourceItem) int {
	var c int
	switch sortKey {
	case "created":
		c = strings.Compare(a.createdISO, b.createdISO)
	case "name", "name_desc":
		c = strings.Compare(a.nameLower, b.nameLower)
	case "downloads":
		switch {
		case a.downloads < b.downloads:
			c = -1
		case a.downloads > b.downloads:
			c = 1
		}
	default:
		c = strings.Compare(a.updatedISO, b.updatedISO)
	}
	if c != 0 {
		return c
	}
	if c = strings.Compare(a.typ, b.typ); c != 0 {
		return c
	}
	return strings.Compare(a.id, b.id)
}

// ListResources serves the unified project resource tree.
func (s *Store) ListResources(ctx context.Context, q *resourceListQuery, viewer *Viewer, projectID *uuid.UUID) (map[string]any, error) {
	wanted := make([]string, 0, len(resourceSpecs))
	if q.Type != "" {
		for _, spec := range resourceSpecs {
			if spec.wire == q.Type {
				wanted = []string{q.Type}
			}
		}
	}
	if len(wanted) == 0 {
		for _, spec := range resourceSpecs {
			wanted = append(wanted, spec.wire)
		}
	}
	offset := (q.Page - 1) * q.PageSize

	// Counts honor every active filter except the type facet itself, so the
	// type selector always shows what switching to each type would return.
	counts := map[string]int{}
	wheres := map[string]string{}
	argSets := map[string][]any{}
	for _, spec := range resourceSpecs {
		args := []any{}
		where := resourceFilterSQL(spec, q, viewer, projectID, &args)
		wheres[spec.wire] = where
		argSets[spec.wire] = args
		var count int
		err := s.DB.QueryRow(ctx, fmt.Sprintf(
			`SELECT COUNT(*) FROM %s l LEFT JOIN %s v ON l.latest_version_id = v.id WHERE %s`,
			spec.listing, spec.version, where), args...).Scan(&count)
		if err != nil {
			return nil, err
		}
		if count > 0 {
			counts[spec.wire] = count
		}
	}

	total := 0
	var listable []resourceSpec
	for _, spec := range resourceSpecs {
		inWanted := false
		for _, w := range wanted {
			if w == spec.wire {
				inWanted = true
			}
		}
		if !inWanted {
			continue
		}
		total += counts[spec.wire]
		if counts[spec.wire] > 0 {
			listable = append(listable, spec)
		}
	}

	order := resourceOrderSQL(q.Sort)
	items := []resourceItem{}
	if len(listable) == 1 {
		spec := listable[0]
		rows, err := s.resourceRows(ctx, spec, wheres[spec.wire], order, argSets[spec.wire], q.PageSize, offset)
		if err != nil {
			return nil, err
		}
		items = rows
	} else if len(listable) > 1 {
		window := offset + q.PageSize
		var merged []resourceItem
		for _, spec := range listable {
			rows, err := s.resourceRows(ctx, spec, wheres[spec.wire], order, argSets[spec.wire], window, 0)
			if err != nil {
				return nil, err
			}
			merged = append(merged, rows...)
		}
		reverse := q.Sort != "name"
		sort.SliceStable(merged, func(i, j int) bool {
			c := resourceCompare(q.Sort, merged[i], merged[j])
			if reverse {
				return c > 0
			}
			return c < 0
		})
		if offset < len(merged) {
			end := offset + q.PageSize
			if end > len(merged) {
				end = len(merged)
			}
			items = merged[offset:end]
		}
	}

	wireItems := make([]map[string]any, 0, len(items))
	for _, item := range items {
		wireItems = append(wireItems, item.wire)
	}
	wireCounts := map[string]any{}
	for k, v := range counts {
		wireCounts[k] = v
	}
	return map[string]any{
		"items": wireItems, "counts": wireCounts, "total": total,
		"page": q.Page, "page_size": q.PageSize,
	}, nil
}

// ── Lifecycle reads: activity and contributors ──────────────────────────

// resourceSubject is one resolved lifecycle subject.
type resourceSubject struct {
	spec      resourceSpec
	id        string
	creator   string
	coAuthors []string
	createdAt any
	row       map[string]any
}

const subjectColumns = `l.id::text AS id, l.name, l.is_private, l.ownership_scope,
	l.project_id::text AS project_id, l.co_authors, l.created_at`

// resolveResourceSubject finds an agent or component listing by id or unique
// id prefix, in the same type order the route contract fixes.
func (s *Store) resolveResourceSubject(ctx context.Context, subjectID string) (*resourceSubject, error) {
	norm := strings.ToLower(strings.TrimSpace(subjectID))
	_, uuidErr := uuid.Parse(norm)
	isUUID := uuidErr == nil
	if !isUUID && len(norm) < 4 {
		return nil, nil
	}
	for _, spec := range resourceSpecs {
		creatorCol := "l." + spec.creator
		var sql string
		var args []any
		if isUUID {
			sql = fmt.Sprintf(`SELECT %s, %s::text AS creator FROM %s l WHERE l.id = $1`,
				subjectColumns, creatorCol, spec.listing)
			args = []any{norm}
		} else {
			sql = fmt.Sprintf(`SELECT %s, %s::text AS creator FROM %s l WHERE l.id::text LIKE $1 LIMIT 2`,
				subjectColumns, creatorCol, spec.listing)
			args = []any{norm + "%"}
		}
		rows, err := s.DB.Query(ctx, sql, args...)
		if err != nil {
			return nil, err
		}
		found := collectRows(rows)
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		// An ambiguous prefix inside one type falls through to the next,
		// exactly as the resolver contract does.
		if len(found) != 1 {
			continue
		}
		row := found[0]
		return &resourceSubject{
			spec: spec, id: rowStr(row, "id", ""), creator: rowStr(row, "creator", ""),
			coAuthors: rowCoAuthors(row), createdAt: row["created_at"], row: row,
		}, nil
	}
	return nil, nil
}

// subjectVisible is the row-level twin of the list visibility filter.
func (s *Store) subjectVisible(ctx context.Context, sub *resourceSubject, viewer *Viewer) (bool, error) {
	if viewer != nil && viewer.ProjectID != "" {
		projectID := rowNStr(sub.row, "project_id")
		if projectID == nil || *projectID != viewer.ProjectID {
			return false, nil
		}
	}
	if !rowBool(sub.row, "is_private") {
		return true, nil
	}
	if viewer == nil {
		return false, nil
	}
	if viewer.seesPrivateListings() {
		return true, nil
	}
	creatorMatch := sub.creator == viewer.ID.String()
	if rowStr(sub.row, "ownership_scope", "") == "private" {
		return creatorMatch, nil
	}
	projectID := rowNStr(sub.row, "project_id")
	if projectID == nil {
		return creatorMatch, nil
	}
	var ok bool
	err := s.DB.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM project_memberships WHERE project_id = $1 AND user_id = $2)`,
		*projectID, viewer.ID).Scan(&ok)
	if err != nil {
		return false, err
	}
	if ok {
		return true, nil
	}
	return false, nil
}

func (s *Store) requireResourceSubject(ctx context.Context, subjectID string, viewer *Viewer) (*resourceSubject, error) {
	sub, err := s.resolveResourceSubject(ctx, subjectID)
	if err != nil {
		return nil, err
	}
	if sub != nil {
		visible, err := s.subjectVisible(ctx, sub, viewer)
		if err != nil {
			return nil, err
		}
		if !visible {
			sub = nil
		}
	}
	if sub == nil {
		return nil, &apiError{Status: 404, Detail: "Resource not found"}
	}
	return sub, nil
}

// subjectPermission mirrors the effective-permission contract for either arm.
func subjectPermission(sub *resourceSubject, viewer *Viewer) string {
	creator := uuid.Nil
	if id, err := uuid.Parse(sub.creator); err == nil {
		creator = id
	}
	return EffectivePermission(creator, sub.coAuthors, viewer)
}

// subjectVersion is one version row of the lifecycle feed.
type subjectVersion struct {
	id, version, status               string
	description, rejectionReason      string
	releasedBy, reviewedBy            *string
	createdAt, releasedAt, reviewedAt *time.Time
	promotedFrom                      *string
}

// visibleVersions lists the versions this caller may learn about, oldest first.
func (s *Store) visibleVersions(ctx context.Context, sub *resourceSubject, viewer *Viewer) ([]subjectVersion, error) {
	fk := "listing_id"
	promoted := "NULL AS promoted_from"
	if sub.spec.isAgent {
		fk = "agent_id"
		promoted = "promoted_from::text AS promoted_from"
	}
	statusFilter := ""
	if !mayViewUnapproved(subjectPermission(sub, viewer), viewer) {
		statusFilter = "AND status = 'approved'"
	}
	rows, err := s.DB.Query(ctx, fmt.Sprintf(
		`SELECT id::text AS id, version, status::text AS status, COALESCE(description, '') AS description,
		        COALESCE(rejection_reason, '') AS rejection_reason,
		        released_by::text AS released_by, reviewed_by::text AS reviewed_by,
		        created_at, released_at, reviewed_at, %s
		 FROM %s WHERE %s = $1 %s ORDER BY created_at ASC`,
		promoted, sub.spec.version, fk, statusFilter), sub.id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []subjectVersion
	for _, row := range collectRows(rows) {
		v := subjectVersion{
			id: rowStr(row, "id", ""), version: rowStr(row, "version", ""),
			status:      rowStr(row, "status", ""),
			description: rowStr(row, "description", ""), rejectionReason: rowStr(row, "rejection_reason", ""),
			releasedBy: rowNStr(row, "released_by"), reviewedBy: rowNStr(row, "reviewed_by"),
			promotedFrom: rowNStr(row, "promoted_from"),
		}
		v.createdAt = timePtr(row["created_at"])
		v.releasedAt = timePtr(row["released_at"])
		v.reviewedAt = timePtr(row["reviewed_at"])
		out = append(out, v)
	}
	return out, rows.Err()
}

func timePtr(v any) *time.Time {
	if t, ok := v.(time.Time); ok {
		u := t.UTC()
		return &u
	}
	return nil
}

// subjectIssue is one review issue with its comment trail.
type subjectIssue struct {
	id, title, status     string
	authorID, resolvedBy  *string
	createdAt, resolvedAt *time.Time
	comments              []subjectComment
}

type subjectComment struct {
	authorID  *string
	createdAt *time.Time
}

func (s *Store) subjectIssues(ctx context.Context, sub *resourceSubject) ([]subjectIssue, error) {
	rows, err := s.DB.Query(ctx,
		`SELECT id::text AS id, title, status::text AS status, author_id::text AS author_id,
		        resolved_by::text AS resolved_by, created_at, resolved_at
		 FROM review_issues WHERE subject_type = $1 AND subject_id = $2 ORDER BY created_at ASC`,
		sub.spec.subject, sub.id)
	if err != nil {
		return nil, err
	}
	var issues []subjectIssue
	index := map[string]int{}
	for _, row := range collectRows(rows) {
		issue := subjectIssue{
			id: rowStr(row, "id", ""), title: rowStr(row, "title", ""), status: rowStr(row, "status", ""),
			authorID: rowNStr(row, "author_id"), resolvedBy: rowNStr(row, "resolved_by"),
			createdAt: timePtr(row["created_at"]), resolvedAt: timePtr(row["resolved_at"]),
		}
		index[issue.id] = len(issues)
		issues = append(issues, issue)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(issues) == 0 {
		return issues, nil
	}
	ids := make([]string, 0, len(issues))
	for _, issue := range issues {
		ids = append(ids, issue.id)
	}
	crows, err := s.DB.Query(ctx,
		`SELECT issue_id::text AS issue_id, author_id::text AS author_id, created_at
		 FROM review_issue_comments WHERE issue_id = ANY($1::uuid[]) ORDER BY created_at ASC`, ids)
	if err != nil {
		return nil, err
	}
	defer crows.Close()
	for _, row := range collectRows(crows) {
		if i, ok := index[rowStr(row, "issue_id", "")]; ok {
			issues[i].comments = append(issues[i].comments, subjectComment{
				authorID: rowNStr(row, "author_id"), createdAt: timePtr(row["created_at"]),
			})
		}
	}
	return issues, crows.Err()
}

// lifecycleEvent is one derived timeline entry before actor hydration.
type lifecycleEvent struct {
	kind      string
	at        *time.Time
	actorID   *string
	version   any
	versionID string
	issueID   string
	detail    any
}

func (s *Store) lifecycleUsers(ctx context.Context, ids map[string]bool) (map[string]map[string]any, error) {
	clean := make([]string, 0, len(ids))
	for id := range ids {
		if id != "" {
			clean = append(clean, id)
		}
	}
	users := map[string]map[string]any{}
	if len(clean) == 0 {
		return users, nil
	}
	rows, err := s.DB.Query(ctx,
		`SELECT id::text AS id, username, name FROM users WHERE id = ANY($1::uuid[])`, clean)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for _, row := range collectRows(rows) {
		users[rowStr(row, "id", "")] = map[string]any{
			"id": row["id"], "username": row["username"], "name": row["name"],
		}
	}
	return users, rows.Err()
}

func lifecycleActor(users map[string]map[string]any, actorID *string) any {
	if actorID == nil {
		return nil
	}
	if u, ok := users[*actorID]; ok {
		return u
	}
	return map[string]any{"id": *actorID, "username": nil, "name": nil}
}

// ResourceActivity derives the immutable lifecycle timeline, newest first.
func (s *Store) ResourceActivity(ctx context.Context, subjectID string, limit int, viewer *Viewer) (map[string]any, error) {
	sub, err := s.requireResourceSubject(ctx, subjectID, viewer)
	if err != nil {
		return nil, err
	}
	versions, err := s.visibleVersions(ctx, sub, viewer)
	if err != nil {
		return nil, err
	}
	issues, err := s.subjectIssues(ctx, sub)
	if err != nil {
		return nil, err
	}

	var events []lifecycleEvent
	if created := timePtr(sub.createdAt); created != nil {
		var actor *string
		if sub.creator != "" {
			actor = &sub.creator
		}
		events = append(events, lifecycleEvent{kind: "resource_created", at: created, actorID: actor})
	}
	for _, ver := range versions {
		opened := ver.createdAt
		if opened == nil {
			opened = ver.releasedAt
		}
		var detail any
		if ver.description != "" {
			detail = ver.description
		}
		events = append(events, lifecycleEvent{
			kind: "change_opened", at: opened, actorID: ver.releasedBy,
			version: ver.version, versionID: ver.id, detail: detail,
		})
		switch ver.status {
		case "approved":
			at := firstTime(ver.reviewedAt, ver.releasedAt, opened)
			actor := ver.reviewedBy
			if actor == nil {
				actor = ver.releasedBy
			}
			events = append(events, lifecycleEvent{
				kind: "version_published", at: at, actorID: actor, version: ver.version, versionID: ver.id,
			})
		case "rejected":
			var reason any
			if ver.rejectionReason != "" {
				reason = ver.rejectionReason
			}
			events = append(events, lifecycleEvent{
				kind: "change_rejected", at: firstTime(ver.reviewedAt, opened), actorID: ver.reviewedBy,
				version: ver.version, versionID: ver.id, detail: reason,
			})
		}
		if ver.promotedFrom != nil {
			events = append(events, lifecycleEvent{
				kind: "version_restored", at: opened, actorID: ver.releasedBy,
				version: ver.version, versionID: ver.id,
			})
		}
	}
	for _, issue := range issues {
		events = append(events, lifecycleEvent{
			kind: "issue_opened", at: issue.createdAt, actorID: issue.authorID,
			issueID: issue.id, detail: issue.title,
		})
		for _, comment := range issue.comments {
			events = append(events, lifecycleEvent{
				kind: "issue_comment", at: comment.createdAt, actorID: comment.authorID,
				issueID: issue.id, detail: issue.title,
			})
		}
		if issue.status == "resolved" && issue.resolvedAt != nil {
			events = append(events, lifecycleEvent{
				kind: "issue_resolved", at: issue.resolvedAt, actorID: issue.resolvedBy,
				issueID: issue.id, detail: issue.title,
			})
		}
	}

	kept := events[:0]
	for _, e := range events {
		if e.at != nil {
			kept = append(kept, e)
		}
	}
	sort.SliceStable(kept, func(i, j int) bool { return kept[i].at.After(*kept[j].at) })
	total := len(kept)
	if len(kept) > limit {
		kept = kept[:limit]
	}

	actorIDs := map[string]bool{}
	for _, e := range kept {
		if e.actorID != nil {
			actorIDs[*e.actorID] = true
		}
	}
	users, err := s.lifecycleUsers(ctx, actorIDs)
	if err != nil {
		return nil, err
	}
	wire := make([]map[string]any, 0, len(kept))
	for _, e := range kept {
		wire = append(wire, map[string]any{
			"type":       e.kind,
			"at":         wireTimePlus(*e.at),
			"actor":      lifecycleActor(users, e.actorID),
			"version":    e.version,
			"version_id": nilIfEmptyStr(e.versionID),
			"issue_id":   nilIfEmptyStr(e.issueID),
			"detail":     e.detail,
		})
	}
	return map[string]any{
		"subject_type": sub.spec.subject, "subject_id": sub.id, "total": total, "events": wire,
	}, nil
}

func firstTime(candidates ...*time.Time) *time.Time {
	for _, t := range candidates {
		if t != nil {
			return t
		}
	}
	return nil
}

// contributorStats accumulates one user's attribution counters.
type contributorStats struct {
	changesOpened, versionsPublished, reviews int
	issuesOpened, issuesResolved, comments    int
	isCreator                                 bool
	lastActivity                              *time.Time
}

// ResourceContributors derives the attribution roster from history.
func (s *Store) ResourceContributors(ctx context.Context, subjectID string, viewer *Viewer) (map[string]any, error) {
	sub, err := s.requireResourceSubject(ctx, subjectID, viewer)
	if err != nil {
		return nil, err
	}
	versions, err := s.visibleVersions(ctx, sub, viewer)
	if err != nil {
		return nil, err
	}
	issues, err := s.subjectIssues(ctx, sub)
	if err != nil {
		return nil, err
	}

	stats := map[string]*contributorStats{}
	order := []string{}
	bucket := func(userID *string) *contributorStats {
		if userID == nil || *userID == "" {
			return nil
		}
		entry, ok := stats[*userID]
		if !ok {
			entry = &contributorStats{}
			stats[*userID] = entry
			order = append(order, *userID)
		}
		return entry
	}
	touch := func(entry *contributorStats, at *time.Time) {
		if entry == nil || at == nil {
			return
		}
		if entry.lastActivity == nil || at.After(*entry.lastActivity) {
			entry.lastActivity = at
		}
	}

	if sub.creator != "" {
		entry := bucket(&sub.creator)
		entry.isCreator = true
		touch(entry, timePtr(sub.createdAt))
	}
	for _, ver := range versions {
		if entry := bucket(ver.releasedBy); entry != nil {
			entry.changesOpened++
			if ver.status == "approved" {
				entry.versionsPublished++
			}
			touch(entry, firstTime(ver.createdAt, ver.releasedAt))
		}
		if ver.reviewedBy != nil {
			reviewer := bucket(ver.reviewedBy)
			reviewer.reviews++
			touch(reviewer, ver.reviewedAt)
		}
	}
	for _, issue := range issues {
		if author := bucket(issue.authorID); author != nil {
			author.issuesOpened++
			touch(author, issue.createdAt)
		}
		if issue.status == "resolved" && issue.resolvedBy != nil {
			resolver := bucket(issue.resolvedBy)
			resolver.issuesResolved++
			touch(resolver, issue.resolvedAt)
		}
		for _, comment := range issue.comments {
			if commenter := bucket(comment.authorID); commenter != nil {
				commenter.comments++
				touch(commenter, comment.createdAt)
			}
		}
	}

	ids := map[string]bool{}
	for id := range stats {
		ids[id] = true
	}
	users, err := s.lifecycleUsers(ctx, ids)
	if err != nil {
		return nil, err
	}
	type rosterEntry struct {
		wire    map[string]any
		lastISO string
		opened  int
	}
	roster := make([]rosterEntry, 0, len(order))
	for _, userID := range order {
		entry := stats[userID]
		lastISO := ""
		var lastWire any
		if entry.lastActivity != nil {
			lastISO, _ = wireTimePlus(*entry.lastActivity).(string)
			lastWire = lastISO
		}
		id := userID
		roster = append(roster, rosterEntry{
			wire: map[string]any{
				"user":               lifecycleActor(users, &id),
				"is_creator":         entry.isCreator,
				"changes_opened":     entry.changesOpened,
				"versions_published": entry.versionsPublished,
				"reviews":            entry.reviews,
				"issues_opened":      entry.issuesOpened,
				"issues_resolved":    entry.issuesResolved,
				"comments":           entry.comments,
				"last_activity_at":   lastWire,
			},
			lastISO: lastISO, opened: entry.changesOpened,
		})
	}
	sort.SliceStable(roster, func(i, j int) bool {
		if c := strings.Compare(roster[i].lastISO, roster[j].lastISO); c != 0 {
			return c > 0
		}
		return roster[i].opened > roster[j].opened
	})
	wire := make([]map[string]any, 0, len(roster))
	for _, entry := range roster {
		wire = append(wire, entry.wire)
	}
	return map[string]any{
		"subject_type": sub.spec.subject, "subject_id": sub.id,
		"total": len(wire), "contributors": wire,
	}, nil
}

// ── Agent identity resolution (registry resolve, agent arm) ─────────────

// ResolveAgentIdentity finds an agent by UUID, prefix, canonical name, or
// unambiguous bare name, hiding what the caller may not see.
func (s *Store) ResolveAgentIdentity(ctx context.Context, identifier string, viewer *Viewer) (map[string]any, error) {
	norm := strings.ToLower(strings.TrimSpace(identifier))
	const cols = `l.id::text AS id, l.namespace, l.slug, l.name, l.is_private, l.ownership_scope,
		l.project_id::text AS project_id, l.co_authors,
		l.created_by::text AS creator, l.created_at, v.status::text AS v_status`
	fromClause := `FROM agents l LEFT JOIN agent_versions v ON l.latest_version_id = v.id`

	gate := func(row map[string]any) (map[string]any, error) {
		sub := &resourceSubject{
			spec: resourceSpecs[0], id: rowStr(row, "id", ""), creator: rowStr(row, "creator", ""),
			coAuthors: rowCoAuthors(row), row: row,
		}
		visible, err := s.subjectVisible(ctx, sub, viewer)
		if err != nil {
			return nil, err
		}
		if !visible {
			return nil, nil
		}
		if rowStr(row, "v_status", "") != "approved" {
			perm := subjectPermission(sub, viewer)
			ownerMatch := viewer != nil && sub.creator == viewer.ID.String()
			if !mayViewUnapproved(perm, viewer) && !ownerMatch {
				return nil, nil
			}
		}
		return row, nil
	}

	// UUID and unique-prefix lookups return any status; the gate above hides
	// what the name branch's status filter would have hidden.
	if _, err := uuid.Parse(norm); err == nil {
		rows, err := s.DB.Query(ctx, fmt.Sprintf(
			`SELECT %s %s WHERE l.id = $1 AND l.deleted_at IS NULL`, cols, fromClause), norm)
		if err != nil {
			return nil, err
		}
		found := collectRows(rows)
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		if len(found) == 1 {
			return gate(found[0])
		}
	} else if len(norm) >= 4 {
		rows, err := s.DB.Query(ctx, fmt.Sprintf(
			`SELECT %s %s WHERE l.id::text LIKE $1 AND l.deleted_at IS NULL LIMIT 2`, cols, fromClause), norm+"%")
		if err != nil {
			return nil, err
		}
		found := collectRows(rows)
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		if len(found) == 1 {
			return gate(found[0])
		}
	}

	// Name branch: canonical namespace/slug, else bare slug-or-name with an
	// ambiguity report scoped to what the caller may see.
	var identity string
	args := []any{}
	bare := false
	if ns, slug, ok := strings.Cut(identifier, "/"); ok && ns != "" && slug != "" && !strings.Contains(slug, "/") {
		args = append(args, strings.ToLower(strings.TrimSpace(ns)), strings.ToLower(strings.TrimSpace(slug)))
		identity = "l.namespace = $1 AND l.slug = $2"
	} else {
		args = append(args, norm, identifier)
		identity = "(l.slug = $1 OR l.name = $2)"
		bare = true
	}
	statusGate := "v.status = 'approved'"
	if viewer != nil {
		args = append(args, viewer.ID)
		statusGate = fmt.Sprintf("(v.status = 'approved' OR l.created_by = $%d)", len(args))
	}
	visibility := visibilitySQLCreator("l", "l.created_by", viewer, &args)
	rows, err := s.DB.Query(ctx, fmt.Sprintf(
		`SELECT %s FROM agents l JOIN agent_versions v ON l.latest_version_id = v.id
		 WHERE %s AND l.deleted_at IS NULL AND %s AND %s LIMIT 2`,
		cols, identity, statusGate, visibility), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	found := collectRows(rows)
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if bare && len(found) > 1 {
		choices := make([]string, 0, len(found))
		for _, row := range found {
			choices = append(choices, rowStr(row, "namespace", "")+"/"+rowStr(row, "slug", ""))
		}
		return nil, &apiError{Status: 409,
			Detail: fmt.Sprintf("'%s' is ambiguous; use one of: %s", identifier, strings.Join(choices, ", "))}
	}
	if len(found) == 0 {
		return nil, nil
	}
	return gate(found[0])
}

// ── Handlers ────────────────────────────────────────────────────────────

func resourceQueryInt(q map[string][]string, key string, def, ge, le int, errs *[]fieldError) int {
	raw, ok := firstQuery(q, key)
	if !ok {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		*errs = append(*errs, fieldError{Type: "int_parsing", Loc: []string{"query", key},
			Msg: "Input should be a valid integer, unable to parse string as an integer", Input: raw})
		return def
	}
	if n < ge {
		*errs = append(*errs, fieldError{Type: "greater_than_equal", Loc: []string{"query", key},
			Msg: fmt.Sprintf("Input should be greater than or equal to %d", ge), Input: raw,
			Ctx: map[string]any{"ge": ge}})
		return def
	}
	if le > 0 && n > le {
		*errs = append(*errs, fieldError{Type: "less_than_equal", Loc: []string{"query", key},
			Msg: fmt.Sprintf("Input should be less than or equal to %d", le), Input: raw,
			Ctx: map[string]any{"le": le}})
		return def
	}
	return n
}

func resourceQueryBool(q map[string][]string, key string, errs *[]fieldError) bool {
	raw, ok := firstQuery(q, key)
	if !ok {
		return false
	}
	switch strings.ToLower(raw) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off", "":
		return false
	}
	*errs = append(*errs, fieldError{Type: "bool_parsing", Loc: []string{"query", key},
		Msg: "Input should be a valid boolean, unable to interpret input", Input: raw})
	return false
}

func resourceQueryTime(q map[string][]string, key string, errs *[]fieldError) *time.Time {
	raw, ok := firstQuery(q, key)
	if !ok || raw == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05", "2006-01-02"} {
		if t, err := time.Parse(layout, raw); err == nil {
			u := t.UTC()
			return &u
		}
	}
	*errs = append(*errs, fieldError{Type: "datetime_parsing", Loc: []string{"query", key},
		Msg: "Input should be a valid datetime", Input: raw})
	return nil
}

func firstQuery(q map[string][]string, key string) (string, bool) {
	if vals, ok := q[key]; ok && len(vals) > 0 {
		return vals[0], true
	}
	return "", false
}

func (h *Handler) listResources() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := viewerFrom(r)
		raw := r.URL.Query()
		errs := []fieldError{}
		q := &resourceListQuery{
			Type:   raw.Get("type"),
			Search: raw.Get("search"),
			Scope:  raw.Get("scope"),
			Status: raw.Get("status"),
			Owner:  raw.Get("owner"),
			Sort:   raw.Get("sort"),
			Mine:   resourceQueryBool(raw, "mine", &errs), IncludeUnpublished: resourceQueryBool(raw, "include_unpublished", &errs),
			UpdatedAfter: resourceQueryTime(raw, "updated_after", &errs),
			CreatedAfter: resourceQueryTime(raw, "created_after", &errs),
			Page:         resourceQueryInt(raw, "page", 1, 1, 0, &errs),
			PageSize:     resourceQueryInt(raw, "page_size", 10, 1, 50, &errs),
		}
		if len(q.Search) > 200 {
			errs = append(errs, fieldError{Type: "string_too_long", Loc: []string{"query", "search"},
				Msg: "String should have at most 200 characters", Input: q.Search,
				Ctx: map[string]any{"max_length": 200}})
		}
		if len(q.Owner) > 255 {
			errs = append(errs, fieldError{Type: "string_too_long", Loc: []string{"query", "owner"},
				Msg: "String should have at most 255 characters", Input: q.Owner,
				Ctx: map[string]any{"max_length": 255}})
		}
		if len(errs) > 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, errs)
			return
		}
		if q.Sort == "" {
			q.Sort = "updated"
		}
		validSort := false
		for _, s := range resourceSorts {
			if q.Sort == s {
				validSort = true
			}
		}
		if !validSort {
			writeStoreError(w, r, &apiError{Status: 422,
				Detail: "sort must be one of " + strings.Join(resourceSorts, ", ")})
			return
		}
		if q.Scope != "" {
			if q.Scope != "project" && q.Scope != "private" {
				writeStoreError(w, r, &apiError{Status: 422,
					Detail: "scope must be one of " + strings.Join(resourceScopes, ", ")})
				return
			}
		}
		if q.Status != "" {
			valid := false
			for _, s := range resourceStatuses {
				if q.Status == s {
					valid = true
				}
			}
			if !valid {
				writeStoreError(w, r, &apiError{Status: 422,
					Detail: "status must be one of " + strings.Join(resourceStatuses, ", ")})
				return
			}
		}
		offset := (q.Page - 1) * q.PageSize
		if offset+q.PageSize > resourceMaxWindow {
			writeStoreError(w, r, &apiError{Status: 422,
				Detail: "Page is beyond the supported window; narrow the filters"})
			return
		}

		// Anonymous callers carry no memberships to validate, so any claimed
		// scope is ignored and they get the public-only listing.
		var projectID *uuid.UUID
		if viewer != nil {
			ambient, err := h.Store.AmbientProjectID(r.Context(), r, viewer)
			if err != nil {
				writeStoreError(w, r, err)
				return
			}
			projectID = ambient
		}
		out, err := h.Store.ListResources(r.Context(), q, viewer, projectID)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, out)
	})
}

func (h *Handler) resourceActivity() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		errs := []fieldError{}
		limit := resourceQueryInt(r.URL.Query(), "limit", 100, 1, 500, &errs)
		if len(errs) > 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, errs)
			return
		}
		out, err := h.Store.ResourceActivity(r.Context(), r.PathValue("subject_id"), limit, viewer)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, out)
	})
}

func (h *Handler) resourceContributors() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		out, err := h.Store.ResourceContributors(r.Context(), r.PathValue("subject_id"), viewer)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, out)
	})
}

// registerResourceRoutes mounts the unified resource tree and lifecycle reads.
func (h *Handler) registerResourceRoutes(mux *http.ServeMux, withAuth func(http.Handler) http.Handler) {
	mux.Handle("GET /api/v1/resources", withAuth(h.listResources()))
	mux.Handle("GET /api/v1/resources/{subject_id}/activity", withAuth(h.resourceActivity()))
	mux.Handle("GET /api/v1/resources/{subject_id}/contributors", withAuth(h.resourceContributors()))
}
