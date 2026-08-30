// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
	"github.com/garudex-labs/caracal/internal/cli/config"
)

const bulkOp = "Bulk submit components"

var bulkEndpoints = map[string]string{
	"mcp": "/api/v1/mcps/submit", "skill": "/api/v1/skills/submit",
	"hook": "/api/v1/hooks/submit", "prompt": "/api/v1/prompts/submit",
	"sandbox": "/api/v1/sandboxes/submit",
}

type bulkComponent struct {
	Type    string
	Name    string
	Payload map[string]any
}

func bulkValidationError(message, path, remediation string) *clierr.Error {
	return &clierr.Error{
		Category: clierr.Validation, Message: message,
		Operation: bulkOp, Resource: path, Remediation: remediation,
	}
}

func loadBulkComponents(path string) ([]bulkComponent, *clierr.Error) {
	blob, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, &clierr.Error{
				Category: clierr.NotFound, Message: "Bulk component file was not found.",
				Operation: bulkOp, Resource: path,
				Remediation: "Provide an existing JSON file and retry.", Detail: err.Error(),
			}
		}
		return nil, &clierr.Error{
			Category: clierr.Unexpected, Message: err.Error(), Operation: bulkOp, Resource: path,
		}
	}
	var raw any
	if err := json.Unmarshal(blob, &raw); err != nil {
		return nil, bulkValidationError("Bulk component file is not valid JSON.", path, "Correct the JSON and retry.")
	}
	var entries []any
	switch v := raw.(type) {
	case []any:
		entries = v
	case map[string]any:
		entries, _ = v["components"].([]any)
	}
	if len(entries) == 0 {
		return nil, bulkValidationError(`Bulk component JSON must be a non-empty array or {"components": [...]}.`,
			path, "Add at least one typed component object.")
	}
	if len(entries) > 200 {
		return nil, bulkValidationError("Bulk component files may contain at most 200 entries.",
			path, "Split the input into files of 200 entries or fewer.")
	}
	components := []bulkComponent{}
	identities := map[string]bool{}
	for index, rawEntry := range entries {
		entry, ok := rawEntry.(map[string]any)
		if !ok {
			return nil, bulkValidationError(fmt.Sprintf("Bulk component entry %d must be an object.", index+1),
				path, "Replace scalar and array entries with typed component objects.")
		}
		componentType := strings.ToLower(strings.TrimSpace(fmt.Sprint(entry["type"])))
		if entry["type"] == nil {
			componentType = ""
		}
		if _, known := bulkEndpoints[componentType]; !known {
			return nil, bulkValidationError(fmt.Sprintf("Bulk component entry %d has an unsupported type.", index+1),
				path, "Choose from: mcp, skill, hook, prompt, sandbox.")
		}
		payload := map[string]any{}
		for key, value := range entry {
			if key != "type" {
				payload[key] = value
			}
		}
		name := ""
		if raw, has := payload["name"]; has && raw != nil {
			name = strings.TrimSpace(fmt.Sprint(raw))
		}
		if name == "" {
			return nil, bulkValidationError(fmt.Sprintf("Bulk component entry %d requires a name.", index+1),
				path, "Add a non-empty name to every entry.")
		}
		identity := componentType + "\x00" + strings.ToLower(name)
		if identities[identity] {
			return nil, bulkValidationError(fmt.Sprintf("Bulk component file repeats %s name: %s.", componentType, name),
				path, "Keep one entry for each component type and name.")
		}
		identities[identity] = true
		if _, has := payload["version"]; !has {
			payload["version"] = "1.0.0"
		}
		components = append(components, bulkComponent{Type: componentType, Name: name, Payload: payload})
	}
	return components, nil
}

func bulkOwner(client apiClient) (string, *clierr.Error) {
	cfg, cerr := config.Load()
	if cerr == nil {
		if configured := config.Str(cfg, "username"); configured != "" {
			return configured, nil
		}
	}
	raw, rerr := client.Do("GET", "/api/v1/auth/whoami", nil, nil, "Resolve bulk component owner", "user account")
	if rerr != nil {
		return "", rerr
	}
	var identity struct {
		Username string `json:"username"`
		Email    string `json:"email"`
	}
	_ = json.Unmarshal(raw, &identity)
	if identity.Username != "" {
		return identity.Username, nil
	}
	return identity.Email, nil
}

func rawField(doc map[string]json.RawMessage, key string) string {
	if value, ok := doc[key]; ok {
		return string(value)
	}
	return "null"
}

func bulkGroup() *cobra.Command {
	group := &cobra.Command{Use: "bulk", Short: "Submit mixed Registry components from one JSON file"}
	cmd := &cobra.Command{Use: "submit", Short: "Submit mixed MCP, skill, hook, prompt, and sandbox entries", Args: cobra.NoArgs}
	fromFile := cmd.Flags().String("from-file", "", "JSON file containing mixed typed components.")
	dryRun := cmd.Flags().Bool("dry-run", false, "Validate file structure and preview without mutations.")
	yes := cmd.Flags().BoolP("yes", "y", false, "Skip confirmation.")
	mode := outputFlag(cmd)
	cmd.RunE = func(c *cobra.Command, _ []string) error {
		if !c.Flags().Changed("from-file") {
			return usageError("registry bulk submit", "Missing option '--from-file'.")
		}
		components, cerr := loadBulkComponents(*fromFile)
		if cerr != nil {
			return cerr
		}
		if *mode == "json" && !*dryRun && !*yes {
			return bulkValidationError("JSON mode requires --yes before bulk component submission.",
				*fromFile, "Add --yes or use --dry-run.")
		}
		if *dryRun {
			parts := make([]string, len(components))
			for i, item := range components {
				parts[i] = fmt.Sprintf(`{"type": %s, "name": %s, "status": "planned"}`,
					jsonString(item.Type), jsonString(item.Name))
			}
			doc := fmt.Sprintf(`{"total": %d, "submitted": 0, "skipped": 0, "errors": 0, "dry_run": true, "results": [%s]}`,
				len(components), strings.Join(parts, ", "))
			if *mode == "json" {
				outputJSONRaw([]byte(doc))
			} else {
				for i, item := range components {
					fmt.Printf("%d\t%s\t%s\tplanned\n", i+1, item.Type, item.Name)
				}
			}
			return nil
		}
		if !*yes && !confirm(fmt.Sprintf("Submit %d Registry components?", len(components))) {
			return abortErr(bulkOp)
		}
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		owner := ""
		needsOwner := false
		for _, item := range components {
			if value, has := item.Payload["owner"]; !has || strings.TrimSpace(fmt.Sprint(value)) == "" || value == nil {
				needsOwner = true
				break
			}
		}
		if needsOwner {
			owner, cerr = bulkOwner(client)
			if cerr != nil {
				return cerr
			}
		}
		results := []string{}
		submitted, skipped, errorCount := 0, 0, 0
		for i, item := range components {
			if value, has := item.Payload["owner"]; !has || value == nil || strings.TrimSpace(fmt.Sprint(value)) == "" {
				item.Payload["owner"] = owner
			}
			raw, cerr := client.Do("POST", bulkEndpoints[item.Type], nil, item.Payload,
				bulkOp, item.Type+" submission")
			if cerr != nil {
				switch cerr.Category {
				case clierr.Auth, clierr.Permission, clierr.RateLimit, clierr.Unavailable, clierr.Version:
					return cerr
				}
				status := "error"
				if cerr.Category == clierr.Conflict {
					status = "skipped"
					skipped++
				} else {
					errorCount++
				}
				results = append(results, fmt.Sprintf(`{"type": %s, "name": %s, "status": %s, "error": {"category": %s, "message": %s, "request_id": %s}}`,
					jsonString(item.Type), jsonString(item.Name), jsonString(status),
					jsonString(string(cerr.Category)), jsonString(cerr.Message), jsonStringOrNull(cerr.RequestID)))
				continue
			}
			submitted++
			var created map[string]json.RawMessage
			_ = json.Unmarshal(raw, &created)
			results = append(results, fmt.Sprintf(`{"type": %s, "name": %s, "status": "submitted", "id": %s, "qualified_name": %s, "review_status": %s}`,
				jsonString(item.Type), jsonString(item.Name),
				rawField(created, "id"), rawField(created, "qualified_name"), rawField(created, "status")))
			_ = i
		}
		var doc bytes.Buffer
		fmt.Fprintf(&doc, `{"total": %d, "submitted": %d, "skipped": %d, "errors": %d, "dry_run": false, "results": [%s]}`,
			len(components), submitted, skipped, errorCount, strings.Join(results, ", "))
		if *mode == "json" {
			outputJSONRaw(doc.Bytes())
			return nil
		}
		fmt.Printf("%d submitted, %d skipped, %d errors\n", submitted, skipped, errorCount)
		return nil
	}
	group.AddCommand(cmd)
	return group
}
