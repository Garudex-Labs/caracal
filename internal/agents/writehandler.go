// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/audit"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/registry"
	"github.com/garudex-labs/caracal/internal/resretention"
	"github.com/garudex-labs/caracal/internal/tenancy"
)

// registryStore is the sibling-domain surface the write plane borrows:
// ambient project resolution shared with the component families.
type registryStore interface {
	AmbientProjectID(ctx context.Context, r *http.Request, viewer *registry.Viewer) (*uuid.UUID, error)
}

type createAgentBody struct {
	Name            string          `json:"name"`
	Version         string          `json:"version"`
	Description     string          `json:"description"`
	Category        *string         `json:"category"`
	Owner           *string         `json:"owner"`
	Visibility      string          `json:"visibility"`
	Prompt          string          `json:"prompt"`
	ModelName       *string         `json:"model_name"`
	ModelConfig     map[string]any  `json:"model_config_json"`
	ModelsByHarness map[string]any  `json:"models_by_harness"`
	Supported       []string        `json:"supported_harnesses"`
	McpServerIDs    []string        `json:"mcp_server_ids"`
	Components      []componentBody `json:"components"`
	ExternalMcps    []externalMcp   `json:"external_mcps"`
	SuccessCriteria map[string]any  `json:"success_criteria"`
}

type componentBody struct {
	ComponentType  string         `json:"component_type"`
	ComponentID    string         `json:"component_id"`
	ConfigOverride map[string]any `json:"config_override"`
}

// validateCreateBody mirrors the request-model validation: required fields,
// the slug-style name rule, and the closed literal sets. rawBody echoes the
// submitted object in missing-field reports.
func validateCreateBody(body *createAgentBody, rawBody map[string]json.RawMessage, hasName, hasVersion, hasOwner, hasModel bool) []map[string]any {
	errs := []map[string]any{}
	echo := map[string]any{}
	for k, v := range rawBody {
		var decoded any
		_ = json.Unmarshal(v, &decoded)
		echo[k] = decoded
	}
	missing := func(field string) {
		errs = append(errs, map[string]any{"type": "missing", "loc": []any{"body", field}, "msg": "Field required", "input": echo})
	}
	if !hasName {
		missing("name")
	}
	if !hasVersion {
		missing("version")
	}
	if !hasOwner {
		missing("owner")
	}
	if !hasModel {
		missing("model_name")
	}
	if hasName {
		nameErr := ""
		switch {
		case body.Name == "":
			nameErr = "name is required"
		case len(body.Name) > 64:
			nameErr = "name must be at most 64 characters"
		case !agentNameRE.MatchString(body.Name):
			nameErr = "Invalid name '" + body.Name + "'. Must start with a letter or digit and contain only lowercase letters, digits, hyphens, and underscores."
		}
		if nameErr != "" {
			errs = append(errs, map[string]any{
				"type": "value_error", "loc": []any{"body", "name"},
				"msg": "Value error, " + nameErr, "input": body.Name,
				"ctx": map[string]any{"error": map[string]any{}},
			})
		}
	}
	if body.Visibility != "" && body.Visibility != "project" && body.Visibility != "private" {
		const expected = "'project' or 'private'"
		errs = append(errs, map[string]any{
			"type": "literal_error", "loc": []any{"body", "visibility"},
			"msg": "Input should be " + expected, "input": body.Visibility,
			"ctx": map[string]any{"expected": expected},
		})
	}
	for i, c := range body.Components {
		if _, known := registry.Families[c.ComponentType+"s"]; !known {
			const expected = "'mcp', 'skill', 'hook' or 'prompt'"
			errs = append(errs, map[string]any{
				"type": "literal_error", "loc": []any{"body", "components", i, "component_type"},
				"msg": "Input should be " + expected, "input": c.ComponentType,
				"ctx": map[string]any{"expected": expected},
			})
		}
	}
	return errs
}

// tenancyUser loads the caller's identity fields for publish resolution.
func (h *Handler) tenancyUser(r *http.Request, viewer *registry.Viewer) tenancy.User {
	claims, _ := httpapi.ClaimsFrom(r.Context())
	user := tenancy.User{ID: viewer.ID, Role: viewer.Role, Email: claims.Email}
	var username *string
	if err := h.Store.DB.QueryRow(r.Context(),
		`SELECT username FROM users WHERE id = $1`, viewer.ID).Scan(&username); err == nil && username != nil {
		user.Username = *username
	}
	return user
}

func (h *Handler) emitEvent(r *http.Request, viewer *registry.Viewer, action, agentID, name, detail string) {
	if h.Audit == nil {
		return
	}
	claims, _ := httpapi.ClaimsFrom(r.Context())
	h.Audit.Log(audit.Record{
		EventID:      uuid.NewString(),
		Timestamp:    time.Now().UTC().Format("2006-01-02 15:04:05.000"),
		ActorID:      viewer.ID.String(),
		ActorEmail:   claims.Email,
		ActorRole:    viewer.Role,
		Action:       action,
		ResourceType: "agent",
		ResourceID:   agentID,
		ResourceName: name,
		Detail:       detail,
	})
}

func (h *Handler) create() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := viewerFrom(r)
		if viewer == nil {
			httpapi.WriteError(w, http.StatusUnauthorized, "Missing credentials")
			return
		}
		var raw map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []map[string]any{{"type": "model_attributes_type", "loc": []any{"body"},
				"msg": "Input should be a valid dictionary or object to extract fields from"}})
			return
		}
		blob, _ := json.Marshal(raw)
		var body createAgentBody
		if err := json.Unmarshal(blob, &body); err != nil {
			httpapi.WriteError(w, http.StatusUnprocessableEntity, "Invalid request body")
			return
		}
		_, hasName := raw["name"]
		_, hasVersion := raw["version"]
		_, hasOwner := raw["owner"]
		_, hasModel := raw["model_name"]
		if errs := validateCreateBody(&body, raw, hasName, hasVersion, hasOwner, hasModel); len(errs) > 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, errs)
			return
		}
		if body.Description == "" {
			httpapi.WriteError(w, http.StatusUnprocessableEntity, "Description must not be empty")
			return
		}

		ambient, err := h.Registry.AmbientProjectID(r.Context(), r, viewer)
		if err != nil {
			if status, detailText, ok := registry.APIErrorOf(err); ok {
				httpapi.WriteError(w, status, detailText)
				return
			}
			httpapi.WriteInternalError(w, r, err)
			return
		}

		refs := make([]componentRef, 0, len(body.Components))
		overrides := make([]map[string]any, 0, len(body.Components))
		for _, c := range body.Components {
			refs = append(refs, componentRef{ComponentType: c.ComponentType, ComponentID: c.ComponentID})
			overrides = append(overrides, c.ConfigOverride)
		}
		req := &CreateAgentRequest{
			Name: body.Name, Version: body.Version, Description: body.Description,
			Category: body.Category, Owner: deref(body.Owner),
			Visibility: body.Visibility, Prompt: body.Prompt, ModelName: deref(body.ModelName),
			ModelConfigJSON: body.ModelConfig, ModelsByHarness: body.ModelsByHarness,
			SupportedList: body.Supported, McpServerIDs: body.McpServerIDs,
			Components: refs, ComponentConfigs: overrides,
			ExternalMcps: body.ExternalMcps, SuccessCriteria: body.SuccessCriteria,
			ProjectID: ambient,
		}
		user := h.tenancyUser(r, viewer)
		agentID, err := h.Store.CreateAgent(r.Context(), user, req)
		if h.writeFailure(w, r, err) {
			return
		}
		h.emitEvent(r, viewer, "agent.create", agentID, body.Name, "")
		row, err := h.Store.Load(r.Context(), agentID, viewer, true)
		if err != nil || row == nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		links, err := h.Store.Components(r.Context(), rowStr(row, "latest_version_id", ""))
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		body2 := detail(row, links, viewer)
		body2.UserPermission = nil
		// The creation response reports names only; identity and status
		// resolution belong to the detail view.
		for i := range body2.ComponentLinks {
			body2.ComponentLinks[i].Namespace = ""
			body2.ComponentLinks[i].Slug = ""
			body2.ComponentLinks[i].QualifiedName = ""
			body2.ComponentLinks[i].Status = nil
		}
		httpapi.WriteJSON(w, http.StatusOK, body2)
	})
}

// writeFailure translates store rejections to their wire shapes.
func (h *Handler) writeFailure(w http.ResponseWriter, r *http.Request, err error) bool {
	if err == nil {
		return false
	}
	var installErr *errInstall
	if errors.As(err, &installErr) {
		// A JSON-array detail carries structured component errors.
		if strings.HasPrefix(installErr.detail, "[") {
			var items []any
			if json.Unmarshal([]byte(installErr.detail), &items) == nil {
				httpapi.WriteErrorDetail(w, installErr.status, items)
				return true
			}
		}
		httpapi.WriteError(w, installErr.status, installErr.detail)
		return true
	}
	var tenancyErr *tenancy.Error
	if errors.As(err, &tenancyErr) {
		httpapi.WriteError(w, tenancyErr.Status, tenancyErr.Detail)
		return true
	}
	httpapi.WriteInternalError(w, r, err)
	return true
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func (h *Handler) deleteAgent() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		row, viewer, ok := h.loadLifecycle(w, r, LoadOpts{PreferOwner: true, AllStatuses: true})
		if !ok {
			return
		}
		allowed, err := h.canManageResourceLifecycle(r.Context(), row, viewer)
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		if !allowed {
			httpapi.WriteError(w, http.StatusForbidden, "Not authorized")
			return
		}
		agentID := rowStr(row, "id", "")
		policy := h.resourceRetentionPolicy(r.Context(), row)
		class := resretention.ClassForAgent(rowStr(row, "ownership_scope", ""), rowBool(row, "is_private"))
		name, deletedAt, scheduledPurgeAt, err := h.Store.SoftDelete(r.Context(), agentID, class, policy)
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		h.emitEvent(r, viewer, "agent.delete", agentID, name, "")
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"deleted": agentID, "name": name, "deleted_at": wireTimeISO(deletedAt),
			"scheduled_purge_at": wireTimeISO(scheduledPurgeAt),
		})
	})
}

func (h *Handler) canManageResourceLifecycle(ctx context.Context, row map[string]any, viewer *registry.Viewer) (bool, error) {
	if permission(row, viewer) == "owner" {
		return true, nil
	}
	class := resretention.ClassForAgent(rowStr(row, "ownership_scope", ""), rowBool(row, "is_private"))
	if class == resretention.ClassPrivate {
		return false, nil
	}
	projectIDRaw := rowNStr(row, "project_id")
	if projectIDRaw == nil {
		return false, nil
	}
	projectID, err := uuid.Parse(*projectIDRaw)
	if err != nil {
		return false, nil
	}
	return h.Store.CanAdministerProjectResource(ctx, projectID, viewer.ID)
}

func (h *Handler) resourceRetentionPolicy(ctx context.Context, row map[string]any) resretention.Policy {
	projectIDRaw := rowNStr(row, "project_id")
	if projectIDRaw == nil {
		return resretention.DefaultPolicy()
	}
	projectID, err := uuid.Parse(*projectIDRaw)
	if err != nil {
		return resretention.DefaultPolicy()
	}
	db, ok := h.Store.DB.(resretention.DB)
	if !ok {
		return resretention.DefaultPolicy()
	}
	policy, err := (&resretention.Store{DB: db}).ReadPolicy(ctx, projectID)
	if err != nil {
		return resretention.DefaultPolicy()
	}
	return policy
}

func (h *Handler) restore() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		row, viewer, ok := h.loadLifecycle(w, r, LoadOpts{PreferOwner: true, AllStatuses: true, IncludeDeleted: true})
		if !ok {
			return
		}
		if row["deleted_at"] == nil {
			httpapi.WriteError(w, http.StatusNotFound, "Deleted agent not found")
			return
		}
		allowed, err := h.canManageResourceLifecycle(r.Context(), row, viewer)
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		if !allowed {
			httpapi.WriteError(w, http.StatusForbidden, "Not authorized")
			return
		}
		if scheduledPurgeAt, ok := rowTime(row, "scheduled_purge_at"); ok && !scheduledPurgeAt.After(time.Now().UTC()) {
			httpapi.WriteError(w, http.StatusGone, "Retention period expired; the agent is no longer recoverable")
			return
		}
		newName := ""
		var body struct {
			Name *string `json:"name"`
		}
		if r.Body != nil {
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body.Name != nil {
				newName = strings.TrimSpace(*body.Name)
			}
		}
		name, _, err := h.Store.Restore(r.Context(), row, newName)
		if h.writeFailure(w, r, err) {
			return
		}
		h.emitEvent(r, viewer, "agent.restore", rowStr(row, "id", ""), name, "")
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"id": rowStr(row, "id", ""), "name": name, "status": rowStr(row, "status", "draft"),
		})
	})
}

func (h *Handler) purge() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		row, viewer, ok := h.loadLifecycle(w, r, LoadOpts{PreferOwner: true, AllStatuses: true, IncludeDeleted: true})
		if !ok {
			return
		}
		if row["deleted_at"] == nil {
			httpapi.WriteError(w, http.StatusNotFound, "Deleted agent not found")
			return
		}
		allowed, err := h.canManageResourceLifecycle(r.Context(), row, viewer)
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		if !allowed {
			httpapi.WriteError(w, http.StatusForbidden, "Not authorized")
			return
		}
		var body struct {
			Confirm string `json:"confirm"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity,
				[]map[string]any{{"type": "missing", "loc": []any{"body", "confirm"}, "msg": "Field required", "input": nil}})
			return
		}
		if strings.ToLower(strings.TrimSpace(body.Confirm)) != "permanently delete" {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity,
				[]map[string]any{{"type": "value_error", "loc": []any{"body", "confirm"},
					"msg": "Type 'permanently delete' to confirm permanent deletion", "input": body.Confirm}})
			return
		}
		agentID := rowStr(row, "id", "")
		name, err := h.Store.PurgeDeleted(r.Context(), agentID)
		if h.writeFailure(w, r, err) {
			return
		}
		h.emitEvent(r, viewer, "agent.purge", agentID, name, "")
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{"deleted": agentID, "name": name, "permanent": true})
	})
}

func (h *Handler) archive() http.Handler {
	return h.flipArchive("archived", "approved",
		"Only the owner or an admin can archive this agent",
		"Only approved agents can be archived", "agent.archive", LoadOpts{PreferOwner: true})
}

func (h *Handler) unarchive() http.Handler {
	return h.flipArchive("approved", "archived",
		"Only the owner or an admin can unarchive this agent",
		"Agent is not archived", "agent.unarchive", LoadOpts{PreferOwner: true, AllStatuses: true})
}

func (h *Handler) flipArchive(toStatus, fromStatus, permDetail, stateDetail, action string, opts LoadOpts) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		row, viewer, ok := h.loadLifecycle(w, r, opts)
		if !ok {
			return
		}
		if rowStr(row, "created_by", "") != viewer.ID.String() {
			httpapi.WriteError(w, http.StatusForbidden, permDetail)
			return
		}
		if rowStr(row, "status", "draft") != fromStatus {
			httpapi.WriteError(w, http.StatusBadRequest, stateDetail)
			return
		}
		latest := rowStr(row, "latest_version_id", "")
		if latest == "" {
			httpapi.WriteError(w, http.StatusBadRequest, "Agent has no version")
			return
		}
		if err := h.Store.SetLatestVersionStatus(r.Context(), latest, toStatus); err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		h.emitEvent(r, viewer, action, rowStr(row, "id", ""), rowStr(row, "name", ""), "")
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"id": rowStr(row, "id", ""), "name": rowStr(row, "name", ""), "status": toStatus,
		})
	})
}

// loadLifecycle resolves an agent for a mutation route.
func (h *Handler) loadLifecycle(w http.ResponseWriter, r *http.Request, opts LoadOpts) (map[string]any, *registry.Viewer, bool) {
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
	row, err := h.Store.LoadWith(r.Context(), agentID, viewer, opts)
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
		if opts.IncludeDeleted {
			httpapi.WriteError(w, http.StatusNotFound, "Deleted agent not found")
		} else {
			httpapi.WriteError(w, http.StatusNotFound, "Agent not found")
		}
		return nil, nil, false
	}
	return row, viewer, true
}
