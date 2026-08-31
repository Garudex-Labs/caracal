// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/registry"
)

type updateBody struct {
	Name            *string         `json:"name"`
	Version         *string         `json:"version"`
	VersionBumpType *string         `json:"version_bump_type"`
	Description     *string         `json:"description"`
	Category        *string         `json:"category"`
	Owner           *string         `json:"owner"`
	Visibility      *string         `json:"visibility"`
	Prompt          *string         `json:"prompt"`
	ModelName       *string         `json:"model_name"`
	ModelConfig     map[string]any  `json:"model_config_json"`
	ModelsByHarness map[string]any  `json:"models_by_harness"`
	Supported       []string        `json:"supported_harnesses"`
	McpServerIDs    []string        `json:"mcp_server_ids"`
	Components      []componentBody `json:"components"`
	ExternalMcps    []externalMcp   `json:"external_mcps"`
	SuccessCriteria map[string]any  `json:"success_criteria"`
}

// parseUpdateBody decodes the body and tracks which fields were provided.
func parseUpdateBody(r *http.Request) (*updateBody, map[string]bool, error) {
	var raw map[string]json.RawMessage
	if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
		return nil, nil, err
	}
	blob, _ := json.Marshal(raw)
	var body updateBody
	if err := json.Unmarshal(blob, &body); err != nil {
		return nil, nil, err
	}
	set := map[string]bool{}
	for k := range raw {
		set[k] = true
	}
	return &body, set, nil
}

// writeUpdateResponse reloads the agent and renders the creation-style shape.
func (h *Handler) writeUpdateResponse(w http.ResponseWriter, r *http.Request, viewer *registry.Viewer, agentID string, withNames bool) {
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
	body := detail(row, links, viewer)
	body.UserPermission = nil
	for i := range body.ComponentLinks {
		body.ComponentLinks[i].Namespace = ""
		body.ComponentLinks[i].Slug = ""
		body.ComponentLinks[i].QualifiedName = ""
		body.ComponentLinks[i].Status = nil
		if !withNames {
			body.ComponentLinks[i].ComponentName = ""
		}
	}
	if !withNames {
		for i := range body.McpLinks {
			body.McpLinks[i].McpName = "(component)"
		}
	}
	httpapi.WriteJSON(w, http.StatusOK, body)
}

func componentRefsOf(items []componentBody) ([]componentRef, []map[string]any, []map[string]any) {
	refs := make([]componentRef, 0, len(items))
	overrides := make([]map[string]any, 0, len(items))
	literalErrs := []map[string]any{}
	for i, c := range items {
		if _, known := registry.Families[c.ComponentType+"s"]; !known {
			const expected = "'mcp', 'skill', 'hook' or 'prompt'"
			literalErrs = append(literalErrs, map[string]any{
				"type": "literal_error", "loc": []any{"body", "components", i, "component_type"},
				"msg": "Input should be " + expected, "input": c.ComponentType,
				"ctx": map[string]any{"expected": expected},
			})
			continue
		}
		refs = append(refs, componentRef{ComponentType: c.ComponentType, ComponentID: c.ComponentID})
		overrides = append(overrides, c.ConfigOverride)
	}
	return refs, overrides, literalErrs
}

// applyVersionFields writes provided latest-version fields; the compat rule
// requires a version row to exist.
func (h *Handler) applyVersionFields(r *http.Request, versionID string, body *updateBody, set map[string]bool) error {
	assignments := []string{}
	args := []any{}
	add := func(column string, value any) {
		args = append(args, value)
		assignments = append(assignments, column+" = $"+itoa(len(args)))
	}
	if body.Version != nil {
		add("version", *body.Version)
	}
	if body.Description != nil {
		add("description", *body.Description)
	}
	if body.Prompt != nil {
		add("prompt", *body.Prompt)
	}
	if body.ModelName != nil {
		add("model_name", *body.ModelName)
	}
	if set["model_config_json"] && body.ModelConfig != nil {
		blob, _ := json.Marshal(body.ModelConfig)
		add("model_config_json", string(blob))
	}
	if set["models_by_harness"] && body.ModelsByHarness != nil {
		blob, _ := json.Marshal(body.ModelsByHarness)
		add("models_by_harness", string(blob))
	}
	if set["supported_harnesses"] && body.Supported != nil {
		blob, _ := json.Marshal(body.Supported)
		add("supported_harnesses", string(blob))
	}
	if set["success_criteria"] {
		if body.SuccessCriteria == nil {
			add("success_criteria", nil)
		} else {
			blob, _ := json.Marshal(body.SuccessCriteria)
			add("success_criteria", string(blob))
		}
	}
	if set["external_mcps"] && body.ExternalMcps != nil {
		externals := make([]map[string]any, 0, len(body.ExternalMcps))
		for _, ext := range body.ExternalMcps {
			args := ext.Args
			if args == nil {
				args = []string{}
			}
			env := ext.Env
			if env == nil {
				env = map[string]string{}
			}
			externals = append(externals, map[string]any{
				"name": ext.Name, "command": ext.Command, "args": args, "env": env, "url": ext.URL,
			})
		}
		blob, _ := json.Marshal(externals)
		add("external_mcps", string(blob))
	}
	if len(assignments) == 0 {
		return nil
	}
	args = append(args, versionID)
	_, err := h.Store.Exec(r.Context(), "UPDATE agent_versions SET "+strings.Join(assignments, ", ")+
		" WHERE id = $"+itoa(len(args)), args...)
	return err
}

func (h *Handler) applyAgentFields(r *http.Request, agentID string, body *updateBody) error {
	assignments := []string{}
	args := []any{}
	add := func(column string, value any) {
		args = append(args, value)
		assignments = append(assignments, column+" = $"+itoa(len(args)))
	}
	if body.Name != nil {
		add("name", *body.Name)
	}
	if body.Owner != nil {
		add("owner", *body.Owner)
	}
	if body.Category != nil {
		add("category", *body.Category)
	}
	if len(assignments) == 0 {
		return nil
	}
	add("updated_at", "now()")
	assignments[len(assignments)-1] = "updated_at = now()"
	args = args[:len(args)-1]
	args = append(args, agentID)
	_, err := h.Store.Exec(r.Context(), "UPDATE agents SET "+strings.Join(assignments, ", ")+
		" WHERE id = $"+itoa(len(args)), args...)
	return err
}

func itoa(n int) string {
	return strconv.Itoa(n)
}

// externalCommandGuard validates each external server command.
func externalCommandGuard(externals []externalMcp) error {
	for _, ext := range externals {
		if err := validateMcpCommand(ext.Command, ext.Args); err != nil {
			return &errInstall{422, "Invalid MCP command: " + err.Error()}
		}
	}
	return nil
}

func (h *Handler) update() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		row, viewer, ok := h.loadLifecycle(w, r, LoadOpts{PreferOwner: true})
		if !ok {
			return
		}
		body, set, err := parseUpdateBody(r)
		if err != nil {
			httpapi.WriteError(w, http.StatusUnprocessableEntity, "Invalid request body")
			return
		}
		if permission(row, viewer) != "owner" {
			httpapi.WriteError(w, http.StatusForbidden, "Not the agent owner or editor")
			return
		}
		agentID := rowStr(row, "id", "")
		isPrivate := rowBool(row, "is_private")
		if body.Visibility != nil && *body.Visibility != visibility(row) {
			httpapi.WriteError(w, http.StatusUnprocessableEntity,
				"Visibility cannot be changed here. Use PATCH /api/v1/registry/agent/"+agentID+"/visibility instead.")
			return
		}
		latestVersionID := rowStr(row, "latest_version_id", "")
		if body.VersionBumpType != nil && body.Version == nil {
			bumped := bumpVersion(rowStr(row, "version", "0.0.0"), *body.VersionBumpType)
			body.Version = &bumped
		}
		if body.Name != nil && *body.Name != rowStr(row, "name", "") {
			var conflict *string
			err := h.Store.DB.QueryRow(r.Context(), `SELECT id::text FROM agents
				WHERE name = $1 AND deleted_at IS NULL AND id != $2`, *body.Name, agentID).Scan(&conflict)
			if err == nil {
				httpapi.WriteError(w, http.StatusConflict,
					"An active agent named '"+*body.Name+"' already exists.")
				return
			}
		}
		versionFieldTouched := body.Version != nil || body.Description != nil || body.Prompt != nil ||
			body.ModelName != nil || set["model_config_json"] || set["models_by_harness"] || set["supported_harnesses"]
		if (versionFieldTouched || set["success_criteria"]) && latestVersionID == "" {
			if set["success_criteria"] {
				httpapi.WriteError(w, http.StatusBadRequest, "Agent has no version to update")
			} else {
				httpapi.WriteInternalError(w, r, errors.New("agent draft update touched version fields but no latest version exists"))
			}
			return
		}
		if set["external_mcps"] && body.ExternalMcps != nil {
			if h.writeFailure(w, r, externalCommandGuard(body.ExternalMcps)) {
				return
			}
		}
		targetProjectID := ""
		if isPrivate {
			if projectID := rowNStr(row, "project_id"); projectID != nil {
				targetProjectID = *projectID
			}
		}
		componentsChanged := false
		if set["components"] && body.Components != nil {
			if latestVersionID == "" {
				httpapi.WriteError(w, http.StatusBadRequest, "Agent has no version to update components on")
				return
			}
			refs, overrides, literalErrs := componentRefsOf(body.Components)
			if len(literalErrs) > 0 {
				httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, literalErrs)
				return
			}
			validationErrors, err := h.Store.ValidateComponents(r.Context(), refs, viewer, targetProjectID)
			if err != nil {
				httpapi.WriteInternalError(w, r, err)
				return
			}
			if len(validationErrors) > 0 {
				httpapi.WriteErrorDetail(w, http.StatusBadRequest, validationErrors)
				return
			}
			resolved, _, err := h.Store.resolveCurrentVersions(r.Context(), refs)
			if err != nil {
				httpapi.WriteInternalError(w, r, err)
				return
			}
			if err := replaceComponents(r.Context(), h.Store.DB, h.Store, latestVersionID, refs, overrides, false, resolved); err != nil {
				httpapi.WriteInternalError(w, r, err)
				return
			}
			componentsChanged = true
		} else if set["mcp_server_ids"] && body.McpServerIDs != nil {
			if latestVersionID == "" {
				httpapi.WriteError(w, http.StatusBadRequest, "Agent has no version to update components on")
				return
			}
			refs := make([]componentRef, 0, len(body.McpServerIDs))
			for _, id := range body.McpServerIDs {
				refs = append(refs, componentRef{ComponentType: "mcp", ComponentID: id})
			}
			validationErrors, err := h.Store.ValidateComponents(r.Context(), refs, viewer, targetProjectID)
			if err != nil {
				httpapi.WriteInternalError(w, r, err)
				return
			}
			if len(validationErrors) > 0 {
				// The legacy list reports only the first failure, as a plain string.
				httpapi.WriteError(w, http.StatusBadRequest, validationErrors[0].Reason)
				return
			}
			resolved, _, err := h.Store.resolveCurrentVersions(r.Context(), refs)
			if err != nil {
				httpapi.WriteInternalError(w, r, err)
				return
			}
			if err := replaceComponents(r.Context(), h.Store.DB, h.Store, latestVersionID, refs, nil, true, resolved); err != nil {
				httpapi.WriteInternalError(w, r, err)
				return
			}
			componentsChanged = true
		}
		if err := h.applyVersionFields(r, latestVersionID, body, set); err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		if err := h.applyAgentFields(r, agentID, body); err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		if componentsChanged || set["external_mcps"] {
			var externals []any
			_ = h.Store.DB.QueryRow(r.Context(),
				`SELECT external_mcps FROM agent_versions WHERE id = $1`, latestVersionID).Scan(&externals)
			if err := h.Store.refreshInference(r.Context(), latestVersionID, externals); err != nil {
				httpapi.WriteInternalError(w, r, err)
				return
			}
		}
		snapshotNeedsRefresh := body.VersionBumpType != nil || versionFieldTouched ||
			set["external_mcps"] || set["components"] || set["mcp_server_ids"] || set["success_criteria"]
		if snapshotNeedsRefresh && latestVersionID != "" {
			if err := h.Store.refreshSnapshot(r.Context(), latestVersionID); err != nil {
				httpapi.WriteInternalError(w, r, err)
				return
			}
		}
		h.emitEvent(r, viewer, "agent.update", agentID, rowStr(row, "name", ""), "")
		h.writeUpdateResponse(w, r, viewer, agentID, true)
	})
}

func (h *Handler) createDraft() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := viewerFrom(r)
		if viewer == nil {
			httpapi.WriteError(w, http.StatusUnauthorized, "Missing credentials")
			return
		}
		var raw map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
			httpapi.WriteError(w, http.StatusUnprocessableEntity, "Invalid request body")
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
			ProjectID: ambient, AsDraft: true,
		}
		user := h.tenancyUser(r, viewer)
		agentID, err := h.Store.CreateAgent(r.Context(), user, req)
		if h.writeFailure(w, r, err) {
			return
		}
		h.writeUpdateResponse(w, r, viewer, agentID, false)
	})
}

func (h *Handler) updateDraft() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		row, viewer, ok := h.loadLifecycle(w, r, LoadOpts{PreferOwner: true})
		if !ok {
			return
		}
		body, set, err := parseUpdateBody(r)
		if err != nil {
			httpapi.WriteError(w, http.StatusUnprocessableEntity, "Invalid request body")
			return
		}
		if permission(row, viewer) != "owner" {
			httpapi.WriteError(w, http.StatusForbidden, "Not the agent owner or editor")
			return
		}
		status := rowStr(row, "status", "draft")
		if status != "draft" && status != "rejected" && status != "pending" {
			httpapi.WriteError(w, http.StatusBadRequest, "Only draft, rejected, or pending agents can be edited")
			return
		}
		latestVersionID := rowStr(row, "latest_version_id", "")
		if latestVersionID == "" {
			httpapi.WriteError(w, http.StatusBadRequest, "Agent has no version to update")
			return
		}
		if set["mcp_server_ids"] && body.McpServerIDs != nil {
			httpapi.WriteError(w, http.StatusUnprocessableEntity,
				"mcp_server_ids is not accepted here. Send MCP servers in 'components' instead.")
			return
		}
		agentID := rowStr(row, "id", "")
		// Visibility is fixed at creation; changing it goes through the
		// dedicated PATCH .../visibility endpoint, never a field update here.
		if body.Visibility != nil && *body.Visibility != visibility(row) {
			httpapi.WriteError(w, http.StatusUnprocessableEntity,
				"Visibility cannot be changed here. Use PATCH /api/v1/registry/agent/"+agentID+"/visibility instead.")
			return
		}
		targetProjectID := ""
		if projectID := rowNStr(row, "project_id"); projectID != nil {
			targetProjectID = *projectID
		}
		if body.VersionBumpType != nil && body.Version == nil {
			bumped := bumpVersion(rowStr(row, "version", "0.0.0"), *body.VersionBumpType)
			body.Version = &bumped
		}
		if set["external_mcps"] && body.ExternalMcps != nil {
			if h.writeFailure(w, r, externalCommandGuard(body.ExternalMcps)) {
				return
			}
		}
		componentsChanged := false
		if set["components"] && body.Components != nil {
			refs, overrides, literalErrs := componentRefsOf(body.Components)
			if len(literalErrs) > 0 {
				httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, literalErrs)
				return
			}
			validationErrors, err := h.Store.ValidateComponents(r.Context(), refs, viewer, targetProjectID)
			if err != nil {
				httpapi.WriteInternalError(w, r, err)
				return
			}
			if len(validationErrors) > 0 {
				httpapi.WriteErrorDetail(w, http.StatusBadRequest, validationErrors)
				return
			}
			resolved, _, err := h.Store.resolveCurrentVersions(r.Context(), refs)
			if err != nil {
				httpapi.WriteInternalError(w, r, err)
				return
			}
			if err := replaceComponents(r.Context(), h.Store.DB, h.Store, latestVersionID, refs, overrides, false, resolved); err != nil {
				httpapi.WriteInternalError(w, r, err)
				return
			}
			componentsChanged = true
		}
		// A live foreign lock refuses the save.
		isEditing, by, since, err := h.Store.editLockState(r.Context(), latestVersionID)
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		if isEditing && (by == nil || *by != viewer.ID) && !lockExpired(since) {
			httpapi.WriteError(w, http.StatusConflict,
				"This item is currently being edited by another user. Please try again later.")
			return
		}
		if err := h.Store.ReleaseEditLock(r.Context(), latestVersionID); err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		if err := h.applyVersionFields(r, latestVersionID, body, set); err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		if err := h.applyAgentFields(r, agentID, body); err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		if componentsChanged || set["external_mcps"] {
			var externals []any
			_ = h.Store.DB.QueryRow(r.Context(),
				`SELECT external_mcps FROM agent_versions WHERE id = $1`, latestVersionID).Scan(&externals)
			if err := h.Store.refreshInference(r.Context(), latestVersionID, externals); err != nil {
				httpapi.WriteInternalError(w, r, err)
				return
			}
		}
		if err := h.Store.refreshSnapshot(r.Context(), latestVersionID); err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		h.writeUpdateResponse(w, r, viewer, agentID, false)
	})
}

func (h *Handler) startEdit() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		row, viewer, ok := h.loadLifecycle(w, r, LoadOpts{PreferOwner: true})
		if !ok {
			return
		}
		if permission(row, viewer) != "owner" {
			httpapi.WriteError(w, http.StatusForbidden, "Not the agent owner or editor")
			return
		}
		latestVersionID := rowStr(row, "latest_version_id", "")
		if latestVersionID == "" {
			httpapi.WriteError(w, http.StatusBadRequest, "Agent has no version")
			return
		}
		status := rowStr(row, "status", "draft")
		if status != "pending" && status != "draft" && status != "rejected" {
			httpapi.WriteError(w, http.StatusBadRequest, "Cannot edit: agent version is '"+status+"'")
			return
		}
		if h.writeFailure(w, r, h.Store.AcquireEditLock(r.Context(), latestVersionID, viewer.ID)) {
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{"status": "locked"})
	})
}

func (h *Handler) cancelEdit() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		row, viewer, ok := h.loadLifecycle(w, r, LoadOpts{PreferOwner: true})
		if !ok {
			return
		}
		if permission(row, viewer) != "owner" {
			httpapi.WriteError(w, http.StatusForbidden, "Not the agent owner or editor")
			return
		}
		latestVersionID := rowStr(row, "latest_version_id", "")
		if latestVersionID == "" {
			httpapi.WriteError(w, http.StatusBadRequest, "Agent has no version")
			return
		}
		// Releasing another user's live lock is not allowed; expired locks are.
		isEditing, by, since, err := h.Store.editLockState(r.Context(), latestVersionID)
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		if !isEditing || (by != nil && *by == viewer.ID) || lockExpired(since) {
			if err := h.Store.ReleaseEditLock(r.Context(), latestVersionID); err != nil {
				httpapi.WriteInternalError(w, r, err)
				return
			}
		}
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{"status": "unlocked"})
	})
}

func (h *Handler) submitDraft() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		row, viewer, ok := h.loadLifecycle(w, r, LoadOpts{PreferOwner: true})
		if !ok {
			return
		}
		if permission(row, viewer) != "owner" {
			httpapi.WriteError(w, http.StatusForbidden, "Not the agent owner or editor")
			return
		}
		status := rowStr(row, "status", "draft")
		if status != "draft" && status != "rejected" {
			httpapi.WriteError(w, http.StatusBadRequest, "Agent is not a draft")
			return
		}
		if rowStr(row, "description", "") == "" {
			httpapi.WriteError(w, http.StatusBadRequest, "Description is required before submitting")
			return
		}
		latestVersionID := rowStr(row, "latest_version_id", "")
		agentID := rowStr(row, "id", "")
		targetProjectID := ""
		if rowBool(row, "is_private") {
			if projectID := rowNStr(row, "project_id"); projectID != nil {
				targetProjectID = *projectID
			}
		}
		links, err := h.Store.Components(r.Context(), latestVersionID)
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		if len(links) > 0 {
			refs := make([]componentRef, 0, len(links))
			for _, link := range links {
				refs = append(refs, componentRef{
					ComponentType: rowStr(link, "component_type", ""),
					ComponentID:   rowStr(link, "component_id", ""),
				})
			}
			validationErrors, err := h.Store.ValidateComponents(r.Context(), refs, viewer, targetProjectID)
			if err != nil {
				httpapi.WriteInternalError(w, r, err)
				return
			}
			if len(validationErrors) > 0 {
				httpapi.WriteErrorDetail(w, http.StatusBadRequest, validationErrors)
				return
			}
		}
		if latestVersionID != "" {
			flags := scanForGaming(rowStr(row, "prompt", ""))
			flagsJSON, _ := json.Marshal(flags)
			if _, err := h.Store.Exec(r.Context(), `UPDATE agent_versions SET gaming_flags = $1
				WHERE id = $2`, string(flagsJSON), latestVersionID); err != nil {
				httpapi.WriteInternalError(w, r, err)
				return
			}
			if err := h.Store.refreshSnapshot(r.Context(), latestVersionID); err != nil {
				httpapi.WriteInternalError(w, r, err)
				return
			}
			// Project-shared publishing never auto-approves; submission always queues.
			if _, err := h.Store.Exec(r.Context(), `UPDATE agent_versions SET status = 'pending'
				WHERE id = $1`, latestVersionID); err != nil {
				httpapi.WriteInternalError(w, r, err)
				return
			}
		}
		h.emitEvent(r, viewer, "agent.submit", agentID, rowStr(row, "name", ""), "")
		h.writeUpdateResponse(w, r, viewer, agentID, true)
	})
}
