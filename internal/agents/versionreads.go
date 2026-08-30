// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/garudex-labs/caracal/internal/registry"
)

// errNotFound carries a detail string for a 404 the store diagnosed itself.
type errNotFound struct{ detail string }

func (e *errNotFound) Error() string { return e.detail }

// jsonKeysInOrder lists an object's top-level keys in document order, which
// a decoded map cannot preserve.
func jsonKeysInOrder(raw string) []string {
	dec := json.NewDecoder(strings.NewReader(raw))
	keys := []string{}
	depth := 0
	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch v := tok.(type) {
		case json.Delim:
			if v == '{' || v == '[' {
				depth++
			} else {
				depth--
			}
		case string:
			if depth == 1 && dec.More() {
				keys = append(keys, v)
				var skip json.RawMessage
				_ = dec.Decode(&skip)
			}
		}
	}
	return keys
}

// pyListRepr renders a string list the way the availability detail does.
func pyListRepr(items []string) string {
	quoted := make([]string, 0, len(items))
	for _, s := range items {
		quoted = append(quoted, "'"+s+"'")
	}
	return "[" + strings.Join(quoted, ", ") + "]"
}

// HarnessConfig returns the stored, pre-generated configuration for one
// harness; nothing is generated at request time.
func (s *Store) HarnessConfig(ctx context.Context, agentRow map[string]any, viewer *registry.Viewer, version, harness string) (json.RawMessage, error) {
	statusGate := ""
	if !mayViewUnapproved(permission(agentRow, viewer), viewer) {
		statusGate = " AND v.status = 'approved'"
	}
	var raw *string
	err := s.DB.QueryRow(ctx, `SELECT v.harness_configs::text FROM agent_versions v
		WHERE v.agent_id = $1 AND v.version = $2`+statusGate,
		rowStr(agentRow, "id", ""), version).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, &errNotFound{"Version not found"}
	}
	if err != nil {
		return nil, err
	}
	available := []string{}
	if raw != nil {
		available = jsonKeysInOrder(*raw)
	}
	for _, key := range available {
		if key == harness {
			var configs map[string]json.RawMessage
			if err := json.Unmarshal([]byte(*raw), &configs); err != nil {
				return nil, err
			}
			var compact bytes.Buffer
			if err := json.Compact(&compact, configs[harness]); err != nil {
				return nil, err
			}
			return compact.Bytes(), nil
		}
	}
	return nil, &errNotFound{fmt.Sprintf(
		"harness '%s' not supported by this agent version. Available: %s",
		harness, pyListRepr(available))}
}

// renderYAMLSnapshot is the canonical snapshot text for a version: fixed key
// order, models_by_harness always present, prompt last.
func renderYAMLSnapshot(row map[string]any, components []map[string]any) string {
	var b strings.Builder
	b.WriteString("# Auto-generated snapshot - review the structured fields above and the prompt below.\n")
	writeYAMLEntry(&b, 0, "version", rowStr(row, "version", ""))
	writeYAMLEntry(&b, 0, "description", rowStr(row, "description", ""))
	writeYAMLEntry(&b, 0, "model_name", rowStr(row, "model_name", ""))

	models := map[string]string{}
	keys := []string{}
	for k, v := range rowDict(row, "models_by_harness") {
		if s, ok := v.(string); ok && s != "" {
			models[k] = s
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	if len(models) == 0 {
		b.WriteString("models_by_harness: {}\n")
	} else {
		b.WriteString("models_by_harness:\n")
		for _, k := range keys {
			writeYAMLEntry(&b, 1, k, models[k])
		}
	}
	writeYAMLList(&b, "supported_harnesses", rowList(row, "supported_harnesses"))
	writeYAMLList(&b, "external_mcps", rowList(row, "external_mcps"))

	if len(components) == 0 {
		b.WriteString("components: []\n")
	} else {
		b.WriteString("components:\n")
		for _, comp := range components {
			first := true
			for _, key := range []string{"type", "id", "name", "template", "description", "version"} {
				v, present := comp[key]
				if !present {
					continue
				}
				prefix := "  "
				if first {
					prefix = "- "
					first = false
				}
				b.WriteString(prefix)
				writeYAMLEntry(&b, 0, key, fmt.Sprint(v))
			}
			if override, ok := comp["config_override"].(map[string]any); ok && len(override) > 0 {
				blob, _ := json.Marshal(override)
				b.WriteString("  ")
				writeYAMLEntry(&b, 0, "config_override", string(blob))
			}
		}
	}
	writeYAMLEntry(&b, 0, "prompt", rowStr(row, "prompt", ""))
	if cfg := rowDict(row, "model_config_json"); len(cfg) > 0 {
		blob, _ := json.Marshal(cfg)
		writeYAMLEntry(&b, 0, "model_config_json", string(blob))
	}
	if sc := rowNDict(row, "success_criteria"); len(sc) > 0 {
		blob, _ := json.Marshal(sc)
		writeYAMLEntry(&b, 0, "success_criteria", string(blob))
	}
	return b.String()
}

func writeYAMLEntry(b *strings.Builder, indent int, key, value string) {
	b.WriteString(strings.Repeat("  ", indent))
	b.WriteString(key)
	b.WriteString(": ")
	b.WriteString(yamlScalar(value))
	b.WriteString("\n")
}

func writeYAMLList(b *strings.Builder, key string, items []any) {
	if len(items) == 0 {
		b.WriteString(key + ": []\n")
		return
	}
	b.WriteString(key + ":\n")
	for _, item := range items {
		b.WriteString("- " + yamlScalar(fmt.Sprint(item)) + "\n")
	}
}

// yamlScalar quotes only when a plain scalar would be ambiguous.
func yamlScalar(s string) string {
	if s == "" {
		return "''"
	}
	if strings.ContainsAny(s, "\n\"\\") {
		return fmt.Sprintf("%q", s)
	}
	if strings.ContainsAny(s, ":#{}[]&*!|>'%@`,") ||
		strings.HasPrefix(s, "- ") || s != strings.TrimSpace(s) {
		return "'" + strings.ReplaceAll(s, "'", "''") + "'"
	}
	return s
}

type componentChange struct {
	Type    string `json:"type"`
	Name    string `json:"name"`
	Change  string `json:"change"`
	Version string `json:"version,omitempty"`
	From    string `json:"from,omitempty"`
	To      string `json:"to,omitempty"`
}

// VersionDiff compares two versions: the snapshot text diff plus the
// component-level changes.
func (s *Store) VersionDiff(ctx context.Context, agentRow map[string]any, viewer *registry.Viewer, v1, v2 string) (map[string]any, error) {
	statusGate := ""
	if !mayViewUnapproved(permission(agentRow, viewer), viewer) {
		statusGate = " AND v.status = 'approved'"
	}
	agentID := rowStr(agentRow, "id", "")
	load := func(version string) (map[string]any, error) {
		rows, err := s.DB.Query(ctx, `SELECT v.id::text AS id, v.version, v.description,
			v.prompt, v.model_name, v.model_config_json, v.models_by_harness,
			v.external_mcps, v.supported_harnesses, v.success_criteria, v.yaml_snapshot
			FROM agent_versions v WHERE v.agent_id = $1 AND v.version = $2`+statusGate,
			agentID, version)
		if err != nil {
			return nil, err
		}
		collected := registry.CollectRows(rows)
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		if len(collected) == 0 {
			return nil, &errNotFound{fmt.Sprintf("Version '%s' not found", version)}
		}
		return collected[0], nil
	}
	ver1, err := load(v1)
	if err != nil {
		return nil, err
	}
	ver2, err := load(v2)
	if err != nil {
		return nil, err
	}

	snapshot := func(row map[string]any) (string, error) {
		if text := rowStr(row, "yaml_snapshot", ""); text != "" {
			return text, nil
		}
		links, err := s.snapshotComponents(ctx, rowStr(row, "id", ""))
		if err != nil {
			return "", err
		}
		return renderYAMLSnapshot(row, links), nil
	}
	text1, err := snapshot(ver1)
	if err != nil {
		return nil, err
	}
	text2, err := snapshot(ver2)
	if err != nil {
		return nil, err
	}
	yamlDiff := strings.Join(unifiedDiff(snapshotLines(text1), snapshotLines(text2),
		"v"+v1, "v"+v2), "\n")

	links1, err := s.Components(ctx, rowStr(ver1, "id", ""))
	if err != nil {
		return nil, err
	}
	links2, err := s.Components(ctx, rowStr(ver2, "id", ""))
	if err != nil {
		return nil, err
	}
	type key struct{ Type, ID string }
	byKey1 := map[key]map[string]any{}
	for _, link := range links1 {
		byKey1[key{rowStr(link, "component_type", ""), rowStr(link, "component_id", "")}] = link
	}
	byKey2 := map[key]map[string]any{}
	for _, link := range links2 {
		byKey2[key{rowStr(link, "component_type", ""), rowStr(link, "component_id", "")}] = link
	}
	changes := []componentChange{}
	for _, link := range links2 {
		k := key{rowStr(link, "component_type", ""), rowStr(link, "component_id", "")}
		prev, existed := byKey1[k]
		if !existed {
			changes = append(changes, componentChange{
				Type: k.Type, Name: rowStr(link, "component_name", ""),
				Change: "added", Version: rowStr(link, "resolved_version", ""),
			})
		} else if rowStr(prev, "resolved_version", "") != rowStr(link, "resolved_version", "") {
			changes = append(changes, componentChange{
				Type: k.Type, Name: rowStr(link, "component_name", ""),
				Change: "updated",
				From:   rowStr(prev, "resolved_version", ""),
				To:     rowStr(link, "resolved_version", ""),
			})
		}
	}
	for _, link := range links1 {
		k := key{rowStr(link, "component_type", ""), rowStr(link, "component_id", "")}
		if _, exists := byKey2[k]; !exists {
			changes = append(changes, componentChange{
				Type: k.Type, Name: rowStr(link, "component_name", ""),
				Change: "removed", Version: rowStr(link, "resolved_version", ""),
			})
		}
	}
	return map[string]any{
		"agent_id":          agentID,
		"version_a":         v1,
		"version_b":         v2,
		"yaml_diff":         yamlDiff,
		"component_changes": changes,
	}, nil
}

// snapshotComponents lists a version's components with resolved listing
// names and per-type detail fields, in snapshot entry shape.
func (s *Store) snapshotComponents(ctx context.Context, versionID string) ([]map[string]any, error) {
	links, err := s.Components(ctx, versionID)
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(links))
	for _, link := range links {
		entry := map[string]any{
			"type": rowStr(link, "component_type", ""),
			"id":   rowStr(link, "component_id", ""),
		}
		if name, ok := link["ref_name"].(string); ok {
			entry["name"] = name
			if rowStr(link, "component_type", "") == "prompt" {
				entry["template"] = ""
			} else {
				entry["description"] = ""
			}
		} else if stored := rowStr(link, "component_name", ""); stored != "" {
			entry["name"] = stored
		} else {
			entry["name"] = rowStr(link, "component_id", "")[:8]
		}
		if v := rowStr(link, "resolved_version", ""); v != "" {
			entry["version"] = v
		}
		if override := rowNDict(link, "config_override"); len(override) > 0 {
			entry["config_override"] = override
		}
		out = append(out, entry)
	}
	return out, nil
}
