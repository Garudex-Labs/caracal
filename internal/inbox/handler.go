// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package inbox

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/httpapi"
)

// Handler serves the per-user inbox routes.
type Handler struct {
	Store *Store

	reportLimit rateWindow
}

// Routes returns the route set; callers wrap it in the required-auth chain.
func (h *Handler) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/inbox", h.list)
	mux.HandleFunc("GET /api/v1/inbox/count", h.count)
	mux.HandleFunc("GET /api/v1/inbox/{id}", h.show)
	mux.HandleFunc("POST /api/v1/inbox/{id}/read", h.flip("read"))
	mux.HandleFunc("POST /api/v1/inbox/{id}/unread", h.flip("unread"))
	mux.HandleFunc("POST /api/v1/inbox/{id}/done", h.flip("done"))
	mux.HandleFunc("POST /api/v1/inbox/{id}/dismiss", h.flip("dismissed"))
	mux.HandleFunc("POST /api/v1/inbox/{id}/reopen", h.flip("open"))
	mux.HandleFunc("POST /api/v1/inbox/read-all", h.readAll)
	mux.HandleFunc("POST /api/v1/inbox/outdated-report", h.outdatedReport)
	return mux
}

type itemResponse struct {
	ID               string         `json:"id"`
	Kind             string         `json:"kind"`
	State            string         `json:"state"`
	Read             bool           `json:"read"`
	ReadAt           *string        `json:"read_at"`
	ActionRequired   bool           `json:"action_required"`
	Title            string         `json:"title"`
	Body             *string        `json:"body"`
	SubjectType      string         `json:"subject_type"`
	SubjectID        *string        `json:"subject_id"`
	SubjectNamespace *string        `json:"subject_namespace"`
	SubjectSlug      *string        `json:"subject_slug"`
	ActionURL        *string        `json:"action_url"`
	ActionCommand    *string        `json:"action_command"`
	ActorID          *string        `json:"actor_id"`
	ProjectID        *string        `json:"project_id"`
	Payload          map[string]any `json:"payload"`
	CreatedAt        string         `json:"created_at"`
	ResolvedAt       *string        `json:"resolved_at"`
}

type eventResponse struct {
	ID        string  `json:"id"`
	Event     string  `json:"event"`
	ActorID   *string `json:"actor_id"`
	Detail    *string `json:"detail"`
	CreatedAt string  `json:"created_at"`
}

func wireTime(t time.Time) string {
	t = t.UTC()
	if t.Nanosecond() == 0 {
		return t.Format("2006-01-02T15:04:05Z")
	}
	return t.Format("2006-01-02T15:04:05.000000Z")
}

func wireTimePtr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := wireTime(*t)
	return &s
}

func wireItem(it *Item) itemResponse {
	return itemResponse{
		ID: it.ID, Kind: it.Kind, State: it.State,
		Read: it.ReadAt != nil, ReadAt: wireTimePtr(it.ReadAt),
		ActionRequired: it.ActionRequired, Title: it.Title, Body: it.Body,
		SubjectType: it.SubjectType, SubjectID: it.SubjectID,
		SubjectNamespace: it.SubjectNamespace, SubjectSlug: it.SubjectSlug,
		ActionURL: it.ActionURL, ActionCommand: it.ActionCommand,
		ActorID: it.ActorID, ProjectID: it.ProjectID, Payload: it.Payload,
		CreatedAt: wireTime(it.CreatedAt), ResolvedAt: wireTimePtr(it.ResolvedAt),
	}
}

type fieldError struct {
	Type  string         `json:"type"`
	Loc   []any          `json:"loc"`
	Msg   string         `json:"msg"`
	Input any            `json:"input"`
	Ctx   map[string]any `json:"ctx,omitempty"`
}

func write422(w http.ResponseWriter, errs []fieldError) {
	httpapi.WriteJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": errs})
}

func (h *Handler) caller(w http.ResponseWriter, r *http.Request) (uuid.UUID, string, bool) {
	claims, ok := httpapi.ClaimsFrom(r.Context())
	if !ok {
		httpapi.WriteError(w, http.StatusUnauthorized, "Missing credentials")
		return uuid.UUID{}, "", false
	}
	return claims.UserID, claims.Role, true
}

func enumChoices(values []string) string {
	quoted := make([]string, len(values))
	for i, v := range values {
		quoted[i] = "'" + v + "'"
	}
	if len(quoted) == 1 {
		return quoted[0]
	}
	return strings.Join(quoted[:len(quoted)-1], ", ") + " or " + quoted[len(quoted)-1]
}

func enumParam(q url.Values, name string, values []string, errs *[]fieldError) string {
	raw := q.Get(name)
	if raw == "" {
		return ""
	}
	for _, v := range values {
		if raw == v {
			return raw
		}
	}
	choices := enumChoices(values)
	*errs = append(*errs, fieldError{Type: "enum", Loc: []any{"query", name},
		Msg: "Input should be " + choices, Input: raw, Ctx: map[string]any{"expected": choices}})
	return ""
}

func boolParam(q url.Values, name string, errs *[]fieldError) *bool {
	raw := q.Get(name)
	if raw == "" && !q.Has(name) {
		return nil
	}
	switch strings.ToLower(raw) {
	case "true", "yes", "on", "1", "t", "y":
		v := true
		return &v
	case "false", "no", "off", "0", "f", "n":
		v := false
		return &v
	}
	*errs = append(*errs, fieldError{Type: "bool_parsing", Loc: []any{"query", name},
		Msg: "Input should be a valid boolean, unable to interpret input", Input: raw})
	return nil
}

func intParam(q url.Values, name string, def, min, max int, errs *[]fieldError) int {
	raw := q.Get(name)
	if raw == "" && !q.Has(name) {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		*errs = append(*errs, fieldError{Type: "int_parsing", Loc: []any{"query", name},
			Msg: "Input should be a valid integer, unable to parse string as an integer", Input: raw})
		return def
	}
	if n < min {
		*errs = append(*errs, fieldError{Type: "greater_than_equal", Loc: []any{"query", name},
			Msg: fmt.Sprintf("Input should be greater than or equal to %d", min), Input: raw,
			Ctx: map[string]any{"ge": min}})
		return def
	}
	if max > 0 && n > max {
		*errs = append(*errs, fieldError{Type: "less_than_equal", Loc: []any{"query", name},
			Msg: fmt.Sprintf("Input should be less than or equal to %d", max), Input: raw,
			Ctx: map[string]any{"le": max}})
		return def
	}
	return n
}

func maxLenParam(q url.Values, name string, maxLen int, errs *[]fieldError) string {
	raw := q.Get(name)
	if len(raw) > maxLen {
		*errs = append(*errs, fieldError{Type: "string_too_long", Loc: []any{"query", name},
			Msg: fmt.Sprintf("String should have at most %d characters", maxLen), Input: raw,
			Ctx: map[string]any{"max_length": maxLen}})
		return ""
	}
	return raw
}

func (h *Handler) parseFilters(q url.Values, errs *[]fieldError, withUnread bool) Filters {
	f := Filters{
		State:       enumParam(q, "state", []string{"open", "done", "dismissed"}, errs),
		Kind:        enumParam(q, "kind", Kinds, errs),
		SubjectType: maxLenParam(q, "subject_type", 32, errs),
		Q:           maxLenParam(q, "q", 200, errs),
	}
	f.ActionRequired = boolParam(q, "action_required", errs)
	if withUnread {
		f.Unread = boolParam(q, "unread", errs)
	}
	return f
}

func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	userID, role, ok := h.caller(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	errs := []fieldError{}
	f := h.parseFilters(q, &errs, true)
	sort := q.Get("sort")
	if sort == "" {
		sort = "newest"
	} else if sort != "newest" && sort != "oldest" {
		errs = append(errs, fieldError{Type: "string_pattern_mismatch", Loc: []any{"query", "sort"},
			Msg: "String should match pattern '^(newest|oldest)$'", Input: sort,
			Ctx: map[string]any{"pattern": "^(newest|oldest)$"}})
	}
	page := intParam(q, "page", 1, 1, 0, &errs)
	pageSize := intParam(q, "page_size", 25, 1, 100, &errs)
	if len(errs) > 0 {
		write422(w, errs)
		return
	}
	items, total, err := h.Store.List(r.Context(), userID, role, f, sort, page, pageSize)
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	wired := make([]itemResponse, 0, len(items))
	for _, it := range items {
		wired = append(wired, wireItem(it))
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"items": wired, "total": total, "page": page, "page_size": pageSize,
	})
}

func (h *Handler) count(w http.ResponseWriter, r *http.Request) {
	userID, role, ok := h.caller(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	errs := []fieldError{}
	facets := false
	if v := boolParam(q, "facets", &errs); v != nil {
		facets = *v
	}
	facetState := "open"
	if q.Has("facet_state") {
		facetState = enumParam(q, "facet_state", []string{"open", "done", "dismissed"}, &errs)
	}
	if len(errs) > 0 {
		write422(w, errs)
		return
	}
	counts, err := h.Store.Count(r.Context(), userID, role, facets, facetState)
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"unread": counts.Unread, "action_required": counts.Action,
		"open": counts.ByState["open"], "done": counts.ByState["done"],
		"dismissed": counts.ByState["dismissed"],
		"by_kind":   counts.ByKind, "by_subject_type": counts.BySubjectType,
	})
}

func (h *Handler) loadOwn(w http.ResponseWriter, r *http.Request, userID uuid.UUID, role string) *Item {
	itemID, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		reason := uuidErrorText(r.PathValue("id"))
		write422(w, []fieldError{{Type: "uuid_parsing", Loc: []any{"path", "item_id"},
			Msg: "Input should be a valid UUID, " + reason, Input: r.PathValue("id"),
			Ctx: map[string]any{"error": reason}}})
		return nil
	}
	item, err := h.Store.LoadOwn(r.Context(), itemID, userID, role)
	if errors.Is(err, ErrNotFound) {
		httpapi.WriteError(w, http.StatusNotFound, "Inbox item not found")
		return nil
	}
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return nil
	}
	return item
}

func (h *Handler) show(w http.ResponseWriter, r *http.Request) {
	userID, role, ok := h.caller(w, r)
	if !ok {
		return
	}
	item := h.loadOwn(w, r, userID, role)
	if item == nil {
		return
	}
	history, err := h.Store.History(r.Context(), item.ID)
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	base := wireItem(item)
	events := make([]eventResponse, 0, len(history))
	for _, e := range history {
		events = append(events, eventResponse{
			ID: e.ID, Event: e.Event, ActorID: e.ActorID, Detail: e.Detail, CreatedAt: wireTime(e.CreatedAt),
		})
	}
	httpapi.WriteJSON(w, http.StatusOK, orderedDetail{base, events})
}

// orderedDetail keeps the item fields first and history last.
type orderedDetail struct {
	itemResponse
	History []eventResponse `json:"history"`
}

func (h *Handler) flip(action string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, role, ok := h.caller(w, r)
		if !ok {
			return
		}
		item := h.loadOwn(w, r, userID, role)
		if item == nil {
			return
		}
		var fresh *Item
		var err error
		switch action {
		case "read":
			fresh, err = h.Store.SetRead(r.Context(), item, userID, true)
		case "unread":
			fresh, err = h.Store.SetRead(r.Context(), item, userID, false)
		default:
			fresh, err = h.Store.Resolve(r.Context(), item, userID, action)
		}
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, wireItem(fresh))
	}
}

func (h *Handler) readAll(w http.ResponseWriter, r *http.Request) {
	userID, role, ok := h.caller(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	errs := []fieldError{}
	f := h.parseFilters(q, &errs, false)
	if len(errs) > 0 {
		write422(w, errs)
		return
	}
	updated, err := h.Store.ReadAll(r.Context(), userID, role, f)
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]int{"updated": updated})
}

var (
	typePattern    = regexp.MustCompile(`^[a-z_]+$`)
	nsSlugPattern  = regexp.MustCompile(`^[a-zA-Z0-9._-]+$`)
	versionPattern = regexp.MustCompile(`^[a-zA-Z0-9.+_-]+$`)
)

func (h *Handler) outdatedReport(w http.ResponseWriter, r *http.Request) {
	if !h.reportLimit.allow(rateKey(r), 10, time.Minute) {
		w.Header().Set("Retry-After", "60")
		httpapi.WriteJSON(w, http.StatusTooManyRequests,
			map[string]string{"error": "Rate limit exceeded: 10 per 1 minute"})
		return
	}
	userID, _, ok := h.caller(w, r)
	if !ok {
		return
	}
	var req struct {
		Items []struct {
			Type           string     `json:"type"`
			ComponentID    *uuid.UUID `json:"component_id"`
			Name           string     `json:"name"`
			Namespace      *string    `json:"namespace"`
			Slug           *string    `json:"slug"`
			CurrentVersion string     `json:"current_version"`
			LatestVersion  string     `json:"latest_version"`
			Harness        *string    `json:"harness"`
		} `json:"items"`
	}
	var raw struct {
		Items []map[string]any `json:"items"`
	}
	body, err := io.ReadAll(r.Body)
	if err != nil || json.Unmarshal(body, &req) != nil || json.Unmarshal(body, &raw) != nil {
		write422(w, []fieldError{{Type: "missing", Loc: []any{"body"}, Msg: "Field required", Input: nil}})
		return
	}
	errs := []fieldError{}
	if len(req.Items) > 200 {
		errs = append(errs, fieldError{Type: "too_long", Loc: []any{"body", "items"},
			Msg:   "List should have at most 200 items after validation, not " + strconv.Itoa(len(req.Items)),
			Input: nil, Ctx: map[string]any{"field_type": "List", "max_length": 200, "actual_length": len(req.Items)}})
	}
	entries := make([]OutdatedEntry, 0, len(req.Items))
	pattern := func(idx int, field, value, pat string, re *regexp.Regexp, required bool) bool {
		if value == "" {
			if required {
				errs = append(errs, fieldError{Type: "string_too_short", Loc: []any{"body", "items", idx, field},
					Msg: "String should have at least 1 character", Input: value, Ctx: map[string]any{"min_length": 1}})
			}
			return !required
		}
		if !re.MatchString(value) {
			errs = append(errs, fieldError{Type: "string_pattern_mismatch", Loc: []any{"body", "items", idx, field},
				Msg: "String should match pattern '" + pat + "'", Input: value, Ctx: map[string]any{"pattern": pat}})
			return false
		}
		return true
	}
	for idx, item := range req.Items {
		okAll := pattern(idx, "type", item.Type, `^[a-z_]+$`, typePattern, true)
		if item.ComponentID == nil {
			// The validation layer reports the whole submitted item for a
			// missing field.
			errs = append(errs, fieldError{Type: "missing", Loc: []any{"body", "items", idx, "component_id"},
				Msg: "Field required", Input: raw.Items[idx]})
			okAll = false
		}
		if item.Namespace != nil {
			okAll = pattern(idx, "namespace", *item.Namespace, `^[a-zA-Z0-9._-]+$`, nsSlugPattern, false) && okAll
		}
		if item.Slug != nil {
			okAll = pattern(idx, "slug", *item.Slug, `^[a-zA-Z0-9._-]+$`, nsSlugPattern, false) && okAll
		}
		okAll = pattern(idx, "current_version", item.CurrentVersion, `^[a-zA-Z0-9.+_-]+$`, versionPattern, true) && okAll
		okAll = pattern(idx, "latest_version", item.LatestVersion, `^[a-zA-Z0-9.+_-]+$`, versionPattern, true) && okAll
		if item.Harness != nil {
			okAll = pattern(idx, "harness", *item.Harness, `^[a-zA-Z0-9._-]+$`, safeHarness, false) && okAll
		}
		if !okAll {
			continue
		}
		entries = append(entries, OutdatedEntry{
			Type: item.Type, ComponentID: *item.ComponentID, Name: item.Name,
			Namespace: item.Namespace, Slug: item.Slug,
			CurrentVersion: item.CurrentVersion, LatestVersion: item.LatestVersion,
			Harness: item.Harness,
		})
	}
	if len(errs) > 0 {
		write422(w, errs)
		return
	}
	created, superseded, err := h.Store.ReportOutdated(r.Context(), userID, entries)
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]int{"created": created, "superseded": superseded})
}

// rateKey buckets by bearer-token digest, falling back to the client address.
func rateKey(r *http.Request) string {
	auth := r.Header.Get("Authorization")
	scheme, token, ok := strings.Cut(auth, " ")
	if ok && strings.EqualFold(scheme, "bearer") && strings.TrimSpace(token) != "" {
		sum := sha256.Sum256([]byte(strings.TrimSpace(token)))
		return "token:" + hex.EncodeToString(sum[:])
	}
	if ip := r.Header.Get("X-Real-IP"); ip != "" {
		return "ip:" + ip
	}
	return "ip:" + r.RemoteAddr
}

// rateWindow is a fixed-window n-per-window gate.
type rateWindow struct {
	mu   sync.Mutex
	hits map[string][]time.Time
}

func (l *rateWindow) allow(key string, n int, window time.Duration) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if l.hits == nil {
		l.hits = map[string][]time.Time{}
	}
	kept := l.hits[key][:0]
	for _, at := range l.hits[key] {
		if now.Sub(at) < window {
			kept = append(kept, at)
		}
	}
	if len(kept) >= n {
		l.hits[key] = kept
		return false
	}
	l.hits[key] = append(kept, now)
	return true
}

// uuidErrorText mirrors the parse-error taxonomy of the validation layer.
func uuidErrorText(raw string) string { return httpapi.UUIDErrorText(raw) }
