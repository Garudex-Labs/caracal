// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"

	"github.com/garudex-labs/caracal/internal/harnessgen"
	"github.com/garudex-labs/caracal/internal/httpapi"
)

// archivedInstallWarning matches the shared archive warning line.
func archivedInstallWarning(itemType, name string) string {
	return fmt.Sprintf("Archived %s '%s' is deprecated and may be removed from future agent pulls.", itemType, name)
}

// resolveInstallable applies the install gate: approved listings for anyone
// visible, archived or owned listings as fallback.
func (s *Store) resolveInstallable(ctx context.Context, f Family, identifier string, viewer *Viewer) (map[string]any, error) {
	row, err := s.Resolve(ctx, f, identifier, viewer, true)
	if err != nil {
		return nil, err
	}
	if row == nil {
		row, err = s.Resolve(ctx, f, identifier, viewer, false)
		if err != nil {
			return nil, err
		}
		if row == nil || (rowStr(row, "status", "draft") != "archived" && rowPermission(row, viewer) != "owner") {
			return nil, &apiError{Status: 404, Detail: "Listing not found or not approved"}
		}
	}
	return row, nil
}

// recordDownload notes the install and bumps the latest version's counter.
func (s *Store) recordDownload(ctx context.Context, f Family, row map[string]any, viewer *Viewer, harnessName string) error {
	listingID := rowStr(row, "id", "")
	if _, err := s.DB.Exec(ctx, fmt.Sprintf(
		`INSERT INTO %s_downloads (id, listing_id, user_id, harness, downloaded_at)
		 VALUES (gen_random_uuid(), $1, $2, $3, now())`, f.Name), listingID, viewer.ID, harnessName); err != nil {
		return err
	}
	if latest := rowNStr(row, "latest_version_id"); latest != nil {
		if _, err := s.DB.Exec(ctx, fmt.Sprintf(
			`UPDATE %s SET download_count = download_count + 1 WHERE id = $1`, f.VersionTable), *latest); err != nil {
			return err
		}
	}
	return nil
}

// serverURL derives the public API endpoint for generated telemetry hooks.
func (h *Handler) serverURL(ctx context.Context, r *http.Request) string {
	if h.Mirror != nil && h.Mirror.Settings != nil {
		if configured := h.Mirror.Settings.String(ctx, "deployment.public_url", ""); configured != "" {
			return strings.TrimRight(configured, "/")
		}
	}
	if r != nil && r.Host != "" {
		scheme := r.Header.Get("X-Forwarded-Proto")
		if scheme == "" {
			scheme = "http"
		}
		return scheme + "://" + r.Host
	}
	return "http://localhost:8080"
}

// installBody is the shared install request body.
type installBody struct {
	Harness      string
	LocalName    string
	EnvValues    map[string]string
	HeaderValues map[string]string
	Version      string
	Scope        string
	Platform     string
}

func parseInstallBody(raw map[string]any, errs *[]fieldError) installBody {
	body := installBody{Scope: "project", EnvValues: map[string]string{}, HeaderValues: map[string]string{}}
	harnessVal, ok := raw["harness"].(string)
	if !ok || raw["harness"] == nil {
		if _, present := raw["harness"]; !present {
			// pydantic reports the enclosing object as the missing field's input
			*errs = append(*errs, fieldError{Type: "missing", Loc: []string{"body", "harness"}, Msg: "Field required", Input: raw})
		} else {
			*errs = append(*errs, fieldError{Type: "string_type", Loc: []string{"body", "harness"}, Msg: "Input should be a valid string", Input: raw["harness"]})
		}
	} else {
		body.Harness = harnessVal
	}
	if v, ok := raw["local_name"].(string); ok {
		body.LocalName = v
	}
	if v, ok := raw["version"].(string); ok {
		body.Version = v
	}
	if v, ok := raw["scope"].(string); ok {
		body.Scope = v
	}
	if v, ok := raw["platform"].(string); ok {
		body.Platform = v
	}
	for key, target := range map[string]map[string]string{"env_values": body.EnvValues, "header_values": body.HeaderValues} {
		if m, ok := raw[key].(map[string]any); ok {
			for k, v := range m {
				if sv, ok := v.(string); ok {
					target[k] = sv
				}
			}
		}
	}
	return body
}

// installResponse is the common wire shape; hooks extend it.
type installResponse struct {
	ListingID     string         `json:"listing_id"`
	Harness       string         `json:"harness"`
	ConfigSnippet map[string]any `json:"config_snippet"`
	Warnings      []string       `json:"warnings"`
}

// InstallMcp renders the MCP config snippet and records the download.
func (s *Store) InstallMcp(ctx context.Context, identifier string, body installBody, viewer *Viewer) (*installResponse, error) {
	f := Families["mcps"]
	row, err := s.resolveInstallable(ctx, f, identifier, viewer)
	if err != nil {
		return nil, err
	}
	warnings := []string{}
	if rowStr(row, "status", "") == "archived" {
		warnings = append(warnings, archivedInstallWarning("MCP", rowStr(row, "name", "")))
	}
	if setup := rowNStr(row, "setup_instructions"); setup != nil && *setup != "" {
		warnings = append(warnings, fmt.Sprintf("MCP '%s' requires local setup before use:\n%s", rowStr(row, "name", ""), *setup))
	}
	if err := s.recordDownload(ctx, f, row, viewer, body.Harness); err != nil {
		return nil, err
	}

	envNames := []string{}
	for _, item := range rowList(row, "environment_variables") {
		if entry, ok := item.(map[string]any); ok {
			if name, ok := entry["name"].(string); ok && name != "" {
				envNames = append(envNames, name)
			}
		}
	}
	args := []string{}
	for _, a := range rowList(row, "args") {
		if sv, ok := a.(string); ok {
			args = append(args, sv)
		}
	}
	slug := rowStr(row, "slug", "")
	if slug == "" {
		slug = rowStr(row, "name", "")
	}
	command := rowNStr(row, "command")
	in := harnessgen.McpSnippetInput{
		LocalName:    body.LocalName,
		Slug:         slug,
		Framework:    rowStr(row, "framework", ""),
		DockerImage:  rowStr(row, "docker_image", ""),
		HasCommand:   command != nil,
		Args:         args,
		EnvVarNames:  envNames,
		EnvValues:    body.EnvValues,
		HeaderValues: body.HeaderValues,
		Transport:    rowStr(row, "transport", ""),
		URL:          rowStr(row, "url", ""),
		AutoApprove:  rowList(row, "auto_approve"),
	}
	if command != nil {
		in.Command = *command
	}
	snippet, err := harnessgen.McpInstallSnippet(body.Harness, in)
	if err != nil {
		return nil, &apiError{Status: 500, Detail: err.Error()}
	}
	return &installResponse{
		ListingID:     rowStr(row, "id", ""),
		Harness:       body.Harness,
		ConfigSnippet: snippet,
		Warnings:      warnings,
	}, nil
}

// skillSourceColumns are the version fields feeding the skill config.
const skillSourceColumns = `version, description, slash_command, git_url, skill_path, git_ref,
	skill_md_content, delivery_mode, script_content, script_filename`

// InstallSkill renders the skill telemetry-and-file snippet.
func (s *Store) InstallSkill(ctx context.Context, identifier string, body installBody, viewer *Viewer, serverURL string) (*installResponse, error) {
	f := Families["skills"]
	row, err := s.resolveInstallable(ctx, f, identifier, viewer)
	if err != nil {
		return nil, err
	}
	warnings := []string{}
	if rowStr(row, "status", "") == "archived" {
		warnings = append(warnings, archivedInstallWarning("skill", rowStr(row, "name", "")))
	}

	listingID := rowStr(row, "id", "")
	var source map[string]any
	if body.Version != "" {
		rows, err := s.DB.Query(ctx,
			`SELECT `+skillSourceColumns+` FROM skill_versions
			 WHERE listing_id = $1 AND version = $2 AND status::text IN ($3, $4) LIMIT 1`,
			listingID, body.Version, "approved", rowStr(row, "status", ""))
		if err != nil {
			return nil, err
		}
		matches := collectRows(rows)
		rows.Close()
		if len(matches) == 0 {
			return nil, &apiError{Status: 404, Detail: fmt.Sprintf("Version '%s' not found for this skill", body.Version)}
		}
		source = matches[0]
	} else if latest := rowNStr(row, "latest_version_id"); latest != nil {
		rows, err := s.DB.Query(ctx, `SELECT `+skillSourceColumns+` FROM skill_versions WHERE id = $1`, *latest)
		if err != nil {
			return nil, err
		}
		matches := collectRows(rows)
		rows.Close()
		if len(matches) > 0 {
			source = matches[0]
		}
	}
	if source == nil {
		source = map[string]any{}
	}

	if err := s.recordDownload(ctx, f, row, viewer, body.Harness); err != nil {
		return nil, err
	}

	skillName := harnessgen.SanitizeComponentName(firstNonEmpty(body.LocalName, rowStr(row, "slug", ""), rowStr(row, "name", "")))
	hookEntry := map[string]any{
		"type": "http",
		"url":  serverURL + "/api/v1/telemetry/hooks",
		"headers": map[string]any{
			"Authorization":      "Bearer $CARACAL_ACCESS_TOKEN",
			"X-Caracal-Skill-Id": listingID,
		},
		"timeout": 10,
	}
	for k, v := range harnessgen.SkillHookExtra(body.Harness) {
		hookEntry[k] = v
	}
	matcherEntry := []any{map[string]any{"matcher": "*", "hooks": []any{hookEntry}}}

	skillInfo := map[string]any{"name": skillName, "id": listingID}
	for _, key := range []string{"git_url", "skill_path", "git_ref"} {
		if v := rowStr(source, key, ""); v != "" {
			skillInfo[key] = v
		}
	}
	if content := rowStr(source, "skill_md_content", ""); content != "" {
		if _, aerr := analyzeSkillMD(content, rowStr(row, "slash_command", "")); aerr != nil {
			return nil, &apiError{Status: 400, Detail: aerr.Detail}
		}
		skillInfo["skill_md_content"] = content
	}
	delivery := rowStr(source, "delivery_mode", "")
	if delivery == "" {
		delivery = "git_fetch"
	}
	skillInfo["delivery_mode"] = delivery
	if delivery == "registry_direct" {
		if v := rowStr(source, "script_content", ""); v != "" {
			skillInfo["script_content"] = v
		}
		if v := rowStr(source, "script_filename", ""); v != "" {
			skillInfo["script_filename"] = v
		}
	}
	if body.Version != "" {
		skillInfo["version"] = rowStr(source, "version", "")
		skillInfo["latest_version"] = row["version"]
	}

	config := map[string]any{
		"hooks":      map[string]any{"SessionStart": matcherEntry, "SessionEnd": matcherEntry},
		"skill":      skillInfo,
		"harness":    body.Harness,
		"ide":        body.Harness,
		"listing_id": listingID,
	}

	// Harness skill file: verbatim SKILL.md when stored, else a stub.
	fileName := harnessgen.SanitizeComponentName(rowStr(row, "name", "skill"))
	if content := rowStr(source, "skill_md_content", ""); content != "" {
		if path := harnessgen.SkillFilePath(body.Harness, body.Scope, fileName); path != "" {
			config["skills"] = map[string]any{"path": path, "content": content}
		}
	} else {
		desc := rowStr(source, "description", "")
		if desc == "" {
			desc = rowStr(row, "description", "")
		}
		if file := harnessgen.SkillInstallFile(body.Harness, body.Scope, fileName,
			shortDescription(desc), desc, rowStr(row, "slash_command", "")); file != nil {
			config["skills"] = file
		}
	}
	return &installResponse{
		ListingID:     listingID,
		Harness:       body.Harness,
		ConfigSnippet: config,
		Warnings:      warnings,
	}, nil
}

// hookInstallResponse extends the shared shape with file delivery data.
type hookInstallResponse struct {
	ListingID     string           `json:"listing_id"`
	Harness       string           `json:"harness"`
	ConfigSnippet map[string]any   `json:"config_snippet"`
	ConfigPath    string           `json:"config_path"`
	Files         []map[string]any `json:"files"`
	Requirements  []any            `json:"requirements"`
	SourceFetch   map[string]any   `json:"source_fetch"`
	Notes         []string         `json:"notes"`
	Warnings      []string         `json:"warnings"`
}

// hookSourceColumns are the version fields feeding the hook install config.
const hookSourceColumns = `event, handler_type, handler_config, script_content, script_filename,
	source_url, source_path, source_ref, resolved_sha, requirements`

// InstallHook renders the hook install bundle.
func (s *Store) InstallHook(ctx context.Context, identifier string, body installBody, viewer *Viewer) (*hookInstallResponse, error) {
	f := Families["hooks"]
	row, err := s.resolveInstallable(ctx, f, identifier, viewer)
	if err != nil {
		return nil, err
	}
	warnings := []string{}
	if rowStr(row, "status", "") == "archived" {
		warnings = append(warnings, archivedInstallWarning("hook", rowStr(row, "name", "")))
	}
	listingID := rowStr(row, "id", "")

	source := map[string]any{}
	if latest := rowNStr(row, "latest_version_id"); latest != nil {
		rows, err := s.DB.Query(ctx, `SELECT `+hookSourceColumns+` FROM hook_versions WHERE id = $1`, *latest)
		if err != nil {
			return nil, err
		}
		matches := collectRows(rows)
		rows.Close()
		if len(matches) > 0 {
			source = matches[0]
		}
	}

	if err := s.recordDownload(ctx, f, row, viewer, body.Harness); err != nil {
		return nil, err
	}

	resp := &hookInstallResponse{
		ListingID:     listingID,
		Harness:       body.Harness,
		ConfigSnippet: map[string]any{},
		Files:         []map[string]any{},
		Requirements:  []any{},
		Notes:         []string{},
		Warnings:      warnings,
	}
	hookName := harnessgen.SanitizeComponentName(firstNonEmpty(body.LocalName, rowStr(row, "slug", ""), rowStr(row, "name", "")))
	spec, known := harnessgen.HarnessSpec(body.Harness)
	if !known {
		resp.Notes = []string{fmt.Sprintf("harness '%s' is not recognized. Supported: %s",
			body.Harness, strings.Join(harnessgen.RegistryHarnessNames(), ", "))}
		return resp, nil
	}

	event := rowStr(source, "event", "")
	ideEvent := spec.HookEventsMap[event]
	if ideEvent == "" {
		supported := []string{}
		for k, v := range spec.HookEventsMap {
			if v != "" {
				supported = append(supported, k)
			}
		}
		sort.Strings(supported)
		resp.Notes = []string{
			fmt.Sprintf("Event '%s' is not supported by %s.", event, spec.DisplayName),
			"Supported events: " + strings.Join(supported, ", "),
		}
		return resp, nil
	}

	handlerConfig := rowDict(source, "handler_config")
	command, _ := handlerConfig["command"].(string)

	if spec.HookType == "plugin" {
		resp.ConfigSnippet = map[string]any{
			"_manual_setup": true,
			"_instructions": []string{
				"OpenCode uses a plugin system for hooks.",
				fmt.Sprintf("Create a plugin file in .opencode/plugins/%s.ts", hookName),
				fmt.Sprintf("Register the '%s' event handler.", ideEvent),
				"Command to execute: " + command,
			},
			"event":   ideEvent,
			"command": command,
		}
		resp.ConfigPath = fmt.Sprintf(".opencode/plugins/%s.ts", hookName)
		resp.Requirements = rowList(source, "requirements")
		resp.Notes = []string{"OpenCode requires a TypeScript plugin. See https://opencode.ai/docs/plugins/ for the plugin API."}
		return resp, nil
	}

	handlerType := rowStr(source, "handler_type", "command")
	if handlerType == "" {
		handlerType = "command"
	}
	timeout := 0
	if t, ok := handlerConfig["timeout"].(float64); ok {
		timeout = int(t)
	}
	scriptContent := rowStr(source, "script_content", "")
	scriptFilename := rowStr(source, "script_filename", "")
	actualCommand := command
	if scriptContent != "" && scriptFilename != "" {
		scriptPath := spec.HookScriptsDir + "/" + scriptFilename
		actualCommand = scriptPath
		resp.Files = append(resp.Files, map[string]any{
			"path":       scriptPath,
			"content":    scriptContent,
			"executable": true,
		})
	}
	sourceURL := rowStr(source, "source_url", "")
	sourcePath := rowStr(source, "source_path", "")
	if sourceURL != "" && sourcePath != "" && scriptContent == "" {
		ref := rowStr(source, "source_ref", "")
		if ref == "" {
			ref = "main"
		}
		resp.SourceFetch = map[string]any{
			"url":        sourceURL,
			"path":       sourcePath,
			"ref":        ref,
			"sha":        source["resolved_sha"],
			"target_dir": spec.HookScriptsDir + "/" + hookName,
		}
		actualCommand = fmt.Sprintf("%s/%s/%s", spec.HookScriptsDir, hookName, command)
	}
	resp.ConfigSnippet = harnessgen.HookInstallSnippet(body.Harness, ideEvent, handlerType, actualCommand, timeout)
	if len(spec.Hooks) > 0 {
		configPath := spec.Hooks["project"]
		if configPath == "" {
			configPath = spec.Hooks["user"]
		}
		resp.ConfigPath = strings.ReplaceAll(configPath, "{name}", hookName)
	}
	resp.Requirements = rowList(source, "requirements")
	resp.Notes = harnessgen.HookInstallNotes(body.Harness)
	return resp, nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// shortDescription extracts a one-line summary from a description.
func shortDescription(desc string) string {
	if desc == "" {
		return ""
	}
	firstLine := strings.TrimSpace(strings.SplitN(desc, "\n", 2)[0])
	firstLine = strings.TrimLeft(firstLine, "#")
	firstLine = strings.TrimLeft(firstLine, " ")
	if len(firstLine) <= 200 {
		return firstLine
	}
	sentence, _, _ := strings.Cut(firstLine, ".")
	return strings.TrimSpace(sentence)
}

// install is the shared handler for the three installable families.
func (h *Handler) install(family string) http.Handler {
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
		bodyMap := map[string]any{}
		if err := json.Unmarshal(raw, &bodyMap); err != nil {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
				{Type: "json_invalid", Loc: []string{"body", "0"}, Msg: "JSON decode error", Input: map[string]any{}},
			})
			return
		}
		errs := []fieldError{}
		body := parseInstallBody(bodyMap, &errs)
		if len(errs) > 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, errs)
			return
		}
		identifier := r.PathValue("listing_id")
		var out any
		var serr error
		switch family {
		case "mcps":
			out, serr = h.Store.InstallMcp(r.Context(), identifier, body, viewer)
		case "skills":
			out, serr = h.Store.InstallSkill(r.Context(), identifier, body, viewer, h.serverURL(r.Context(), r))
		default:
			out, serr = h.Store.InstallHook(r.Context(), identifier, body, viewer)
		}
		if serr != nil {
			writeStoreError(w, r, serr)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, out)
	})
}
