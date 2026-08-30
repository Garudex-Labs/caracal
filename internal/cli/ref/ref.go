// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package ref resolves registry references: local aliases, positional rows
// from the last list results, qualified names, and server identities.
package ref

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/garudex-labs/caracal/internal/cli/api"
	"github.com/garudex-labs/caracal/internal/cli/clierr"
	"github.com/garudex-labs/caracal/internal/cli/config"
)

// LastResults is the positional-reference cache written by list commands.
type LastResults struct {
	ItemType *string           `json:"item_type"`
	IDs      []string          `json:"ids"`
	Names    map[string]string `json:"names"`
}

func lastResultsFile() string { return filepath.Join(config.Dir(), "last_results.json") }

// SaveLastResults caches list results and the registry type that produced them.
func SaveLastResults(items []map[string]any, itemType string) error {
	ids := make([]string, 0, len(items))
	type namePair struct{ name, id string }
	names := []namePair{}
	seen := map[string]bool{}
	for _, item := range items {
		id := fmt.Sprint(item["id"])
		ids = append(ids, id)
		if name, ok := item["name"].(string); ok && name != "" {
			lower := strings.ToLower(name)
			if seen[lower] {
				// Later duplicates overwrite, matching dict assignment.
				for i := range names {
					if names[i].name == lower {
						names[i].id = id
					}
				}
				continue
			}
			seen[lower] = true
			names = append(names, namePair{lower, id})
		}
	}
	// The on-disk format matches the shared writer's default separators.
	var doc strings.Builder
	doc.WriteString(`{"item_type": `)
	writeJSONString(&doc, itemType)
	doc.WriteString(`, "ids": [`)
	for i, id := range ids {
		if i > 0 {
			doc.WriteString(", ")
		}
		writeJSONString(&doc, id)
	}
	doc.WriteString(`], "names": {`)
	for i, pair := range names {
		if i > 0 {
			doc.WriteString(", ")
		}
		writeJSONString(&doc, pair.name)
		doc.WriteString(": ")
		writeJSONString(&doc, pair.id)
	}
	doc.WriteString(`}}`)
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, []byte(doc.String()), "", "  "); err != nil {
		return err
	}
	if err := os.MkdirAll(config.Dir(), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(config.Dir(), ".last_results.json.")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(pretty.Bytes()); err != nil {
		_ = tmp.Close()
		return err
	}
	_ = tmp.Close()
	if err := os.Chmod(tmp.Name(), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), lastResultsFile())
}

func writeJSONString(doc *strings.Builder, value string) {
	blob, _ := json.Marshal(value)
	doc.Write(blob)
}

// LoadLastResults reads the cache, tolerating absence.
func LoadLastResults() (*LastResults, *clierr.Error) {
	blob, err := os.ReadFile(lastResultsFile())
	if err != nil {
		return &LastResults{IDs: []string{}, Names: map[string]string{}}, nil
	}
	var cache LastResults
	if json.Unmarshal(blob, &cache) != nil {
		return nil, &clierr.Error{
			Category: clierr.Validation, Message: "The cached CLI list results are malformed.",
			Operation: "Load CLI list results", Resource: lastResultsFile(),
			Remediation: "Remove the results cache and run the list command again.",
		}
	}
	if cache.IDs == nil {
		cache.IDs = []string{}
	}
	if cache.Names == nil {
		cache.Names = map[string]string{}
	}
	return &cache, nil
}

// ResolveAlias expands @aliases and positional row numbers.
func ResolveAlias(name, expectedType string) (string, *clierr.Error) {
	if strings.HasPrefix(name, "@") {
		aliases, cerr := config.LoadAliases()
		if cerr != nil {
			return "", cerr
		}
		target, ok := aliases[name[1:]]
		if !ok {
			return "", &clierr.Error{
				Category: clierr.NotFound, Message: fmt.Sprintf("Alias %s is not configured.", name),
				Operation: "Resolve CLI alias", Resource: name,
				Remediation: fmt.Sprintf("Run caracal config alias %s <reference> to create it.", name[1:]),
			}
		}
		return target, nil
	}
	if isDigits(name) {
		cache, cerr := LoadLastResults()
		if cerr != nil {
			return "", cerr
		}
		if expectedType != "" && (cache.ItemType == nil || *cache.ItemType != expectedType) {
			return "", &clierr.Error{
				Category: clierr.NotFound, Message: fmt.Sprintf("Row %s is not from the latest %s list.", name, expectedType),
				Operation: "Resolve CLI row reference", Resource: name,
				Remediation: fmt.Sprintf("Run the %s list command and retry with one of its row numbers.", expectedType),
			}
		}
		idx, _ := strconv.Atoi(name)
		if idx >= 1 && idx <= len(cache.IDs) {
			return cache.IDs[idx-1], nil
		}
		return "", &clierr.Error{
			Category: clierr.NotFound, Message: fmt.Sprintf("Row %s does not exist in the latest list results.", name),
			Operation: "Resolve CLI row reference", Resource: name,
			Remediation: "Run the relevant list command and retry with one of its row numbers.",
		}
	}
	return name, nil
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// singularTypes maps plurals used by callers onto the resolver's type names.
var singularTypes = map[string]string{
	"mcps": "mcp", "skills": "skill", "hooks": "hook",
	"prompts": "prompt", "sandboxes": "sandbox", "agents": "agent",
}

// ResolveRegistryReference resolves aliases, rows, and qualified names to a
// server identity, leaving UUIDs and bare names to the server. Server
// failures inherit the calling command's operation and resource labels.
func ResolveRegistryReference(client *api.Client, itemType, reference, op, resource string) (string, *clierr.Error) {
	if singular, ok := singularTypes[itemType]; ok {
		itemType = singular
	}
	var resolved string
	var cerr *clierr.Error
	if isDigits(reference) {
		resolved, cerr = ResolveAlias(reference, itemType)
	} else {
		resolved, cerr = ResolveAlias(reference, "")
	}
	if cerr != nil {
		return "", cerr
	}
	if strings.Contains(resolved, "/") {
		raw, cerr := client.GetRaw("/api/v1/registry/resolve",
			map[string]string{"type": itemType, "identifier": resolved})
		if cerr != nil {
			if op != "" {
				cerr.Operation = op
			}
			if resource != "" {
				cerr.Resource = resource
			}
			return "", cerr
		}
		var doc struct {
			ID any `json:"id"`
		}
		if json.Unmarshal(raw, &doc) != nil || doc.ID == nil {
			return "", &clierr.Error{
				Category: clierr.Unavailable, Message: "The registry returned an invalid resolution response.",
				Operation: "Resolve registry item", Resource: resolved,
				Remediation: "Check server health and retry.",
			}
		}
		return fmt.Sprint(doc.ID), nil
	}
	return resolved, nil
}
