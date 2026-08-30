// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package harnessgen

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"

	"github.com/garudex-labs/caracal/internal/harness"
)

func harnessCapability(name string) harness.Capability {
	return harness.Capability(name)
}

// typeLabels order component sections in the rules document.
var typeLabels = []struct{ Type, Heading string }{
	{"mcp", "MCP Servers"}, {"skill", "Skills"}, {"hook", "Hooks"},
	{"prompt", "Prompts"}, {"sandbox", "Sandboxes"},
}

// buildRulesContent assembles the agent prompt and a component summary.
// Prompt templates inline their content when listings are provided; sandbox
// listings inject usage instructions with the run command.
func buildRulesContent(req *Request, promptListings map[string]Listing) string {
	agent := req.Agent
	sections := []string{}
	if agent.Prompt != "" {
		sections = append(sections, agent.Prompt)
	}

	displayName := func(componentID string) string {
		if n, ok := req.ComponentNames[componentID]; ok {
			return n
		}
		if len(componentID) >= 8 {
			return componentID[:8]
		}
		return componentID
	}
	byType := map[string][]string{}
	for _, comp := range agent.Components {
		byType[comp.Type] = append(byType[comp.Type], displayName(comp.ID))
	}

	for _, tl := range typeLabels {
		names := byType[tl.Type]
		if len(names) == 0 {
			continue
		}
		switch {
		case tl.Type == "prompt" && len(promptListings) > 0:
			lines := []string{"## " + tl.Heading, ""}
			for _, comp := range agent.Components {
				if comp.Type != "prompt" {
					continue
				}
				listing, ok := promptListings[comp.ID]
				if !ok {
					continue
				}
				pname := displayName(comp.ID)
				if template := listing.str("template"); template != "" {
					lines = append(lines, "### "+pname, "", template, "")
				} else {
					lines = append(lines, "- **"+pname+"**")
				}
			}
			sections = append(sections, strings.Join(lines, "\n"))
		case tl.Type == "sandbox" && len(req.SandboxLists) > 0:
			lines := []string{
				"## Sandboxes",
				"",
				"You have access to isolated execution environments. Use these to run code safely.",
			}
			for _, comp := range agent.Components {
				if comp.Type != "sandbox" {
					continue
				}
				listing, ok := req.SandboxLists[comp.ID]
				if !ok {
					continue
				}
				limits := listing.dict("resource_limits")
				timeout, memory := any(300), any(512)
				if v, ok := limits["timeout"]; ok {
					timeout = v
				}
				if v, ok := limits["memory_mb"]; ok {
					memory = v
				}
				image := listing.str("image")
				lines = append(lines, "",
					"### "+displayName(comp.ID),
					fmt.Sprintf("- **Image:** `%s`", image),
					fmt.Sprintf("- **Timeout:** %vs | **Memory:** %vMB | **Network:** %s",
						jsonNumber(timeout), jsonNumber(memory), listing.strOr("network_policy", "none")))
				if entrypoint := listing.str("entrypoint"); entrypoint != "" {
					lines = append(lines, fmt.Sprintf("- **Default command:** `%s`", entrypoint))
				}
				lines = append(lines, fmt.Sprintf(
					`- **Run:** `+"`"+`caracal sandbox run --sandbox-id %s --image %s --timeout %v --command "<your command>"`+"`",
					comp.ID, image, jsonNumber(timeout)))
			}
			sections = append(sections, strings.Join(lines, "\n"))
		default:
			lines := []string{"## " + tl.Heading, ""}
			for _, n := range names {
				lines = append(lines, "- **"+n+"**")
			}
			sections = append(sections, strings.Join(lines, "\n"))
		}
	}
	if len(sections) == 0 {
		return "# " + agent.Name
	}
	return strings.Join(sections, "\n\n")
}

// jsonNumber renders numeric row values without a float exponent tail.
func jsonNumber(v any) string {
	switch n := v.(type) {
	case float64:
		if n == float64(int64(n)) {
			return fmt.Sprintf("%d", int64(n))
		}
		return fmt.Sprintf("%v", n)
	default:
		return fmt.Sprintf("%v", v)
	}
}

// generatePromptFiles builds native prompt files for harnesses with
// first-class prompt support.
func generatePromptFiles(req *Request) []map[string]any {
	if len(req.PromptListings) == 0 {
		return nil
	}
	order := listingOrder(req.Agent, "prompt", req.PromptListings)
	localNames := localRegistryNames(order, req.PromptListings)
	files := []map[string]any{}
	for _, comp := range req.Agent.Components {
		if comp.Type != "prompt" {
			continue
		}
		listing, ok := req.PromptListings[comp.ID]
		if !ok {
			continue
		}
		template := listing.str("template")
		if template == "" {
			continue
		}
		rawName := localNames[comp.ID]
		if rawName == "" {
			if n, ok := req.ComponentNames[comp.ID]; ok {
				rawName = n
			} else {
				rawName = comp.ID[:8]
			}
		}
		safe := sanitizeName(rawName)
		description := listing.strOr("description", rawName)
		descYAML := strings.SplitN(strings.ReplaceAll(description, `"`, "'"), "\n", 2)[0]
		content := fmt.Sprintf("---\ndescription: \"%s\"\n---\n\n%s\n",
			descYAML, strings.TrimRight(template, " \t\n"))
		files = append(files, map[string]any{
			"path":    fmt.Sprintf(".github/prompts/%s.prompt.md", safe),
			"content": content,
		})
	}
	return files
}

// mergeHookComponents folds hook components into a harness hooks config.
func mergeHookComponents(hooksContent map[string]any, hookConfigs []hookConfig, harnessName string, adapter adapter) {
	spec, _ := specOf(harnessName)
	eventsMap := map[string]string{}
	scriptsDir := ""
	if spec != nil {
		eventsMap = spec.HookEventsMap
		scriptsDir = spec.HookScriptsDir
	}
	hooksDict, ok := hooksContent["hooks"].(map[string]any)
	if !ok {
		hooksDict = map[string]any{}
		hooksContent["hooks"] = hooksDict
	}
	for _, hc := range hookConfigs {
		event := hc.str("event")
		if event == "" {
			continue
		}
		ideEvent := event
		if mapped, ok := eventsMap[event]; ok {
			ideEvent = mapped
		}
		command := str(hc.dict("handler_config")["command"])
		scriptFilename := hc.str("script_filename")
		if scriptFilename != "" && scriptsDir != "" {
			command = scriptsDir + "/" + scriptFilename
		} else if command == "" {
			continue
		}
		entries, _ := hooksDict[ideEvent].([]any)
		hooksDict[ideEvent] = append(entries, adapter.formatHookComponent(command))
	}
}

// collectHookScriptFiles lists hook scripts to write on install.
func collectHookScriptFiles(hookConfigs []hookConfig, harnessName string) []map[string]any {
	spec, _ := specOf(harnessName)
	if spec == nil || spec.HookScriptsDir == "" {
		return nil
	}
	files := []map[string]any{}
	for _, hc := range hookConfigs {
		content := hc.str("script_content")
		filename := hc.str("script_filename")
		if content != "" && filename != "" {
			files = append(files, map[string]any{
				"path":       spec.HookScriptsDir + "/" + filename,
				"content":    content,
				"executable": true,
			})
		}
	}
	return files
}

// ── Telemetry hook fragments shared across adapters ──

const sessionPushCmd = "caracal hook session-push"

var sessionPushEvents = []string{"UserPromptSubmit", "Stop"}

// claudeCodeHooksFrontmatterLines renders the hooks: frontmatter section:
// session-push telemetry on the two JSONL events plus custom hook matchers.
func claudeCodeHooksFrontmatterLines(customHooks []hookConfig) []string {
	byEvent := map[string][]hookConfig{}
	eventOrder := []string{}
	for _, h := range customHooks {
		ev := h.str("event")
		if ev == "" {
			continue
		}
		if _, seen := byEvent[ev]; !seen {
			eventOrder = append(eventOrder, ev)
		}
		byEvent[ev] = append(byEvent[ev], h)
	}
	lines := []string{"hooks:"}
	for _, event := range sessionPushEvents {
		lines = append(lines,
			"  "+event+":",
			"    - hooks:",
			"        - type: command",
			fmt.Sprintf("          command: %q", sessionPushCmd))
		for _, ch := range byEvent[event] {
			lines = append(lines, customHookMatcherLines(ch)...)
		}
	}
	for _, event := range eventOrder {
		if event == "UserPromptSubmit" || event == "Stop" {
			continue
		}
		lines = append(lines, "  "+event+":")
		for _, ch := range byEvent[event] {
			lines = append(lines, customHookMatcherLines(ch)...)
		}
	}
	return lines
}

func customHookMatcherLines(hook hookConfig) []string {
	handlerConfig := hook.dict("handler_config")
	if hook.str("handler_type") == "http" {
		timeout := any(10)
		if v, ok := handlerConfig["timeout"]; ok {
			timeout = v
		}
		return []string{
			"    - hooks:",
			"        - type: http",
			fmt.Sprintf("          url: %q", str(handlerConfig["url"])),
			fmt.Sprintf("          timeout: %v", jsonNumber(timeout)),
		}
	}
	command := str(handlerConfig["command"])
	if scriptFilename := hook.str("script_filename"); scriptFilename != "" && command == scriptFilename {
		command = ".claude/hooks/" + scriptFilename
	}
	if command == "" {
		return nil
	}
	return []string{"    - hooks:", "        - type: command", fmt.Sprintf("          command: %q", command)}
}

// cursorHooksConfig is the telemetry hooks file for Cursor.
func cursorHooksConfig(platform string) map[string]any {
	cmd := sessionPushCmd + " --harness cursor"
	if platform == "win32" {
		cmd = "caracal hook session-push --harness cursor"
	}
	return map[string]any{
		"version": 1,
		"hooks": map[string]any{
			"beforeSubmitPrompt": []any{map[string]any{"command": cmd, "type": "command"}},
			"stop":               []any{map[string]any{"command": cmd, "type": "command"}},
		},
	}
}

var copilotCliHookEvents = []string{
	"sessionStart", "sessionEnd", "userPromptSubmitted", "preToolUse", "postToolUse",
}

// copilotCliHooksConfig is the telemetry hooks file for Copilot CLI.
func copilotCliHooksConfig() map[string]any {
	hooks := map[string]any{}
	for _, event := range copilotCliHookEvents {
		hooks[event] = []any{map[string]any{
			"type":       "command",
			"bash":       sessionPushCmd + " --harness copilot-cli",
			"powershell": "caracal hook session-push --harness copilot-cli",
			"timeoutSec": 5,
		}}
	}
	return map[string]any{"version": 1, "hooks": hooks}
}

// codexHooksConfig is the telemetry hooks file for Codex CLI.
func codexHooksConfig(agentName string) map[string]any {
	cmd := "caracal hook session-push --harness codex"
	if agentName != "" {
		cmd = "CARACAL_AGENT_NAME=" + agentName + " " + cmd
	}
	entry := func() []any {
		return []any{map[string]any{
			"matcher": "",
			"hooks":   []any{map[string]any{"type": "command", "command": cmd}},
		}}
	}
	return map[string]any{
		"hooks": map[string]any{"UserPromptSubmit": entry(), "Stop": entry()},
	}
}

var gooseHookEvents = []string{"SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"}

// gooseHooksConfig is the telemetry plugin hooks file for goose.
func gooseHooksConfig(platform string) map[string]any {
	command := sessionPushCmd + " --harness goose"
	if platform == "win32" {
		command = "caracal hook session-push --harness goose"
	}
	hooks := map[string]any{}
	for _, event := range gooseHookEvents {
		hooks[event] = []any{map[string]any{
			"hooks": []any{map[string]any{"type": "command", "command": command, "timeout": 30}},
		}}
	}
	return map[string]any{"hooks": hooks}
}

// collectOpencodeHookPlugins renders one TypeScript plugin per hook component.
func collectOpencodeHookPlugins(hookConfigs []hookConfig) []map[string]any {
	spec, _ := specOf("opencode")
	eventsMap := map[string]string{}
	if spec != nil {
		eventsMap = spec.HookEventsMap
	}
	plugins := []map[string]any{}
	for _, hc := range hookConfigs {
		event := hc.str("event")
		if event == "" {
			continue
		}
		handlerConfig := hc.dict("handler_config")
		handlerType := hc.str("handler_type")
		if handlerType == "" {
			handlerType = "command"
		}
		command := str(handlerConfig["command"])
		name := hc.str("name")
		if name == "" {
			name = "hook-" + strings.ToLower(event)
		}
		safeName := sanitizeName(name)
		ideEvent := event
		if mapped, ok := eventsMap[event]; ok {
			ideEvent = mapped
		}
		if filename, content := hc.str("script_filename"), hc.str("script_content"); filename != "" && content != "" {
			command = ".opencode/hooks/" + filename
		}
		if command == "" && handlerType != "http" {
			continue
		}
		var source string
		if handlerType == "http" {
			timeout := 10
			if v, ok := handlerConfig["timeout"].(float64); ok {
				timeout = int(v)
			}
			source = opencodeHTTPHookPlugin(safeName, ideEvent, str(handlerConfig["url"]), timeout)
		} else {
			source = opencodeCommandHookPlugin(safeName, ideEvent, command)
		}
		plugins = append(plugins, map[string]any{
			"path":    fmt.Sprintf(".opencode/plugins/hook-%s.ts", safeName),
			"content": source,
		})
	}
	return plugins
}

func opencodeCommandHookPlugin(name, event, command string) string {
	cmdJSON, _ := json.Marshal(command)
	return fmt.Sprintf(`// Caracal hook plugin: %s
// Event: %s
// Auto-generated by `+"`caracal pull`"+`

import { execSync } from "child_process";

const HOOK_COMMAND = %s;

export const Hook_%s = async (ctx) => {
  return {
    event: async ({ event }) => {
      if (event?.type === "%s") {
        try {
          execSync(HOOK_COMMAND, {
            cwd: ctx.directory,
            timeout: 10000,
            stdio: ["pipe", "pipe", "pipe"],
            shell: true,
          });
        } catch {
          // Non-blocking: don't break the session
        }
      }
    },
  };
};
`, name, event, cmdJSON, strings.ReplaceAll(name, "-", "_"), event)
}

func opencodeHTTPHookPlugin(name, event, rawURL string, timeout int) string {
	parsed, err := url.Parse(rawURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return fmt.Sprintf("// Caracal hook plugin: %s - SKIPPED (invalid URL)\nexport {};\n", name)
	}
	urlJSON, _ := json.Marshal(rawURL)
	reqModule := "http"
	if strings.HasPrefix(rawURL, "https") {
		reqModule = "https"
	}
	return fmt.Sprintf(`// Caracal hook plugin: %s
// Event: %s
// Auto-generated by `+"`caracal pull`"+`

import { request } from "%s";

const HOOK_URL = %s;

export const Hook_%s = async (ctx) => {
  return {
    event: async ({ event }) => {
      if (event?.type === "%s") {
        try {
          const body = JSON.stringify({ event: event?.type, properties: event?.properties || {} });
          const req = request(HOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
            timeout: %d,
          });
          req.on("error", () => {});
          req.on("timeout", () => { req.destroy(); });
          req.write(body);
          req.end();
        } catch {
          // Non-blocking
        }
      }
    },
  };
};
`, name, event, reqModule, urlJSON, strings.ReplaceAll(name, "-", "_"), event, timeout*1000)
}

// ── Model helpers ──

var modelShortNames = []string{"sonnet", "opus", "haiku"}

// modelNameToFrontmatter converts a stored model name into a frontmatter
// short name where one applies.
func modelNameToFrontmatter(modelName string) string {
	if modelName == "" {
		return ""
	}
	lower := strings.ToLower(modelName)
	for _, short := range modelShortNames {
		if strings.Contains(lower, short) {
			return short
		}
	}
	return modelName
}

// wrapKiroPrompt frames the prompt as agent specialization so identity
// guardrails don't reject it.
func wrapKiroPrompt(prompt, agentName string) string {
	if prompt == "" {
		return prompt
	}
	return fmt.Sprintf("# %s - Agent Specialization\n\n"+
		"You are a Kiro agent with the following specialization.\n\n"+
		"## Instructions\n\n%s", agentName, prompt)
}

// yamlScalarValue quotes only when a plain scalar would be ambiguous.
func yamlScalarValue(s string) string {
	if s == "" {
		return "''"
	}
	if strings.ContainsAny(s, "\n\"\\") {
		blob, _ := json.Marshal(s)
		return string(blob)
	}
	if strings.ContainsAny(s, ":#{}[]&*!|>'%@`,") || strings.HasPrefix(s, "- ") || s != strings.TrimSpace(s) {
		return "'" + strings.ReplaceAll(s, "'", "''") + "'"
	}
	return s
}

// yamlFrontmatter renders ordered key/value pairs as a frontmatter block.
func yamlFrontmatter(pairs [][2]string) string {
	var b strings.Builder
	b.WriteString("---\n")
	for _, kv := range pairs {
		b.WriteString(kv[0])
		b.WriteString(": ")
		b.WriteString(yamlScalarValue(kv[1]))
		b.WriteString("\n")
	}
	b.WriteString("---\n\n")
	return b.String()
}

// generateSkillFile renders one harness-specific skill file, or nil for
// harnesses that inline skills into the rules document.
func generateSkillFile(skill skillConfig, harnessName, scope string, adapter adapter) map[string]any {
	spec, ok := specOf(strings.ReplaceAll(harnessName, "_", "-"))
	if !ok || len(spec.Skills) == 0 {
		return nil
	}
	name := str(skill["name"])
	desc := str(skill["description"])
	slashCmd := str(skill["slash_command"])
	pathTemplate, ok := spec.Skills[scope]
	if !ok {
		for _, v := range spec.Skills {
			pathTemplate = v
			break
		}
	}
	path := strings.ReplaceAll(pathTemplate, "{name}", name)
	var content string
	if spec.SkillFormat == "yaml_frontmatter" {
		pairs := [][2]string{{"name", name}}
		if desc != "" {
			pairs = append(pairs, [2]string{"description", desc})
		}
		pairs = append(pairs, adapter.skillFrontmatterExtra(slashCmd)...)
		content = yamlFrontmatter(pairs) + desc + "\n"
	} else {
		pairs := [][2]string{{"description", desc}, {"alwaysApply", "false"}}
		content = yamlFrontmatterRaw(pairs) + "# " + name + "\n\n" + desc + "\n"
	}
	return map[string]any{"path": path, "content": content}
}

// yamlFrontmatterRaw renders values without scalar quoting (booleans).
func yamlFrontmatterRaw(pairs [][2]string) string {
	var b strings.Builder
	b.WriteString("---\n")
	for _, kv := range pairs {
		b.WriteString(kv[0])
		b.WriteString(": ")
		if kv[1] == "false" || kv[1] == "true" {
			b.WriteString(kv[1])
		} else {
			b.WriteString(yamlScalarValue(kv[1]))
		}
		b.WriteString("\n")
	}
	b.WriteString("---\n\n")
	return b.String()
}
