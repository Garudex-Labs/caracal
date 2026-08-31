// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/tenancy"
)

// Handler serves the registry route family for all component types.
type Handler struct {
	Store *Store
	// ValidHarnesses gates the supported-harness tokens on writes.
	ValidHarnesses []string
	// Mirror clones and inspects registered git sources.
	Mirror *Mirror
}

// Register mounts every route this service answers for the registry write
// plane, the component families, and the unified resource tree.
func (h *Handler) Register(mux *http.ServeMux, withAuth func(http.Handler) http.Handler) {
	for _, f := range Families {
		prefix := "/api/v1/" + f.Prefix
		mux.Handle("GET "+prefix, withAuth(h.list(f)))
		mux.Handle("GET "+prefix+"/my", withAuth(h.mine(f)))
		mux.Handle("GET "+prefix+"/{listing_id}", withAuth(h.show(f)))
		mux.Handle("PATCH "+prefix+"/{listing_id}/archive", withAuth(h.lifecycle(f, h.Store.Archive)))
		mux.Handle("PATCH "+prefix+"/{listing_id}/unarchive", withAuth(h.lifecycle(f, h.Store.Unarchive)))
		mux.Handle("POST "+prefix+"/{listing_id}/start-edit", withAuth(h.editLock(f, h.Store.StartEdit, "locked")))
		mux.Handle("POST "+prefix+"/{listing_id}/cancel-edit", withAuth(h.editLock(f, h.Store.CancelEdit, "unlocked")))
		mux.Handle("GET "+prefix+"/{listing_id}/versions", withAuth(h.listVersions(f)))
		mux.Handle("GET "+prefix+"/{listing_id}/versions/{version}", withAuth(h.getVersion(f)))
		mux.Handle("GET "+prefix+"/{listing_id}/version-suggestions", withAuth(h.suggestVersions(f)))
		mux.Handle("GET "+prefix+"/{entity_id}/co-authors", withAuth(h.listCoAuthors(f)))
		mux.Handle("POST "+prefix+"/{entity_id}/co-authors", withAuth(h.addCoAuthor(f)))
		mux.Handle("DELETE "+prefix+"/{entity_id}/co-authors/{user_id}", withAuth(h.removeCoAuthor(f)))
		mux.Handle("GET "+prefix+"/{entity_id}/editors", withAuth(h.listEditors(f)))
		mux.Handle("POST "+prefix+"/draft", withAuth(h.createDraft(f)))
		mux.Handle("PUT "+prefix+"/{listing_id}/draft", withAuth(h.updateDraft(f)))
		if f.Prefix == "mcps" || f.Prefix == "skills" || f.Prefix == "hooks" {
			mux.Handle("POST "+prefix+"/{listing_id}/install", withAuth(h.install(f.Prefix)))
		}
		mux.Handle("POST "+prefix+"/{listing_id}/submit", withAuth(h.submitForReview(f)))
		mux.Handle("POST "+prefix+"/submit", withAuth(h.submitDirect(f)))
		mux.Handle("POST "+prefix+"/{listing_id}/versions", withAuth(h.publishVersion(f)))
		mux.Handle("POST "+prefix+"/{listing_id}/versions/{version}/review", withAuth(h.reviewVersion(f)))
		mux.Handle("POST "+prefix+"/{listing_id}/versions/{version}/restore", withAuth(h.restoreVersion(f)))
	}
	mux.Handle("POST /api/v1/prompts/{listing_id}/render", withAuth(h.renderPrompt()))
	mux.Handle("GET /api/v1/recommendations/me", withAuth(h.myRecommendations()))
	mux.Handle("POST /api/v1/recommendations/feedback", withAuth(h.recommendationFeedback()))
	mux.Handle("POST /api/v1/component-sources", withAuth(h.addSource()))
	mux.Handle("GET /api/v1/component-sources", withAuth(h.listSources()))
	mux.Handle("GET /api/v1/component-sources/{source_id}", withAuth(h.getSource()))
	mux.Handle("DELETE /api/v1/component-sources/{source_id}", withAuth(h.deleteSource()))
	mux.Handle("POST /api/v1/component-sources/{source_id}/sync", withAuth(h.syncSource()))
	mux.Handle("GET /api/v1/registry/resolve", withAuth(h.resolve()))
	h.registerReviewRoutes(mux, withAuth)
	h.registerTailRoutes(mux, withAuth)
	h.registerFinalRoutes(mux, withAuth)
	h.registerResourceRoutes(mux, withAuth)
}

// viewerFrom converts optional-auth claims to a registry viewer.
func viewerFrom(r *http.Request) *Viewer {
	claims, ok := httpapi.ClaimsFrom(r.Context())
	if !ok {
		return nil
	}
	projectID, _ := tenancy.ProjectIDFromContext(r.Context())
	return &Viewer{ID: claims.UserID, Role: claims.Role, ProjectID: projectID}
}

// fieldError is one item of the request-validation error body.
type fieldError struct {
	Type  string         `json:"type"`
	Loc   []string       `json:"loc"`
	Msg   string         `json:"msg"`
	Input any            `json:"input"`
	Ctx   map[string]any `json:"ctx,omitempty"`
}

// familyByName resolves a family by its singular type name.
func familyByName(name string) (Family, bool) {
	for _, f := range Families {
		if f.Name == name {
			return f, true
		}
	}
	return Family{}, false
}

func intParam(q url.Values, name string, def, min, max int, errs *[]fieldError) int {
	raw := q.Get(name)
	if raw == "" && !q.Has(name) {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		*errs = append(*errs, fieldError{
			Type: "int_parsing", Loc: []string{"query", name},
			Msg: "Input should be a valid integer, unable to parse string as an integer", Input: raw,
		})
		return def
	}
	if n < min {
		*errs = append(*errs, fieldError{
			Type: "greater_than_equal", Loc: []string{"query", name},
			Msg: fmt.Sprintf("Input should be greater than or equal to %d", min), Input: raw,
			Ctx: map[string]any{"ge": min},
		})
		return def
	}
	if max >= 0 && n > max {
		*errs = append(*errs, fieldError{
			Type: "less_than_equal", Loc: []string{"query", name},
			Msg: fmt.Sprintf("Input should be less than or equal to %d", max), Input: raw,
			Ctx: map[string]any{"le": max},
		})
		return def
	}
	return n
}

func boolParam(q url.Values, name string, errs *[]fieldError) bool {
	raw := q.Get(name)
	if raw == "" && !q.Has(name) {
		return false
	}
	switch strings.ToLower(raw) {
	case "true", "yes", "on", "1", "t", "y":
		return true
	case "false", "no", "off", "0", "f", "n":
		return false
	}
	*errs = append(*errs, fieldError{
		Type: "bool_parsing", Loc: []string{"query", name},
		Msg: "Input should be a valid boolean, unable to interpret input", Input: raw,
	})
	return false
}

// uuidErrorText mirrors the parse-error taxonomy of the validation layer:
// character, group count, group length, then simple-format length.
func uuidErrorText(raw string) string {
	body := strings.TrimPrefix(raw, "urn:uuid:")
	offset := len(raw) - len(body)
	for i, c := range body {
		isHex := (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
		if !isHex && c != '-' {
			return fmt.Sprintf(
				"invalid character: expected an optional prefix of `urn:uuid:` followed by [0-9a-fA-F-], found `%c` at %d",
				c, offset+i+1)
		}
	}
	if strings.Contains(body, "-") {
		groups := strings.Split(body, "-")
		if len(groups) != 5 {
			return fmt.Sprintf("invalid group count: expected 5, found %d", len(groups))
		}
		want := []int{8, 4, 4, 4, 12}
		for i, g := range groups {
			if len(g) != want[i] {
				return fmt.Sprintf("invalid group length in group %d: expected %d, found %d", i, want[i], len(g))
			}
		}
	}
	return fmt.Sprintf("invalid length: expected length 32 for simple format, found %d", len(body))
}

func uuidParam(q url.Values, name string, errs *[]fieldError) string {
	raw := q.Get(name)
	if raw == "" {
		return ""
	}
	id, err := uuid.Parse(raw)
	if err != nil {
		reason := uuidErrorText(raw)
		*errs = append(*errs, fieldError{
			Type: "uuid_parsing", Loc: []string{"query", name},
			Msg: "Input should be a valid UUID, " + reason, Input: raw,
			Ctx: map[string]any{"error": reason},
		})
		return ""
	}
	return id.String()
}

func (h *Handler) list(f Family) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		errs := []fieldError{}
		p := ListParams{
			Namespace:              q.Get("namespace"),
			Search:                 q.Get("search"),
			ComposableForProjectID: uuidParam(q, "composable_for_project_id", &errs),
			Limit:                  intParam(q, "limit", 50, 1, 200, &errs),
			Offset:                 intParam(q, "offset", 0, 0, -1, &errs),
			Extra:                  map[string]string{},
			Harness:                q.Get("harness"),
			TargetAgent:            q.Get("target_agent"),
		}
		for param := range f.ListFilters {
			p.Extra[param] = q.Get(param)
		}
		if len(errs) > 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, errs)
			return
		}

		rows, total, err := h.Store.List(r.Context(), f, p, viewerFrom(r))
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		out := make([]any, 0, len(rows))
		for _, row := range rows {
			out = append(out, summarize(f, row))
		}
		w.Header().Set("X-Total-Count", strconv.Itoa(total))
		httpapi.WriteJSON(w, http.StatusOK, out)
	})
}

func (h *Handler) mine(f Family) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := viewerFrom(r)
		if viewer == nil {
			httpapi.WriteError(w, http.StatusUnauthorized, "Missing credentials")
			return
		}
		rows, err := h.Store.Mine(r.Context(), f, viewer)
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		out := make([]any, 0, len(rows))
		for _, row := range rows {
			out = append(out, summarize(f, row))
		}
		httpapi.WriteJSON(w, http.StatusOK, out)
	})
}

func (h *Handler) show(f Family) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		identifier := r.PathValue("listing_id")
		// An encoded slash decodes to extra path segments, which no route serves.
		if strings.Contains(identifier, "/") {
			httpapi.WriteError(w, http.StatusNotFound, "Not Found")
			return
		}
		row, permission, err := h.Store.Show(r.Context(), f, identifier, viewerFrom(r))
		var ambiguous *ErrAmbiguous
		switch {
		case errors.As(err, &ambiguous):
			httpapi.WriteError(w, http.StatusConflict, ambiguous.Error())
			return
		case errors.Is(err, ErrNotFound):
			httpapi.WriteError(w, http.StatusNotFound, "Listing not found")
			return
		case err != nil:
			httpapi.WriteInternalError(w, r, err)
			return
		}
		var validations []map[string]any
		if f.Prefix == "mcps" {
			if validations, err = h.Store.ValidationResults(r.Context(), rowStr(row, "id", "")); err != nil {
				httpapi.WriteInternalError(w, r, err)
				return
			}
		}
		httpapi.WriteJSON(w, http.StatusOK, detail(f, row, &permission, validations))
	})
}

// registryResolution is the cross-family identity answer.
type registryResolution struct {
	ID            string `json:"id"`
	Type          string `json:"type"`
	Namespace     string `json:"namespace"`
	Slug          string `json:"slug"`
	QualifiedName string `json:"qualified_name"`
}

var resolveTypePattern = regexp.MustCompile(`^(agent|mcp|skill|hook|prompt)$`)

// resolve answers GET /api/v1/registry/resolve; agent identity remains with
// the incumbent service and is relayed.
func (h *Handler) resolve() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		errs := []fieldError{}
		kind := q.Get("type")
		identifier := q.Get("identifier")
		switch {
		case !q.Has("type"):
			errs = append(errs, fieldError{Type: "missing", Loc: []string{"query", "type"}, Msg: "Field required", Input: nil})
		case !resolveTypePattern.MatchString(kind):
			errs = append(errs, fieldError{
				Type: "string_pattern_mismatch", Loc: []string{"query", "type"},
				Msg:   "String should match pattern '^(agent|mcp|skill|hook|prompt)$'",
				Input: kind, Ctx: map[string]any{"pattern": "^(agent|mcp|skill|hook|prompt)$"},
			})
		}
		switch {
		case !q.Has("identifier"):
			errs = append(errs, fieldError{Type: "missing", Loc: []string{"query", "identifier"}, Msg: "Field required", Input: nil})
		case len(identifier) < 1:
			errs = append(errs, fieldError{
				Type: "string_too_short", Loc: []string{"query", "identifier"},
				Msg: "String should have at least 1 character", Input: identifier,
				Ctx: map[string]any{"min_length": 1},
			})
		case len(identifier) > 129:
			errs = append(errs, fieldError{
				Type: "string_too_long", Loc: []string{"query", "identifier"},
				Msg: "String should have at most 129 characters", Input: identifier,
				Ctx: map[string]any{"max_length": 129},
			})
		}
		if len(errs) > 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, errs)
			return
		}
		if kind == "agent" {
			row, err := h.Store.ResolveAgentIdentity(r.Context(), identifier, viewerFrom(r))
			if err != nil {
				writeStoreError(w, r, err)
				return
			}
			if row == nil {
				httpapi.WriteError(w, http.StatusNotFound, "Agent not found")
				return
			}
			httpapi.WriteJSON(w, http.StatusOK, map[string]any{
				"id": rowStr(row, "id", ""), "type": "agent",
				"namespace": rowStr(row, "namespace", ""), "slug": rowStr(row, "slug", ""),
				"qualified_name": rowStr(row, "namespace", "") + "/" + rowStr(row, "slug", ""),
			})
			return
		}

		f, ok := familyByName(kind)
		if !ok {
			httpapi.WriteInternalError(w, r, fmt.Errorf("no component family registered for kind %q", kind))
			return
		}
		row, _, err := h.Store.Show(r.Context(), f, identifier, viewerFrom(r))
		var ambiguous *ErrAmbiguous
		switch {
		case errors.As(err, &ambiguous):
			httpapi.WriteError(w, http.StatusConflict, ambiguous.Error())
			return
		case errors.Is(err, ErrNotFound):
			httpapi.WriteError(w, http.StatusNotFound, strings.ToUpper(kind[:1])+kind[1:]+" not found")
			return
		case err != nil:
			httpapi.WriteInternalError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, registryResolution{
			ID:            rowStr(row, "id", ""),
			Type:          kind,
			Namespace:     rowStr(row, "namespace", ""),
			Slug:          rowStr(row, "slug", ""),
			QualifiedName: rowStr(row, "namespace", "") + "/" + rowStr(row, "slug", ""),
		})
	})
}

// requireUser is the authenticated floor for lifecycle mutations.
func requireUser(w http.ResponseWriter, r *http.Request) *Viewer {
	viewer := viewerFrom(r)
	if viewer == nil {
		httpapi.WriteError(w, http.StatusUnauthorized, "Missing credentials")
	}
	return viewer
}

// writeStoreError translates store errors to their wire contract.
func writeStoreError(w http.ResponseWriter, r *http.Request, err error) {
	var ambiguous *ErrAmbiguous
	var api *apiError
	var invalid *validationError
	switch {
	case errors.As(err, &ambiguous):
		httpapi.WriteError(w, http.StatusConflict, ambiguous.Error())
	case errors.As(err, &api):
		if api.DetailAny != nil {
			httpapi.WriteErrorDetail(w, api.Status, api.DetailAny)
			return
		}
		httpapi.WriteError(w, api.Status, api.Detail)
	case errors.As(err, &invalid):
		httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, invalid.Errs)
	default:
		httpapi.WriteInternalError(w, r, err)
	}
}

func (h *Handler) lifecycle(f Family, op func(context.Context, Family, string, *Viewer) (*archiveResult, error)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		identifier := r.PathValue("listing_id")
		if strings.Contains(identifier, "/") {
			httpapi.WriteError(w, http.StatusNotFound, "Not Found")
			return
		}
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		result, err := op(r.Context(), f, identifier, viewer)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, result)
	})
}

func (h *Handler) editLock(f Family, op func(context.Context, Family, string, *Viewer) error, state string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		identifier := r.PathValue("listing_id")
		if strings.Contains(identifier, "/") {
			httpapi.WriteError(w, http.StatusNotFound, "Not Found")
			return
		}
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		if err := op(r.Context(), f, identifier, viewer); err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, map[string]string{"status": state})
	})
}

func (h *Handler) listVersions(f Family) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		identifier := r.PathValue("listing_id")
		if strings.Contains(identifier, "/") {
			httpapi.WriteError(w, http.StatusNotFound, "Not Found")
			return
		}
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		q := r.URL.Query()
		errs := []fieldError{}
		page := intParam(q, "page", 1, 1, -1, &errs)
		pageSize := intParam(q, "page_size", 20, 1, 100, &errs)
		if len(errs) > 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, errs)
			return
		}
		result, err := h.Store.ListVersions(r.Context(), f, identifier, viewer, page, pageSize)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, result)
	})
}

func (h *Handler) getVersion(f Family) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		identifier := r.PathValue("listing_id")
		version := r.PathValue("version")
		if strings.Contains(identifier, "/") || strings.Contains(version, "/") {
			httpapi.WriteError(w, http.StatusNotFound, "Not Found")
			return
		}
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		blob, err := h.Store.GetVersion(r.Context(), f, identifier, version, viewer)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, blob)
	})
}

func (h *Handler) suggestVersions(f Family) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		identifier := r.PathValue("listing_id")
		if strings.Contains(identifier, "/") {
			httpapi.WriteError(w, http.StatusNotFound, "Not Found")
			return
		}
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		result, err := h.Store.SuggestVersions(r.Context(), f, identifier, viewer)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, result)
	})
}

func (h *Handler) renderPrompt() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		identifier := r.PathValue("listing_id")
		if strings.Contains(identifier, "/") {
			httpapi.WriteError(w, http.StatusNotFound, "Not Found")
			return
		}
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
		if err != nil || len(bytes.TrimSpace(body)) == 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
				{Type: "missing", Loc: []string{"body"}, Msg: "Field required", Input: nil},
			})
			return
		}
		var req struct {
			Variables map[string]string `json:"variables"`
		}
		if err := json.Unmarshal(body, &req); err != nil {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
				{Type: "json_invalid", Loc: []string{"body", "0"}, Msg: "JSON decode error", Input: map[string]any{}},
			})
			return
		}
		result, err := h.Store.RenderPrompt(r.Context(), identifier, req.Variables, viewer)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, result)
	})
}

// pathUUID validates a typed uuid path parameter, appending the
// request-validation error on failure.
func pathUUID(r *http.Request, name string, errs *[]fieldError) uuid.UUID {
	raw := r.PathValue(name)
	id, err := uuid.Parse(raw)
	if err != nil {
		reason := uuidErrorText(raw)
		*errs = append(*errs, fieldError{
			Type: "uuid_parsing", Loc: []string{"path", name},
			Msg: "Input should be a valid UUID, " + reason, Input: raw,
			Ctx: map[string]any{"error": reason},
		})
	}
	return id
}

func (h *Handler) listCoAuthors(f Family) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		errs := []fieldError{}
		entityID := pathUUID(r, "entity_id", &errs)
		if len(errs) > 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, errs)
			return
		}
		out, err := h.Store.CoAuthors(r.Context(), f, entityID, viewer)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, out)
	})
}

func (h *Handler) addCoAuthor(f Family) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		errs := []fieldError{}
		entityID := pathUUID(r, "entity_id", &errs)
		if len(errs) > 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, errs)
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
		if err != nil || len(bytes.TrimSpace(body)) == 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
				{Type: "missing", Loc: []string{"body"}, Msg: "Field required", Input: nil},
			})
			return
		}
		var req struct {
			Email    *string `json:"email"`
			Username *string `json:"username"`
			UserID   *string `json:"user_id"`
		}
		if err := json.Unmarshal(body, &req); err != nil {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
				{Type: "json_invalid", Loc: []string{"body", "0"}, Msg: "JSON decode error", Input: map[string]any{}},
			})
			return
		}
		ref := UserRef{}
		if req.UserID != nil {
			ref.UserID = *req.UserID
		}
		if req.Email != nil {
			ref.Email = *req.Email
		}
		if req.Username != nil {
			ref.Username = *req.Username
		}
		out, err := h.Store.AddCoAuthor(r.Context(), f, entityID, viewer, ref)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, out)
	})
}

func (h *Handler) removeCoAuthor(f Family) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		errs := []fieldError{}
		entityID := pathUUID(r, "entity_id", &errs)
		userID := pathUUID(r, "user_id", &errs)
		if len(errs) > 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, errs)
			return
		}
		if err := h.Store.RemoveCoAuthor(r.Context(), f, entityID, userID, viewer); err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, map[string]string{"detail": "Co-author removed"})
	})
}

func (h *Handler) listEditors(f Family) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		errs := []fieldError{}
		entityID := pathUUID(r, "entity_id", &errs)
		if len(errs) > 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, errs)
			return
		}
		out, err := h.Store.Editors(r.Context(), f, entityID)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, out)
	})
}

func (h *Handler) createDraft(f Family) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4<<20))
		if err != nil || len(bytes.TrimSpace(raw)) == 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
				{Type: "missing", Loc: []string{"body"}, Msg: "Field required", Input: nil},
			})
			return
		}
		body := &draftBody{raw: map[string]any{}}
		if err := json.Unmarshal(raw, &body.raw); err != nil {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
				{Type: "json_invalid", Loc: []string{"body", "0"}, Msg: "JSON decode error", Input: map[string]any{}},
			})
			return
		}
		ambient, err := h.Store.AmbientProjectID(r.Context(), r, viewer)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		row, err := h.Store.CreateDraft(r.Context(), f, viewer, body, ambient, h.ValidHarnesses)
		var invalid *validationError
		switch {
		case errors.As(err, &invalid):
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, invalid.Errs)
			return
		case err != nil:
			writeStoreError(w, r, err)
			return
		}
		var validations []map[string]any
		if f.Prefix == "mcps" {
			validations = []map[string]any{}
		}
		httpapi.WriteJSON(w, http.StatusOK, detail(f, row, nil, validations))
	})
}

func (h *Handler) updateDraft(f Family) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		identifier := r.PathValue("listing_id")
		if strings.Contains(identifier, "/") {
			httpapi.WriteError(w, http.StatusNotFound, "Not Found")
			return
		}
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4<<20))
		if err != nil || len(bytes.TrimSpace(raw)) == 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
				{Type: "missing", Loc: []string{"body"}, Msg: "Field required", Input: nil},
			})
			return
		}
		body := &draftBody{raw: map[string]any{}}
		if err := json.Unmarshal(raw, &body.raw); err != nil {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
				{Type: "json_invalid", Loc: []string{"body", "0"}, Msg: "JSON decode error", Input: map[string]any{}},
			})
			return
		}
		row, err := h.Store.UpdateDraft(r.Context(), f, identifier, viewer, body, h.ValidHarnesses)
		var invalid *validationError
		switch {
		case errors.As(err, &invalid):
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, invalid.Errs)
			return
		case err != nil:
			writeStoreError(w, r, err)
			return
		}
		var validations []map[string]any
		if f.Prefix == "mcps" {
			if validations, err = h.Store.ValidationResults(r.Context(), rowStr(row, "id", "")); err != nil {
				httpapi.WriteInternalError(w, r, err)
				return
			}
		}
		httpapi.WriteJSON(w, http.StatusOK, detail(f, row, nil, validations))
	})
}

// sourceCreateBody validates the add-source request.
func sourceCreateBody(b *draftBody) SourceCreate {
	// Git import sources are always Project-scoped.
	req := SourceCreate{Visibility: "project"}
	url, present := b.raw["url"].(string)
	switch {
	case b.raw["url"] == nil:
		b.errs = append(b.errs, fieldError{Type: "missing", Loc: []string{"body", "url"}, Msg: "Field required", Input: b.raw})
	case !present:
		b.fail("string_type", "url", "Input should be a valid string", nil)
	case len(url) < 10:
		b.fail("string_too_short", "url", "String should have at least 10 characters", map[string]any{"min_length": 10})
	case !strings.HasPrefix(url, "https://"):
		b.fail("string_pattern_mismatch", "url", "String should match pattern '^https://'", map[string]any{"pattern": "^https://"})
	default:
		req.URL = url
	}
	kind, present := b.raw["component_type"].(string)
	switch {
	case b.raw["component_type"] == nil:
		b.errs = append(b.errs, fieldError{Type: "missing", Loc: []string{"body", "component_type"}, Msg: "Field required", Input: b.raw})
	case !present:
		b.fail("string_type", "component_type", "Input should be a valid string", nil)
	case !resolveTypePattern.MatchString(kind) || kind == "agent":
		b.fail("string_pattern_mismatch", "component_type",
			"String should match pattern '^(mcp|skill|hook|prompt)$'",
			map[string]any{"pattern": "^(mcp|skill|hook|prompt)$"})
	default:
		req.ComponentType = kind
	}
	return req
}

func (h *Handler) addSource() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
		if err != nil || len(bytes.TrimSpace(raw)) == 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
				{Type: "missing", Loc: []string{"body"}, Msg: "Field required", Input: nil},
			})
			return
		}
		body := &draftBody{raw: map[string]any{}}
		if err := json.Unmarshal(raw, &body.raw); err != nil {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
				{Type: "json_invalid", Loc: []string{"body", "0"}, Msg: "JSON decode error", Input: map[string]any{}},
			})
			return
		}
		req := sourceCreateBody(body)
		if len(body.errs) > 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, body.errs)
			return
		}
		ambient, err := h.Store.AmbientProjectID(r.Context(), r, viewer)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		out, err := h.Store.AddSource(r.Context(), viewer, req, ambient)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusCreated, out)
	})
}

func (h *Handler) listSources() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		out, err := h.Store.ListSources(r.Context(), viewer, r.URL.Query().Get("component_type"))
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, out)
	})
}

func (h *Handler) getSource() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		errs := []fieldError{}
		sourceID := pathUUID(r, "source_id", &errs)
		if len(errs) > 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, errs)
			return
		}
		out, err := h.Store.GetSource(r.Context(), viewer, sourceID)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, out)
	})
}

func (h *Handler) deleteSource() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		errs := []fieldError{}
		sourceID := pathUUID(r, "source_id", &errs)
		if len(errs) > 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, errs)
			return
		}
		if err := h.Store.DeleteSource(r.Context(), viewer, sourceID); err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, map[string]string{"deleted": sourceID.String()})
	})
}

// recommendTypeAliases maps plural and singular type names onto canonical
// singular forms.
var recommendTypeAliases = map[string]string{
	"skill": "skill", "hook": "hook", "prompt": "prompt", "mcp": "mcp",
	"skills": "skill", "hooks": "hook", "prompts": "prompt", "mcps": "mcp",
}

// recommendFamilies is the default recommendation order.
var recommendFamilies = []string{"skill", "hook", "prompt", "mcp"}

func (h *Handler) myRecommendations() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		q := r.URL.Query()
		errs := []fieldError{}
		limit := intParam(q, "limit", 8, 1, 24, &errs)
		refresh := boolParam(q, "refresh", &errs)
		if len(errs) > 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, errs)
			return
		}
		names := recommendFamilies
		if raw := q.Get("type"); raw != "" {
			normalized, ok := recommendTypeAliases[strings.ToLower(strings.TrimSpace(raw))]
			if !ok {
				httpapi.WriteError(w, http.StatusBadRequest, fmt.Sprintf("Unknown component type '%s'", raw))
				return
			}
			names = []string{normalized}
		}
		families := make([]Family, 0, len(names))
		for _, name := range names {
			if f, ok := familyByName(name); ok {
				families = append(families, f)
			}
		}
		// Telemetry problems must not take down the registry home page.
		profile, err := h.Store.GetOrBuildProfile(r.Context(), viewer.ID, "default", refresh)
		if err != nil || profile == nil {
			profile = &WorkProfile{}
		}
		items := h.Store.RecommendForUser(r.Context(), viewer, profile, families, limit)
		topics := profile.Topics
		if topics == nil {
			topics = []string{}
		}
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"items":            items,
			"personalized":     !profile.isEmpty(),
			"profile_sessions": profile.SessionCount,
			"topics":           topics,
		})
	})
}

func (h *Handler) recommendationFeedback() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
		if err != nil || len(bytes.TrimSpace(raw)) == 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
				{Type: "missing", Loc: []string{"body"}, Msg: "Field required", Input: nil},
			})
			return
		}
		body := &draftBody{raw: map[string]any{}}
		if err := json.Unmarshal(raw, &body.raw); err != nil {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
				{Type: "json_invalid", Loc: []string{"body", "0"}, Msg: "JSON decode error", Input: map[string]any{}},
			})
			return
		}
		componentType := body.str("component_type", "")
		if _, present := body.raw["component_type"]; !present {
			body.errs = append(body.errs, fieldError{Type: "missing", Loc: []string{"body", "component_type"}, Msg: "Field required", Input: body.raw})
		}
		var componentID uuid.UUID
		if v, present := body.raw["component_id"]; !present {
			body.errs = append(body.errs, fieldError{Type: "missing", Loc: []string{"body", "component_id"}, Msg: "Field required", Input: body.raw})
		} else if s, ok := v.(string); !ok {
			body.fail("uuid_type", "component_id", "UUID input should be a string, bytes or UUID object", nil)
		} else if id, err := uuid.Parse(s); err != nil {
			reason := uuidErrorText(s)
			body.fail("uuid_parsing", "component_id", "Input should be a valid UUID, "+reason, map[string]any{"error": reason})
		} else {
			componentID = id
		}
		action := body.str("action", "")
		if _, present := body.raw["action"]; !present {
			body.errs = append(body.errs, fieldError{Type: "missing", Loc: []string{"body", "action"}, Msg: "Field required", Input: body.raw})
		}
		if len(body.errs) > 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, body.errs)
			return
		}
		normalized, ok := recommendTypeAliases[strings.ToLower(strings.TrimSpace(componentType))]
		if !ok {
			httpapi.WriteError(w, http.StatusBadRequest, fmt.Sprintf("Unknown component type '%s'", componentType))
			return
		}
		switch action {
		case "dismissed", "not_relevant", "installed":
		default:
			httpapi.WriteError(w, http.StatusBadRequest, fmt.Sprintf("Unknown action '%s'", action))
			return
		}
		if err := h.Store.RecordFeedback(r.Context(), viewer.ID, normalized, componentID, action); err != nil {
			writeStoreError(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
}
