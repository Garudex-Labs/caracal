// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/spf13/cobra"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
	"github.com/garudex-labs/caracal/internal/cli/ref"
	harnessdata "github.com/garudex-labs/caracal/packages/harness-data"
)

// ── registry models ────────────────────────────────────────────────

type modelCatalogFile struct {
	Harness string            `json:"harness"`
	Models  []json.RawMessage `json:"models"`
}

type modelRowFields struct {
	ID    string `json:"id"`
	Kind  string `json:"kind"`
	Label string `json:"label"`
}

// mergedModelRows returns each catalog row with harness, model_id, and
// display_name appended, preserving the row's own key order.
func mergedModelRows(harness string) ([]json.RawMessage, []modelRowFields, *clierr.Error) {
	entries, err := harnessdata.ModelsFS.ReadDir("harness_models")
	if err != nil {
		return nil, nil, &clierr.Error{Category: clierr.Unexpected, Message: err.Error(), Operation: "List harness models"}
	}
	catalogs := map[string]modelCatalogFile{}
	names := []string{}
	for _, entry := range entries {
		blob, err := harnessdata.ModelsFS.ReadFile("harness_models/" + entry.Name())
		if err != nil {
			return nil, nil, &clierr.Error{Category: clierr.Unexpected, Message: err.Error(), Operation: "List harness models"}
		}
		var catalog modelCatalogFile
		if err := json.Unmarshal(blob, &catalog); err != nil {
			return nil, nil, &clierr.Error{Category: clierr.Unexpected, Message: err.Error(), Operation: "List harness models"}
		}
		catalogs[catalog.Harness] = catalog
		names = append(names, catalog.Harness)
	}
	sort.Strings(names)
	selected := names
	if harness != "" {
		if _, ok := catalogs[harness]; !ok {
			return nil, nil, usageError("registry models",
				fmt.Sprintf("Invalid value for harness: Unknown harness '%s'. Valid harnesses: %s", harness, strings.Join(names, ", ")))
		}
		selected = []string{harness}
	}
	rows := []json.RawMessage{}
	fields := []modelRowFields{}
	for _, name := range selected {
		catalog := catalogs[name]
		for _, raw := range catalog.Models {
			var row modelRowFields
			if err := json.Unmarshal(raw, &row); err != nil {
				continue
			}
			display := row.Label
			if display == "" {
				display = row.ID
			}
			trimmed := bytes.TrimRight(raw, " \n\t")
			trimmed = bytes.TrimSuffix(trimmed, []byte("}"))
			suffix := fmt.Sprintf(`, "harness": %s, "model_id": %s, "display_name": %s}`,
				jsonString(catalog.Harness), jsonString(row.ID), jsonString(display))
			merged := append(append([]byte{}, trimmed...), []byte(suffix)...)
			rows = append(rows, json.RawMessage(merged))
			fields = append(fields, modelRowFields{ID: row.ID, Kind: row.Kind, Label: display})
		}
	}
	return rows, fields, nil
}

func jsonString(s string) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	return strings.TrimRight(buf.String(), "\n")
}

func emitModels(harness, mode string) error {
	rows, fields, cerr := mergedModelRows(harness)
	if cerr != nil {
		return cerr
	}
	if mode == "json" {
		var doc bytes.Buffer
		doc.WriteString(`{"models": [`)
		for i, row := range rows {
			if i > 0 {
				doc.WriteString(", ")
			}
			doc.Write(row)
		}
		doc.WriteString(`], "source": "harness-registry", "degraded": false}`)
		outputJSONRaw(doc.Bytes())
		return nil
	}
	for _, row := range fields {
		kind := row.Kind
		if kind == "" {
			kind = "exact"
		}
		fmt.Printf("%s\t%s\t%s\n", row.ID, kind, row.Label)
	}
	fmt.Printf("source: harness-registry, count: %d\n", len(rows))
	return nil
}

func modelsGroup() *cobra.Command {
	group := &cobra.Command{Use: "models", Short: "Inspect registry-backed harness model data", Args: cobra.NoArgs}
	harness := group.Flags().String("harness", "", "Filter to one harness.")
	mode := outputFlag(group)
	group.RunE = func(_ *cobra.Command, _ []string) error { return emitModels(*harness, *mode) }

	list := &cobra.Command{Use: "list", Short: "List registry-backed harness models", Args: cobra.NoArgs}
	listHarness := list.Flags().String("harness", "", "Filter to one harness.")
	listMode := outputFlag(list)
	list.RunE = func(_ *cobra.Command, _ []string) error { return emitModels(*listHarness, *listMode) }
	group.AddCommand(list)
	return group
}

// ── registry recommend ─────────────────────────────────────────────

var recommendTypePlural = map[string]string{
	"mcp": "mcps", "skill": "skills", "hook": "hooks", "prompt": "prompts", "sandbox": "sandboxes",
}

func normalizeRecommendType(raw, operation string) (string, *clierr.Error) {
	value := strings.ToLower(strings.TrimSpace(raw))
	if _, ok := recommendTypePlural[value]; ok {
		return value, nil
	}
	for singular, plural := range recommendTypePlural {
		if value == plural {
			return singular, nil
		}
	}
	return "", &clierr.Error{
		Category: clierr.Validation, Message: fmt.Sprintf("Unknown component type: %s.", raw),
		Operation: operation, Resource: "component type",
		Remediation: "Choose one of: hook, mcp, prompt, sandbox, skill.",
	}
}

func emitRecommendations(limit int, typeFlag string, refresh bool, mode string) error {
	if limit < 1 || limit > 24 {
		return usageError("registry recommend",
			fmt.Sprintf("Invalid value for '--limit' / '-n': %d is not in the range 1<=x<=24.", limit))
	}
	params := map[string]string{"limit": fmt.Sprint(limit)}
	if typeFlag != "" {
		normalized, cerr := normalizeRecommendType(typeFlag, "List registry recommendations")
		if cerr != nil {
			return cerr
		}
		params["type"] = normalized
	}
	if refresh {
		params["refresh"] = "true"
	}
	client, cerr := newClient()
	if cerr != nil {
		return cerr
	}
	raw, cerr := client.Do("GET", "/api/v1/recommendations/me", params, nil,
		"List recommendations", "registry recommendations")
	if cerr != nil {
		return cerr
	}
	if mode == "json" {
		outputJSONRaw(raw)
		return nil
	}
	printDocumentSummary(raw)
	return nil
}

func recommendGroup() *cobra.Command {
	group := &cobra.Command{Use: "recommend", Short: "Components recommended for you, based on your own sessions", Args: cobra.NoArgs}
	limit := group.Flags().IntP("limit", "n", 8, "How many to return")
	typeFlag := group.Flags().StringP("type", "t", "", "Restrict to one component type")
	refresh := group.Flags().Bool("refresh", false, "Recompute your profile instead of using the cache")
	mode := outputFlag(group)
	group.RunE = func(_ *cobra.Command, _ []string) error {
		return emitRecommendations(*limit, *typeFlag, *refresh, *mode)
	}

	list := &cobra.Command{Use: "list", Short: "Show components recommended for you", Args: cobra.NoArgs}
	listLimit := list.Flags().IntP("limit", "n", 8, "How many to return")
	listType := list.Flags().StringP("type", "t", "", "Restrict to one component type")
	listRefresh := list.Flags().Bool("refresh", false, "Recompute your profile instead of using the cache")
	listMode := outputFlag(list)
	list.RunE = func(_ *cobra.Command, _ []string) error {
		return emitRecommendations(*listLimit, *listType, *listRefresh, *listMode)
	}

	dismiss := &cobra.Command{Use: "dismiss TYPE REFERENCE", Short: "Stop recommending a component to you", Args: cobra.ExactArgs(2)}
	action := dismiss.Flags().StringP("action", "a", "dismissed", "Feedback to record: dismissed, not_relevant, installed")
	dismissMode := outputFlag(dismiss)
	dismiss.RunE = func(_ *cobra.Command, args []string) error {
		normalized, cerr := normalizeRecommendType(args[0], "Update recommendation feedback")
		if cerr != nil {
			return cerr
		}
		if *action != "dismissed" && *action != "not_relevant" && *action != "installed" {
			return &clierr.Error{
				Category: clierr.Validation, Message: fmt.Sprintf("Unknown recommendation action: %s.", *action),
				Operation: "Update recommendation feedback", Resource: "action",
				Remediation: "Choose one of: dismissed, not_relevant, installed.",
			}
		}
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		componentID, cerr := ref.ResolveRegistryReference(client, normalized, args[1], "Update recommendation feedback", "registry recommendations")
		if cerr != nil {
			return cerr
		}
		body := fmt.Sprintf(`{"component_type": %s, "component_id": %s, "action": %s}`,
			jsonString(normalized), jsonString(componentID), jsonString(*action))
		if _, cerr := client.Do("POST", "/api/v1/recommendations/feedback", nil,
			json.RawMessage(body), "Update recommendation feedback", "registry recommendations"); cerr != nil {
			return cerr
		}
		result := body
		if *dismissMode == "json" {
			outputJSONRaw([]byte(result))
			return nil
		}
		if *action == "installed" {
			fmt.Printf("Marked %s %s as installed.\n", normalized, args[1])
		} else {
			fmt.Printf("%s %s will no longer be recommended to you.\n", normalized, args[1])
		}
		return nil
	}

	group.AddCommand(list, dismiss)
	return group
}

// ── prompt render ──────────────────────────────────────────────────

func promptRenderCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "render PROMPT_ID", Short: "Render a prompt template with variable substitution", Args: cobra.ExactArgs(1)}
	vars := cmd.Flags().StringArrayP("var", "v", nil, "Variable as key=value")
	mode := outputFlag(cmd)
	cmd.RunE = func(_ *cobra.Command, args []string) error {
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		resolved, cerr := ref.ResolveRegistryReference(client, "prompt", args[0], "Render prompt", "prompt registry")
		if cerr != nil {
			return cerr
		}
		var body bytes.Buffer
		body.WriteString(`{"variables": {`)
		for i, pair := range *vars {
			key, value, found := strings.Cut(pair, "=")
			if !found || strings.TrimSpace(key) == "" {
				return &clierr.Error{
					Category: clierr.Validation, Message: "Prompt variables must use key=value syntax.",
					Operation: "Render prompt", Resource: pair,
					Remediation: "Provide each variable as a non-empty key and value.",
				}
			}
			if i > 0 {
				body.WriteString(", ")
			}
			body.WriteString(jsonString(strings.TrimSpace(key)))
			body.WriteString(": ")
			body.WriteString(jsonString(strings.Trim(value, `"'`)))
		}
		body.WriteString("}}")
		raw, cerr := client.Do("POST", "/api/v1/prompts/"+resolved+"/render", nil,
			json.RawMessage(body.Bytes()), "Render prompt", "prompt registry")
		if cerr != nil {
			return cerr
		}
		if *mode == "json" {
			outputJSONRaw(raw)
			return nil
		}
		var result struct {
			Rendered string `json:"rendered"`
		}
		if json.Unmarshal(raw, &result) == nil && result.Rendered != "" {
			fmt.Println(result.Rendered)
		} else {
			outputJSONRaw(raw)
		}
		return nil
	}
	return cmd
}

// ── version publish ────────────────────────────────────────────────

// pep440Re mirrors the canonical public version-scheme pattern.
var pep440Re = regexp.MustCompile(`(?i)^\s*v?(?:(?:[0-9]+!)?[0-9]+(?:\.[0-9]+)*(?:[-_.]?(?:a|b|c|rc|alpha|beta|pre|preview)[-_.]?[0-9]*)?(?:(?:-[0-9]+)|(?:[-_.]?(?:post|rev|r)[-_.]?[0-9]*))?(?:[-_.]?dev[-_.]?[0-9]*)?)(?:\+[a-z0-9]+(?:[-_.][a-z0-9]+)*)?\s*$`)

func versionPublishCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "publish TYPE LISTING", Short: "Publish a new version for a registry component", Args: cobra.ExactArgs(2)}
	version := cmd.Flags().StringP("version", "v", "", "Version to publish (e.g. 1.2.0)")
	description := cmd.Flags().StringP("description", "d", "", "Short description of this version")
	changelog := cmd.Flags().String("changelog", "", "Changelog notes")
	harnesses := cmd.Flags().StringArray("harness", nil, "Supported harnesses (repeat for multiple)")
	extra := cmd.Flags().String("extra", "", "Extra JSON for type-specific fields")
	mode := outputFlag(cmd)
	cmd.RunE = func(c *cobra.Command, args []string) error {
		componentType := strings.ToLower(strings.TrimSpace(args[0]))
		if !contains([]string{"mcp", "skill", "hook", "prompt", "sandbox"}, componentType) {
			return &clierr.Error{
				Category: clierr.Validation, Message: fmt.Sprintf("Unknown component type: %s.", componentType),
				Operation: "Manage component version", Resource: "component type",
				Remediation: "Choose one of: hook, mcp, prompt, sandbox, skill.",
			}
		}
		if !c.Flags().Changed("description") {
			return usageError("registry version publish", "Missing option '--description' / '-d'.")
		}
		var extraDoc json.RawMessage
		if c.Flags().Changed("extra") {
			trimmed := strings.TrimSpace(*extra)
			var probe any
			if err := json.Unmarshal([]byte(trimmed), &probe); err != nil {
				return &clierr.Error{
					Category: clierr.Validation, Message: "The extra version metadata is not valid JSON.",
					Operation: "Publish component version", Resource: "extra metadata",
					Remediation: "Correct the JSON and retry.", Detail: err.Error(),
				}
			}
			if _, ok := probe.(map[string]any); !ok {
				return &clierr.Error{
					Category: clierr.Validation, Message: "The extra version metadata must be a JSON object.",
					Operation: "Publish component version", Resource: "extra metadata",
					Remediation: "Provide a JSON object and retry.",
				}
			}
			extraDoc = json.RawMessage(trimmed)
		}
		for _, name := range *harnesses {
			if !contains(validHarnesses, name) {
				return &clierr.Error{
					Category: clierr.Validation, Message: fmt.Sprintf("Unknown harness: %s.", name),
					Operation: "Publish component version", Resource: "supported harnesses",
					Remediation: "Choose from: " + strings.Join(validHarnesses, ", ") + ".",
				}
			}
		}
		plural := recommendTypePlural[componentType]
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		resolved, cerr := ref.ResolveRegistryReference(client, componentType, args[1], "Publish component version", "component versions")
		if cerr != nil {
			return cerr
		}
		versionValue := *version
		if *mode == "json" && versionValue == "" {
			return &clierr.Error{
				Category: clierr.Validation, Message: "JSON mode requires an explicit component version.",
				Operation: "Publish component version", Resource: args[1],
				Remediation: "Provide a version and retry.",
			}
		}
		if versionValue == "" {
			raw, cerr := client.Do("GET", "/api/v1/"+plural+"/"+resolved+"/version-suggestions", nil, nil,
				"Publish component version", "component versions")
			if cerr != nil {
				return cerr
			}
			var suggestions struct {
				Current     string            `json:"current"`
				Suggestions map[string]string `json:"suggestions"`
			}
			_ = json.Unmarshal(raw, &suggestions)
			fmt.Printf("Current: %s  patch→%s  minor→%s  major→%s\n", orDefault(suggestions.Current, "?"),
				orDefault(suggestions.Suggestions["patch"], "?"), orDefault(suggestions.Suggestions["minor"], "?"),
				orDefault(suggestions.Suggestions["major"], "?"))
			versionValue = textInput("Version", "")
		}
		if !pep440Re.MatchString(versionValue) {
			return &clierr.Error{
				Category: clierr.Validation, Message: "The component version is invalid.",
				Operation: "Publish component version", Resource: versionValue,
				Remediation: "Provide a valid version and retry.",
				Detail:      fmt.Sprintf("InvalidVersion(\"Invalid version: '%s'\")", versionValue),
			}
		}
		var body bytes.Buffer
		body.WriteString(`{"version": ` + jsonString(versionValue))
		body.WriteString(`, "description": ` + jsonString(*description))
		if c.Flags().Changed("changelog") {
			body.WriteString(`, "changelog": ` + jsonString(*changelog))
		}
		if len(*harnesses) > 0 {
			parts := make([]string, len(*harnesses))
			for i, name := range *harnesses {
				parts[i] = jsonString(name)
			}
			body.WriteString(`, "supported_harnesses": [` + strings.Join(parts, ", ") + `]`)
		}
		if extraDoc != nil {
			body.WriteString(`, "extra": ` + string(extraDoc))
		}
		body.WriteString("}")
		raw, cerr := client.Do("POST", "/api/v1/"+plural+"/"+resolved+"/versions", nil,
			json.RawMessage(body.Bytes()), "Publish component version", "component versions")
		if cerr != nil {
			return cerr
		}
		if *mode == "json" {
			outputJSONRaw(raw)
			return nil
		}
		var result struct {
			Version string `json:"version"`
			Status  string `json:"status"`
		}
		_ = json.Unmarshal(raw, &result)
		fmt.Printf("Version %s submitted for review!  Status: %s\n",
			orDefault(result.Version, versionValue), orDefault(result.Status, "pending"))
		return nil
	}
	return cmd
}

func orDefault(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func usageError(command, message string) *clierr.Error {
	return &clierr.Error{
		Category:    clierr.Usage,
		Message:     message,
		Operation:   "Run caracal " + command,
		Remediation: "Run caracal " + command + " --help for valid usage.",
	}
}
