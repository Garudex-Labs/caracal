// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package harnessgen

import (
	"fmt"
	"sort"
	"strings"

	"github.com/garudex-labs/caracal/internal/harness"
)

// McpSnippetInput carries one MCP listing's launch fields for
// component-level config snippets.
type McpSnippetInput struct {
	LocalName    string // overrides the listing slug when set
	Slug         string // listing slug or name fallback
	Framework    string
	DockerImage  string
	Command      string // stored launch command; empty means inferred
	HasCommand   bool
	Args         []string
	EnvVarNames  []string          // declared environment variable names
	EnvValues    map[string]string // caller-supplied values
	HeaderValues map[string]string
	Transport    string
	URL          string
	AutoApprove  []any
}

// buildMcpSnippetContext normalizes a listing the same way the agent
// generator does before harness-specific formatting.
func buildMcpSnippetContext(in McpSnippetInput) *mcpContext {
	name := in.Slug
	if in.LocalName != "" {
		name = in.LocalName
	}
	name = sanitizeName(name)

	serverEnv := map[string]string{}
	for _, varName := range in.EnvVarNames {
		serverEnv[varName] = in.EnvValues[varName]
	}

	transport := strings.ToLower(in.Transport)
	url := ""
	if in.URL != "" && (transport == "sse" || transport == "streamable-http" || transport == "") {
		url = in.URL
	}
	command := ""
	args := []string{}
	if url == "" {
		run := buildRunCommand(name, in.Framework, in.DockerImage, serverEnv, in.Command, in.Args, in.HasCommand)
		if len(run) > 0 {
			command = run[0]
			args = run[1:]
		}
	}
	if transport == "" {
		transport = "sse"
	}
	headers := map[string]string{}
	for k, v := range in.HeaderValues {
		headers[k] = v
	}
	return &mcpContext{
		Name:        name,
		Command:     command,
		Args:        args,
		ServerEnv:   serverEnv,
		Headers:     headers,
		Transport:   transport,
		URL:         url,
		AutoApprove: in.AutoApprove,
	}
}

// McpInstallSnippet renders the harness-specific MCP config for one listing.
func McpInstallSnippet(harnessName string, in McpSnippetInput) (map[string]any, error) {
	if _, ok := adapters[harnessName]; !ok {
		return nil, fmt.Errorf("No adapter registered for harness: '%s'", harnessName)
	}
	ctx := buildMcpSnippetContext(in)
	switch harnessName {
	case "claude-code":
		if ctx.URL != "" {
			snippet := map[string]any{}
			if len(ctx.ServerEnv) > 0 {
				snippet["env"] = ctx.ServerEnv
			}
			return map[string]any{
				"command":                 append([]string{"claude", "mcp", "add", ctx.Name, "--url"}, ctx.URL),
				"type":                    "shell_command",
				"claude_settings_snippet": snippet,
				"mcpServers":              map[string]any{ctx.Name: ctx.standardEntry()},
			}, nil
		}
		return map[string]any{
			"command": append([]string{"claude", "mcp", "add", ctx.Name, "--", ctx.Command}, ctx.Args...),
			"type":    "shell_command",
		}, nil
	case "codex":
		var entry map[string]any
		if ctx.URL != "" {
			entry = map[string]any{"url": ctx.URL}
			if len(ctx.Headers) > 0 {
				entry["headers"] = ctx.Headers
			}
			if len(ctx.ServerEnv) > 0 {
				entry["env"] = ctx.ServerEnv
			}
		} else {
			entry = ctx.standardEntry()
		}
		return map[string]any{"mcp_servers": map[string]any{ctx.Name: entry}}, nil
	case "copilot", "copilot-cli":
		entry := map[string]any{}
		if ctx.URL == "" {
			entry["type"] = "stdio"
		}
		for k, v := range ctx.standardEntry() {
			entry[k] = v
		}
		if harnessName == "copilot-cli" {
			entry["tools"] = []string{"*"}
		}
		return map[string]any{"mcpServers": map[string]any{ctx.Name: entry}}, nil
	case "goose":
		return map[string]any{"extensions": map[string]any{ctx.Name: gooseAdapter{}.agentMcpEntry(ctx)}}, nil
	case "opencode":
		return map[string]any{"mcp": map[string]any{ctx.Name: opencodeAdapter{}.agentMcpEntry(ctx)}}, nil
	}
	return map[string]any{"mcpServers": map[string]any{ctx.Name: ctx.standardEntry()}}, nil
}

// HookInstallSnippet renders the harness-specific hook config entry.
func HookInstallSnippet(harnessName, event, handlerType, command string, timeout int) map[string]any {
	switch harnessName {
	case "claude-code":
		entry := map[string]any{"type": handlerType, "command": command}
		if timeout != 0 {
			entry["timeout"] = timeout
		}
		return map[string]any{"hooks": map[string]any{
			event: []any{map[string]any{"matcher": "*", "hooks": []any{entry}}},
		}}
	case "codex":
		return map[string]any{
			"hooks":   map[string]any{event: map[string]any{"command": command}},
			"_format": "toml",
			"_note":   fmt.Sprintf("Add to .codex/config.toml under [hooks.%s]", event),
		}
	case "copilot", "copilot-cli", "kiro":
		return map[string]any{"hooks": map[string]any{event: []any{map[string]any{"command": command}}}}
	case "cursor":
		return map[string]any{"version": 1, "hooks": map[string]any{event: []any{map[string]any{"command": command}}}}
	case "goose":
		entry := map[string]any{"type": "command", "command": command}
		if timeout != 0 {
			entry["timeout"] = timeout
		}
		return map[string]any{
			"hooks": map[string]any{event: []any{map[string]any{"hooks": []any{entry}}}},
			"_note": "Add to .agents/plugins/caracal/hooks/hooks.json",
		}
	}
	entry := map[string]any{"command": command}
	if timeout != 0 {
		entry["timeout"] = timeout
	}
	return map[string]any{"hooks": map[string]any{event: []any{entry}}}
}

// HookInstallNotes returns adapter-specific setup notes.
func HookInstallNotes(harnessName string) []string {
	if harnessName == "claude-code" {
		return []string{"Also works in Cursor via Third Party Hooks (enable in Cursor Settings → Features)."}
	}
	return []string{}
}

// SkillHookExtra returns extra fields merged into telemetry hook entries.
func SkillHookExtra(harnessName string) map[string]any {
	if harnessName == "claude-code" {
		return map[string]any{"allowedEnvVars": []string{"CARACAL_ACCESS_TOKEN"}}
	}
	return map[string]any{}
}

// SkillInstallFile renders the harness skill file for a component install,
// using the one-line summary in frontmatter and the full description as body.
func SkillInstallFile(harnessName, scope, name, shortDesc, fullDesc, slashCommand string) map[string]any {
	spec, ok := specOf(strings.ReplaceAll(harnessName, "_", "-"))
	if !ok || len(spec.Skills) == 0 {
		return nil
	}
	pathTemplate, ok := spec.Skills[scope]
	if !ok {
		keys := make([]string, 0, len(spec.Skills))
		for k := range spec.Skills {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		pathTemplate = spec.Skills[keys[0]]
	}
	path := strings.ReplaceAll(pathTemplate, "{name}", name)
	var content string
	if spec.SkillFormat == "yaml_frontmatter" {
		pairs := [][2]string{{"name", name}}
		if shortDesc != "" {
			pairs = append(pairs, [2]string{"description", shortDesc})
		}
		if a, aok := adapters[strings.ReplaceAll(harnessName, "_", "-")]; aok {
			pairs = append(pairs, a.skillFrontmatterExtra(slashCommand)...)
		}
		content = yamlFrontmatter(pairs) + fullDesc + "\n"
	} else {
		pairs := [][2]string{{"description", shortDesc}, {"alwaysApply", "false"}}
		content = yamlFrontmatterRaw(pairs) + "# " + name + "\n\n" + fullDesc + "\n"
	}
	return map[string]any{"path": path, "content": content}
}

// SkillFilePath resolves the harness skill file location for a scope.
func SkillFilePath(harnessName, scope, name string) string {
	spec, ok := specOf(strings.ReplaceAll(harnessName, "_", "-"))
	if !ok || len(spec.Skills) == 0 {
		return ""
	}
	pattern, ok := spec.Skills[scope]
	if !ok {
		keys := make([]string, 0, len(spec.Skills))
		for k := range spec.Skills {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		pattern = spec.Skills[keys[0]]
	}
	return strings.ReplaceAll(pattern, "{name}", name)
}

// SanitizeComponentName exposes the shared identifier normalisation.
func SanitizeComponentName(name string) string { return sanitizeName(name) }

// HarnessSpec exposes registry data for component install responses.
func HarnessSpec(harnessName string) (*harness.Spec, bool) {
	return specOf(strings.ReplaceAll(harnessName, "_", "-"))
}

// RegistryHarnessNames lists harness keys in canonical declaration order.
func RegistryHarnessNames() []string { return registry().Names() }

// HarnessNames lists registered harness keys in sorted order.
func HarnessNames() []string {
	names := make([]string, 0, len(adapters))
	for k := range adapters {
		names = append(names, k)
	}
	sort.Strings(names)
	return names
}
