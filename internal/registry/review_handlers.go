// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sort"
	"strings"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/httpapi"
)

// reviewQueue answers GET /api/v1/review with the merged pending queue.
func (h *Handler) reviewQueue() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		scope, err := h.Store.reviewScopeFor(r.Context(), viewer)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		var projectFilter *uuid.UUID
		if viewer.ProjectID != "" {
			parsed, perr := uuid.Parse(viewer.ProjectID)
			if perr != nil {
				httpapi.WriteInternalError(w, r, perr)
				return
			}
			projectFilter = &parsed
		}
		if raw := r.URL.Query().Get("project_id"); raw != "" {
			parsed, perr := uuid.Parse(raw)
			if perr != nil {
				httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
					{Type: "uuid_parsing", Loc: []string{"query", "project_id"},
						Msg: "Input should be a valid UUID, " + uuidParseHint(raw), Input: raw},
				})
				return
			}
			if projectFilter != nil && parsed != *projectFilter {
				httpapi.WriteError(w, http.StatusConflict, "Project scope mismatch between request context and query")
				return
			}
			projectFilter = &parsed
		}
		if aerr := checkProjectFilter(projectFilter, scope); aerr != nil {
			writeStoreError(w, r, aerr)
			return
		}
		typeFilter := r.URL.Query().Get("type")
		tab := r.URL.Query().Get("tab")

		var agents, components []map[string]any
		if tab != "components" {
			agents, err = h.Store.PendingAgents(r.Context(), scope, projectFilter)
			if err != nil {
				writeStoreError(w, r, err)
				return
			}
		}
		if tab != "agents" {
			components, err = h.Store.PendingComponents(r.Context(), scope, typeFilter, projectFilter)
			if err != nil {
				writeStoreError(w, r, err)
				return
			}
		}
		switch tab {
		case "agents":
			httpapi.WriteJSON(w, http.StatusOK, agents)
		case "components":
			httpapi.WriteJSON(w, http.StatusOK, components)
		default:
			all := append(append([]map[string]any{}, agents...), components...)
			sort.SliceStable(all, func(i, j int) bool {
				a, _ := all[i]["created_at"].(string)
				b, _ := all[j]["created_at"].(string)
				return a > b
			})
			httpapi.WriteJSON(w, http.StatusOK, all)
		}
	})
}

// uuidParseHint approximates the pydantic uuid error suffix.
func uuidParseHint(raw string) string {
	return "invalid UUID '" + raw + "'"
}

// reviewDetail answers GET /api/v1/review/{listing_id}, falling back to the
// agent table when no component matches.
func (h *Handler) reviewDetail() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		scope, err := h.Store.reviewScopeFor(r.Context(), viewer)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		identifier := r.PathValue("listing_id")
		f, listing, err := h.Store.findReviewListing(r.Context(), identifier)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		if listing != nil {
			if !scope.CanReview(rowProjectID(listing, "project_id"), rowBool(listing, "is_private")) {
				writeStoreError(w, r, notFoundErr())
				return
			}
			out, err := h.Store.ReviewDetail(r.Context(), f, listing)
			if err != nil {
				writeStoreError(w, r, err)
				return
			}
			httpapi.WriteJSON(w, http.StatusOK, out)
			return
		}
		agentID, perr := uuid.Parse(identifier)
		if perr != nil {
			writeStoreError(w, r, notFoundErr())
			return
		}
		out, err := h.Store.AgentReviewDetail(r.Context(), agentID, scope)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, out)
	})
}

// AgentReviewDetail renders the agent branch of the review detail view.
func (s *Store) AgentReviewDetail(ctx context.Context, agentID uuid.UUID, scope interface {
	CanReview(*uuid.UUID, bool) bool
}) (map[string]any, error) {
	agent, err := s.agentRow(ctx, agentID)
	if err != nil {
		return nil, err
	}
	if agent == nil || !scope.CanReview(rowProjectID(agent, "project_id"), rowBool(agent, "is_private")) {
		return nil, notFoundErr()
	}
	pending, err := s.pendingAgentVersions(ctx, rowStr(agent, "id", ""))
	if err != nil {
		return nil, err
	}
	var ver map[string]any
	if len(pending) > 0 {
		ver = pending[0]
	} else if latest := rowNStr(agent, "latest_version_id"); latest != nil {
		rows, qerr := s.DB.Query(ctx,
			`SELECT *, id::text AS id, released_by::text AS released_by
			 FROM agent_versions WHERE id = $1`, *latest)
		if qerr != nil {
			return nil, qerr
		}
		matches := collectRows(rows)
		rows.Close()
		if len(matches) > 0 {
			ver = matches[0]
		}
	}
	components := []map[string]any{}
	if ver != nil {
		loaded, cerr := s.agentVersionComponents(ctx, rowStr(ver, "id", ""))
		if cerr != nil {
			return nil, cerr
		}
		components = loaded
	}
	ready, blocking, err := s.agentComponentsReady(ctx, components)
	if err != nil {
		return nil, err
	}
	str := func(row map[string]any, key string) string {
		if row == nil {
			return ""
		}
		return rowStr(row, key, "")
	}
	submittedBy := str(ver, "released_by")
	if submittedBy == "" {
		submittedBy = rowStr(agent, "created_by", "")
	}
	out := map[string]any{
		"type":         "agent",
		"id":           rowStr(agent, "id", ""),
		"name":         rowStr(agent, "name", ""),
		"description":  firstNonEmpty(str(ver, "description"), rowStr(agent, "description", "")),
		"version":      firstNonEmpty(str(ver, "version"), rowStr(agent, "version", "")),
		"owner":        rowStr(agent, "owner", ""),
		"status":       firstNonEmpty(str(ver, "status"), rowStr(agent, "status", "")),
		"submitted_by": submittedBy,
		"created_at":   wireTimePlus(agent["created_at"]),
		"updated_at":   wireTimePlus(agent["updated_at"]),
		"git_url":      agent["git_url"],
	}
	fill := func(key string, fallback any) {
		if ver != nil && ver[key] != nil {
			out[key] = ver[key]
			return
		}
		out[key] = fallback
	}
	fill("prompt", "")
	fill("model_name", "")
	fill("model_config_json", map[string]any{})
	fill("external_mcps", []any{})
	fill("supported_harnesses", []any{})
	fill("required_capabilities", []any{})
	if ver != nil {
		out["rejection_reason"] = ver["rejection_reason"]
		out["gaming_flags"] = ver["gaming_flags"]
		out["success_criteria"] = ver["success_criteria"]
	} else {
		out["rejection_reason"] = nil
		out["gaming_flags"] = nil
		out["success_criteria"] = nil
	}
	out["component_count"] = len(components)
	out["components_ready"] = ready
	out["component_blockers"] = blocking

	expanded := []any{}
	for _, comp := range components {
		ctype, _ := comp["component_type"].(string)
		cid, _ := comp["component_id"].(string)
		name, _ := comp["component_name"].(string)
		entry := map[string]any{"component_type": ctype, "component_id": cid, "name": name}
		for _, prefix := range reviewFamilies {
			f := Families[prefix]
			if f.Name != ctype {
				continue
			}
			var listingName string
			var description, template, category *string
			err := s.DB.QueryRow(ctx,
				`SELECT l.name, v.description,
				        CASE WHEN $2 = 'prompt' THEN v.template END,
				        CASE WHEN $2 = 'prompt' THEN v.category END
				 FROM `+f.ListingTable+` l LEFT JOIN `+f.VersionTable+` v ON l.latest_version_id = v.id
				 WHERE l.id = $1`, cid, ctype).Scan(&listingName, &description, &template, &category)
			if err == nil {
				entry["name"] = listingName
				if ctype == "prompt" {
					entry["template"] = deref(template)
					entry["category"] = deref(category)
				} else {
					entry["description"] = deref(description)
				}
			}
			break
		}
		expanded = append(expanded, entry)
	}
	out["components"] = expanded

	if name, err := s.displayName(ctx, submittedBy); err == nil && name != "" {
		out["submitted_by"] = name
	}
	return out, nil
}

func deref(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}

// reviewBody reads an optional JSON object body.
func reviewBody(w http.ResponseWriter, r *http.Request, required bool) (map[string]any, bool) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil || len(strings.TrimSpace(string(raw))) == 0 {
		if required {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
				{Type: "missing", Loc: []string{"body"}, Msg: "Field required", Input: nil},
			})
			return nil, false
		}
		return map[string]any{}, true
	}
	body := map[string]any{}
	if err := json.Unmarshal(raw, &body); err != nil {
		httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
			{Type: "json_invalid", Loc: []string{"body", "0"}, Msg: "JSON decode error", Input: map[string]any{}},
		})
		return nil, false
	}
	return body, true
}

// requiredReason enforces the reject bodies' single mandatory field.
func requiredReason(w http.ResponseWriter, body map[string]any) (string, bool) {
	reason, ok := body["reason"].(string)
	if _, present := body["reason"]; !present {
		httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
			{Type: "missing", Loc: []string{"body", "reason"}, Msg: "Field required", Input: body},
		})
		return "", false
	}
	if !ok {
		httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
			{Type: "string_type", Loc: []string{"body", "reason"}, Msg: "Input should be a valid string", Input: body["reason"]},
		})
		return "", false
	}
	return reason, true
}

func (h *Handler) reviewDecide(approve bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		reason := ""
		if !approve {
			body, ok := reviewBody(w, r, true)
			if !ok {
				return
			}
			if v, isStr := body["reason"].(string); isStr {
				reason = v
			}
		}
		out, err := h.Store.DecideListing(r.Context(), r.PathValue("listing_id"), approve, reason, viewer)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, out)
	})
}

func (h *Handler) reviewAgentDecide(approve bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		errs := []fieldError{}
		agentID := pathUUID(r, "agent_id", &errs)
		if len(errs) > 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, errs)
			return
		}
		reason, category := "", ""
		if approve {
			body, ok := reviewBody(w, r, false)
			if !ok {
				return
			}
			if v, isStr := body["category"].(string); isStr {
				category = v
			}
		} else {
			body, ok := reviewBody(w, r, true)
			if !ok {
				return
			}
			reason, ok = requiredReason(w, body)
			if !ok {
				return
			}
		}
		out, err := h.Store.DecideAgent(r.Context(), agentID, approve, reason, category, viewer)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, out)
	})
}

func (h *Handler) reviewBundleDecide(approve bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		errs := []fieldError{}
		bundleID := pathUUID(r, "bundle_id", &errs)
		if len(errs) > 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, errs)
			return
		}
		reason := ""
		if !approve {
			body, ok := reviewBody(w, r, true)
			if !ok {
				return
			}
			if v, isStr := body["reason"].(string); isStr {
				reason = v
			}
		}
		out, err := h.Store.DecideBundle(r.Context(), bundleID, approve, reason, viewer)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, out)
	})
}

func (h *Handler) reviewRelatedSkills() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		out, err := h.Store.RelatedSkills(r.Context(), r.PathValue("listing_id"), viewer)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, out)
	})
}

func (h *Handler) reviewApproveWithSkills() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		body, ok := reviewBody(w, r, true)
		if !ok {
			return
		}
		skillIDs := []string{}
		if raw, isList := body["skill_ids"].([]any); isList {
			for _, v := range raw {
				if s, isStr := v.(string); isStr {
					skillIDs = append(skillIDs, s)
				}
			}
		}
		out, err := h.Store.ApproveWithSkills(r.Context(), r.PathValue("listing_id"), skillIDs, viewer)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, out)
	})
}

// registerReviewRoutes mounts the review surface.
func (h *Handler) registerReviewRoutes(mux *http.ServeMux, withAuth func(http.Handler) http.Handler) {
	mux.Handle("GET /api/v1/review", withAuth(h.reviewQueue()))
	mux.Handle("GET /api/v1/review/{listing_id}", withAuth(h.reviewDetail()))
	mux.Handle("POST /api/v1/review/{listing_id}/approve", withAuth(h.reviewDecide(true)))
	mux.Handle("POST /api/v1/review/{listing_id}/reject", withAuth(h.reviewDecide(false)))
	mux.Handle("POST /api/v1/review/agents/{agent_id}/approve", withAuth(h.reviewAgentDecide(true)))
	mux.Handle("POST /api/v1/review/agents/{agent_id}/reject", withAuth(h.reviewAgentDecide(false)))
	mux.Handle("POST /api/v1/review/bundles/{bundle_id}/approve", withAuth(h.reviewBundleDecide(true)))
	mux.Handle("POST /api/v1/review/bundles/{bundle_id}/reject", withAuth(h.reviewBundleDecide(false)))
	mux.Handle("GET /api/v1/review/{listing_id}/related-skills", withAuth(h.reviewRelatedSkills()))
	mux.Handle("POST /api/v1/review/{listing_id}/approve-with-skills", withAuth(h.reviewApproveWithSkills()))
}
