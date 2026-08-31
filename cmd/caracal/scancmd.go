// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

// ── discovered item documents (attribute order matters) ────────────

type discoveredMcp struct {
	Name        string
	Command     any
	Args        []any
	URL         any
	Description string
	Source      string
}

func (m discoveredMcp) doc() *omap {
	doc := newOmap()
	doc.set("name", m.Name)
	doc.set("command", m.Command)
	if m.Args == nil {
		doc.set("args", []any{})
	} else {
		doc.set("args", m.Args)
	}
	doc.set("url", m.URL)
	doc.set("description", m.Description)
	doc.set("source", m.Source)
	return doc
}

type discoveredSkill struct {
	Name        string
	Description string
	Source      string
	TaskType    string
}

func (s discoveredSkill) doc() *omap {
	doc := newOmap()
	doc.set("name", s.Name)
	doc.set("description", s.Description)
	doc.set("source", s.Source)
	doc.set("task_type", orDefault(s.TaskType, "general"))
	return doc
}

type discoveredHook struct {
	Name          string
	Event         string
	HandlerType   string
	HandlerConfig any
	Description   string
	Source        string
}

func (h discoveredHook) doc() *omap {
	doc := newOmap()
	doc.set("name", h.Name)
	doc.set("event", h.Event)
	doc.set("handler_type", h.HandlerType)
	if h.HandlerConfig == nil {
		doc.set("handler_config", newOmap())
	} else {
		doc.set("handler_config", h.HandlerConfig)
	}
	doc.set("description", h.Description)
	doc.set("source", h.Source)
	return doc
}

type discoveredAgent struct {
	Name        string
	Description string
	ModelName   string
	Prompt      string
	SourceFile  string
}

func (a discoveredAgent) doc() *omap {
	doc := newOmap()
	doc.set("name", a.Name)
	doc.set("description", a.Description)
	doc.set("model_name", a.ModelName)
	doc.set("prompt", a.Prompt)
	doc.set("source_file", a.SourceFile)
	return doc
}

type scanResult struct {
	MCPs   []discoveredMcp
	Skills []discoveredSkill
	Hooks  []discoveredHook
	Agents []discoveredAgent
}

// ── shared helpers ─────────────────────────────────────────────────

var frontmatterBlockRe = regexp.MustCompile(`(?s)^---\s*\n(.*?)\n---`)

func parseFrontmatterField(content, field string) string {
	match := frontmatterBlockRe.FindStringSubmatch(content)
	if match == nil {
		return ""
	}
	for _, line := range strings.Split(match[1], "\n") {
		if strings.HasPrefix(line, field+":") {
			value := strings.TrimSpace(line[len(field)+1:])
			value = strings.Trim(value, `"`)
			value = strings.Trim(value, `'`)
			return value
		}
	}
	return ""
}

func firstContentLine(content string) string {
	inFrontmatter, pastFrontmatter := false, false
	for _, line := range strings.Split(content, "\n") {
		stripped := strings.TrimSpace(line)
		if stripped == "---" {
			if !inFrontmatter {
				inFrontmatter = true
			} else {
				pastFrontmatter = true
			}
			continue
		}
		if inFrontmatter && !pastFrontmatter {
			continue
		}
		if pastFrontmatter && stripped != "" && !strings.HasPrefix(stripped, "#") {
			if len(stripped) > 200 {
				return stripped[:200]
			}
			return stripped
		}
	}
	return ""
}

// extractServerMap applies the shared mcpServers lookup with shape fallback.
func extractServerMap(config *omap, keys ...string) *omap {
	if config == nil {
		return newOmap()
	}
	if len(keys) == 0 {
		keys = []string{"mcpServers"}
	}
	for _, key := range keys {
		if servers := config.object(key); servers != nil {
			return servers
		}
	}
	scan := newOmap()
	for _, name := range config.keys {
		entry, ok := config.get(name).(*omap)
		if !ok {
			continue
		}
		if entry.has("command") || entry.has("url") || entry.has("type") {
			scan.set(name, entry)
		}
	}
	return scan
}

func loadOrderedFile(path string) *omap {
	blob, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	value, err := decodeOrderedJSON(blob)
	if err != nil {
		return nil
	}
	doc, _ := value.(*omap)
	return doc
}

var jsoncCommentRe = regexp.MustCompile(`(?s)("(?:[^"\\]|\\.)*")|//[^\n]*|/\*.*?\*/`)

func loadJSONCFile(path string) *omap {
	blob, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	cleaned := jsoncCommentRe.ReplaceAllStringFunc(string(blob), func(match string) string {
		if strings.HasPrefix(match, `"`) {
			return match
		}
		return ""
	})
	value, err := decodeOrderedJSON([]byte(cleaned))
	if err != nil {
		return nil
	}
	doc, _ := value.(*omap)
	return doc
}

func mcpFromEntry(name string, entry *omap, description, source string) discoveredMcp {
	args := entry.array("args")
	return discoveredMcp{
		Name: name, Command: plain(entry.get("command")), Args: plainList(args),
		URL: plain(entry.get("url")), Description: description, Source: source,
	}
}

func scanSkillFiles(dir, sourceLabel, fallbackPrefix string) []discoveredSkill {
	matches := []string{}
	_ = filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() && info.Name() == "SKILL.md" {
			matches = append(matches, path)
		}
		return nil
	})
	sort.Strings(matches)
	skills := []discoveredSkill{}
	for _, path := range matches {
		blob, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		content := string(blob)
		name := filepath.Base(filepath.Dir(path))
		description := parseFrontmatterField(content, "description")
		if description == "" {
			description = firstContentLine(content)
		}
		if description == "" {
			description = fallbackPrefix + name
		}
		taskType := parseFrontmatterField(content, "task_type")
		skills = append(skills, discoveredSkill{Name: name, Description: description, Source: sourceLabel, TaskType: taskType})
	}
	return skills
}

// ── per-harness scanners ───────────────────────────────────────────

func scanClaudeCodeHome(home string) scanResult {
	result := scanResult{}
	claudeDir := filepath.Join(home, ".claude")
	if _, err := os.Stat(claudeDir); err != nil {
		return result
	}
	settings := loadOrderedFile(filepath.Join(claudeDir, "settings.json"))
	if settings == nil {
		return result
	}
	active := map[string]bool{}
	if plugins := settings.object("enabledPlugins"); plugins != nil {
		for _, key := range plugins.keys {
			if enabled, ok := plugins.get(key).(bool); ok && enabled {
				active[key] = true
			}
		}
	}
	pluginPaths := map[string]string{}
	if installed := loadOrderedFile(filepath.Join(claudeDir, "plugins", "installed_plugins.json")); installed != nil {
		if plugins := installed.object("plugins"); plugins != nil {
			for _, key := range plugins.keys {
				if !active[key] {
					continue
				}
				entries, _ := plugins.get(key).([]any)
				if len(entries) == 0 {
					continue
				}
				if entry, ok := entries[0].(*omap); ok && entry.str("installPath") != "" {
					pluginPaths[key] = entry.str("installPath")
				}
			}
		}
	}
	for _, key := range sortedKeys(active) {
		pluginDir, ok := pluginPaths[key]
		if !ok || pluginDir == "" {
			continue
		}
		info, err := os.Stat(pluginDir)
		if err != nil || !info.IsDir() {
			continue
		}
		pluginName := strings.SplitN(key, "@", 2)[0]
		pluginDesc := "Plugin: " + pluginName
		if meta := loadOrderedFile(filepath.Join(pluginDir, ".claude-plugin", "plugin.json")); meta != nil {
			if desc := meta.str("description"); desc != "" {
				pluginDesc = desc
			}
		}
		if config := loadOrderedFile(filepath.Join(pluginDir, ".mcp.json")); config != nil {
			servers := extractServerMap(config)
			for _, serverName := range servers.keys {
				entry, ok := servers.get(serverName).(*omap)
				if !ok {
					continue
				}
				result.MCPs = append(result.MCPs, mcpFromEntry(serverName, entry, pluginDesc, "plugin:"+pluginName))
			}
		}
		for _, skill := range scanSkillFiles(pluginDir, "plugin:"+pluginName, "Skill from "+pluginName+": ") {
			skill.Name = pluginName + "/" + skill.Name
			skill.TaskType = ""
			result.Skills = append(result.Skills, skill)
		}
	}
	result.Skills = append(result.Skills, scanSkillFiles(filepath.Join(claudeDir, "skills"), "claude:skills", "Skill: ")...)
	agentFiles, _ := filepath.Glob(filepath.Join(claudeDir, "agents", "*.md"))
	sort.Strings(agentFiles)
	for _, path := range agentFiles {
		blob, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		content := string(blob)
		name := strings.TrimSuffix(filepath.Base(path), ".md")
		description := firstContentLine(content)
		if description == "" {
			description = "Agent: " + name
		}
		body := content
		if match := regexp.MustCompile(`(?s)^---\s*\n.*?\n---\s*\n?`).FindString(content); match != "" {
			body = content[len(match):]
		}
		result.Agents = append(result.Agents, discoveredAgent{
			Name: name, Description: description, ModelName: parseFrontmatterField(content, "model"),
			Prompt: body, SourceFile: path,
		})
	}
	return result
}

func scanClaudeCodeProject(projectDir string) scanResult {
	result := scanResult{}
	config := loadOrderedFile(filepath.Join(projectDir, ".mcp.json"))
	if config == nil {
		return result
	}
	servers := extractServerMap(config)
	for _, name := range servers.keys {
		entry, ok := servers.get(name).(*omap)
		if !ok {
			continue
		}
		result.MCPs = append(result.MCPs, mcpFromEntry(name, entry, fmt.Sprintf("Claude Code project MCP: %s", name), "claude-code:project"))
	}
	return result
}

func scanKiroHome(home string) scanResult {
	result := scanResult{}
	kiroDir := filepath.Join(home, ".kiro")
	if _, err := os.Stat(kiroDir); err != nil {
		return result
	}
	seen := map[string]bool{}
	if config := loadOrderedFile(filepath.Join(kiroDir, "settings", "mcp.json")); config != nil {
		servers := extractServerMap(config)
		for _, name := range servers.keys {
			entry, ok := servers.get(name).(*omap)
			if !ok || seen[name] {
				continue
			}
			seen[name] = true
			result.MCPs = append(result.MCPs, mcpFromEntry(name, entry, fmt.Sprintf("Kiro global MCP: %s", name), "kiro:global"))
		}
	}
	profileFiles, _ := filepath.Glob(filepath.Join(kiroDir, "agents", "*.json"))
	sort.Strings(profileFiles)
	for _, path := range profileFiles {
		if strings.TrimSuffix(filepath.Base(path), ".json") == "kiro_default" {
			continue
		}
		profile := loadOrderedFile(path)
		if profile == nil {
			continue
		}
		name := orDefault(profile.str("name"), strings.TrimSuffix(filepath.Base(path), ".json"))
		description := profile.str("description")
		if description == "" {
			description = "Kiro agent: " + name
		}
		result.Agents = append(result.Agents, discoveredAgent{
			Name: name, Description: description, ModelName: profile.str("model"),
			Prompt: profile.str("prompt"), SourceFile: path,
		})
		if servers := profile.object("mcpServers"); servers != nil {
			for _, serverName := range servers.keys {
				entry, ok := servers.get(serverName).(*omap)
				if !ok || seen[serverName] {
					continue
				}
				seen[serverName] = true
				result.MCPs = append(result.MCPs, mcpFromEntry(serverName, entry,
					fmt.Sprintf("From Kiro agent: %s", name), fmt.Sprintf("kiro:agent:%s", name)))
			}
		}
		if hooks := profile.object("hooks"); hooks != nil {
			for _, event := range hooks.keys {
				var handlerConfig any = newOmap()
				if entries := hooks.array(event); len(entries) > 0 {
					if first, ok := entries[0].(*omap); ok {
						handlerConfig = first
					}
				}
				result.Hooks = append(result.Hooks, discoveredHook{
					Name: fmt.Sprintf("kiro:%s/%s", name, event), Event: event, HandlerType: "command",
					HandlerConfig: handlerConfig,
					Description:   fmt.Sprintf("Kiro hook: %s on agent %s", event, name),
					Source:        fmt.Sprintf("kiro:agent:%s", name),
				})
			}
		}
	}
	result.Skills = append(result.Skills, scanSkillFiles(filepath.Join(kiroDir, "skills"), "kiro:skills", "Kiro skill: ")...)
	return result
}

func scanKiroProject(projectDir string) scanResult {
	result := scanResult{}
	config := loadOrderedFile(filepath.Join(projectDir, ".kiro", "settings", "mcp.json"))
	if config == nil {
		return result
	}
	servers := extractServerMap(config)
	for _, name := range servers.keys {
		entry, ok := servers.get(name).(*omap)
		if !ok {
			continue
		}
		result.MCPs = append(result.MCPs, mcpFromEntry(name, entry, fmt.Sprintf("Kiro project MCP: %s", name), "kiro:project"))
	}
	return result
}

func scanMCPFile(path, descriptionFormat, source string, keys ...string) []discoveredMcp {
	config := loadOrderedFile(path)
	if config == nil {
		return nil
	}
	servers := extractServerMap(config, keys...)
	mcps := []discoveredMcp{}
	for _, name := range servers.keys {
		entry, ok := servers.get(name).(*omap)
		if !ok {
			continue
		}
		mcps = append(mcps, mcpFromEntry(name, entry, fmt.Sprintf(descriptionFormat, name), source))
	}
	return mcps
}

func scanCodexTOML(path, descriptionFormat, source string) []discoveredMcp {
	blob, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	mcps := []discoveredMcp{}
	var current *discoveredMcp
	flush := func() {
		if current != nil {
			mcps = append(mcps, *current)
			current = nil
		}
	}
	for _, line := range strings.Split(string(blob), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[mcp.servers.") && strings.HasSuffix(trimmed, "]") {
			flush()
			name := strings.TrimSuffix(strings.TrimPrefix(trimmed, "[mcp.servers."), "]")
			name = strings.Trim(name, `"`)
			current = &discoveredMcp{Name: name, Args: []any{},
				Description: fmt.Sprintf(descriptionFormat, name), Source: source}
			continue
		}
		if strings.HasPrefix(trimmed, "[") {
			flush()
			continue
		}
		if current == nil {
			continue
		}
		key, value, found := strings.Cut(trimmed, "=")
		if !found {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		switch key {
		case "command":
			current.Command = strings.Trim(value, `"`)
		case "url":
			current.URL = strings.Trim(value, `"`)
		case "args":
			inner := strings.Trim(value, "[]")
			args := []any{}
			for _, part := range strings.Split(inner, ",") {
				part = strings.TrimSpace(part)
				if part != "" {
					args = append(args, strings.Trim(part, `"`))
				}
			}
			current.Args = args
		}
	}
	flush()
	return mcps
}

func scanOpencodeDir(configDir, source string, includeMCPs bool) scanResult {
	result := scanResult{}
	if includeMCPs {
		config := loadJSONCFile(filepath.Join(configDir, "opencode.json"))
		if config == nil {
			config = loadJSONCFile(filepath.Join(configDir, "opencode.jsonc"))
		}
		if config != nil {
			if servers := config.object("mcp"); servers != nil {
				for _, name := range servers.keys {
					entry, ok := servers.get(name).(*omap)
					if !ok {
						continue
					}
					mcp := discoveredMcp{Name: name, Description: fmt.Sprintf("OpenCode MCP: %s", name), Source: source, Args: []any{}}
					switch command := entry.get("command").(type) {
					case []any:
						if len(command) > 0 {
							mcp.Command = plain(command[0])
							mcp.Args = plainList(command[1:])
						}
					default:
						mcp.Command = plain(entry.get("command"))
						mcp.Args = plainList(entry.array("args"))
					}
					mcp.URL = plain(entry.get("url"))
					result.MCPs = append(result.MCPs, mcp)
				}
			}
		}
	}
	skillsDir := filepath.Join(configDir, "skills")
	if entries, err := os.ReadDir(skillsDir); err == nil {
		names := []string{}
		for _, entry := range entries {
			if entry.IsDir() {
				names = append(names, entry.Name())
			}
		}
		sort.Strings(names)
		for _, name := range names {
			blob, err := os.ReadFile(filepath.Join(skillsDir, name, "SKILL.md"))
			if err != nil {
				continue
			}
			result.Skills = append(result.Skills, discoveredSkill{
				Name: name, Description: opencodeFrontmatterField(string(blob), "description"), Source: source,
			})
		}
	}
	agentsDir := filepath.Join(configDir, "agents")
	if entries, err := os.ReadDir(agentsDir); err == nil {
		names := []string{}
		for _, entry := range entries {
			if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".md") {
				names = append(names, entry.Name())
			}
		}
		sort.Strings(names)
		for _, fileName := range names {
			blob, err := os.ReadFile(filepath.Join(agentsDir, fileName))
			if err != nil {
				continue
			}
			content := string(blob)
			name := strings.TrimSuffix(fileName, ".md")
			description := opencodeFrontmatterField(content, "description")
			if description == "" {
				description = "Agent: " + name
			}
			result.Agents = append(result.Agents, discoveredAgent{
				Name: name, Description: description, ModelName: opencodeFrontmatterField(content, "model"),
				Prompt: content, SourceFile: filepath.Join(agentsDir, fileName),
			})
		}
	}
	pluginsDir := filepath.Join(configDir, "plugins")
	if entries, err := os.ReadDir(pluginsDir); err == nil {
		names := []string{}
		for _, entry := range entries {
			ext := filepath.Ext(entry.Name())
			if !entry.IsDir() && (ext == ".ts" || ext == ".js" || ext == ".mjs") {
				names = append(names, entry.Name())
			}
		}
		sort.Strings(names)
		for _, fileName := range names {
			name := strings.TrimSuffix(fileName, filepath.Ext(fileName))
			result.Hooks = append(result.Hooks, discoveredHook{
				Name: name, Event: "plugin", HandlerType: "plugin", HandlerConfig: newOmap(),
				Description: fmt.Sprintf("OpenCode plugin hook: %s", name), Source: source,
			})
		}
	}
	return result
}

func opencodeFrontmatterField(content, field string) string {
	if !strings.HasPrefix(content, "---") {
		return ""
	}
	parts := strings.SplitN(content, "---", 3)
	if len(parts) < 3 {
		return ""
	}
	for _, line := range strings.Split(parts[1], "\n") {
		if strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t") {
			continue
		}
		stripped := strings.TrimSpace(line)
		if strings.HasPrefix(stripped, field+":") {
			value := strings.TrimSpace(stripped[len(field)+1:])
			if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
				value = value[1 : len(value)-1]
			}
			return value
		}
	}
	return ""
}

func scanGooseHome(home string) scanResult {
	result := scanResult{}
	configDir := filepath.Join(home, ".config", "goose")
	agentsRoot := gooseAgentsHome(home)
	configInfo, configErr := os.Stat(configDir)
	agentsInfo, agentsErr := os.Stat(agentsRoot)
	if (configErr != nil || !configInfo.IsDir()) && (agentsErr != nil || !agentsInfo.IsDir()) {
		return result
	}
	if blob, err := os.ReadFile(filepath.Join(configDir, "config.yaml")); err == nil {
		var node yaml.Node
		if yaml.Unmarshal(blob, &node) == nil {
			doc, _ := yamlNodeToOmap(&node).(*omap)
			if doc != nil {
				if extensions := doc.object("extensions"); extensions != nil {
					for _, name := range extensions.keys {
						entry, ok := extensions.get(name).(*omap)
						if !ok {
							continue
						}
						entryType := fmt.Sprint(plain(entry.get("type")))
						if entryType != "stdio" && entryType != "streamable_http" && entryType != "sse" {
							continue
						}
						displayName := orDefault(entry.str("display_name"), orDefault(entry.str("name"), name))
						mcp := discoveredMcp{
							Name: orDefault(entry.str("name"), name), Args: []any{},
							Description: fmt.Sprintf("Goose extension: %s", displayName), Source: "goose:global",
						}
						if command := entry.get("cmd"); truthy(command) {
							mcp.Command = plain(command)
						} else {
							mcp.Command = plain(entry.get("command"))
						}
						if args, ok := entry.get("args").([]any); ok {
							mcp.Args = plainList(args)
						}
						if url := entry.get("uri"); truthy(url) {
							mcp.URL = plain(url)
						} else {
							mcp.URL = plain(entry.get("url"))
						}
						result.MCPs = append(result.MCPs, mcp)
					}
				}
			}
		}
	}
	result.Skills = append(result.Skills, scanGooseSkills(filepath.Join(agentsRoot, "skills"), "goose:skills")...)
	result.Hooks = append(result.Hooks, scanGoosePlugins(filepath.Join(agentsRoot, "plugins"), "goose:plugins")...)
	result.Agents = append(result.Agents, scanGooseAgents(filepath.Join(agentsRoot, "agents"))...)
	return result
}

func scanGooseSkills(dir, source string) []discoveredSkill {
	matches, _ := filepath.Glob(filepath.Join(dir, "*", "SKILL.md"))
	sort.Strings(matches)
	skills := []discoveredSkill{}
	for _, path := range matches {
		blob, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		content := string(blob)
		name := filepath.Base(filepath.Dir(path))
		description := parseFrontmatterField(content, "description")
		if description == "" {
			description = firstContentLine(content)
		}
		if description == "" {
			description = "Skill: " + name
		}
		skills = append(skills, discoveredSkill{Name: name, Description: description, Source: source})
	}
	return skills
}

func scanGoosePlugins(dir, source string) []discoveredHook {
	matches, _ := filepath.Glob(filepath.Join(dir, "*", "hooks", "hooks.json"))
	sort.Strings(matches)
	hooks := []discoveredHook{}
	for _, path := range matches {
		pluginName := filepath.Base(filepath.Dir(filepath.Dir(path)))
		doc := loadOrderedFile(path)
		if doc == nil {
			continue
		}
		declared := doc.object("hooks")
		if declared == nil {
			continue
		}
		for _, event := range declared.keys {
			for _, rawRule := range declared.array(event) {
				rule, ok := rawRule.(*omap)
				if !ok {
					continue
				}
				for _, rawHandler := range rule.array("hooks") {
					handler, ok := rawHandler.(*omap)
					if !ok {
						continue
					}
					hooks = append(hooks, discoveredHook{
						Name: pluginName, Event: event,
						HandlerType: orDefault(handler.str("type"), "command"), HandlerConfig: handler,
						Description: fmt.Sprintf("Goose plugin hook: %s (%s)", pluginName, event), Source: source,
					})
				}
			}
		}
	}
	return hooks
}

func scanGooseAgents(dir string) []discoveredAgent {
	matches, _ := filepath.Glob(filepath.Join(dir, "*.md"))
	sort.Strings(matches)
	agents := []discoveredAgent{}
	for _, path := range matches {
		content := ""
		if blob, err := os.ReadFile(path); err == nil {
			content = string(blob)
		}
		name := orDefault(parseFrontmatterField(content, "name"), strings.TrimSuffix(filepath.Base(path), ".md"))
		description := parseFrontmatterField(content, "description")
		if description == "" {
			description = "Agent: " + name
		}
		prompt := content
		if len(prompt) > 500 {
			prompt = prompt[:500]
		}
		agents = append(agents, discoveredAgent{
			Name: name, Description: description, ModelName: parseFrontmatterField(content, "model"),
			Prompt: prompt, SourceFile: path,
		})
	}
	return agents
}

func scanCopilotCliHooksDir(dir string) []discoveredHook {
	matches, _ := filepath.Glob(filepath.Join(dir, "*.json"))
	sort.Strings(matches)
	hooks := []discoveredHook{}
	for _, path := range matches {
		doc := loadOrderedFile(path)
		if doc == nil {
			continue
		}
		declared := doc.object("hooks")
		if declared == nil {
			continue
		}
		stem := strings.TrimSuffix(filepath.Base(path), ".json")
		for _, event := range declared.keys {
			for _, rawEntry := range declared.array(event) {
				entry, ok := rawEntry.(*omap)
				if !ok {
					continue
				}
				hooks = append(hooks, discoveredHook{
					Name: fmt.Sprintf("%s/%s", stem, event), Event: event, HandlerType: "command",
					HandlerConfig: entry, Description: fmt.Sprintf("Hook from %s: %s", stem, event),
					Source: "copilot-cli:hooks",
				})
			}
		}
	}
	return hooks
}

func scanCopilotCliAgents(dir string) []discoveredAgent {
	agents := []discoveredAgent{}
	addAgent := func(path, name string) {
		blob, err := os.ReadFile(path)
		if err != nil {
			return
		}
		content := string(blob)
		description := parseFrontmatterField(content, "description")
		if description == "" {
			description = firstContentLine(content)
		}
		if description == "" {
			description = "Agent: " + name
		}
		agents = append(agents, discoveredAgent{
			Name: name, Description: description, ModelName: parseFrontmatterField(content, "model"),
			Prompt: "", SourceFile: path,
		})
	}
	agentFiles, _ := filepath.Glob(filepath.Join(dir, "*.agent.md"))
	sort.Strings(agentFiles)
	for _, path := range agentFiles {
		name := strings.TrimSuffix(strings.TrimSuffix(filepath.Base(path), ".md"), ".agent")
		addAgent(path, name)
	}
	plainFiles, _ := filepath.Glob(filepath.Join(dir, "*.md"))
	sort.Strings(plainFiles)
	for _, path := range plainFiles {
		if strings.HasSuffix(path, ".agent.md") {
			continue
		}
		addAgent(path, strings.TrimSuffix(filepath.Base(path), ".md"))
	}
	return agents
}

// ── hook detection ─────────────────────────────────────────────────

func markerIn(haystack string) bool {
	for _, marker := range caracalHookMarkers {
		if strings.Contains(haystack, marker) {
			return true
		}
	}
	return false
}

func detectHooksFor(name, home, homeDir string) string {
	switch name {
	case "cursor":
		doc := loadJSONCFile(filepath.Join(home, ".cursor", "hooks.json"))
		if doc == nil {
			doc = loadOrderedFile(filepath.Join(home, ".cursor", "hooks.json"))
		}
		if doc == nil {
			return "missing"
		}
		hooks := doc.object("hooks")
		if hooks == nil || hooks.len() == 0 {
			return "missing"
		}
		found := 0
		for _, event := range []string{"beforeSubmitPrompt", "stop"} {
			for _, rawEntry := range hooks.array(event) {
				if entry, ok := rawEntry.(*omap); ok && markerIn(entry.str("command")) {
					found++
					break
				}
			}
		}
		if found >= 2 {
			return "installed"
		}
		if found > 0 {
			return "partial"
		}
		return "missing"
	case "pi":
		if info, err := os.Stat(filepath.Join(homeDir, "extensions", "caracal.ts")); err == nil && !info.IsDir() {
			return "installed"
		}
		return "missing"
	case "claude-code":
		settings := loadOrderedFile(filepath.Join(homeDir, "settings.json"))
		if settings == nil {
			return "missing"
		}
		hooks := settings.object("hooks")
		if hooks == nil || hooks.len() == 0 {
			return "missing"
		}
		found := 0
		for _, event := range hooks.keys {
			for _, rawGroup := range hooks.array(event) {
				group, ok := rawGroup.(*omap)
				if !ok {
					continue
				}
				for _, rawHook := range group.array("hooks") {
					if hook, ok := rawHook.(*omap); ok && markerIn(hook.str("command")+hook.str("url")) {
						found++
						break
					}
				}
			}
		}
		if found >= 3 {
			return "installed"
		}
		if found > 0 {
			return "partial"
		}
		return "missing"
	case "kiro":
		agentsDir := filepath.Join(homeDir, "agents")
		profiles, _ := filepath.Glob(filepath.Join(agentsDir, "*.json"))
		kept := []string{}
		for _, path := range profiles {
			if strings.TrimSuffix(filepath.Base(path), ".json") != "kiro_default" {
				kept = append(kept, path)
			}
		}
		if len(kept) == 0 {
			return "missing"
		}
		hooked := 0
		for _, path := range kept {
			profile := loadOrderedFile(path)
			if profile == nil {
				continue
			}
			matched := false
			if hooks := profile.object("hooks"); hooks != nil {
				for _, event := range hooks.keys {
					for _, rawHook := range hooks.array(event) {
						if hook, ok := rawHook.(*omap); ok && markerIn(hook.str("command")) {
							matched = true
						}
					}
				}
			}
			if matched {
				hooked++
			}
		}
		if hooked == len(kept) {
			return "installed"
		}
		if hooked > 0 {
			return "partial"
		}
		return "missing"
	case "codex":
		doc := loadOrderedFile(filepath.Join(home, ".codex", "hooks.json"))
		if doc == nil {
			return "missing"
		}
		hooks := doc.object("hooks")
		if hooks == nil || hooks.len() == 0 {
			return "missing"
		}
		for _, event := range hooks.keys {
			for _, rawGroup := range hooks.array(event) {
				group, ok := rawGroup.(*omap)
				if !ok {
					continue
				}
				for _, rawHook := range group.array("hooks") {
					if hook, ok := rawHook.(*omap); ok && markerIn(hook.str("command")) {
						return "installed"
					}
				}
			}
		}
		return "missing"
	case "copilot":
		check := func(dir string) bool {
			matches, _ := filepath.Glob(filepath.Join(dir, "*.json"))
			for _, path := range matches {
				doc := loadOrderedFile(path)
				if doc == nil {
					continue
				}
				hooks := doc.object("hooks")
				if hooks == nil {
					continue
				}
				for _, event := range hooks.keys {
					for _, rawEntry := range hooks.array(event) {
						entry, ok := rawEntry.(*omap)
						if !ok {
							continue
						}
						command := orDefault(entry.str("command"), entry.str("bash"))
						if strings.Contains(command, "caracal") || strings.Contains(command, "session_push") ||
							strings.Contains(command, "session-push") {
							return true
						}
					}
				}
			}
			return false
		}
		hooksDir := homeDir
		if filepath.Base(homeDir) == ".vscode" {
			hooksDir = filepath.Join(filepath.Dir(homeDir), ".github", "hooks")
		}
		if check(hooksDir) || check(filepath.Join(home, ".copilot", "hooks")) {
			return "installed"
		}
		return "missing"
	case "copilot-cli":
		hasHooks := func(dir string) bool {
			matches, _ := filepath.Glob(filepath.Join(dir, "*.json"))
			for _, path := range matches {
				doc := loadOrderedFile(path)
				if doc == nil {
					continue
				}
				hooks := doc.object("hooks")
				if hooks == nil {
					continue
				}
				for _, event := range hooks.keys {
					for _, rawEntry := range hooks.array(event) {
						if entry, ok := rawEntry.(*omap); ok && markerIn(entry.str("bash")+entry.str("command")) {
							return true
						}
					}
				}
			}
			return false
		}
		if hasHooks(filepath.Join(homeDir, "hooks")) || hasHooks(filepath.Join(homeDir, ".github", "hooks")) {
			return "installed"
		}
		return "missing"
	case "opencode":
		pluginsDir := filepath.Join(homeDir, "plugins")
		entries, err := os.ReadDir(pluginsDir)
		if err != nil {
			return "missing"
		}
		for _, entry := range entries {
			ext := filepath.Ext(entry.Name())
			if ext != ".ts" && ext != ".js" && ext != ".mjs" {
				continue
			}
			blob, err := os.ReadFile(filepath.Join(pluginsDir, entry.Name()))
			if err != nil {
				continue
			}
			content := string(blob)
			if strings.Contains(content, "CaracalPlugin") || strings.Contains(strings.ToLower(content), "caracal") {
				return "installed"
			}
		}
		return "missing"
	case "antigravity":
		hooksPath := filepath.Join(homeDir, "hooks.json")
		if _, err := os.Stat(hooksPath); err != nil {
			if dir := antigravityConfigDir(home); dir != "" {
				hooksPath = filepath.Join(dir, "hooks.json")
			}
		}
		doc := loadOrderedFile(hooksPath)
		if doc == nil {
			return "missing"
		}
		if doc.has("caracal-telemetry") {
			return "installed"
		}
		return "missing"
	case "goose":
		hooksPath := filepath.Join(homeDir, "plugins", "caracal", "hooks", "hooks.json")
		if _, err := os.Stat(hooksPath); err != nil {
			hooksPath = filepath.Join(gooseAgentsHome(home), "plugins", "caracal", "hooks", "hooks.json")
		}
		doc := loadOrderedFile(hooksPath)
		if doc == nil {
			return "missing"
		}
		hooks := doc.object("hooks")
		installed := 0
		for _, event := range []string{"SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"} {
			matched := false
			if hooks != nil {
				for _, rawRule := range hooks.array(event) {
					rule, ok := rawRule.(*omap)
					if !ok {
						continue
					}
					for _, rawHandler := range rule.array("hooks") {
						if handler, ok := rawHandler.(*omap); ok && markerIn(handler.str("command")+handler.str("url")) {
							matched = true
						}
					}
				}
			}
			if matched {
				installed++
			}
		}
		if installed == 4 {
			return "installed"
		}
		if installed > 0 {
			return "partial"
		}
		return "missing"
	}
	return "n/a"
}

// ── the scan command ───────────────────────────────────────────────

var scanAdapterOrder = []string{
	"antigravity", "claude-code", "codex", "copilot", "copilot-cli",
	"cursor", "goose", "kiro", "opencode", "pi",
}

var scanHomeDirs = map[string]string{
	"claude-code": "~/.claude", "kiro": "~/.kiro", "codex": "~/.codex",
	"copilot": "~/.vscode", "copilot-cli": "~/.copilot",
	"opencode": "~/.config/opencode", "antigravity": "~/.gemini",
	"cursor": "~/.cursor", "pi": "~/.pi/agent",
}

func scanHarness(name, home, projectDir string) (scanResult, scanResult) {
	switch name {
	case "claude-code":
		return scanClaudeCodeHome(home), scanClaudeCodeProject(projectDir)
	case "kiro":
		return scanKiroHome(home), scanKiroProject(projectDir)
	case "cursor":
		homeResult := scanResult{MCPs: scanMCPFile(filepath.Join(home, ".cursor", "mcp.json"), "Cursor global MCP: %s", "cursor:global")}
		projResult := scanResult{MCPs: scanMCPFile(filepath.Join(projectDir, ".cursor", "mcp.json"), "Cursor project MCP: %s", "cursor:project")}
		return homeResult, projResult
	case "pi":
		homeResult := scanResult{}
		piDir := filepath.Join(home, ".pi", "agent")
		if _, err := os.Stat(piDir); err == nil {
			homeResult.MCPs = scanMCPFile(filepath.Join(piDir, "mcp.json"), "Pi MCP: %s", "pi:global")
			homeResult.Skills = scanSkillFiles(filepath.Join(piDir, "skills"), "pi:skills", "Skill: ")
		}
		projResult := scanResult{}
		projPi := filepath.Join(projectDir, ".pi")
		projResult.MCPs = scanMCPFile(filepath.Join(projPi, "mcp.json"), "Pi MCP: %s", "pi:project")
		projResult.Skills = scanSkillFiles(filepath.Join(projPi, "skills"), "pi:skills", "Skill: ")
		return homeResult, projResult
	case "codex":
		homeResult := scanResult{}
		if _, err := os.Stat(filepath.Join(home, ".codex")); err == nil {
			homeResult.MCPs = scanCodexTOML(filepath.Join(home, ".codex", "config.toml"), "Codex MCP: %s", "codex:global")
		}
		projResult := scanResult{MCPs: scanCodexTOML(filepath.Join(projectDir, ".codex", "config.toml"), "Codex project MCP: %s", "codex:project")}
		return homeResult, projResult
	case "copilot":
		homeResult := scanResult{}
		if _, err := os.Stat(filepath.Join(home, ".vscode")); err == nil {
			homeResult.MCPs = scanMCPFile(filepath.Join(home, ".vscode", "mcp.json"), "Copilot MCP: %s", "copilot:global", "servers", "mcpServers")
		}
		projResult := scanResult{MCPs: scanMCPFile(filepath.Join(projectDir, ".vscode", "mcp.json"), "Copilot project MCP: %s", "copilot:project", "servers", "mcpServers")}
		return homeResult, projResult
	case "copilot-cli":
		homeResult := scanResult{}
		copilotDir := filepath.Join(home, ".copilot")
		if _, err := os.Stat(copilotDir); err == nil {
			homeResult.MCPs = scanMCPFile(filepath.Join(copilotDir, "mcp-config.json"), "Copilot CLI MCP: %s", "copilot-cli:global", "mcpServers")
			homeResult.Skills = scanSkillFiles(filepath.Join(copilotDir, "skills"), "copilot-cli:skills", "Skill: ")
			homeResult.Hooks = scanCopilotCliHooksDir(filepath.Join(copilotDir, "hooks"))
		}
		projResult := scanResult{
			MCPs:   scanMCPFile(filepath.Join(projectDir, ".mcp.json"), "Copilot CLI MCP: %s", "copilot-cli:project", "mcpServers"),
			Skills: scanSkillFiles(filepath.Join(projectDir, ".agents", "skills"), "copilot-cli:skills", "Skill: "),
			Agents: scanCopilotCliAgents(filepath.Join(projectDir, ".github", "agents")),
			Hooks:  scanCopilotCliHooksDir(filepath.Join(projectDir, ".github", "hooks")),
		}
		return homeResult, projResult
	case "opencode":
		homeResult := scanResult{}
		configDir := filepath.Join(home, ".config", "opencode")
		if _, err := os.Stat(configDir); err == nil {
			homeResult = scanOpencodeDir(configDir, "opencode:global", true)
		}
		projResult := scanResult{MCPs: []discoveredMcp{}}
		if config := loadOrderedFile(filepath.Join(projectDir, "opencode.json")); config != nil {
			if servers := config.object("mcp"); servers != nil {
				for _, serverName := range servers.keys {
					entry, ok := servers.get(serverName).(*omap)
					if !ok {
						continue
					}
					projResult.MCPs = append(projResult.MCPs, mcpFromEntry(serverName, entry,
						fmt.Sprintf("OpenCode MCP: %s", serverName), "opencode:project"))
				}
			}
		}
		projectSub := scanOpencodeDir(filepath.Join(projectDir, ".opencode"), "opencode:project", false)
		projResult.Skills = projectSub.Skills
		projResult.Agents = projectSub.Agents
		projResult.Hooks = projectSub.Hooks
		return homeResult, projResult
	case "antigravity":
		homeResult := scanResult{}
		configDir := antigravityConfigDir(home)
		agDir := filepath.Join(home, ".gemini", "antigravity-cli")
		if _, err := os.Stat(agDir); err != nil {
			agDir = configDir
		}
		if configDir != "" || agDir != "" {
			if configDir == "" {
				configDir = agDir
			}
			homeResult.MCPs = scanAntigravityMCPs(filepath.Join(configDir, "mcp_config.json"), "antigravity:global")
			homeResult.Skills = scanSkillFiles(filepath.Join(configDir, "skills"), "antigravity:skills", "Skill: ")
			homeResult.Hooks = scanAntigravityHooks(filepath.Join(configDir, "hooks.json"))
			homeResult.Agents = scanAntigravityAgents(filepath.Join(agDir, "agents"))
		}
		projResult := scanResult{}
		projAg := filepath.Join(projectDir, ".agents")
		if _, err := os.Stat(projAg); err == nil {
			projResult.MCPs = scanAntigravityMCPs(filepath.Join(projAg, "mcp_config.json"), "antigravity:project")
			projResult.Skills = scanSkillFiles(filepath.Join(projAg, "skills"), "antigravity:skills", "Skill: ")
		}
		return homeResult, projResult
	case "goose":
		return scanGooseHome(home), scanGooseProject(projectDir)
	}
	return scanResult{}, scanResult{}
}

func scanAntigravityMCPs(path, source string) []discoveredMcp {
	config := loadOrderedFile(path)
	if config == nil {
		return nil
	}
	servers := extractServerMap(config)
	mcps := []discoveredMcp{}
	for _, name := range servers.keys {
		entry, ok := servers.get(name).(*omap)
		if !ok {
			continue
		}
		mcp := mcpFromEntry(name, entry, fmt.Sprintf("Antigravity MCP: %s", name), source)
		if url := entry.get("serverUrl"); truthy(url) {
			mcp.URL = plain(url)
		}
		mcps = append(mcps, mcp)
	}
	return mcps
}

func scanAntigravityHooks(path string) []discoveredHook {
	doc := loadOrderedFile(path)
	if doc == nil {
		return nil
	}
	hooks := []discoveredHook{}
	for _, hookName := range doc.keys {
		hookDef, ok := doc.get(hookName).(*omap)
		if !ok {
			continue
		}
		for _, event := range hookDef.keys {
			if event == "enabled" {
				continue
			}
			entries, ok := hookDef.get(event).([]any)
			if !ok {
				continue
			}
			for _, rawEntry := range entries {
				entry, ok := rawEntry.(*omap)
				if !ok {
					continue
				}
				handlers := []any{entry}
				if inner, ok := entry.get("hooks").([]any); ok {
					handlers = inner
				}
				for _, rawHandler := range handlers {
					handler, ok := rawHandler.(*omap)
					if !ok {
						continue
					}
					hooks = append(hooks, discoveredHook{
						Name: hookName, Event: event, HandlerType: "command", HandlerConfig: handler,
						Description: fmt.Sprintf("Hook: %s", event), Source: "antigravity:hooks",
					})
				}
			}
		}
	}
	return hooks
}

func scanAntigravityAgents(dir string) []discoveredAgent {
	matches, _ := filepath.Glob(filepath.Join(dir, "*", "agent.json"))
	sort.Strings(matches)
	agents := []discoveredAgent{}
	for _, path := range matches {
		name := filepath.Base(filepath.Dir(path))
		description, model, prompt, content := "", "", "", ""
		if blob, err := os.ReadFile(path); err == nil {
			content = string(blob)
			if doc := loadOrderedFile(path); doc != nil {
				name = orDefault(doc.str("name"), name)
				description = doc.str("description")
				model = doc.str("model")
				prompt = doc.str("system_prompt")
			}
		}
		if description == "" {
			description = "Agent: " + name
		}
		body := orDefault(prompt, content)
		if len(body) > 500 {
			body = body[:500]
		}
		agents = append(agents, discoveredAgent{Name: name, Description: description, ModelName: model, Prompt: body, SourceFile: path})
	}
	return agents
}

func scanGooseProject(projectDir string) scanResult {
	result := scanResult{}
	agentsRoot := filepath.Join(projectDir, ".agents")
	if info, err := os.Stat(agentsRoot); err != nil || !info.IsDir() {
		return result
	}
	result.Skills = scanGooseSkills(filepath.Join(agentsRoot, "skills"), "goose:project")
	result.Hooks = scanGoosePlugins(filepath.Join(agentsRoot, "plugins"), "goose:project")
	result.Agents = scanGooseAgents(filepath.Join(agentsRoot, "agents"))
	return result
}

func scanCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "scan", Short: "Discover installed harness components", Args: cobra.NoArgs}
	harnessFlag := cmd.Flags().StringP("harness", "i", "", "Filter to a specific harness")
	mode := outputFlag(cmd)
	cmd.RunE = func(_ *cobra.Command, _ []string) error {
		if *harnessFlag != "" && !contains(scanAdapterOrder, *harnessFlag) {
			valid := append([]string{}, scanAdapterOrder...)
			sort.Strings(valid)
			fmt.Fprintf(os.Stderr, "Unknown harness: %s\n", *harnessFlag)
			fmt.Fprintf(os.Stderr, "Valid harnesses: %s\n", strings.Join(valid, ", "))
			os.Exit(1)
		}
		home, _ := os.UserHomeDir()
		projectDir, _ := os.Getwd()
		allMCPs := []discoveredMcp{}
		allSkills := []discoveredSkill{}
		allHooks := []discoveredHook{}
		allAgents := []discoveredAgent{}
		seenMCPNames := map[string]bool{}
		type harnessStatus struct{ name, hooks string }
		statuses := []harnessStatus{}
		selected := scanAdapterOrder
		if *harnessFlag != "" {
			selected = []string{*harnessFlag}
		}
		appendMCPs := func(mcps []discoveredMcp) {
			for _, mcp := range mcps {
				if !seenMCPNames[mcp.Name] {
					seenMCPNames[mcp.Name] = true
					allMCPs = append(allMCPs, mcp)
				}
			}
		}
		for _, name := range selected {
			var homeDir string
			if name == "goose" {
				configDir := filepath.Join(home, ".config", "goose")
				dataDir := filepath.Join(home, ".local", "share", "goose")
				if info, err := os.Stat(configDir); err == nil && info.IsDir() {
					homeDir = configDir
				} else if info, err := os.Stat(dataDir); err == nil && info.IsDir() {
					homeDir = dataDir
				} else {
					continue
				}
			} else {
				label := scanHomeDirs[name]
				homeDir = strings.Replace(label, "~", home, 1)
				if info, err := os.Stat(homeDir); err != nil || !info.IsDir() {
					continue
				}
			}
			homeResult, projResult := scanHarness(name, home, projectDir)
			appendMCPs(homeResult.MCPs)
			appendMCPs(projResult.MCPs)
			allSkills = append(allSkills, homeResult.Skills...)
			allSkills = append(allSkills, projResult.Skills...)
			allHooks = append(allHooks, homeResult.Hooks...)
			allHooks = append(allHooks, projResult.Hooks...)
			allAgents = append(allAgents, homeResult.Agents...)
			allAgents = append(allAgents, projResult.Agents...)
			statuses = append(statuses, harnessStatus{name, detectHooksFor(name, home, homeDir)})
			if projectDir != home {
				_, extra := scanHarness(name, home, home)
				appendMCPs(extra.MCPs)
			}
		}
		total := len(allMCPs) + len(allSkills) + len(allHooks) + len(allAgents)
		if total == 0 && len(statuses) == 0 {
			if *mode == "json" {
				outputJSONRaw([]byte(`{"harnesses": [], "mcps": [], "skills": [], "hooks": [], "agents": []}`))
				return nil
			}
			fmt.Println("No harness configurations found.")
			os.Exit(1)
		}
		doc := newOmap()
		harnessDocs := []any{}
		for _, status := range statuses {
			entry := newOmap()
			entry.set("name", status.name)
			entry.set("hooks", status.hooks)
			harnessDocs = append(harnessDocs, entry)
		}
		doc.set("harnesses", harnessDocs)
		mcpDocs := []any{}
		for _, mcp := range allMCPs {
			mcpDocs = append(mcpDocs, mcp.doc())
		}
		doc.set("mcps", mcpDocs)
		skillDocs := []any{}
		for _, skill := range allSkills {
			skillDocs = append(skillDocs, skill.doc())
		}
		doc.set("skills", skillDocs)
		hookDocs := []any{}
		for _, hook := range allHooks {
			hookDocs = append(hookDocs, hook.doc())
		}
		doc.set("hooks", hookDocs)
		agentDocs := []any{}
		for _, agent := range allAgents {
			agentDocs = append(agentDocs, agent.doc())
		}
		doc.set("agents", agentDocs)
		blob, err := marshalOrdered(doc)
		if err != nil {
			return err
		}
		if *mode == "json" {
			outputJSONRaw(blob)
			return nil
		}
		printDocumentSummary(blob)
		return nil
	}
	return cmd
}

func sortedKeys(m map[string]bool) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
