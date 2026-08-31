// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/audit"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/registry"
	"github.com/garudex-labs/caracal/internal/tenancy"
)

// Handler serves the agent surface; anything not answered natively is
// relayed to the incumbent API.
type Handler struct {
	Store    *Store
	Settings SettingsReader
	Audit    *audit.Logger
	Registry registryStore
}

// Register mounts the native reads. The group requires authentication except
// the stats views, which allow anonymous callers; the archive view requires
// the operator floor.
func (h *Handler) Register(mux *http.ServeMux, withAuth, withOptional func(http.Handler) http.Handler) {
	mux.Handle("GET /api/v1/agents", withAuth(h.list()))
	mux.Handle("GET /api/v1/agents/my", withAuth(h.mine()))
	mux.Handle("GET /api/v1/agents/archived", withAuth(httpapi.RequireRole("operator", h.archived())))
	mux.Handle("GET /api/v1/agents/deleted", withAuth(h.deleted()))
	mux.Handle("GET /api/v1/agents/{agent_id}", withAuth(h.show()))
	mux.Handle("GET /api/v1/agents/{agent_id}/versions", withAuth(h.versions()))
	mux.Handle("GET /api/v1/agents/{agent_id}/versions/{version}", withAuth(h.version()))
	mux.Handle("GET /api/v1/agents/{agent_id}/version-suggestions", withAuth(h.versionSuggestions()))
	mux.Handle("GET /api/v1/agents/{agent_id}/downloads", withOptional(h.downloads()))
	mux.Handle("GET /api/v1/agents/{agent_id}/traces", withOptional(h.traces()))
	mux.Handle("GET /api/v1/agents/{agent_id}/resolve", withAuth(h.resolveComposition()))
	mux.Handle("GET /api/v1/agents/{agent_id}/manifest", withAuth(h.manifest()))
	mux.Handle("GET /api/v1/agents/{agent_id}/versions/{version}/harness/{harness}", withAuth(h.harnessConfig()))
	mux.Handle("GET /api/v1/agents/{agent_id}/versions/{v1}/diff/{v2}", withAuth(h.versionDiff()))
	mux.Handle("POST /api/v1/agents/validate", withAuth(h.validate()))
	mux.Handle("POST /api/v1/agents/preview-config", withAuth(h.previewConfig()))
	mux.Handle("POST /api/v1/agents/{agent_id}/install", withAuth(h.install()))
	mux.Handle("POST /api/v1/agents", withAuth(h.create()))
	mux.Handle("PUT /api/v1/agents/{agent_id}", withAuth(h.update()))
	mux.Handle("POST /api/v1/agents/draft", withAuth(h.createDraft()))
	mux.Handle("PUT /api/v1/agents/{agent_id}/draft", withAuth(h.updateDraft()))
	mux.Handle("POST /api/v1/agents/{agent_id}/start-edit", withAuth(h.startEdit()))
	mux.Handle("POST /api/v1/agents/{agent_id}/cancel-edit", withAuth(h.cancelEdit()))
	mux.Handle("POST /api/v1/agents/{agent_id}/submit", withAuth(h.submitDraft()))
	mux.Handle("POST /api/v1/agents/{agent_id}/versions", withAuth(h.createVersion()))
	mux.Handle("POST /api/v1/agents/{agent_id}/versions/{version}/review", withAuth(httpapi.RequireRole("reviewer", h.reviewVersion())))
	mux.Handle("POST /api/v1/agents/{agent_id}/versions/{version}/restore", withAuth(h.restoreVersion()))
	mux.Handle("DELETE /api/v1/agents/{agent_id}", withAuth(h.deleteAgent()))
	mux.Handle("PATCH /api/v1/agents/{agent_id}/restore", withAuth(h.restore()))
	mux.Handle("POST /api/v1/agents/{agent_id}/purge", withAuth(h.purge()))
	mux.Handle("PATCH /api/v1/agents/{agent_id}/archive", withAuth(h.archive()))
	mux.Handle("PATCH /api/v1/agents/{agent_id}/unarchive", withAuth(h.unarchive()))
}

func viewerFrom(r *http.Request) *registry.Viewer {
	claims, ok := httpapi.ClaimsFrom(r.Context())
	if !ok {
		return nil
	}
	projectID, _ := tenancy.ProjectIDFromContext(r.Context())
	return &registry.Viewer{ID: claims.UserID, Role: claims.Role, ProjectID: projectID}
}

func writeSummaries(w http.ResponseWriter, rows []map[string]any) {
	out := make([]agentSummary, 0, len(rows))
	for _, row := range rows {
		out = append(out, summarize(row))
	}
	httpapi.WriteJSON(w, http.StatusOK, out)
}

func (h *Handler) list() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := viewerFrom(r)
		if viewer == nil {
			httpapi.WriteError(w, http.StatusUnauthorized, "Missing credentials")
			return
		}
		q := r.URL.Query()
		errs := []registry.FieldError{}
		p := ListParams{
			Search:                 q.Get("search"),
			Namespace:              q.Get("namespace"),
			Category:               q.Get("category"),
			ProjectID:              registry.ParseUUIDQuery(q, "project_id", &errs),
			ComposableForProjectID: registry.ParseUUIDQuery(q, "composable_for_project_id", &errs),
			Limit:                  registry.ParseIntQuery(q, "limit", 50, 1, 200, &errs),
			Offset:                 registry.ParseIntQuery(q, "offset", 0, 0, -1, &errs),
		}
		if len(errs) > 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, errs)
			return
		}
		rows, total, err := h.Store.List(r.Context(), p, viewer)
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		w.Header().Set("X-Total-Count", strconv.Itoa(total))
		writeSummaries(w, rows)
	})
}

func (h *Handler) mine() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := viewerFrom(r)
		if viewer == nil {
			httpapi.WriteError(w, http.StatusUnauthorized, "Missing credentials")
			return
		}
		rows, err := h.Store.Mine(r.Context(), viewer)
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		writeSummaries(w, rows)
	})
}

func (h *Handler) archived() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rows, err := h.Store.Archived(r.Context())
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		writeSummaries(w, rows)
	})
}

func (h *Handler) show() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := viewerFrom(r)
		if viewer == nil {
			httpapi.WriteError(w, http.StatusUnauthorized, "Missing credentials")
			return
		}
		agentID := r.PathValue("agent_id")
		// An encoded slash decodes into a path that matches no route.
		if strings.Contains(agentID, "/") {
			httpapi.WriteError(w, http.StatusNotFound, "Not Found")
			return
		}
		row, err := h.Store.Load(r.Context(), agentID, viewer, true)
		var ambiguous *ErrAmbiguous
		if errors.As(err, &ambiguous) {
			httpapi.WriteError(w, http.StatusConflict, ambiguous.Error())
			return
		}
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		if row == nil {
			httpapi.WriteError(w, http.StatusNotFound, "Agent not found")
			return
		}
		links, err := h.Store.Components(r.Context(), rowStr(row, "latest_version_id", ""))
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, detail(row, links, viewer))
	})
}

// loadForVersions resolves the agent for the version routes: same identity
// gate as show, but without the creator's unapproved-name exception.
func (h *Handler) loadForVersions(w http.ResponseWriter, r *http.Request) (map[string]any, *registry.Viewer, bool) {
	viewer := viewerFrom(r)
	if viewer == nil {
		httpapi.WriteError(w, http.StatusUnauthorized, "Missing credentials")
		return nil, nil, false
	}
	agentID := r.PathValue("agent_id")
	if strings.Contains(agentID, "/") || strings.Contains(r.PathValue("version"), "/") {
		httpapi.WriteError(w, http.StatusNotFound, "Not Found")
		return nil, nil, false
	}
	row, err := h.Store.Load(r.Context(), agentID, viewer, false)
	var ambiguous *ErrAmbiguous
	if errors.As(err, &ambiguous) {
		httpapi.WriteError(w, http.StatusConflict, ambiguous.Error())
		return nil, nil, false
	}
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return nil, nil, false
	}
	if row == nil {
		httpapi.WriteError(w, http.StatusNotFound, "Agent not found")
		return nil, nil, false
	}
	return row, viewer, true
}

func (h *Handler) versions() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		errs := []registry.FieldError{}
		page := registry.ParseIntQuery(q, "page", 1, 1, -1, &errs)
		pageSize := registry.ParseIntQuery(q, "page_size", 20, 1, 100, &errs)
		if len(errs) > 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, errs)
			return
		}
		row, viewer, ok := h.loadForVersions(w, r)
		if !ok {
			return
		}
		pageBody, err := h.Store.Versions(r.Context(), row, viewer, page, pageSize)
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, pageBody)
	})
}

func (h *Handler) version() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		row, viewer, ok := h.loadForVersions(w, r)
		if !ok {
			return
		}
		detailBody, err := h.Store.Version(r.Context(), row, viewer, r.PathValue("version"))
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		if detailBody == nil {
			httpapi.WriteError(w, http.StatusNotFound, "Version not found")
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, detailBody)
	})
}

// loadOptional resolves the agent for the anonymous-allowed stats views,
// mirroring the creator preference only when a caller is present.
func (h *Handler) loadOptional(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	viewer := viewerFrom(r)
	agentID := r.PathValue("agent_id")
	if strings.Contains(agentID, "/") {
		httpapi.WriteError(w, http.StatusNotFound, "Not Found")
		return nil, false
	}
	row, err := h.Store.Load(r.Context(), agentID, viewer, viewer != nil)
	var ambiguous *ErrAmbiguous
	if errors.As(err, &ambiguous) {
		httpapi.WriteError(w, http.StatusConflict, ambiguous.Error())
		return nil, false
	}
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return nil, false
	}
	if row == nil {
		httpapi.WriteError(w, http.StatusNotFound, "Agent not found")
		return nil, false
	}
	return row, true
}

func (h *Handler) downloads() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		row, ok := h.loadOptional(w, r)
		if !ok {
			return
		}
		stats, err := h.Store.DownloadStats(r.Context(), rowStr(row, "id", ""))
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, stats)
	})
}

func (h *Handler) traces() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		errs := []registry.FieldError{}
		registry.ParseIntQuery(q, "limit", 50, 1, 500, &errs)
		registry.ParseIntQuery(q, "offset", 0, 0, -1, &errs)
		if len(errs) > 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, errs)
			return
		}
		row, ok := h.loadOptional(w, r)
		if !ok {
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"agent_id": rowStr(row, "id", ""),
			"traces":   []any{},
			"count":    0,
		})
	})
}

func (h *Handler) versionSuggestions() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := viewerFrom(r)
		if viewer == nil {
			httpapi.WriteError(w, http.StatusUnauthorized, "Missing credentials")
			return
		}
		agentID := r.PathValue("agent_id")
		if strings.Contains(agentID, "/") {
			httpapi.WriteError(w, http.StatusNotFound, "Not Found")
			return
		}
		row, err := h.Store.Load(r.Context(), agentID, viewer, true)
		var ambiguous *ErrAmbiguous
		if errors.As(err, &ambiguous) {
			httpapi.WriteError(w, http.StatusConflict, ambiguous.Error())
			return
		}
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		if row == nil {
			httpapi.WriteError(w, http.StatusNotFound, "Agent not found")
			return
		}
		out, err := h.Store.SuggestVersions(r.Context(), row)
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, out)
	})
}

// loadRequired resolves the agent for authenticated composition routes.
func (h *Handler) loadRequired(w http.ResponseWriter, r *http.Request) (map[string]any, *registry.Viewer, bool) {
	viewer := viewerFrom(r)
	if viewer == nil {
		httpapi.WriteError(w, http.StatusUnauthorized, "Missing credentials")
		return nil, nil, false
	}
	agentID := r.PathValue("agent_id")
	if strings.Contains(agentID, "/") {
		httpapi.WriteError(w, http.StatusNotFound, "Not Found")
		return nil, nil, false
	}
	row, err := h.Store.Load(r.Context(), agentID, viewer, true)
	var ambiguous *ErrAmbiguous
	if errors.As(err, &ambiguous) {
		httpapi.WriteError(w, http.StatusConflict, ambiguous.Error())
		return nil, nil, false
	}
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return nil, nil, false
	}
	if row == nil {
		httpapi.WriteError(w, http.StatusNotFound, "Agent not found")
		return nil, nil, false
	}
	return row, viewer, true
}

func (h *Handler) resolveComposition() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		row, viewer, ok := h.loadRequired(w, r)
		if !ok {
			return
		}
		links, err := h.Store.Components(r.Context(), rowStr(row, "latest_version_id", ""))
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		resolved, err := h.Store.Resolve(r.Context(), row, links, viewer)
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, compositionSummary(resolved))
	})
}

func (h *Handler) manifest() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		row, viewer, ok := h.loadRequired(w, r)
		if !ok {
			return
		}
		links, err := h.Store.Components(r.Context(), rowStr(row, "latest_version_id", ""))
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		resolved, err := h.Store.Resolve(r.Context(), row, links, viewer)
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		if !resolved.ok() {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, map[string]any{
				"message": "Agent has unresolvable components",
				"errors":  resolved.Errors,
			})
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, agentManifest(resolved))
	})
}

func (h *Handler) harnessConfig() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.PathValue("version"), "/") || strings.Contains(r.PathValue("harness"), "/") {
			httpapi.WriteError(w, http.StatusNotFound, "Not Found")
			return
		}
		row, viewer, ok := h.loadForVersions(w, r)
		if !ok {
			return
		}
		config, err := h.Store.HarnessConfig(r.Context(), row, viewer, r.PathValue("version"), r.PathValue("harness"))
		var missing *errNotFound
		if errors.As(err, &missing) {
			httpapi.WriteError(w, http.StatusNotFound, missing.detail)
			return
		}
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(config)
	})
}

func (h *Handler) versionDiff() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.PathValue("v1"), "/") || strings.Contains(r.PathValue("v2"), "/") {
			httpapi.WriteError(w, http.StatusNotFound, "Not Found")
			return
		}
		row, viewer, ok := h.loadForVersions(w, r)
		if !ok {
			return
		}
		diff, err := h.Store.VersionDiff(r.Context(), row, viewer, r.PathValue("v1"), r.PathValue("v2"))
		var missing *errNotFound
		if errors.As(err, &missing) {
			httpapi.WriteError(w, http.StatusNotFound, missing.detail)
			return
		}
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, diff)
	})
}

type validateRequest struct {
	Components []componentRef `json:"components"`
	ProjectID  *string        `json:"project_id"`
	Visibility string         `json:"visibility"`
}

type validationIssue struct {
	Severity      string  `json:"severity"`
	ComponentType *string `json:"component_type"`
	ComponentID   *string `json:"component_id"`
	Message       string  `json:"message"`
}

func (h *Handler) validate() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := viewerFrom(r)
		if viewer == nil {
			httpapi.WriteError(w, http.StatusUnauthorized, "Missing credentials")
			return
		}
		var req validateRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []registry.FieldError{{
				Type: "json_invalid", Loc: []string{"body"},
				Msg: "Input should be a valid dictionary or object to extract fields from",
			}})
			return
		}
		if req.Visibility == "" {
			req.Visibility = "project"
		}
		// component_type is a closed set at the request boundary.
		type literalError struct {
			Type  string         `json:"type"`
			Loc   []any          `json:"loc"`
			Msg   string         `json:"msg"`
			Input string         `json:"input"`
			Ctx   map[string]any `json:"ctx"`
		}
		const expected = "'mcp', 'skill', 'hook' or 'prompt'"
		literalErrs := []literalError{}
		for i, ref := range req.Components {
			if _, known := registry.Families[ref.ComponentType+"s"]; !known {
				literalErrs = append(literalErrs, literalError{
					Type:  "literal_error",
					Loc:   []any{"body", "components", i, "component_type"},
					Msg:   "Input should be " + expected,
					Input: ref.ComponentType,
					Ctx:   map[string]any{"expected": expected},
				})
			}
		}
		if len(literalErrs) > 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, literalErrs)
			return
		}
		if len(req.Components) == 0 {
			httpapi.WriteJSON(w, http.StatusOK, map[string]any{"valid": true, "issues": []any{}})
			return
		}
		target := ""
		if req.Visibility == "project" && req.ProjectID != nil {
			target = *req.ProjectID
		}
		errs, err := h.Store.ValidateComponents(r.Context(), req.Components, viewer, target)
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		issues := make([]validationIssue, 0, len(errs))
		for _, e := range errs {
			e := e
			issues = append(issues, validationIssue{
				Severity: "error", ComponentType: &e.ComponentType,
				ComponentID: &e.ComponentID, Message: e.Reason,
			})
		}
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{"valid": len(issues) == 0, "issues": issues})
	})
}

func (h *Handler) deleted() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := viewerFrom(r)
		if viewer == nil {
			httpapi.WriteError(w, http.StatusUnauthorized, "Missing credentials")
			return
		}
		var projectID *uuid.UUID
		if h.Registry != nil {
			var err error
			projectID, err = h.Registry.AmbientProjectID(r.Context(), r, viewer)
			if h.writeFailure(w, r, err) {
				return
			}
		}
		rows, err := h.Store.Deleted(r.Context(), viewer, tenancy.IsOperator(viewer.Role), projectID)
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		writeSummaries(w, rows)
	})
}
