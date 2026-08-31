// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package orgs

import (
	"encoding/base64"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/redact"
	"github.com/garudex-labs/caracal/internal/tenancy"
)

// activityDefaultPageSize is the default server-controlled page size for the
// organization audit and security feeds. Pagination is cursor-based, and the
// API only accepts the explicit sizes the UI exposes, so callers cannot widen
// this to pull an unbounded history in one request.
const activityDefaultPageSize = 20

const orgAuditColumns = "event_id, timestamp, actor_id, actor_email, actor_role, " +
	"action, resource_type, resource_id, resource_name, http_method, " +
	"http_path, status_code, ip_address, user_agent, detail, " +
	"sensitivity, request_id, outcome, duration_ms, chain_hash, source"

const orgSecurityColumns = "event_id, timestamp, event_type, severity, actor_id, " +
	"actor_email, actor_role, target_id, target_type, outcome, source_ip, " +
	"user_agent, detail"

func requireOrgPermission(w http.ResponseWriter, org *Org, permission tenancy.Permission) bool {
	if !tenancy.EffectiveOrgPermissions(org.Role).Has(permission) {
		httpapi.WriteError(w, http.StatusForbidden, "Insufficient organization permissions")
		return false
	}
	return true
}

// activityCursor is the keyset position of the last row already returned:
// pagination continues strictly past this (timestamp, event_id) pair. Non-time
// sorts append their leading sort value as a third cursor segment.
type activityCursor struct {
	timestamp string
	eventID   string
	sortValue string
}

func encodeActivityCursor(timestamp, eventID string, sortValue ...string) string {
	parts := []string{timestamp, eventID}
	if len(sortValue) > 0 {
		parts = append(parts, sortValue[0])
	}
	return base64.RawURLEncoding.EncodeToString([]byte(strings.Join(parts, "|")))
}

func decodeActivityCursor(raw string) (activityCursor, bool) {
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return activityCursor{}, false
	}
	parts := strings.SplitN(string(decoded), "|", 3)
	if len(parts) < 2 || parts[0] == "" {
		return activityCursor{}, false
	}
	if _, err := uuid.Parse(parts[1]); err != nil {
		return activityCursor{}, false
	}
	cursor := activityCursor{timestamp: parts[0], eventID: parts[1]}
	if len(parts) == 3 {
		cursor.sortValue = parts[2]
	}
	return cursor, true
}

type activitySortSpec struct {
	column     string
	paramType  string
	descending bool
}

var activityTimeSorts = map[string]activitySortSpec{
	"newest": {column: "timestamp", paramType: "String", descending: true},
	"oldest": {column: "timestamp", paramType: "String", descending: false},
}

var securitySorts = map[string]activitySortSpec{
	"newest":     {column: "timestamp", paramType: "String", descending: true},
	"oldest":     {column: "timestamp", paramType: "String", descending: false},
	"event_type": {column: "event_type", paramType: "String", descending: false},
	"outcome":    {column: "outcome", paramType: "String", descending: false},
}

var auditSorts = map[string]activitySortSpec{
	"newest":      {column: "timestamp", paramType: "String", descending: true},
	"oldest":      {column: "timestamp", paramType: "String", descending: false},
	"slowest":     {column: "duration_ms", paramType: "Float64", descending: true},
	"status_desc": {column: "status_code", paramType: "UInt16", descending: true},
}

// activityQuery carries the request-derived pagination controls shared by the
// audit and security feeds.
type activityQuery struct {
	sort      activitySortSpec
	pageSize  int
	cursor    activityCursor
	hasCursor bool
}

func validActivityPageSize(size int) bool {
	switch size {
	case 20, 50, 100:
		return true
	default:
		return false
	}
}

func parseActivityQuery(w http.ResponseWriter, r *http.Request, sorts map[string]activitySortSpec) (activityQuery, bool) {
	q := activityQuery{pageSize: activityDefaultPageSize, sort: sorts["newest"]}
	if rawSort := r.URL.Query().Get("sort"); rawSort != "" {
		sort, ok := sorts[rawSort]
		if !ok {
			httpapi.WriteError(w, http.StatusUnprocessableEntity, "sort is invalid")
			return activityQuery{}, false
		}
		q.sort = sort
	} else {
		switch r.URL.Query().Get("dir") {
		case "", "desc":
			q.sort = sorts["newest"]
		case "asc":
			q.sort = sorts["oldest"]
		default:
			httpapi.WriteError(w, http.StatusUnprocessableEntity, "dir must be 'asc' or 'desc'")
			return activityQuery{}, false
		}
	}
	if raw := r.URL.Query().Get("page_size"); raw != "" {
		size, err := strconv.Atoi(raw)
		if err != nil || !validActivityPageSize(size) {
			httpapi.WriteError(w, http.StatusUnprocessableEntity, "page_size must be one of 20, 50, or 100")
			return activityQuery{}, false
		}
		q.pageSize = size
	}
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		cursor, ok := decodeActivityCursor(raw)
		if !ok {
			httpapi.WriteError(w, http.StatusUnprocessableEntity, "cursor is invalid")
			return activityQuery{}, false
		}
		q.cursor = cursor
		q.hasCursor = true
		if q.sort.column != "timestamp" && q.cursor.sortValue == "" {
			httpapi.WriteError(w, http.StatusUnprocessableEntity, "cursor is invalid for sort")
			return activityQuery{}, false
		}
	}
	return q, true
}

var activityTimeFormats = []string{
	time.RFC3339Nano,
	"2006-01-02T15:04:05",
	"2006-01-02 15:04:05",
	"2006-01-02",
}

func parseActivityTime(raw string, endOfDay bool) (time.Time, bool) {
	for _, layout := range activityTimeFormats {
		if ts, err := time.Parse(layout, raw); err == nil {
			if layout == "2006-01-02" && endOfDay {
				ts = ts.Add(24*time.Hour - time.Second)
			}
			return ts, true
		}
	}
	return time.Time{}, false
}

// keyset appends the cursor predicate (when paging) and returns the trailing
// ORDER BY / LIMIT clause. The sort key plus (timestamp, event_id) tie-breakers
// forms a total order, so pages never duplicate or skip rows even when primary
// sort values collide.
func (q activityQuery) keyset(conditions *[]string, params clickhouse.Settings) string {
	dir, cmp := "DESC", "<"
	if !q.sort.descending {
		dir, cmp = "ASC", ">"
	}
	if q.hasCursor && q.sort.column == "timestamp" {
		*conditions = append(*conditions, fmt.Sprintf(
			"(timestamp %s {cursor_ts:String} OR (timestamp = {cursor_ts:String} AND event_id %s {cursor_id:UUID}))",
			cmp, cmp))
		params["param_cursor_ts"] = q.cursor.timestamp
		params["param_cursor_id"] = q.cursor.eventID
	} else if q.hasCursor {
		*conditions = append(*conditions, fmt.Sprintf(
			"(%s %s {cursor_sort:%s} OR (%s = {cursor_sort:%s} AND (timestamp < {cursor_ts:String} OR (timestamp = {cursor_ts:String} AND event_id < {cursor_id:UUID}))))",
			q.sort.column, cmp, q.sort.paramType, q.sort.column, q.sort.paramType))
		params["param_cursor_sort"] = q.cursor.sortValue
		params["param_cursor_ts"] = q.cursor.timestamp
		params["param_cursor_id"] = q.cursor.eventID
	}
	if q.sort.column == "timestamp" {
		return fmt.Sprintf("ORDER BY timestamp %s, event_id %s LIMIT %d", dir, dir, q.pageSize+1)
	}
	return fmt.Sprintf("ORDER BY %s %s, timestamp DESC, event_id DESC LIMIT %d", q.sort.column, dir, q.pageSize+1)
}

// applyEqualityFilters ANDs an allow-listed equality predicate for each filter
// the request carries, keeping arbitrary client parameters out of the query.
func applyEqualityFilters(r *http.Request, conditions *[]string, params clickhouse.Settings, filters [][2]string) {
	for _, filter := range filters {
		query, column := filter[0], filter[1]
		if value := strings.TrimSpace(r.URL.Query().Get(query)); value != "" {
			name := "f_" + column
			*conditions = append(*conditions, column+" = {"+name+":String}")
			params["param_"+name] = value
		}
	}
}

func escapeActivityLike(value string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(value)
}

func applyActivityUIntFilter(w http.ResponseWriter, r *http.Request, conditions *[]string, params clickhouse.Settings, query, column string) bool {
	raw := strings.TrimSpace(r.URL.Query().Get(query))
	if raw == "" {
		return true
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 0 || value > 999 {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, query+" must be a valid status code")
		return false
	}
	name := "f_" + column
	*conditions = append(*conditions, column+" = {"+name+":UInt16}")
	params["param_"+name] = raw
	return true
}

func applySecurityCategoryFilter(w http.ResponseWriter, r *http.Request, conditions *[]string) bool {
	switch r.URL.Query().Get("category") {
	case "":
		return true
	case "auth":
		*conditions = append(*conditions, "(event_type LIKE 'auth.%' OR event_type LIKE 'login_%' OR event_type LIKE 'token_%')")
	case "organization":
		*conditions = append(*conditions, "event_type IN ('org.created', 'org.renamed', 'org.deleted', 'org.ownership.transferred')")
	case "membership":
		*conditions = append(*conditions, "event_type IN ('org.membership.changed', 'org.project.membership.changed')")
	case "project":
		*conditions = append(*conditions, "event_type IN ('org.project.created', 'org.project.deleted', 'org.project.membership.changed', 'org.project.retention.changed')")
	case "invitation":
		*conditions = append(*conditions, "event_type IN ('org.invitation.created', 'org.invitation.revoked', 'org.invitation.accepted')")
	case "settings":
		*conditions = append(*conditions, "event_type LIKE 'admin.setting.%'")
	default:
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "category is not a valid filter")
		return false
	}
	return true
}

// applyActivitySearch adds a parameterized substring match over a fixed search
// expression. Matching n-gram indexes are declared in the activity migrations.
func applyActivitySearch(w http.ResponseWriter, r *http.Request, conditions *[]string, params clickhouse.Settings, expression string) bool {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		return true
	}
	if len(query) > 200 {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "q must be at most 200 characters")
		return false
	}
	escaped := escapeActivityLike(strings.ToLower(query))
	*conditions = append(*conditions, "lowerUTF8("+expression+") LIKE {search:String}")
	params["param_search"] = "%" + escaped + "%"
	return true
}

func applyActivityTextFilter(w http.ResponseWriter, r *http.Request, conditions *[]string, params clickhouse.Settings, query, name, expression string) bool {
	value := strings.TrimSpace(r.URL.Query().Get(query))
	if value == "" {
		return true
	}
	if len(value) > 200 {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, query+" must be at most 200 characters")
		return false
	}
	escaped := escapeActivityLike(strings.ToLower(value))
	*conditions = append(*conditions, "lowerUTF8("+expression+") LIKE {"+name+":String}")
	params["param_"+name] = "%" + escaped + "%"
	return true
}

func applyActivityTimeRange(w http.ResponseWriter, r *http.Request, conditions *[]string, params clickhouse.Settings) bool {
	for _, filter := range []struct {
		query    string
		op       string
		name     string
		endOfDay bool
	}{
		{"start_date", ">=", "start", false},
		{"end_date", "<=", "end", true},
	} {
		raw := strings.TrimSpace(r.URL.Query().Get(filter.query))
		if raw == "" {
			continue
		}
		ts, ok := parseActivityTime(raw, filter.endOfDay)
		if !ok {
			httpapi.WriteError(w, http.StatusUnprocessableEntity, filter.query+" must be a valid datetime")
			return false
		}
		*conditions = append(*conditions, "timestamp "+filter.op+" {"+filter.name+":String}")
		params["param_"+filter.name] = ts.Format("2006-01-02 15:04:05")
	}
	return true
}

// writeActivityPage trims the over-fetched row to the page size, derives the
// next cursor from the last surviving row, and writes the paging envelope.
func writeActivityPage(w http.ResponseWriter, rows []map[string]any, page activityQuery) {
	redactActivityRows(rows)
	events := rows
	hasMore := false
	if len(rows) > page.pageSize {
		hasMore = true
		events = rows[:page.pageSize]
	}
	if events == nil {
		events = []map[string]any{}
	}
	var nextCursor any
	if hasMore {
		last := events[len(events)-1]
		if page.sort.column == "timestamp" {
			nextCursor = encodeActivityCursor(activityString(last, "timestamp"), activityString(last, "event_id"))
		} else {
			nextCursor = encodeActivityCursor(activityString(last, "timestamp"), activityString(last, "event_id"), activityCursorValue(last, page.sort.column))
		}
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"events":      events,
		"next_cursor": nextCursor,
		"has_more":    hasMore,
		"page_size":   page.pageSize,
	})
}

func redactActivityRows(rows []map[string]any) {
	for _, row := range rows {
		for _, key := range []string{"detail", "user_agent", "http_path"} {
			if value, ok := row[key].(string); ok && value != "" {
				row[key] = redact.Secrets(value)
			}
		}
	}
}

func activityString(row map[string]any, key string) string {
	s, _ := row[key].(string)
	return s
}

func activityCursorValue(row map[string]any, key string) string {
	if value, ok := row[key]; ok {
		return fmt.Sprint(value)
	}
	return ""
}

func (h *Handler) orgSecurityEvents(w http.ResponseWriter, r *http.Request) {
	org, ok := h.org(w, r)
	if !ok || !requireOrgPermission(w, org, tenancy.PermissionOrgSecurityRead) {
		return
	}
	if h.CH == nil {
		httpapi.WriteInternalError(w, r, fmt.Errorf("organization security events store is not configured"))
		return
	}
	page, ok := parseActivityQuery(w, r, securitySorts)
	if !ok {
		return
	}
	conditions := []string{"target_type = 'organization'", "target_id = {org_id:String}"}
	params := clickhouse.Settings{"param_org_id": org.ID.String()}
	applyEqualityFilters(r, &conditions, params, [][2]string{
		{"event_type", "event_type"},
		{"severity", "severity"},
		{"outcome", "outcome"},
		{"actor", "actor_email"},
		{"target_type", "target_type"},
		{"target_id", "target_id"},
		{"source_ip", "source_ip"},
	})
	if !applySecurityCategoryFilter(w, r, &conditions) {
		return
	}
	if !applyActivityTimeRange(w, r, &conditions, params) {
		return
	}
	if !applyActivityTextFilter(w, r, &conditions, params, "target", "target", "concat(target_type, ' ', target_id, ' ', detail)") {
		return
	}
	if !applyActivitySearch(w, r, &conditions, params,
		"concat(event_type, ' ', severity, ' ', actor_email, ' ', actor_role, ' ', target_type, ' ', target_id, ' ', outcome, ' ', source_ip, ' ', user_agent, ' ', detail)") {
		return
	}
	order := page.keyset(&conditions, params)
	sql := fmt.Sprintf("SELECT %s FROM security_events WHERE %s %s FORMAT JSON",
		orgSecurityColumns, strings.Join(conditions, " AND "), order)
	rows, err := h.CH.QueryJSON(r.Context(), sql, params)
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	writeActivityPage(w, rows, page)
}

func (h *Handler) orgAuditLog(w http.ResponseWriter, r *http.Request) {
	org, ok := h.org(w, r)
	if !ok || !requireOrgPermission(w, org, tenancy.PermissionOrgAuditRead) {
		return
	}
	if h.CH == nil {
		httpapi.WriteInternalError(w, r, fmt.Errorf("organization audit log store is not configured"))
		return
	}
	page, ok := parseActivityQuery(w, r, auditSorts)
	if !ok {
		return
	}
	// Organization audit events are recorded either against the org id or under
	// its slug path; both scope terms are derived from the resolved org, never
	// from client input, so filters and cursors cannot cross the org boundary.
	conditions := []string{"(resource_id = {org_id:String} OR http_path LIKE {org_path:String})"}
	params := clickhouse.Settings{
		"param_org_id":   org.ID.String(),
		"param_org_path": "/api/v1/orgs/" + org.Slug + "%",
	}
	applyEqualityFilters(r, &conditions, params, [][2]string{
		{"action", "action"},
		{"resource_type", "resource_type"},
		{"resource_id", "resource_id"},
		{"resource_name", "resource_name"},
		{"outcome", "outcome"},
		{"sensitivity", "sensitivity"},
		{"actor", "actor_email"},
		{"request_id", "request_id"},
		{"source", "source"},
		{"ip_address", "ip_address"},
		{"http_method", "http_method"},
	})
	if !applyActivityUIntFilter(w, r, &conditions, params, "status_code", "status_code") {
		return
	}
	if project := strings.TrimSpace(r.URL.Query().Get("project")); project != "" {
		if len(project) > 80 {
			httpapi.WriteError(w, http.StatusUnprocessableEntity, "project must be at most 80 characters")
			return
		}
		conditions = append(conditions, "http_path LIKE {project_path:String}")
		params["param_project_path"] = "/api/v1/orgs/" + org.Slug + "/projects/" + escapeActivityLike(project) + "%"
	}
	if !applyActivityTimeRange(w, r, &conditions, params) {
		return
	}
	if !applyActivityTextFilter(w, r, &conditions, params, "resource", "resource", "concat(resource_type, ' ', resource_id, ' ', resource_name, ' ', http_path)") {
		return
	}
	if !applyActivitySearch(w, r, &conditions, params,
		"concat(actor_email, ' ', action, ' ', resource_type, ' ', resource_name, ' ', http_method, ' ', http_path, ' ', outcome, ' ', detail)") {
		return
	}
	order := page.keyset(&conditions, params)
	sql := fmt.Sprintf("SELECT %s FROM audit_log WHERE %s %s FORMAT JSON",
		orgAuditColumns, strings.Join(conditions, " AND "), order)
	rows, err := h.CH.QueryJSON(r.Context(), sql, params)
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	writeActivityPage(w, rows, page)
}
