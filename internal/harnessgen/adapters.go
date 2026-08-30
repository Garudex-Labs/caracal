// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package harnessgen

import (
	"encoding/json"
	"fmt"
	"strings"
)

// generation is the assembled context an adapter renders.
type generation struct {
	req            *Request
	safeName       string
	mcpConfigs     *Config
	rulesContent   string
	skillConfigs   []skillConfig
	hookConfigs    []hookConfig
	compatWarnings []string
}

func (g *generation) scope(defaultScope string) string {
	if s, ok := g.req.Options["scope"].(string); ok && s != "" {
		return s
	}
	return defaultScope
}

// truncatedDescription is the one-line, 200-rune description fallback.
func (g *generation) truncatedDescription() string {
	desc := g.req.Agent.Description
	if desc == "" {
		desc = g.safeName
	}
	desc = strings.TrimSpace(strings.ReplaceAll(desc, "\n", " "))
	runes := []rune(desc)
	if len(runes) > 200 {
		runes = runes[:200]
	}
	return string(runes)
}

func (g *generation) allWarnings() []string {
	warnings := append([]string{}, g.compatWarnings...)
	warnings = append(warnings, g.req.ModelWarnings...)
	return warnings
}

// adapter renders harness-specific configuration.
type adapter interface {
	agentMcpEntry(ctx *mcpContext) any
	formatConfig(g *generation) *Config
	formatModel(model, provider string) string
	defaultModelCandidate(modelName string) string
	// previewModelFallback is the model emitted when no resolution ran.
	previewModelFallback(modelName string) string
	skillFrontmatterExtra(slashCommand string) [][2]string
	formatHookComponent(command string) any
	emitsPromptFiles() bool
}

// base provides the shared adapter defaults.
type base struct{}

func (base) agentMcpEntry(ctx *mcpContext) any { return ctx.standardEntry() }

func (base) formatModel(model, provider string) string { return model }

func (base) defaultModelCandidate(modelName string) string { return "" }
func (base) previewModelFallback(modelName string) string  { return "" }

func (base) skillFrontmatterExtra(string) [][2]string { return nil }

func (base) formatHookComponent(command string) any {
	return map[string]any{"command": command}
}

func (base) emitsPromptFiles() bool { return false }

var adapters = map[string]adapter{
	"kiro":        kiroAdapter{},
	"claude-code": claudeCodeAdapter{},
	"cursor":      cursorAdapter{},
	"copilot":     copilotAdapter{},
	"copilot-cli": copilotCliAdapter{},
	"codex":       codexAdapter{},
	"opencode":    opencodeAdapter{},
	"goose":       gooseAdapter{},
	"antigravity": antigravityAdapter{},
	"pi":          piAdapter{},
}

// ── Kiro ──

type kiroAdapter struct{ base }

var kiroEventMap = map[string]string{
	"SessionStart": "agentSpawn", "UserPromptSubmit": "userPromptSubmit",
	"PreToolUse": "preToolUse", "PostToolUse": "postToolUse", "Stop": "stop",
}

func (kiroAdapter) formatModel(model, provider string) string {
	// claude-<family>-<major>-<minor>[-<date>] renders with a dotted version.
	parts := strings.Split(model, "-")
	if len(parts) >= 3 && parts[0] == "claude" {
		// Find trailing numeric segments.
		last := parts[len(parts)-1]
		if len(last) == 8 && isDigits(last) && len(parts) >= 4 &&
			isShortDigits(parts[len(parts)-2]) && isShortDigits(parts[len(parts)-3]) {
			head := strings.Join(parts[:len(parts)-2], "-")
			return head + "." + parts[len(parts)-2] + "-" + last
		}
		if isShortDigits(last) && isShortDigits(parts[len(parts)-2]) {
			head := strings.Join(parts[:len(parts)-1], "-")
			return head + "." + last
		}
	}
	return model
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

func isShortDigits(s string) bool { return len(s) >= 1 && len(s) <= 3 && isDigits(s) }

func (a kiroAdapter) formatConfig(g *generation) *Config {
	spec, _ := specOf("kiro")
	scope := g.scope(spec.DefaultScope)
	agentID := g.req.Agent.ID
	pushCmd := fmt.Sprintf("CARACAL_AGENT_ID=%s caracal hook session-push --harness kiro", agentID)
	if g.req.Platform == "win32" {
		pushCmd = fmt.Sprintf(`set "CARACAL_AGENT_ID=%s" && caracal hook session-push --harness kiro`, agentID)
	}
	hooks := map[string]any{
		"userPromptSubmit": []any{map[string]any{"command": pushCmd}},
		"stop":             []any{map[string]any{"command": pushCmd}},
	}
	hooksDir := ".kiro/hooks"
	if scope == "user" {
		hooksDir = "~/.kiro/hooks"
	}
	for _, hc := range g.hookConfigs {
		event := hc.str("event")
		if event == "" {
			continue
		}
		kiroEvent := event
		if mapped, ok := kiroEventMap[event]; ok {
			kiroEvent = mapped
		}
		handlerConfig := hc.dict("handler_config")
		var entry map[string]any
		switch hc.str("handler_type") {
		case "http":
			hookURL := str(handlerConfig["url"])
			if hookURL == "" {
				continue
			}
			entry = map[string]any{
				"command": fmt.Sprintf("curl -s -X POST -H 'Content-Type: application/json' -d @- %s", hookURL),
			}
		default:
			cmd := str(handlerConfig["command"])
			if filename := hc.str("script_filename"); filename != "" {
				cmd = hooksDir + "/" + filename
			} else if cmd == "" {
				continue
			}
			entry = map[string]any{"command": cmd}
		}
		if kiroEvent == "preToolUse" || kiroEvent == "postToolUse" {
			matcher := strOr(handlerConfig["matcher"], "*")
			entry["matcher"] = matcher
		}
		entries, _ := hooks[kiroEvent].([]any)
		hooks[kiroEvent] = append(entries, entry)
	}

	content := NewConfig()
	content.Set("name", g.safeName)
	content.Set("description", g.truncatedDescription())
	content.Set("prompt", wrapKiroPrompt(g.req.Agent.Prompt, g.safeName))
	content.Set("mcpServers", g.mcpConfigs)
	content.Set("tools", []any{"*"})
	content.Set("toolAliases", map[string]any{})
	content.Set("allowedTools", []any{})
	content.Set("resources", []any{
		"file://AGENTS.md", "file://README.md",
		"skill://.kiro/skills/**/SKILL.md", "skill://~/.kiro/skills/**/SKILL.md",
	})
	content.Set("hooks", hooks)
	content.Set("toolsSettings", map[string]any{})
	content.Set("includeMcpJson", true)
	var model any
	if g.req.ResolvedModel != "" {
		model = g.req.ResolvedModel
	}
	content.Set("model", model)

	result := NewConfig()
	result.Set("agent_profile", map[string]any{
		"path":    strings.ReplaceAll(spec.AgentProfile[scope], "{name}", g.safeName),
		"content": content,
	})
	result.Set("scope", scope)
	if len(g.skillConfigs) > 0 {
		result.Set("skill_components", g.skillConfigs)
	}
	hookFiles := collectHookScriptFiles(g.hookConfigs, "kiro")
	if len(hookFiles) > 0 {
		if scope == "user" {
			for _, hf := range hookFiles {
				hf["path"] = strings.Replace(str(hf["path"]), ".kiro/hooks", "~/.kiro/hooks", 1)
			}
		}
		result.Set("hook_files", hookFiles)
	}
	if warnings := g.allWarnings(); len(warnings) > 0 {
		result.Set("_warnings", warnings)
	}
	return result
}

// ── Claude Code ──

type claudeCodeAdapter struct{ base }

func (claudeCodeAdapter) defaultModelCandidate(modelName string) string { return modelName }
func (claudeCodeAdapter) previewModelFallback(modelName string) string {
	return modelNameToFrontmatter(modelName)
}

// skillFrontmatterExtra surfaces the stored slash command as a /command line.
func (claudeCodeAdapter) skillFrontmatterExtra(slashCommand string) [][2]string {
	if slashCommand == "" {
		return nil
	}
	normalized := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(slashCommand), "/"))
	if normalized == "" {
		return nil
	}
	return [][2]string{{"command", "/" + normalized}}
}

func (claudeCodeAdapter) formatModel(model, provider string) string {
	lowered := strings.ToLower(model)
	for _, alias := range []string{"opus", "sonnet", "haiku"} {
		if strings.Contains(lowered, alias) {
			return alias
		}
	}
	return model
}

func (a claudeCodeAdapter) formatConfig(g *generation) *Config {
	spec, _ := specOf("claude-code")
	setupCommands := []any{}
	claudeMcps := NewConfig()
	for _, name := range g.mcpConfigs.Keys() {
		cfgAny, _ := g.mcpConfigs.Get(name)
		cfg, _ := cfgAny.(map[string]any)
		cfgType := str(cfg["type"])
		if str(cfg["url"]) != "" || cfgType == "sse" || cfgType == "streamable-http" {
			claudeMcps.Set(name, cfg)
			continue
		}
		cmd := str(cfg["command"])
		args := cfg["args"]
		setup := []any{"claude", "mcp", "add", name, "--", cmd}
		if list, ok := args.([]any); ok {
			setup = append(setup, list...)
		} else if list, ok := args.([]string); ok {
			for _, s := range list {
				setup = append(setup, s)
			}
		}
		setupCommands = append(setupCommands, setup)
		env := cfg["env"]
		if env == nil {
			env = map[string]any{}
		}
		claudeMcps.Set(name, map[string]any{"command": cmd, "args": args, "env": env})
	}

	scope := g.scope(spec.DefaultScope)
	tools := str(g.req.Options["tools"])
	color := str(g.req.Options["color"])
	modelChoice := g.req.ResolvedModel

	lines := []string{"---", "name: " + g.safeName}
	if desc := g.req.Agent.Description; desc != "" {
		lines = append(lines, fmt.Sprintf("description: %q", desc))
	}
	if modelChoice != "" {
		lines = append(lines, "model: "+modelChoice)
	}
	if tools != "" {
		lines = append(lines, "tools: "+tools)
	}
	if color != "" {
		lines = append(lines, "color: "+color)
	}
	if claudeMcps.Len() > 0 {
		lines = append(lines, "mcpServers:")
		for _, name := range claudeMcps.Keys() {
			lines = append(lines, "  - "+name)
		}
	}
	lines = append(lines, claudeCodeHooksFrontmatterLines(g.hookConfigs)...)
	lines = append(lines, "---")
	agentContent := strings.Join(lines, "\n") + "\n\n" + g.rulesContent

	result := NewConfig()
	result.Set("agent_profile", map[string]any{
		"path":    strings.ReplaceAll(spec.AgentProfile[scope], "{name}", g.safeName),
		"content": agentContent,
	})
	result.Set("mcp_config", claudeMcps)
	result.Set("mcp_setup_commands", setupCommands)
	result.Set("scope", scope)
	if len(g.skillConfigs) > 0 {
		result.Set("skill_components", g.skillConfigs)
	}
	if hookFiles := collectHookScriptFiles(g.hookConfigs, "claude-code"); len(hookFiles) > 0 {
		result.Set("hook_files", hookFiles)
	}
	if warnings := g.allWarnings(); len(warnings) > 0 {
		result.Set("_warnings", warnings)
	}
	return result
}

// ── Cursor ──

type cursorAdapter struct{ base }

func (a cursorAdapter) formatConfig(g *generation) *Config {
	spec, _ := specOf("cursor")
	scope := g.scope(spec.DefaultScope)
	mcpPath, ok := spec.MCPConfig[scope]
	if !ok {
		mcpPath = ".mcp.json"
		for _, v := range spec.MCPConfig {
			mcpPath = v
			break
		}
	}
	model := g.req.ResolvedModel
	if model == "" {
		model = "inherit"
	}
	agentContent := fmt.Sprintf("---\nname: %s\ndescription: %s\nmodel: %s\n---\n\n%s",
		g.safeName, pyRepr(g.truncatedDescription()), model, g.rulesContent)

	serversKey := spec.MCPServersKey
	if serversKey == "" {
		serversKey = "mcpServers"
	}
	result := NewConfig()
	mcpContent := NewConfig()
	mcpContent.Set(serversKey, g.mcpConfigs)
	result.Set("mcp_config", map[string]any{"path": mcpPath, "content": mcpContent})
	result.Set("scope", scope)
	agentDir := ".cursor/agents"
	if scope != "project" {
		agentDir = "~/.cursor/agents"
	}
	result.Set("agent_profile", map[string]any{
		"path":    agentDir + "/" + g.safeName + ".md",
		"content": agentContent,
	})
	hooksPath := ".cursor/hooks.json"
	if scope != "project" {
		hooksPath = "~/.cursor/hooks.json"
	}
	hooksContent := cursorHooksConfig(g.req.Platform)
	mergeHookComponents(hooksContent, g.hookConfigs, "cursor", a)
	result.Set("hooks_config", map[string]any{"path": hooksPath, "content": hooksContent, "merge": true})
	if hookFiles := collectHookScriptFiles(g.hookConfigs, "cursor"); len(hookFiles) > 0 {
		result.Set("hook_files", hookFiles)
	}
	if len(g.skillConfigs) > 0 {
		result.Set("skill_components", g.skillConfigs)
	}
	if len(g.compatWarnings) > 0 {
		result.Set("_warnings", g.compatWarnings)
	}
	return result
}

// pyRepr renders a string the way a debug literal does in the agent file.
func pyRepr(s string) string {
	if !strings.Contains(s, "'") {
		return "'" + s + "'"
	}
	if !strings.Contains(s, `"`) {
		return `"` + s + `"`
	}
	return "'" + strings.ReplaceAll(s, "'", `\'`) + "'"
}

// ── Copilot (VS Code) ──

type copilotAdapter struct{ base }

func (copilotAdapter) emitsPromptFiles() bool { return true }

func (copilotAdapter) formatHookComponent(command string) any {
	return map[string]any{"type": "command", "command": command}
}

func (a copilotAdapter) formatConfig(g *generation) *Config {
	spec, _ := specOf("copilot")
	copilotConfigs := NewConfig()
	for _, name := range g.mcpConfigs.Keys() {
		cfgAny, _ := g.mcpConfigs.Get(name)
		cfg, _ := cfgAny.(map[string]any)
		entry := map[string]any{}
		for k, v := range cfg {
			entry[k] = v
		}
		if str(cfg["url"]) != "" {
			entry["type"] = strOr(cfg["type"], "sse")
		} else {
			entry["type"] = "stdio"
		}
		copilotConfigs.Set(name, entry)
	}
	desc := g.req.Agent.Description
	if desc == "" {
		desc = g.safeName
	}
	lines := []string{
		"---",
		"name: " + g.safeName,
		fmt.Sprintf("description: %q", desc),
		"target: vscode",
		"tools: ['*']",
		"---",
	}
	agentContent := strings.Join(lines, "\n") + "\n\n" + g.rulesContent

	result := NewConfig()
	result.Set("agent_profile", map[string]any{
		"path":    fmt.Sprintf(".github/agents/%s.agent.md", g.safeName),
		"content": agentContent,
	})
	mcpContent := NewConfig()
	mcpContent.Set(spec.MCPServersKey, copilotConfigs)
	result.Set("mcp_config", map[string]any{"path": spec.MCPConfig["project"], "content": mcpContent})
	result.Set("scope", spec.DefaultScope)
	if promptFiles := generatePromptFiles(g.req); len(promptFiles) > 0 {
		result.Set("prompt_files", promptFiles)
	}
	if len(g.compatWarnings) > 0 {
		result.Set("_warnings", g.compatWarnings)
	}
	return result
}

// ── Copilot CLI ──

type copilotCliAdapter struct{ base }

func (copilotCliAdapter) emitsPromptFiles() bool { return true }

func (copilotCliAdapter) formatHookComponent(command string) any {
	return map[string]any{"type": "command", "command": command}
}

func (a copilotCliAdapter) formatConfig(g *generation) *Config {
	spec, _ := specOf("copilot-cli")
	configs := NewConfig()
	for _, name := range g.mcpConfigs.Keys() {
		cfgAny, _ := g.mcpConfigs.Get(name)
		cfg, _ := cfgAny.(map[string]any)
		entry := map[string]any{}
		for k, v := range cfg {
			entry[k] = v
		}
		if str(cfg["url"]) != "" {
			entry["type"] = strOr(cfg["type"], "sse")
		} else {
			entry["type"] = "stdio"
		}
		entry["tools"] = []any{"*"}
		configs.Set(name, entry)
	}

	desc := g.req.Agent.Description
	if desc == "" {
		desc = g.safeName
	}
	lines := []string{
		"---",
		"name: " + g.safeName,
		fmt.Sprintf("description: %q", desc),
		"tools: ['*']",
	}
	if configs.Len() > 0 {
		lines = append(lines, "mcp-servers:")
		for _, name := range configs.Keys() {
			cfgAny, _ := configs.Get(name)
			cfg, _ := cfgAny.(map[string]any)
			lines = append(lines, "  "+name+":")
			if t := str(cfg["type"]); t != "" {
				lines = append(lines, "    type: "+t)
			}
			if c := str(cfg["command"]); c != "" {
				lines = append(lines, "    command: "+c)
			}
			if args := anyList(cfg["args"]); len(args) > 0 {
				parts := make([]string, 0, len(args))
				for _, arg := range args {
					parts = append(parts, fmt.Sprintf("%v", arg))
				}
				lines = append(lines, "    args: ["+strings.Join(parts, ", ")+"]")
			}
			if u := str(cfg["url"]); u != "" {
				lines = append(lines, "    url: "+u)
			}
		}
	}
	lines = append(lines, "---")
	agentContent := strings.Join(lines, "\n") + "\n\n" + g.rulesContent

	hooksContent := copilotCliHooksConfig()
	mergeHookComponents(hooksContent, g.hookConfigs, "copilot-cli", a)

	skills := []any{}
	for _, s := range g.skillConfigs {
		if file := generateSkillFile(s, "copilot-cli", "project", a); file != nil {
			skills = append(skills, file)
		}
	}

	result := NewConfig()
	result.Set("agent_profile", map[string]any{
		"path":    fmt.Sprintf(".github/agents/%s.agent.md", g.safeName),
		"content": agentContent,
	})
	mcpContent := NewConfig()
	mcpContent.Set(spec.MCPServersKey, configs)
	result.Set("mcp_config", map[string]any{"path": spec.MCPConfig["project"], "content": mcpContent})
	result.Set("hooks_config", map[string]any{"path": ".github/hooks/caracal.json", "content": hooksContent})
	result.Set("scope", spec.DefaultScope)
	if hookFiles := collectHookScriptFiles(g.hookConfigs, "copilot-cli"); len(hookFiles) > 0 {
		result.Set("hook_files", hookFiles)
	}
	if promptFiles := generatePromptFiles(g.req); len(promptFiles) > 0 {
		result.Set("prompt_files", promptFiles)
	}
	if len(skills) > 0 {
		result.Set("skills", skills)
		gitSkills := []any{}
		for _, s := range g.skillConfigs {
			if str(s["git_url"]) != "" {
				gitSkills = append(gitSkills, s)
			}
		}
		result.Set("skill_components", gitSkills)
	}
	if len(g.compatWarnings) > 0 {
		result.Set("_warnings", g.compatWarnings)
	}
	return result
}

func anyList(v any) []any {
	switch list := v.(type) {
	case []any:
		return list
	case []string:
		out := make([]any, 0, len(list))
		for _, s := range list {
			out = append(out, s)
		}
		return out
	}
	return nil
}

// ── Codex ──

type codexAdapter struct{ base }

func (a codexAdapter) formatConfig(g *generation) *Config {
	spec, _ := specOf("codex")
	scope := g.scope(spec.DefaultScope)
	serversKey := spec.MCPServersKey
	if serversKey == "" {
		serversKey = "mcp_servers"
	}
	content := NewConfig()
	content.Set(serversKey, g.mcpConfigs)

	tomlLines := []string{
		"name = " + jsonString(g.safeName),
		"description = " + jsonString(g.truncatedDescription()),
		"developer_instructions = " + jsonString(g.rulesContent),
	}
	if g.req.ResolvedModel != "" {
		tomlLines = append(tomlLines, "model = "+jsonString(g.req.ResolvedModel))
	}

	result := NewConfig()
	result.Set("agent_profile", map[string]any{
		"path":    strings.ReplaceAll(spec.AgentProfile[scope], "{name}", g.safeName),
		"content": strings.Join(tomlLines, "\n") + "\n",
	})
	result.Set("mcp_config", map[string]any{"path": spec.MCPConfig[scope], "content": content})
	result.Set("hooks_config", map[string]any{
		"path":    spec.Hooks[scope],
		"content": codexHooksConfig(g.safeName),
	})
	result.Set("scope", scope)
	if warnings := g.allWarnings(); len(warnings) > 0 {
		result.Set("_warnings", warnings)
	}
	return result
}

func jsonString(s string) string {
	blob, _ := json.Marshal(s)
	return string(blob)
}

// ── OpenCode ──

type opencodeAdapter struct{ base }

func (opencodeAdapter) agentMcpEntry(ctx *mcpContext) any {
	if ctx.URL != "" {
		entry := map[string]any{"type": "remote", "url": ctx.URL}
		if len(ctx.Headers) > 0 {
			entry["headers"] = ctx.Headers
		}
		if len(ctx.ServerEnv) > 0 {
			entry["env"] = ctx.ServerEnv
		}
		return entry
	}
	entry := map[string]any{"type": "local", "command": append([]string{ctx.Command}, ctx.Args...)}
	if len(ctx.ServerEnv) > 0 {
		entry["environment"] = ctx.ServerEnv
	}
	return entry
}

func (opencodeAdapter) formatModel(model, provider string) string {
	if strings.Contains(model, "/") {
		return model
	}
	return provider + "/" + model
}

func (a opencodeAdapter) formatConfig(g *generation) *Config {
	spec, _ := specOf("opencode")
	scope := g.scope(spec.DefaultScope)

	opencodeMcp := NewConfig()
	for _, name := range g.mcpConfigs.Keys() {
		vAny, _ := g.mcpConfigs.Get(name)
		v, _ := vAny.(map[string]any)
		entryType := str(v["type"])
		if entryType == "local" || entryType == "remote" {
			entry := map[string]any{}
			for k, val := range v {
				entry[k] = val
			}
			if env, ok := entry["env"]; ok {
				if _, has := entry["environment"]; !has {
					entry["environment"] = env
					delete(entry, "env")
				}
			}
			opencodeMcp.Set(name, entry)
			continue
		}
		cmdArray := []any{v["command"]}
		cmdArray = append(cmdArray, anyList(v["args"])...)
		entry := map[string]any{"type": "local", "command": cmdArray}
		if env, ok := v["env"]; ok && !emptyValue(env) {
			entry["environment"] = env
		}
		opencodeMcp.Set(name, entry)
	}

	rulesPath := strings.ReplaceAll(spec.AgentProfile[scope], "{name}", g.safeName)
	mcpPath, ok := spec.MCPConfig[scope]
	if !ok {
		for _, v := range spec.MCPConfig {
			mcpPath = v
			break
		}
	}
	content := NewConfig()
	content.Set(spec.MCPServersKey, opencodeMcp)
	if g.req.ResolvedModel != "" {
		content.Set("model", g.req.ResolvedModel)
	}

	result := NewConfig()
	result.Set("agent_profile", map[string]any{"path": rulesPath, "content": g.rulesContent})
	result.Set("mcp_config", map[string]any{"path": mcpPath, "content": content})
	result.Set("scope", scope)
	if len(g.skillConfigs) > 0 {
		result.Set("skill_components", g.skillConfigs)
	}
	if len(g.hookConfigs) > 0 {
		plugins := collectOpencodeHookPlugins(g.hookConfigs)
		scripts := collectHookScriptFiles(g.hookConfigs, "opencode")
		if len(plugins)+len(scripts) > 0 {
			result.Set("hook_files", append(plugins, scripts...))
		}
	}
	if warnings := g.allWarnings(); len(warnings) > 0 {
		result.Set("_warnings", warnings)
	}
	return result
}

func emptyValue(v any) bool {
	switch t := v.(type) {
	case map[string]any:
		return len(t) == 0
	case map[string]string:
		return len(t) == 0
	case nil:
		return true
	}
	return false
}

// ── Goose ──

type gooseAdapter struct{ base }

func (gooseAdapter) agentMcpEntry(ctx *mcpContext) any {
	var entry map[string]any
	if ctx.URL != "" {
		headers := any(ctx.Headers)
		if ctx.Headers == nil {
			headers = map[string]string{}
		}
		entry = map[string]any{
			"type": "streamable_http", "name": ctx.Name, "enabled": true,
			"uri": ctx.URL, "headers": headers,
		}
	} else {
		entry = map[string]any{
			"type": "stdio", "name": ctx.Name, "enabled": true,
			"cmd": ctx.Command, "args": ctx.Args,
		}
	}
	envs := any(ctx.ServerEnv)
	if ctx.ServerEnv == nil {
		envs = map[string]string{}
	}
	entry["envs"] = envs
	entry["env_keys"] = []any{}
	entry["timeout"] = 300
	return entry
}

func (gooseAdapter) formatHookComponent(command string) any {
	return map[string]any{"hooks": []any{map[string]any{"type": "command", "command": command}}}
}

func (a gooseAdapter) formatConfig(g *generation) *Config {
	spec, _ := specOf("goose")
	scope := g.scope(spec.DefaultScope)

	frontmatter := [][2]string{{"name", g.safeName}, {"description", g.truncatedDescription()}}
	if g.req.ResolvedModel != "" {
		frontmatter = append(frontmatter, [2]string{"model", g.req.ResolvedModel})
	}
	var fm strings.Builder
	for _, kv := range frontmatter {
		fm.WriteString(kv[0])
		fm.WriteString(": ")
		fm.WriteString(yamlScalarValue(kv[1]))
		fm.WriteString("\n")
	}
	agentContent := "---\n" + fm.String() + "---\n\n" + g.rulesContent

	result := NewConfig()
	result.Set("agent_profile", map[string]any{
		"path":    strings.ReplaceAll(spec.AgentProfile[scope], "{name}", g.safeName),
		"content": agentContent,
	})
	result.Set("scope", scope)

	if g.mcpConfigs.Len() > 0 {
		extensions := NewConfig()
		for _, name := range g.mcpConfigs.Keys() {
			entryAny, _ := g.mcpConfigs.Get(name)
			extensions.Set(name, gooseAsExtension(name, entryAny))
		}
		content := NewConfig()
		content.Set(spec.MCPServersKey, extensions)
		result.Set("mcp_config", map[string]any{"path": spec.MCPConfig["user"], "content": content})
	}

	hooksContent := gooseHooksConfig(g.req.Platform)
	mergeHookComponents(hooksContent, g.hookConfigs, "goose", a)
	hooksPath := spec.Hooks[scope]
	result.Set("hooks_config", map[string]any{"path": hooksPath, "content": hooksContent, "merge": true})

	manifest, _ := json.MarshalIndent(map[string]any{
		"name": "caracal", "version": "1.0.0",
		"description": "Caracal session telemetry and hook components for goose",
	}, "", "  ")
	hookFiles := []map[string]any{{
		"path":    strings.Replace(hooksPath, "hooks/hooks.json", "plugin.json", 1),
		"content": string(manifest) + "\n",
	}}
	hookFiles = append(hookFiles, collectHookScriptFiles(g.hookConfigs, "goose")...)
	result.Set("hook_files", hookFiles)

	if len(g.skillConfigs) > 0 {
		result.Set("skill_components", g.skillConfigs)
	}
	if warnings := g.allWarnings(); len(warnings) > 0 {
		result.Set("_warnings", warnings)
	}
	return result
}

func gooseAsExtension(name string, entryAny any) any {
	entry, ok := entryAny.(map[string]any)
	if !ok {
		return entryAny
	}
	t := str(entry["type"])
	if t == "stdio" || t == "streamable_http" {
		return entry
	}
	extension := map[string]any{
		"type": "stdio", "name": name, "enabled": true,
		"cmd": entry["command"], "args": anyListOrEmpty(entry["args"]),
		"envs": dictOrEmpty(entry["env"]), "env_keys": []any{}, "timeout": 300,
	}
	if u := str(entry["url"]); u != "" {
		extension["type"] = "streamable_http"
		extension["uri"] = u
		extension["headers"] = dictOrEmpty(entry["headers"])
		delete(extension, "cmd")
		delete(extension, "args")
	}
	return extension
}

func anyListOrEmpty(v any) []any {
	if l := anyList(v); l != nil {
		return l
	}
	return []any{}
}

func dictOrEmpty(v any) any {
	switch t := v.(type) {
	case map[string]any:
		return t
	case map[string]string:
		return t
	}
	return map[string]any{}
}

// ── Antigravity ──

type antigravityAdapter struct{ base }

func (a antigravityAdapter) formatConfig(g *generation) *Config {
	spec, _ := specOf("antigravity")
	scope := g.scope(spec.DefaultScope)
	content := NewConfig()
	content.Set("name", g.safeName)
	content.Set("description", g.truncatedDescription())
	content.Set("system_prompt", g.rulesContent)
	content.Set("mcpServers", g.mcpConfigs)
	content.Set("tools", []any{"*"})
	var model any
	if g.req.ResolvedModel != "" {
		model = g.req.ResolvedModel
	}
	content.Set("model", model)

	result := NewConfig()
	result.Set("agent_profile", map[string]any{
		"path":    strings.ReplaceAll(spec.AgentProfile[scope], "{name}", g.safeName),
		"content": content,
	})
	result.Set("scope", scope)

	if g.mcpConfigs.Len() > 0 {
		mcpPath, ok := spec.MCPConfig[scope]
		if !ok {
			mcpPath = spec.MCPConfig["user"]
		}
		mcpContent := NewConfig()
		mcpContent.Set(spec.MCPServersKey, g.mcpConfigs)
		result.Set("mcp_config", map[string]any{"path": mcpPath, "content": mcpContent})
	}

	skills := []any{}
	skillPathTemplate, ok := spec.Skills[scope]
	if !ok {
		skillPathTemplate = spec.Skills["user"]
	}
	for _, skill := range g.skillConfigs {
		name := strOr(skill["name"], "unnamed")
		content := str(skill["skill_md_content"])
		if content == "" {
			content = fmt.Sprintf("---\nname: %s\ndescription: %s\n---\n", name, str(skill["description"]))
		}
		skills = append(skills, map[string]any{
			"path":    strings.ReplaceAll(skillPathTemplate, "{name}", name),
			"content": content,
		})
	}
	if len(skills) > 0 {
		result.Set("skills", skills)
	}
	if warnings := g.allWarnings(); len(warnings) > 0 {
		result.Set("_warnings", warnings)
	}
	return result
}

// ── Pi ──

type piAdapter struct{ base }

func (a piAdapter) formatConfig(g *generation) *Config {
	spec, _ := specOf("pi")
	scope := g.scope(spec.DefaultScope)
	agentName := g.safeName
	rewrite := func(p string) string {
		if strings.HasPrefix(p, "~/.pi/agent/") {
			return strings.Replace(p, "~/.pi/agent/", "~/.pi/agent/agents/"+agentName+"/", 1)
		}
		if strings.HasPrefix(p, ".pi/") {
			return strings.Replace(p, ".pi/", ".pi/agents/"+agentName+"/", 1)
		}
		return p
	}

	result := NewConfig()
	if g.rulesContent != "" {
		rulesPath, ok := spec.AgentProfile[scope]
		if !ok {
			rulesPath = spec.AgentProfile["user"]
			if rulesPath == "" {
				rulesPath = "AGENTS.md"
			}
		}
		result.Set("agent_profile", map[string]any{
			"path":    rewrite(strings.ReplaceAll(rulesPath, "{name}", agentName)),
			"content": g.rulesContent,
		})
	}
	if g.mcpConfigs.Len() > 0 {
		mcpPath, ok := spec.MCPConfig[scope]
		if !ok {
			mcpPath = spec.MCPConfig["user"]
		}
		if mcpPath != "" {
			content := NewConfig()
			content.Set("mcpServers", g.mcpConfigs)
			result.Set("mcp_config", map[string]any{"path": rewrite(mcpPath), "content": content})
		}
	}
	if len(g.skillConfigs) > 0 {
		skillPath, ok := spec.Skills[scope]
		if !ok {
			skillPath = spec.Skills["user"]
		}
		rewritten := []any{}
		for _, skill := range g.skillConfigs {
			copy := skillConfig{}
			for k, v := range skill {
				copy[k] = v
			}
			if name := str(skill["name"]); skillPath != "" && name != "" {
				copy["path"] = rewrite(strings.ReplaceAll(skillPath, "{name}", name))
			}
			rewritten = append(rewritten, copy)
		}
		result.Set("skill_components", rewritten)
	}
	return result
}
