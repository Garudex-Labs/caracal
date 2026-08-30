// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/harness"
	"github.com/garudex-labs/caracal/internal/harnessgen"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/registry"
	"github.com/garudex-labs/caracal/internal/tenancy"
)

const (
	previewMaxComponents = 20
	previewMaxNameLen    = 100
	previewMaxPromptLen  = 50_000
)

type previewComponentRef struct {
	ComponentType string `json:"component_type"`
	ComponentID   string `json:"component_id"`
}

type previewBody struct {
	Name            string                `json:"name"`
	Description     string                `json:"description"`
	Prompt          string                `json:"prompt"`
	ModelName       string                `json:"model_name"`
	Components      []previewComponentRef `json:"components"`
	TargetHarnesses []string              `json:"target_harnesses"`
}

// validatePreviewBody mirrors the request-model limits and literal patterns.
func validatePreviewBody(body *previewBody) []map[string]any {
	errs := []map[string]any{}
	tooLong := func(loc []any, value string, limit int) {
		if len(value) > limit {
			errs = append(errs, map[string]any{
				"type": "string_too_long", "loc": loc,
				"msg": fmt.Sprintf("String should have at most %d characters", limit),
				"ctx": map[string]any{"max_length": limit},
			})
		}
	}
	tooLong([]any{"body", "name"}, body.Name, previewMaxNameLen)
	tooLong([]any{"body", "description"}, body.Description, 1000)
	tooLong([]any{"body", "prompt"}, body.Prompt, previewMaxPromptLen)
	tooLong([]any{"body", "model_name"}, body.ModelName, 100)
	if len(body.Components) > previewMaxComponents {
		echo := make([]map[string]any, 0, len(body.Components))
		for _, c := range body.Components {
			echo = append(echo, map[string]any{"component_type": c.ComponentType, "component_id": c.ComponentID})
		}
		errs = append(errs, map[string]any{
			"type": "too_long", "loc": []any{"body", "components"},
			"msg":   fmt.Sprintf("List should have at most %d items after validation, not %d", previewMaxComponents, len(body.Components)),
			"input": echo,
			"ctx":   map[string]any{"field_type": "List", "max_length": previewMaxComponents, "actual_length": len(body.Components)},
		})
	}
	if len(body.TargetHarnesses) > 9 {
		errs = append(errs, map[string]any{
			"type": "too_long", "loc": []any{"body", "target_harnesses"},
			"msg":   fmt.Sprintf("List should have at most 9 items after validation, not %d", len(body.TargetHarnesses)),
			"input": body.TargetHarnesses,
			"ctx":   map[string]any{"field_type": "List", "max_length": 9, "actual_length": len(body.TargetHarnesses)},
		})
	}
	const pattern = "^(mcp|skill|hook|prompt)$"
	for i, c := range body.Components {
		switch c.ComponentType {
		case "mcp", "skill", "hook", "prompt":
		default:
			errs = append(errs, map[string]any{
				"type": "string_pattern_mismatch", "loc": []any{"body", "components", i, "component_type"},
				"msg": "String should match pattern '" + pattern + "'", "input": c.ComponentType,
				"ctx": map[string]any{"pattern": pattern},
			})
		}
		if _, err := uuid.Parse(c.ComponentID); err != nil {
			errs = append(errs, map[string]any{
				"type": "uuid_parsing", "loc": []any{"body", "components", i, "component_id"},
				"msg":   "Input should be a valid UUID, " + uuidErrorHint(c.ComponentID),
				"input": c.ComponentID,
			})
		}
	}
	return errs
}

func uuidErrorHint(value string) string {
	if len(value) != 36 {
		return fmt.Sprintf("invalid length: expected length 32 for simple format, found %d", len(value))
	}
	return "invalid character: expected an optional prefix of `urn:uuid:` followed by [0-9a-fA-F-], found `" + value[:1] + "` at 1"
}

// previewListings loads one family's listings for preview, applying the same
// visibility rules as every other read path: privacy scope, then approved
// status unless the caller owns the listing or reviews for the deployment.
func (s *Store) previewListings(ctx context.Context, familyName string, ids []string,
	viewer *registry.Viewer) (map[string]harnessgen.Listing, error) {
	if len(ids) == 0 {
		return map[string]harnessgen.Listing{}, nil
	}
	f := registry.Families[familyName+"s"]
	args := []any{}
	visibility := registry.ScopeSQL("l", "l.submitted_by", viewer, &args)
	args = append(args, ids)
	sql := fmt.Sprintf(`SELECT %s, l.submitted_by::text AS submitted_by, l.co_authors
		FROM %s l LEFT JOIN %s v ON l.latest_version_id = v.id
		WHERE %s AND l.id = ANY($%d)`,
		familyInstallColumns(familyName), f.ListingTable, f.VersionTable, visibility, len(args))
	rows, err := s.DB.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	collected := registry.CollectRows(rows)
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	privileged := tenancy.IsGlobalReviewer(viewer.Role)
	out := map[string]harnessgen.Listing{}
	for _, row := range collected {
		visible := rowStr(row, "status", "") == "approved" || privileged ||
			rowStr(row, "submitted_by", "") == viewer.ID.String()
		if !visible {
			for _, co := range rowList(row, "co_authors") {
				if s, ok := co.(string); ok && s == viewer.ID.String() {
					visible = true
					break
				}
			}
		}
		if visible {
			out[rowStr(row, "id", "")] = harnessgen.Listing(row)
		}
	}
	return out, nil
}

// previewConfig renders full harness configs for a composition that is not
// persisted, so the builder can show what an install would write.
func (h *Handler) previewConfig() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			httpapi.WriteError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
		var body previewBody
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &body); err != nil {
				httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []map[string]any{{"type": "model_attributes_type", "loc": []any{"body"},
					"msg": "Input should be a valid dictionary or object to extract fields from"}})
				return
			}
		}
		if errs := validatePreviewBody(&body); len(errs) > 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, errs)
			return
		}
		viewer := viewerFrom(r)
		if viewer == nil {
			httpapi.WriteError(w, http.StatusUnauthorized, "Missing credentials")
			return
		}

		reg := harness.MustLoad()
		valid := map[string]bool{}
		for _, name := range reg.Names() {
			valid[name] = true
		}
		targets := []string{}
		for _, name := range body.TargetHarnesses {
			if valid[name] {
				targets = append(targets, name)
			}
		}
		if len(targets) == 0 {
			targets = reg.Names()
		}

		byType := map[string][]string{}
		for _, c := range body.Components {
			byType[c.ComponentType] = append(byType[c.ComponentType], c.ComponentID)
		}
		families := map[string]map[string]harnessgen.Listing{}
		for _, familyName := range []string{"mcp", "skill", "hook", "prompt"} {
			listings, err := h.Store.previewListings(r.Context(), familyName, byType[familyName], viewer)
			if err != nil {
				httpapi.WriteInternalError(w, r, err)
				return
			}
			families[familyName] = listings
		}

		// A component the caller cannot see reads the same as one that does
		// not exist, so this is not an existence oracle for private listings.
		missing := []string{}
		for _, c := range body.Components {
			if _, ok := families[c.ComponentType][c.ComponentID]; !ok {
				missing = append(missing, c.ComponentID)
			}
		}
		if len(missing) > 0 {
			sort.Strings(missing)
			httpapi.WriteError(w, http.StatusNotFound, "Component not found: "+strings.Join(missing, ", "))
			return
		}

		nameMap := map[string]string{}
		for _, listings := range families {
			for id, listing := range listings {
				if n, ok := listing["name"].(string); ok {
					nameMap[id] = n
				}
			}
		}
		name := body.Name
		if name == "" {
			name = "untitled"
		}
		genComponents := make([]harnessgen.ComponentLink, 0, len(body.Components))
		for i, c := range body.Components {
			genComponents = append(genComponents, harnessgen.ComponentLink{
				Type: c.ComponentType, ID: c.ComponentID, OrderIndex: int64(i),
			})
		}
		genAgent := &harnessgen.Agent{
			ID:          uuid.NewString(),
			Name:        name,
			Description: body.Description,
			Prompt:      body.Prompt,
			ModelName:   body.ModelName,
			Components:  genComponents,
		}

		configs := map[string]map[string]string{}
		for _, harnessName := range targets {
			cfg, err := harnessgen.Generate(&harnessgen.Request{
				Agent:          genAgent,
				Harness:        harnessName,
				CaracalURL:     "https://caracal.example",
				McpListings:    families["mcp"],
				SkillListings:  families["skill"],
				HookListings:   families["hook"],
				PromptListings: families["prompt"],
				ComponentNames: nameMap,
				ResolvedModel:  harnessgen.PreviewModel(harnessName, body.ModelName),
			})
			if err != nil {
				continue
			}
			files := previewFiles(cfg)
			if len(files) > 0 {
				configs[harnessName] = files
			}
		}
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{"configs": configs})
	})
}

// previewFiles flattens one generated config into path -> file content.
func previewFiles(cfg *harnessgen.Config) map[string]string {
	files := map[string]string{}
	addEntry := func(v any) {
		entry, ok := v.(map[string]any)
		if !ok {
			return
		}
		path, ok := entry["path"].(string)
		if !ok || path == "" {
			return
		}
		files[path] = fileContent(entry["content"])
	}
	if v, ok := cfg.Get("agent_profile"); ok {
		addEntry(v)
	}
	if v, ok := cfg.Get("mcp_config"); ok {
		addEntry(v)
	}
	if v, ok := cfg.Get("hooks_config"); ok {
		addEntry(v)
	}
	if v, ok := cfg.Get("skills"); ok {
		if entries, ok := v.([]any); ok {
			for _, e := range entries {
				addEntry(e)
			}
		}
	}
	return files
}

// fileContent renders dict contents the way the wire always has: two-space
// indented JSON; strings pass through.
func fileContent(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	blob, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return ""
	}
	return string(blob)
}
