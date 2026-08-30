// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/registry"
)

type versionCreateBody struct {
	Version         *string               `json:"version"`
	Description     string                `json:"description"`
	Prompt          string                `json:"prompt"`
	ModelName       *string               `json:"model_name"`
	ModelConfig     map[string]any        `json:"model_config_json"`
	ModelsByHarness map[string]any        `json:"models_by_harness"`
	ExternalMcps    []externalMcp         `json:"external_mcps"`
	Supported       []string              `json:"supported_harnesses"`
	Components      []versionComponentRef `json:"components"`
	IsPrerelease    bool                  `json:"is_prerelease"`
	SaveAsDraft     bool                  `json:"save_as_draft"`
	SuccessCriteria map[string]any        `json:"success_criteria"`
}

// validateVersionCreateBody mirrors the request-model validation: required
// fields, the semver rule, and the closed component-type literal.
func validateVersionCreateBody(body *versionCreateBody, rawBody map[string]json.RawMessage) []map[string]any {
	errs := []map[string]any{}
	echo := map[string]any{}
	for k, v := range rawBody {
		var decoded any
		_ = json.Unmarshal(v, &decoded)
		echo[k] = decoded
	}
	if body.Version == nil {
		errs = append(errs, map[string]any{"type": "missing", "loc": []any{"body", "version"}, "msg": "Field required", "input": echo})
	} else if _, _, _, ok := parseSemver(*body.Version); !ok {
		errs = append(errs, map[string]any{
			"type": "value_error", "loc": []any{"body", "version"},
			"msg":   "Value error, Invalid version '" + *body.Version + "'. Must be semver format: x.y.z (e.g. 1.0.0)",
			"input": *body.Version, "ctx": map[string]any{"error": map[string]any{}},
		})
	}
	if body.ModelName == nil {
		errs = append(errs, map[string]any{"type": "missing", "loc": []any{"body", "model_name"}, "msg": "Field required", "input": echo})
	}
	for i, c := range body.Components {
		if _, known := registry.Families[c.ComponentType+"s"]; !known {
			const expected = "'mcp', 'skill', 'hook', 'prompt' or 'sandbox'"
			errs = append(errs, map[string]any{
				"type": "literal_error", "loc": []any{"body", "components", i, "component_type"},
				"msg": "Input should be " + expected, "input": c.ComponentType,
				"ctx": map[string]any{"expected": expected},
			})
		}
	}
	return errs
}

func (h *Handler) createVersion() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			httpapi.WriteError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
		var rawBody map[string]json.RawMessage
		if err := json.Unmarshal(raw, &rawBody); err != nil {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []map[string]any{{"type": "model_attributes_type", "loc": []any{"body"},
				"msg": "Input should be a valid dictionary or object to extract fields from"}})
			return
		}
		var body versionCreateBody
		if err := json.Unmarshal(raw, &body); err != nil {
			httpapi.WriteError(w, http.StatusUnprocessableEntity, "Invalid request body")
			return
		}
		if errs := validateVersionCreateBody(&body, rawBody); len(errs) > 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, errs)
			return
		}
		row, viewer, ok := h.loadRequired(w, r)
		if !ok {
			return
		}
		if permission(row, viewer) != "owner" {
			httpapi.WriteError(w, http.StatusForbidden, "Not authorized to release versions")
			return
		}
		result, err := h.Store.CreateVersion(r.Context(), row, viewer, &VersionCreateRequest{
			Version:         *body.Version,
			Description:     body.Description,
			Prompt:          body.Prompt,
			ModelName:       *body.ModelName,
			ModelConfigJSON: body.ModelConfig,
			ModelsByHarness: body.ModelsByHarness,
			ExternalMcps:    body.ExternalMcps,
			Supported:       body.Supported,
			Components:      body.Components,
			IsPrerelease:    body.IsPrerelease,
			SaveAsDraft:     body.SaveAsDraft,
			SuccessCriteria: body.SuccessCriteria,
		})
		if h.writeFailure(w, r, err) {
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, result)
	})
}

func (h *Handler) reviewVersion() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			httpapi.WriteError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
		var rawBody map[string]json.RawMessage
		if err := json.Unmarshal(raw, &rawBody); err != nil {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []map[string]any{{"type": "model_attributes_type", "loc": []any{"body"},
				"msg": "Input should be a valid dictionary or object to extract fields from"}})
			return
		}
		var body struct {
			Action *string `json:"action"`
			Reason *string `json:"reason"`
		}
		_ = json.Unmarshal(raw, &body)
		if body.Action == nil {
			echo := map[string]any{}
			for k, v := range rawBody {
				var decoded any
				_ = json.Unmarshal(v, &decoded)
				echo[k] = decoded
			}
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []map[string]any{{"type": "missing", "loc": []any{"body", "action"},
				"msg": "Field required", "input": echo}})
			return
		}
		if *body.Action != "approve" && *body.Action != "reject" {
			const expected = "'approve' or 'reject'"
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []map[string]any{{"type": "literal_error", "loc": []any{"body", "action"},
				"msg": "Input should be " + expected, "input": *body.Action,
				"ctx": map[string]any{"expected": expected}}})
			return
		}
		row, viewer, ok := h.loadRequired(w, r)
		if !ok {
			return
		}
		result, err := h.Store.ReviewVersion(r.Context(), row, viewer, r.PathValue("version"), *body.Action, body.Reason)
		if h.writeFailure(w, r, err) {
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, result)
	})
}

func (h *Handler) restoreVersion() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		row, viewer, ok := h.loadRequired(w, r)
		if !ok {
			return
		}
		if permission(row, viewer) != "owner" {
			httpapi.WriteError(w, http.StatusForbidden, "Not authorized to restore versions")
			return
		}
		var body struct {
			Reason *string `json:"reason"`
		}
		if raw, err := io.ReadAll(r.Body); err == nil && len(raw) > 0 {
			_ = json.Unmarshal(raw, &body)
		}
		result, err := h.Store.RestoreVersion(r.Context(), row, viewer, r.PathValue("version"), body.Reason)
		if h.writeFailure(w, r, err) {
			return
		}
		httpapi.WriteJSON(w, http.StatusCreated, result)
	})
}
