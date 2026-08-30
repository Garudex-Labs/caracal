// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package sessions serves the session listing and trace detail routes,
// reading stored rows from ClickHouse and expanding them through the trace
// viewer parsers.
package sessions

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/harness"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/settings"
	"github.com/garudex-labs/caracal/internal/tenancy"
	"github.com/garudex-labs/caracal/internal/traceview"
)

// NameDirectory resolves display names and user search filters.
type NameDirectory interface {
	UserNames(ctx context.Context, ids []string) map[string]string
	AgentNames(ctx context.Context, ids []string) map[string]string
	UserName(ctx context.Context, id uuid.UUID) string
	ResolveUserFilter(ctx context.Context, query string) []string
}

// AgentBinder pins a session to an agent name for the attribution window.
type AgentBinder interface {
	BindAgent(ctx context.Context, sessionID, agentName string) error
}

// ProjectResolver turns untrusted host/header scope into an authorized project ID.
type ProjectResolver interface {
	ResolveProjectID(ctx context.Context, r *http.Request, userID uuid.UUID) (string, error)
}

// Handler serves the sessions route group.
type Handler struct {
	Store    Store
	Dir      NameDirectory
	Settings settings.Reader
	Registry *harness.Registry
	Binder   AgentBinder
	Projects ProjectResolver

	statsMu      sync.Mutex
	statsCached  map[string]any
	statsFetched time.Time
}

func (h *Handler) projectID(w http.ResponseWriter, r *http.Request, userID uuid.UUID) (string, bool) {
	if h.Projects == nil {
		httpapi.WriteInternalError(w, r, errors.New("project resolver is not configured"))
		return "", false
	}
	projectID, err := h.Projects.ResolveProjectID(r.Context(), r, userID)
	if err == nil {
		return projectID, true
	}
	var scopeErr *tenancy.Error
	if errors.As(err, &scopeErr) {
		httpapi.WriteError(w, scopeErr.Status, scopeErr.Detail)
	} else {
		httpapi.WriteInternalError(w, r, err)
	}
	return "", false
}

// platformNames maps harness names to display labels.
var platformNames = map[string]string{
	"kiro":        "Kiro",
	"claude-code": "Claude Code",
	"cursor":      "Cursor",
	"copilot-cli": "Copilot CLI",
	"codex-cli":   "Codex CLI",
	"opencode":    "OpenCode",
}

// Routes returns the route group. Callers mount it behind authentication;
// role floors are enforced per route.
func (h *Handler) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /api/v1/sessions", httpapi.RequireRole("user", http.HandlerFunc(h.listSessions)))
	mux.Handle("GET /api/v1/sessions/query", httpapi.RequireRole("user", http.HandlerFunc(h.querySessions)))
	mux.Handle("GET /api/v1/sessions/summary", httpapi.RequireRole("user", http.HandlerFunc(h.summary)))
	mux.Handle("GET /api/v1/sessions/{session_id}", httpapi.RequireRole("user", http.HandlerFunc(h.getSession)))
	mux.Handle("POST /api/v1/sessions/{session_id}/bind-agent", httpapi.RequireRole("user", http.HandlerFunc(h.bindAgent)))
	return mux
}

// OperatorRoutes returns deployment-level session aggregate reads.
func (h *Handler) OperatorRoutes() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /api/v1/operator/sessions/stats", httpapi.RequireRole("operator", http.HandlerFunc(h.stats)))
	return mux
}

// adminTraceAccess reports whether the caller can see every user's traces.
func (h *Handler) adminTraceAccess(ctx context.Context, role string) bool {
	return role == "operator" && !h.Settings.Bool(ctx, "security.trace_privacy", false)
}

func (h *Handler) listSessions(w http.ResponseWriter, r *http.Request) {
	claims, _ := httpapi.ClaimsFrom(r.Context())
	projectID, ok := h.projectID(w, r, claims.UserID)
	if !ok {
		return
	}
	q := r.URL.Query()

	limit, ok := intParam(q.Get("limit"), 50, 1, 200)
	if !ok {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "limit must be between 1 and 200")
		return
	}
	offset, ok := intParam(q.Get("offset"), 0, 0, 1<<31)
	if !ok {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "offset must be non-negative")
		return
	}
	days := 0
	if raw := q.Get("days"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil {
			httpapi.WriteError(w, http.StatusUnprocessableEntity, "days must be an integer")
			return
		}
		if parsed > 0 {
			days = min(parsed, 365)
		}
	}
	mine := boolParam(q.Get("mine"))

	ctx := r.Context()
	isAdmin := h.adminTraceAccess(ctx, claims.Role)
	uid := claims.UserID.String()

	var userIDs []string
	if userQuery := q.Get("user"); userQuery != "" {
		userIDs = h.Dir.ResolveUserFilter(ctx, userQuery)
		if len(userIDs) == 0 {
			httpapi.WriteJSON(w, http.StatusOK, []any{})
			return
		}
	}

	rows, err := h.Store.ListSessions(ctx, ListFilter{
		ProjectID: projectID,
		Platform:  q.Get("platform"),
		UserIDs:   userIDs,
		Days:      days,
		OwnerOnly: mine || !isAdmin,
		OwnerID:   uid,
		Limit:     limit,
		Offset:    offset,
	})
	if err != nil {
		rows = nil
	}

	decorated := h.decorateRows(ctx, claims.UserID, rows)
	activeOnly := q.Get("status") == "active"
	result := make([]map[string]any, 0, len(decorated))
	for _, row := range decorated {
		if activeOnly && row["is_active"] != true {
			continue
		}
		result = append(result, row)
	}
	httpapi.WriteJSON(w, http.StatusOK, result)
}

// decorateRows resolves display names and normalizes platform/agent fields
// on stored session rows, shared by the legacy list and the query listing.
func (h *Handler) decorateRows(ctx context.Context, callerID uuid.UUID, rows []map[string]any) []map[string]any {
	var rowUserIDs, rowAgentIDs []string
	for _, row := range rows {
		if id := stringValue(row["user_id"]); id != "" {
			rowUserIDs = append(rowUserIDs, id)
		}
		if id := stringValue(row["agent_id"]); id != "" {
			rowAgentIDs = append(rowAgentIDs, id)
		}
	}
	userNames := h.Dir.UserNames(ctx, rowUserIDs)
	agentNames := h.Dir.AgentNames(ctx, rowAgentIDs)
	callerName := h.Dir.UserName(ctx, callerID)

	result := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		rowUID := stringValue(row["user_id"])
		if name, ok := userNames[rowUID]; ok {
			row["user_name"] = name
		} else {
			row["user_name"] = callerName
		}
		harnessName := stringValue(row["harness"])
		delete(row, "harness")
		row["platform"] = platformLabel(harnessName)
		row["service_name"] = harnessName
		row["is_active"] = intValue(row["is_active"]) != 0

		agentID := stringValue(row["agent_id"])
		if agentID == "" {
			row["agent_id"] = nil
			row["agent_name"] = nil
		} else {
			row["agent_id"] = agentID
			if name, ok := agentNames[agentID]; ok {
				row["agent_name"] = name
			} else {
				row["agent_name"] = nil
			}
		}
		if stringValue(row["agent_version"]) == "" {
			row["agent_version"] = nil
		}
		result = append(result, row)
	}
	return result
}

// queryStatuses are the accepted status filter values.
var queryStatuses = map[string]bool{"": true, "active": true, "completed": true}

// maxQueryWindow bounds offset paging; deep offsets degrade into scans the
// UI never needs.
const maxQueryWindow = 5000

// querySessions serves the unified investigation listing: search, filters,
// thresholds, deterministic sort, and offset pagination resolve in the
// store, and the envelope carries the result context plus grounded window
// percentiles. Store failures surface as 503 rather than empty data.
func (h *Handler) querySessions(w http.ResponseWriter, r *http.Request) {
	claims, _ := httpapi.ClaimsFrom(r.Context())
	projectID, ok := h.projectID(w, r, claims.UserID)
	if !ok {
		return
	}
	q := r.URL.Query()

	page, ok := intParam(q.Get("page"), 1, 1, 1<<30)
	if !ok {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "page must be a positive integer")
		return
	}
	pageSize, ok := intParam(q.Get("page_size"), 25, 1, 100)
	if !ok {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "page_size must be between 1 and 100")
		return
	}
	offset := (page - 1) * pageSize
	if offset+pageSize > maxQueryWindow {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "page is beyond the supported window; narrow the filters")
		return
	}
	days, ok := intParam(q.Get("days"), 0, 0, 365)
	if !ok {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "days must be between 0 and 365")
		return
	}
	sort := q.Get("sort")
	if sort == "" {
		sort = "recent"
	}
	if _, ok := querySortKeys[sort]; !ok {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "sort must be one of recent, oldest, duration, tokens, credits, prompts, tools")
		return
	}
	status := q.Get("status")
	if !queryStatuses[status] {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "status must be active or completed")
		return
	}
	minDuration, ok := intParam(q.Get("min_duration"), 0, 0, 1<<30)
	if !ok {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "min_duration must be a non-negative number of seconds")
		return
	}
	minTokens, ok := intParam(q.Get("min_tokens"), 0, 0, 1<<30)
	if !ok {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "min_tokens must be a non-negative integer")
		return
	}

	ctx := r.Context()
	isAdmin := h.adminTraceAccess(ctx, claims.Role)
	mine := boolParam(q.Get("mine"))

	empty := map[string]any{
		"items": []any{}, "total": 0, "page": page, "page_size": pageSize,
		"p95_duration_s": 0, "p95_total_tokens": 0,
	}
	var userIDs []string
	if userQuery := q.Get("user"); userQuery != "" {
		userIDs = h.Dir.ResolveUserFilter(ctx, userQuery)
		if len(userIDs) == 0 {
			httpapi.WriteJSON(w, http.StatusOK, empty)
			return
		}
	}

	result, err := h.Store.QuerySessions(ctx, QueryFilter{
		ProjectID:    projectID,
		Search:       strings.TrimSpace(q.Get("q")),
		Platform:     q.Get("platform"),
		Model:        strings.TrimSpace(q.Get("model")),
		AgentID:      strings.TrimSpace(q.Get("agent")),
		UserIDs:      userIDs,
		Days:         days,
		Status:       status,
		MinDurationS: minDuration,
		MinTokens:    minTokens,
		OwnerOnly:    mine || !isAdmin,
		OwnerID:      claims.UserID.String(),
		Sort:         sort,
		Limit:        pageSize,
		Offset:       offset,
	})
	if err != nil {
		httpapi.WriteError(w, http.StatusServiceUnavailable, "Trace store is unavailable; retry shortly")
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"items":            h.decorateRows(ctx, claims.UserID, result.Items),
		"total":            result.Total,
		"page":             page,
		"page_size":        pageSize,
		"p95_duration_s":   result.P95DurationS,
		"p95_total_tokens": result.P95Tokens,
	})
}

// platformLabel maps a harness name to its display label; unmapped names are
// title-cased, and an unattributed session shows the default platform.
func platformLabel(harnessName string) string {
	if label, ok := platformNames[harnessName]; ok {
		return label
	}
	if harnessName == "" {
		return "Claude Code"
	}
	words := strings.Split(strings.ReplaceAll(harnessName, "-", " "), " ")
	for i, word := range words {
		if word != "" {
			words[i] = strings.ToUpper(word[:1]) + word[1:]
		}
	}
	return strings.Join(words, " ")
}

func (h *Handler) summary(w http.ResponseWriter, r *http.Request) {
	claims, _ := httpapi.ClaimsFrom(r.Context())
	projectID, ok := h.projectID(w, r, claims.UserID)
	if !ok {
		return
	}
	ctx := r.Context()
	scopedUser := ""
	if !h.adminTraceAccess(ctx, claims.Role) {
		scopedUser = claims.UserID.String()
	}
	row, err := h.Store.Summary(ctx, projectID, scopedUser)
	if err != nil {
		row = map[string]any{}
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"total_sessions": intValue(row["total"]),
		"today_sessions": intValue(row["today_sessions"]),
	})
}

func (h *Handler) stats(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ttl := time.Duration(h.Settings.Int(ctx, "data.cache_ttl_default", 30)) * time.Second

	h.statsMu.Lock()
	if h.statsCached != nil && time.Since(h.statsFetched) < ttl {
		cached := h.statsCached
		h.statsMu.Unlock()
		httpapi.WriteJSON(w, http.StatusOK, cached)
		return
	}
	h.statsMu.Unlock()

	row, err := h.Store.Stats(ctx)
	if err != nil {
		row = map[string]any{}
	}
	response := map[string]any{
		"total_sessions":     intValue(row["total_sessions"]),
		"total_prompts":      intValue(row["total_prompts"]),
		"total_api_requests": intValue(row["total_api_requests"]),
		"total_tool_calls":   intValue(row["total_tool_calls"]),
		"total_events":       intValue(row["total_events"]),
	}
	h.statsMu.Lock()
	h.statsCached = response
	h.statsFetched = time.Now()
	h.statsMu.Unlock()
	httpapi.WriteJSON(w, http.StatusOK, response)
}

func (h *Handler) getSession(w http.ResponseWriter, r *http.Request) {
	claims, _ := httpapi.ClaimsFrom(r.Context())
	projectID, ok := h.projectID(w, r, claims.UserID)
	if !ok {
		return
	}
	ctx := r.Context()
	sessionID := r.PathValue("session_id")

	var afterOffset *int64
	if raw := r.URL.Query().Get("after_offset"); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed < 0 {
			httpapi.WriteError(w, http.StatusUnprocessableEntity, "after_offset must be a non-negative integer")
			return
		}
		afterOffset = &parsed
	}

	scopedUser := ""
	if !h.adminTraceAccess(ctx, claims.Role) {
		scopedUser = claims.UserID.String()
	}
	identityRow, err := h.Store.SessionIdentity(ctx, sessionID, projectID, scopedUser)
	if err != nil || identityRow == nil {
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"session_id": sessionID, "harness": "", "events": []any{},
		})
		return
	}
	id := Identity{
		SessionID: sessionID,
		ProjectID: stringValue(identityRow["project_id"]),
		UserID:    stringValue(identityRow["user_id"]),
		Harness:   stringValue(identityRow["harness"]),
	}

	// Both scans run concurrently; wall time is the slower of the two.
	var rows, subRows []map[string]any
	var rowsErr error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		rows, rowsErr = h.Store.SessionRows(ctx, id, afterOffset)
	}()
	go func() {
		defer wg.Done()
		subRows, _ = h.Store.SubagentRows(ctx, id, afterOffset)
	}()
	wg.Wait()

	if rowsErr != nil || len(rows) == 0 {
		if afterOffset != nil {
			httpapi.WriteJSON(w, http.StatusOK, map[string]any{
				"session_id": sessionID, "events": []any{}, "max_offset": *afterOffset,
			})
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"session_id": sessionID, "service_name": "", "events": []any{}, "traces": []any{},
		})
		return
	}

	harnessName := stringValue(rows[0]["harness"])
	var agentID, agentVersion any
	for _, row := range rows {
		if agentID == nil && stringValue(row["agent_id"]) != "" {
			agentID = row["agent_id"]
		}
		if agentVersion == nil && stringValue(row["agent_version"]) != "" {
			agentVersion = row["agent_version"]
		}
	}
	var agentName any
	if agentID != nil {
		if name, ok := h.Dir.AgentNames(ctx, []string{stringValue(agentID)})[stringValue(agentID)]; ok {
			agentName = name
		}
	}

	maxOffset := int64(0)
	if afterOffset != nil {
		maxOffset = *afterOffset
	}
	for _, row := range rows {
		if v := int64(intValue(row["line_offset"])); v > maxOffset {
			maxOffset = v
		}
	}

	events, err := h.parseRows(rows)
	if err != nil {
		httpapi.WriteError(w, http.StatusInternalServerError, "Failed to render session events")
		return
	}

	subagentSessions := []map[string]any{}
	for _, group := range groupBySession(subRows) {
		subEvents, err := h.parseRows(group)
		if err != nil {
			continue
		}
		var spawnedBy any
		if len(group) > 0 {
			spawnedBy = group[0]["parent_uuid"]
		}
		subagentSessions = append(subagentSessions, map[string]any{
			"session_id": stringValue(group[0]["session_id"]),
			"spawned_by": spawnedBy,
			"events":     subEvents,
		})
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"session_id":        sessionID,
		"service_name":      harnessName,
		"agent_id":          agentID,
		"agent_name":        agentName,
		"agent_version":     agentVersion,
		"events":            events,
		"traces":            []any{},
		"subagent_sessions": subagentSessions,
		"max_offset":        maxOffset,
	})
}

// parseRows expands stored rows through the trace viewer parsers.
func (h *Handler) parseRows(rows []map[string]any) ([]*traceview.Event, error) {
	encoded, err := json.Marshal(rows)
	if err != nil {
		return nil, err
	}
	var parsed []traceview.Row
	if err := json.Unmarshal(encoded, &parsed); err != nil {
		return nil, err
	}
	return traceview.Parse(h.Registry, parsed)
}

// groupBySession splits ordered subagent rows into per-session groups,
// preserving line order within each.
func groupBySession(rows []map[string]any) [][]map[string]any {
	var groups [][]map[string]any
	byID := map[string]int{}
	for _, row := range rows {
		sid := stringValue(row["session_id"])
		idx, ok := byID[sid]
		if !ok {
			idx = len(groups)
			byID[sid] = idx
			groups = append(groups, nil)
		}
		groups[idx] = append(groups[idx], row)
	}
	return groups
}

func (h *Handler) bindAgent(w http.ResponseWriter, r *http.Request) {
	claims, _ := httpapi.ClaimsFrom(r.Context())
	projectID, ok := h.projectID(w, r, claims.UserID)
	if !ok {
		return
	}
	ctx := r.Context()
	sessionID := r.PathValue("session_id")
	agentName := r.URL.Query().Get("agent_name")
	if agentName == "" {
		httpapi.WriteError(w, http.StatusUnprocessableEntity, "agent_name is required")
		return
	}

	if claims.Role != "operator" {
		owns, err := h.Store.OwnsSession(ctx, sessionID, projectID, claims.UserID.String())
		if err != nil || !owns {
			httpapi.WriteError(w, http.StatusNotFound, "Session not found or access denied")
			return
		}
	}

	if err := h.Binder.BindAgent(ctx, sessionID, agentName); err != nil {
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"session_id": sessionID, "agent_name": agentName, "bound": false, "error": "Redis unavailable",
		})
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"session_id": sessionID, "agent_name": agentName, "bound": true,
	})
}

// intParam parses a bounded integer query parameter.
func intParam(raw string, fallback, low, high int) (int, bool) {
	if raw == "" {
		return fallback, true
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil || parsed < low || parsed > high {
		return 0, false
	}
	return parsed, true
}

// boolParam accepts the usual query encodings of true.
func boolParam(raw string) bool {
	switch strings.ToLower(raw) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

// stringValue renders an id-like column that may arrive as string or null.
func stringValue(value any) string {
	s, _ := value.(string)
	return s
}

// intValue coerces a ClickHouse JSON number, which arrives as a float for
// 32-bit types and as a quoted string for 64-bit types.
func intValue(value any) int {
	switch v := value.(type) {
	case float64:
		return int(v)
	case string:
		parsed, err := strconv.Atoi(v)
		if err != nil {
			return 0
		}
		return parsed
	case bool:
		if v {
			return 1
		}
		return 0
	default:
		return 0
	}
}
