// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import (
	"context"
	"fmt"

	"github.com/garudex-labs/caracal/internal/registry"
)

// resolvedComponent is one component with its listing data, in the agent's
// component order.
type resolvedComponent struct {
	ComponentType  string
	ComponentID    string
	Name           string
	Version        string
	GitURL         *string
	GitRef         *string
	Description    string
	OrderIndex     int64
	ConfigOverride map[string]any
	ListingStatus  string
	Extra          map[string]any
}

type resolutionError struct {
	ComponentType string `json:"component_type"`
	ComponentID   string `json:"component_id"`
	Reason        string `json:"reason"`
}

type resolvedAgent struct {
	AgentID         string
	AgentName       string
	AgentVersion    string
	AgentPrompt     string
	AgentDesc       string
	ModelName       string
	ModelsByHarness map[string]any
	Components      []resolvedComponent
	Errors          []resolutionError
}

func (r *resolvedAgent) ok() bool { return len(r.Errors) == 0 }

func (r *resolvedAgent) byType(componentType string) []resolvedComponent {
	out := []resolvedComponent{}
	for _, c := range r.Components {
		if c.ComponentType == componentType {
			out = append(out, c)
		}
	}
	return out
}

// familyExtraColumns selects the per-type listing fields the manifest and
// the harness config generators consume, all latest-version delegates.
func familyExtraColumns(name string) string {
	switch name {
	case "mcp":
		return ", v.transport, v.tools_schema, v.mcp_validated, v.setup_instructions, v.source_url AS git_url, v.source_ref AS git_ref"
	case "skill":
		return ", v.skill_path, v.task_type, v.slash_command, v.skill_md_content, v.git_url, v.git_ref"
	case "hook":
		return ", v.event, v.execution_mode, v.priority, v.handler_type, v.handler_config, v.scope," +
			" v.source_url, v.source_ref, v.resolved_sha, v.script_filename, v.requirements," +
			" NULL::text AS git_url, NULL::text AS git_ref"
	case "prompt":
		return ", v.template, v.variables, v.category, NULL::text AS git_url, NULL::text AS git_ref"
	default: // sandbox
		return ", v.runtime_type, v.image, v.resource_limits, v.network_policy, v.entrypoint," +
			" v.runtime_config, v.sandbox_path, v.source_url AS git_url, v.source_ref AS git_ref"
	}
}

// extractExtra mirrors the per-type metadata dictionary, including its
// conditional keys.
func extractExtra(row map[string]any, componentType string) map[string]any {
	switch componentType {
	case "mcp":
		return map[string]any{
			"transport":          row["transport"],
			"tools_schema":       row["tools_schema"],
			"mcp_validated":      rowBool(row, "mcp_validated"),
			"setup_instructions": row["setup_instructions"],
		}
	case "skill":
		skillPath := rowStr(row, "skill_path", "/")
		return map[string]any{
			"skill_path":       skillPath,
			"task_type":        rowStr(row, "task_type", ""),
			"slash_command":    row["slash_command"],
			"skill_md_content": row["skill_md_content"],
		}
	case "hook":
		extra := map[string]any{
			"event":          rowStr(row, "event", ""),
			"execution_mode": rowStr(row, "execution_mode", "async"),
			"priority":       rowIntDefault(row, "priority", 100),
			"handler_type":   rowStr(row, "handler_type", ""),
			"handler_config": rowDict(row, "handler_config"),
			"scope":          rowStr(row, "scope", "agent"),
		}
		if rowStr(row, "source_url", "") != "" {
			extra["source_url"] = row["source_url"]
			extra["source_ref"] = row["source_ref"]
			extra["resolved_sha"] = row["resolved_sha"]
		}
		if rowStr(row, "script_filename", "") != "" {
			extra["script_filename"] = row["script_filename"]
		}
		if rowStr(row, "requirements", "") != "" {
			extra["requirements"] = row["requirements"]
		}
		return extra
	case "prompt":
		return map[string]any{
			"template":  rowStr(row, "template", ""),
			"variables": rowList(row, "variables"),
			"category":  rowStr(row, "category", ""),
		}
	default: // sandbox
		extra := map[string]any{
			"runtime_type":    rowStr(row, "runtime_type", ""),
			"image":           rowStr(row, "image", ""),
			"resource_limits": rowDict(row, "resource_limits"),
			"network_policy":  rowStr(row, "network_policy", "none"),
			"entrypoint":      row["entrypoint"],
			"runtime_config":  rowDict(row, "runtime_config"),
		}
		if rowStr(row, "sandbox_path", "") != "" {
			extra["sandbox_path"] = row["sandbox_path"]
		}
		return extra
	}
}

func rowIntDefault(row map[string]any, key string, def int64) int64 {
	switch n := row[key].(type) {
	case int64:
		return n
	case int32:
		return int64(n)
	case int16:
		return int64(n)
	}
	return def
}

// itemSlug is the listing's stable identity: slug when set, name otherwise.
func itemSlug(row map[string]any) string {
	if s := rowStr(row, "slug", ""); s != "" {
		return s
	}
	return rowStr(row, "name", "")
}

// Resolve looks up every component's listing in its family table, enforcing
// caller visibility, the publish scope of the agent's audience, and the
// approved-only rule, and returns the composition with per-component errors
// in the original component order.
func (s *Store) Resolve(ctx context.Context, agentRow map[string]any, links []map[string]any, viewer *registry.Viewer) (*resolvedAgent, error) {
	byType := map[string][]string{}
	unknown := []resolutionError{}
	for _, link := range links {
		t := rowStr(link, "component_type", "")
		if _, known := registry.Families[t+"s"]; !known {
			unknown = append(unknown, resolutionError{
				ComponentType: t,
				ComponentID:   rowStr(link, "component_id", ""),
				Reason:        fmt.Sprintf("Unknown component type: %s", t),
			})
			continue
		}
		byType[t] = append(byType[t], rowStr(link, "component_id", ""))
	}

	// The publish scope pins what this agent's audience may contain: a
	// public agent composes only public components; a project-private agent
	// adds its own project's private ones.
	publishScope := "l.is_private = FALSE"
	scopeArgs := []any{}
	if rowBool(agentRow, "is_private") {
		if projectID := rowNStr(agentRow, "project_id"); projectID != nil {
			scopeArgs = append(scopeArgs, *projectID)
			publishScope = "(l.is_private = FALSE OR (l.is_private = TRUE AND l.project_id = $%d))"
		}
	}

	found := map[string]map[string]any{}
	for typeName, ids := range byType {
		f := registry.Families[typeName+"s"]
		args := []any{}
		visibility := registry.ScopeSQL("l", "l.submitted_by", viewer, &args)
		scope := publishScope
		if len(scopeArgs) > 0 {
			args = append(args, scopeArgs[0])
			scope = fmt.Sprintf(publishScope, len(args))
		}
		args = append(args, ids)
		sql := fmt.Sprintf(`SELECT l.id::text AS id, l.name, l.slug,
			v.version, v.description, v.status %s
			FROM %s l LEFT JOIN %s v ON l.latest_version_id = v.id
			WHERE %s AND %s AND l.id = ANY($%d)`,
			familyExtraColumns(typeName), f.ListingTable, f.VersionTable,
			visibility, scope, len(args))
		rows, err := s.DB.Query(ctx, sql, args...)
		if err != nil {
			return nil, err
		}
		collected := registry.CollectRows(rows)
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		for _, row := range collected {
			found[rowStr(row, "id", "")] = row
		}
	}

	resolved := &resolvedAgent{
		AgentID:         rowStr(agentRow, "id", ""),
		AgentName:       itemSlug(agentRow),
		AgentVersion:    rowStr(agentRow, "version", "0.0.0"),
		AgentPrompt:     rowStr(agentRow, "prompt", ""),
		AgentDesc:       rowStr(agentRow, "description", ""),
		ModelName:       rowStr(agentRow, "model_name", ""),
		ModelsByHarness: rowDict(agentRow, "models_by_harness"),
		Errors:          unknown,
	}
	for _, link := range links {
		t := rowStr(link, "component_type", "")
		if _, known := registry.Families[t+"s"]; !known {
			continue
		}
		id := rowStr(link, "component_id", "")
		row, ok := found[id]
		if !ok {
			resolved.Errors = append(resolved.Errors, resolutionError{
				ComponentType: t, ComponentID: id,
				Reason: fmt.Sprintf("%s listing %s not found", t, id),
			})
			continue
		}
		status := rowStr(row, "status", "draft")
		if status != "approved" {
			resolved.Errors = append(resolved.Errors, resolutionError{
				ComponentType: t, ComponentID: id,
				Reason: fmt.Sprintf("%s '%s' is not approved (status: %s)", t, rowStr(row, "name", ""), status),
			})
			continue
		}
		resolved.Components = append(resolved.Components, resolvedComponent{
			ComponentType:  t,
			ComponentID:    id,
			Name:           itemSlug(row),
			Version:        rowStr(row, "version", "0.0.0"),
			GitURL:         rowNStr(row, "git_url"),
			GitRef:         rowNStr(row, "git_ref"),
			Description:    rowStr(row, "description", ""),
			OrderIndex:     rowInt(link, "order_index"),
			ConfigOverride: rowNDict(link, "config_override"),
			ListingStatus:  status,
			Extra:          extractExtra(row, t),
		})
	}
	return resolved, nil
}

// ValidateComponents checks a set of component references before they are
// attached to an agent: existence within the caller's visibility, and the
// publish scope of the intended audience. Approval is not required here -
// drafts may reference pending components.
func (s *Store) ValidateComponents(ctx context.Context, refs []componentRef, viewer *registry.Viewer, targetProjectID string) ([]resolutionError, error) {
	errs := []resolutionError{}
	byType := map[string][]string{}
	for _, ref := range refs {
		if _, known := registry.Families[ref.ComponentType+"s"]; !known {
			errs = append(errs, resolutionError{
				ComponentType: ref.ComponentType, ComponentID: ref.ComponentID,
				Reason: fmt.Sprintf("Unknown component type: %s", ref.ComponentType),
			})
			continue
		}
		byType[ref.ComponentType] = append(byType[ref.ComponentType], ref.ComponentID)
	}
	found := map[string]bool{}
	for typeName, ids := range byType {
		f := registry.Families[typeName+"s"]
		args := []any{}
		visibility := registry.ScopeSQL("l", "l.submitted_by", viewer, &args)
		scope := "l.is_private = FALSE"
		if targetProjectID != "" {
			args = append(args, targetProjectID)
			scope = fmt.Sprintf("(l.is_private = FALSE OR (l.is_private = TRUE AND l.project_id = $%d))", len(args))
		}
		args = append(args, ids)
		rows, err := s.DB.Query(ctx, fmt.Sprintf(
			"SELECT l.id::text FROM %s l WHERE %s AND %s AND l.id = ANY($%d)",
			f.ListingTable, visibility, scope, len(args)), args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return nil, err
			}
			found[id] = true
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	for _, ref := range refs {
		if _, known := registry.Families[ref.ComponentType+"s"]; !known {
			continue
		}
		if !found[ref.ComponentID] {
			errs = append(errs, resolutionError{
				ComponentType: ref.ComponentType, ComponentID: ref.ComponentID,
				Reason: fmt.Sprintf("%s listing %s not found", ref.ComponentType, ref.ComponentID),
			})
		}
	}
	return errs, nil
}

// componentRef is a client-supplied component reference.
type componentRef struct {
	ComponentType string `json:"component_type"`
	ComponentID   string `json:"component_id"`
}

var manifestTypeOrder = []struct{ Singular, Plural string }{
	{"mcp", "mcps"}, {"skill", "skills"}, {"hook", "hooks"},
	{"prompt", "prompts"}, {"sandbox", "sandboxes"},
}

// compositionSummary renders the lightweight composition view.
func compositionSummary(r *resolvedAgent) map[string]any {
	counts := map[string]any{}
	components := map[string]any{}
	for _, t := range manifestTypeOrder {
		typed := r.byType(t.Singular)
		if len(typed) == 0 {
			continue
		}
		counts[t.Singular] = len(typed)
		entries := make([]map[string]any, 0, len(typed))
		for _, c := range typed {
			entries = append(entries, map[string]any{
				"name": c.Name, "version": c.Version, "order": c.OrderIndex,
			})
		}
		components[t.Plural] = entries
	}
	errors := make([]resolutionError, 0, len(r.Errors))
	errors = append(errors, r.Errors...)
	return map[string]any{
		"agent_id":         r.AgentID,
		"agent_name":       r.AgentName,
		"agent_version":    r.AgentVersion,
		"resolved":         r.ok(),
		"component_counts": counts,
		"components":       components,
		"errors":           errors,
	}
}

func truthyDict(d map[string]any) bool { return len(d) > 0 }

func setIfTruthyStr(dst map[string]any, key string, v any) {
	if s, ok := v.(string); ok && s != "" {
		dst[key] = s
	}
}

// manifestComponent renders one component entry with only populated fields.
func manifestComponent(c resolvedComponent) map[string]any {
	out := map[string]any{
		"name":        c.Name,
		"version":     c.Version,
		"git_url":     "",
		"description": c.Description,
		"order":       c.OrderIndex,
	}
	if c.GitURL != nil && *c.GitURL != "" {
		out["git_url"] = *c.GitURL
	}
	if c.GitRef != nil && *c.GitRef != "" {
		out["git_ref"] = *c.GitRef
	}
	if truthyDict(c.ConfigOverride) {
		out["config_override"] = c.ConfigOverride
	}
	switch c.ComponentType {
	case "mcp":
		setIfTruthyStr(out, "transport", c.Extra["transport"])
		if tools, ok := c.Extra["tools_schema"].(map[string]any); ok && len(tools) > 0 {
			out["tools"] = tools
		}
	case "skill":
		setIfTruthyStr(out, "slash_command", c.Extra["slash_command"])
		setIfTruthyStr(out, "task_type", c.Extra["task_type"])
		if md, ok := c.Extra["skill_md_content"].(string); ok && md != "" {
			out["config_override"] = map[string]any{"skill_md_content": md}
		}
	case "hook":
		out["event"] = c.Extra["event"]
		out["execution_mode"] = c.Extra["execution_mode"]
		out["priority"] = c.Extra["priority"]
		out["handler_type"] = c.Extra["handler_type"]
		out["handler_config"] = c.Extra["handler_config"]
	case "prompt":
		setIfTruthyStr(out, "template", c.Extra["template"])
		if vars, ok := c.Extra["variables"].([]any); ok && len(vars) > 0 {
			out["variables"] = vars
		}
	case "sandbox":
		out["image"] = c.Extra["image"]
		out["runtime_type"] = c.Extra["runtime_type"]
		if limits, ok := c.Extra["resource_limits"].(map[string]any); ok && len(limits) > 0 {
			out["resource_limits"] = limits
		}
		setIfTruthyStr(out, "network_policy", c.Extra["network_policy"])
		setIfTruthyStr(out, "entrypoint", c.Extra["entrypoint"])
		if cfg, ok := c.Extra["runtime_config"].(map[string]any); ok && len(cfg) > 0 {
			out["runtime_config"] = cfg
		}
	}
	return out
}

// agentManifest renders the portable manifest with only populated fields.
func agentManifest(r *resolvedAgent) map[string]any {
	grouped := map[string]any{}
	for _, t := range manifestTypeOrder {
		typed := r.byType(t.Singular)
		if len(typed) == 0 {
			continue
		}
		entries := make([]map[string]any, 0, len(typed))
		for _, c := range typed {
			entries = append(entries, manifestComponent(c))
		}
		grouped[t.Plural] = entries
	}
	out := map[string]any{
		"name":       r.AgentName,
		"version":    r.AgentVersion,
		"components": grouped,
	}
	if r.AgentPrompt != "" {
		out["prompt"] = r.AgentPrompt
	}
	if r.AgentDesc != "" {
		out["description"] = r.AgentDesc
	}
	if r.ModelName != "" {
		out["model_name"] = r.ModelName
	}
	if truthyDict(r.ModelsByHarness) {
		out["models_by_harness"] = r.ModelsByHarness
	}
	if len(r.Errors) > 0 {
		out["errors"] = r.Errors
	}
	return out
}
