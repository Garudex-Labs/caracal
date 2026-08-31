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
	"github.com/garudex-labs/caracal/internal/harnessgen"
	"github.com/garudex-labs/caracal/internal/httpapi"
)

// SettingsReader gates behavior on runtime settings.
type SettingsReader interface {
	Bool(ctx context.Context, key string, fallback bool) bool
	String(ctx context.Context, key, fallback string) string
}

type installRequest struct {
	Harness      string                       `json:"harness"`
	EnvValues    map[string]map[string]string `json:"env_values"`
	HeaderValues map[string]map[string]string `json:"header_values"`
	Options      map[string]any               `json:"options"`
	Platform     string                       `json:"platform"`
	Version      *string                      `json:"version"`
}

func (h *Handler) install() http.Handler {
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
		var req installRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Harness == "" {
			loc := []any{"body", "harness"}
			msg, errType := "Field required", "missing"
			if err != nil {
				loc, msg, errType = []any{"body"}, "Input should be a valid dictionary or object to extract fields from", "model_attributes_type"
			}
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []map[string]any{{"type": errType, "loc": loc, "msg": msg}})
			return
		}

		if !harnessgen.SupportsAgent(req.Harness) {
			httpapi.WriteError(w, http.StatusUnprocessableEntity,
				"Agents are not supported for the '"+req.Harness+"' harness.")
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
		if rowStr(row, "status", "draft") != "approved" {
			draftAllowed := h.Settings != nil &&
				h.Settings.Bool(r.Context(), "security.allow_draft_install", false) &&
				rowStr(row, "created_by", "") == viewer.ID.String()
			if !draftAllowed {
				httpapi.WriteError(w, http.StatusNotFound, "Agent not found or not approved for installation")
				return
			}
		}

		requestedVersion := ""
		if req.Version != nil {
			requestedVersion = *req.Version
		}
		inputs, err := h.Store.InstallInputs(r.Context(), row, viewer, requestedVersion)
		var installErr *errInstall
		if errors.As(err, &installErr) {
			httpapi.WriteError(w, installErr.status, installErr.detail)
			return
		}
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}

		options := map[string]any{}
		for k, v := range req.Options {
			options[k] = v
		}
		override, _ := options["model"].(string)
		if strings.ToLower(strings.TrimSpace(override)) == "inherit" {
			override = ""
		}
		versionRow := inputs.VersionRow
		resolvedModel, modelWarnings := harnessgen.ResolveModel(
			req.Harness, rowStr(versionRow, "model_name", ""),
			rowDict(versionRow, "models_by_harness"), override)

		agent := &harnessgen.Agent{
			ID:                   rowStr(row, "id", ""),
			Name:                 rowStr(row, "name", ""),
			Slug:                 rowStr(row, "slug", ""),
			Description:          rowStr(versionRow, "description", ""),
			Prompt:               rowStr(versionRow, "prompt", ""),
			ModelName:            rowStr(versionRow, "model_name", ""),
			ModelsByHarness:      rowDict(versionRow, "models_by_harness"),
			ExternalMcps:         rowList(versionRow, "external_mcps"),
			RequiredCapabilities: rowList(versionRow, "required_capabilities"),
		}
		for _, link := range inputs.Links {
			agent.Components = append(agent.Components, harnessgen.ComponentLink{
				Type:           rowStr(link, "component_type", ""),
				ID:             rowStr(link, "component_id", ""),
				OrderIndex:     rowInt(link, "order_index"),
				ConfigOverride: rowNDict(link, "config_override"),
			})
		}
		caracalURL := "http://localhost:8080"
		if h.Settings != nil {
			if v := strings.TrimRight(h.Settings.String(r.Context(), "deployment.public_url", ""), "/"); v != "" {
				caracalURL = v
			}
		}
		genReq := &harnessgen.Request{
			Agent:          agent,
			Harness:        req.Harness,
			CaracalURL:     caracalURL,
			McpListings:    inputs.Families["mcp"],
			SkillListings:  inputs.Families["skill"],
			HookListings:   inputs.Families["hook"],
			PromptListings: inputs.Families["prompt"],
			ComponentNames: inputs.NameMap,
			EnvValues:      req.EnvValues,
			HeaderValues:   req.HeaderValues,
			Options:        options,
			Platform:       req.Platform,
			ResolvedModel:  resolvedModel,
			ModelWarnings:  modelWarnings,
		}
		snippet, err := harnessgen.Generate(genReq)
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}

		warnings := []string{}
		for _, familyName := range []string{"mcp", "skill", "hook", "prompt"} {
			label := familyName
			if familyName == "mcp" {
				label = "MCP"
			}
			for _, link := range inputs.Links {
				if rowStr(link, "component_type", "") != familyName {
					continue
				}
				listing := inputs.Families[familyName][rowStr(link, "component_id", "")]
				name, _ := listing["name"].(string)
				if status, _ := listing["status"].(string); status == "archived" {
					warnings = append(warnings, "Archived "+label+" '"+name+
						"' is deprecated and may be removed from future agent pulls.")
				}
				if familyName == "mcp" {
					if setup, _ := listing["setup_instructions"].(string); setup != "" {
						warnings = append(warnings, "MCP '"+name+"' requires local setup before use:\n"+setup)
					}
				}
			}
		}
		if w, ok := snippet.Get("_warnings"); ok {
			for _, item := range anySlice(w) {
				if s, ok := item.(string); ok {
					warnings = append(warnings, s)
				}
			}
			snippet.Delete("_warnings")
		}

		if err := h.Store.RecordDownload(r.Context(), agent.ID, viewer, req.Harness); err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		if h.Audit != nil {
			claims, _ := httpapi.ClaimsFrom(r.Context())
			h.Audit.Log(audit.Record{
				EventID:      uuid.NewString(),
				Timestamp:    time.Now().UTC().Format("2006-01-02 15:04:05.000"),
				ActorID:      viewer.ID.String(),
				ActorEmail:   claims.Email,
				ActorRole:    viewer.Role,
				Action:       "agent.install",
				ResourceType: "agent",
				ResourceID:   agent.ID,
				ResourceName: agent.Name,
				Detail:       "harness=" + req.Harness,
			})
		}

		httpapi.WriteJSON(w, http.StatusOK, installResponse{
			AgentID: agent.ID, Harness: req.Harness,
			ConfigSnippet: snippet, Warnings: warnings,
		})
	})
}

type installResponse struct {
	AgentID       string   `json:"agent_id"`
	Harness       string   `json:"harness"`
	ConfigSnippet any      `json:"config_snippet"`
	Warnings      []string `json:"warnings"`
}

func anySlice(v any) []any {
	switch t := v.(type) {
	case []any:
		return t
	case []string:
		out := make([]any, 0, len(t))
		for _, s := range t {
			out = append(out, s)
		}
		return out
	}
	return nil
}
