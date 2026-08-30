// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package orgs

import (
	"encoding/base64"
	"fmt"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/tenancy"
)

// activityPageSize is the fixed, server-controlled page size for the
// organization audit and security feeds. Pagination is cursor-based, so the
// client cannot widen this to pull an unbounded history in one request.
const activityPageSize = 50

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
// pagination continues strictly past this (timestamp, event_id) pair.
type activityCursor struct {
	timestamp string
	eventID   string
}

func encodeActivityCursor(timestamp, eventID string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(timestamp + "|" + eventID))
}

func decodeActivityCursor(raw string) (activityCursor, bool) {
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return activityCursor{}, false
	}
	timestamp, eventID, ok := strings.Cut(string(decoded), "|")
	if !ok || timestamp == "" {
		return activityCursor{}, false
	}
	if _, err := uuid.Parse(eventID); err != nil {
		return activityCursor{}, false
	}
	return activityCursor{timestamp: timestamp, eventID: eventID}, true
}

// activityQuery carries the request-derived pagination controls shared by the
// audit and security feeds.
type activityQuery struct {
	ascending bool
	cursor    activityCursor
	hasCursor bool
}

func parseActivityQuery(w http.ResponseWriter, r *http.Request) (activityQuery, bool) {
	var q activityQuery
	switch r.URL.Query().Get("dir") {
	case "", "desc":
		q.ascending = false
	case "asc":
		q.ascending = true
	default:
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "dir must be 'asc' or 'desc'")
		return activityQuery{}, false
	}
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		cursor, ok := decodeActivityCursor(raw)
		if !ok {
			httpapi.WriteError(w, http.StatusUnprocessableEntity, "cursor is invalid")
			return activityQuery{}, false
		}
		q.cursor = cursor
		q.hasCursor = true
	}
	return q, true
}

// keyset appends the cursor predicate (when paging) and returns the trailing
// ORDER BY / LIMIT clause. The (timestamp, event_id) key is a total order, so
// pages never duplicate or skip rows even when timestamps collide, and the
// cursor's timestamp bound lets ClickHouse prune whole month partitions on
// deep pages instead of reading and discarding an ever-growing offset.
func (q activityQuery) keyset(conditions *[]string, params clickhouse.Settings) string {
	dir, cmp := "DESC", "<"
	if q.ascending {
		dir, cmp = "ASC", ">"
	}
	if q.hasCursor {
		*conditions = append(*conditions, fmt.Sprintf(
			"(timestamp %s {cursor_ts:String} OR (timestamp = {cursor_ts:String} AND event_id %s {cursor_id:UUID}))",
			cmp, cmp))
		params["param_cursor_ts"] = q.cursor.timestamp
		params["param_cursor_id"] = q.cursor.eventID
	}
	return fmt.Sprintf("ORDER BY timestamp %s, event_id %s LIMIT %d", dir, dir, activityPageSize+1)
}

// applyEqualityFilters ANDs an indexed equality predicate for each filter the
// request carries. Every target column is bloom-filter indexed, so the
// predicate prunes granules at the storage layer rather than in the handler.
func applyEqualityFilters(r *http.Request, conditions *[]string, params clickhouse.Settings, filters [][2]string) {
	for _, filter := range filters {
		query, column := filter[0], filter[1]
		if value := r.URL.Query().Get(query); value != "" {
			name := "f_" + column
			*conditions = append(*conditions, column+" = {"+name+":String}")
			params["param_"+name] = value
		}
	}
}

// applyActivitySearch adds a parameterized substring match over a fixed search
// expression. The matching n-gram indexes are declared in migration 003.
func applyActivitySearch(w http.ResponseWriter, r *http.Request, conditions *[]string, params clickhouse.Settings, expression string) bool {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		return true
	}
	if len(query) > 200 {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "q must be at most 200 characters")
		return false
	}
	escaped := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(strings.ToLower(query))
	*conditions = append(*conditions, "lowerUTF8("+expression+") LIKE {search:String}")
	params["param_search"] = "%" + escaped + "%"
	return true
}

// writeActivityPage trims the over-fetched row to the page size, derives the
// next cursor from the last surviving row, and writes the paging envelope.
func writeActivityPage(w http.ResponseWriter, rows []map[string]any) {
	events := rows
	hasMore := false
	if len(rows) > activityPageSize {
		hasMore = true
		events = rows[:activityPageSize]
	}
	if events == nil {
		events = []map[string]any{}
	}
	var nextCursor any
	if hasMore {
		last := events[len(events)-1]
		nextCursor = encodeActivityCursor(activityString(last, "timestamp"), activityString(last, "event_id"))
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"events":      events,
		"next_cursor": nextCursor,
		"has_more":    hasMore,
		"page_size":   activityPageSize,
	})
}

func activityString(row map[string]any, key string) string {
	s, _ := row[key].(string)
	return s
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
	page, ok := parseActivityQuery(w, r)
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
	})
	if !applyActivitySearch(w, r, &conditions, params,
		"concat(event_type, ' ', actor_email, ' ', outcome, ' ', detail)") {
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
	writeActivityPage(w, rows)
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
	page, ok := parseActivityQuery(w, r)
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
		{"outcome", "outcome"},
		{"sensitivity", "sensitivity"},
		{"actor", "actor_email"},
	})
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
	writeActivityPage(w, rows)
}
