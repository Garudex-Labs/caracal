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
	{"prompt", "Prompts"},
}

// buildRulesContent assembles the agent prompt and a component summary.
// Prompt templates inline their content when listings are provided.
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
			lines := append([]string{"## " + tl.Heading, ""}, promptSectionLines(req, promptNames(req))...)
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

// promptNames maps each prompt component id to its canonical, collision-safe
// resource name, shared by native prompt files and embedded headings so the
// two never diverge.
func promptNames(req *Request) map[string]string {
	order := listingOrder(req.Agent, "prompt", req.PromptListings)
	local := localRegistryNames(order, req.PromptListings)
	names := map[string]string{}
	for _, id := range order {
		names[id] = canonicalPromptName(local[id])
	}
	return names
}

// canonicalPromptName normalizes a name to safe characters and a bounded
// length for use both as a filename and as an embedded heading.
func canonicalPromptName(raw string) string {
	safe := strings.Trim(sanitizeName(strings.TrimSpace(raw)), "-")
	if safe == "" {
		safe = "prompt"
	}
	if len(safe) > 64 {
		safe = strings.Trim(safe[:64], "-")
	}
	return safe
}

// promptResourceName resolves a component's canonical name, falling back to the
// display name or a short id when no registry name is available.
func promptResourceName(req *Request, compID string, names map[string]string) string {
	if n := names[compID]; n != "" {
		return n
	}
	if n, ok := req.ComponentNames[compID]; ok {
		return canonicalPromptName(n)
	}
	if len(compID) >= 8 {
		return canonicalPromptName(compID[:8])
	}
	return canonicalPromptName(compID)
}

// promptComponentCount counts prompt components with a loaded listing.
func promptComponentCount(req *Request) int {
	n := 0
	for _, comp := range req.Agent.Components {
		if comp.Type == "prompt" {
			if _, ok := req.PromptListings[comp.ID]; ok {
				n++
			}
		}
	}
	return n
}

// appendConfigWarning adds one warning to the config's _warnings list.
func appendConfigWarning(cfg *Config, msg string) {
	existing, _ := cfg.Get("_warnings")
	list, _ := existing.([]string)
	cfg.Set("_warnings", append(append([]string{}, list...), msg))
}

// managedPromptMarker identifies a Caracal-authored native prompt file so a
// later reconcile can remove it without touching user-authored files.
const managedPromptMarker = "<!-- caracal-managed: prompt"

// generatePromptFiles builds native prompt files at the harness's documented
// prompt location. Placement is deterministic: workspace-scoped when the
// harness supports it (project-isolated), otherwise the shared user-level
// location, where filenames are namespace-qualified so one project cannot
// clobber another project's prompt.
func generatePromptFiles(req *Request, spec *harness.Spec) []map[string]any {
	if spec == nil || len(req.PromptListings) == 0 {
		return nil
	}
	res, ok := spec.ResolvePrompt()
	if !ok {
		return nil
	}
	format := ""
	if spec.Prompts != nil {
		format = spec.Prompts.Format
	}
	names := promptNames(req)
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
		name := promptFileName(req, comp.ID, listing, names, res.Workspace)
		files = append(files, map[string]any{
			"path":    strings.ReplaceAll(res.Path, "{name}", name),
			"content": renderPromptFile(format, listing, template, promptQualified(listing, name)),
		})
	}
	return files
}

// promptFileName resolves a prompt's on-disk file name. Workspace-scoped
// locations are project-isolated, so the collision-safe canonical name is
// enough; a shared user-level location is namespace-qualified so distinct
// projects never map different prompts onto the same file.
func promptFileName(req *Request, compID string, listing Listing, names map[string]string, workspace bool) string {
	base := promptResourceName(req, compID, names)
	if workspace {
		return base
	}
	ns := strings.ReplaceAll(listing.str("namespace"), ".", "-")
	slug := listing.ItemSlug()
	if ns == "" || slug == "" {
		return base
	}
	return canonicalPromptName(ns + "-" + slug)
}

// promptQualified is the prompt's registry identity for the managed marker.
func promptQualified(listing Listing, fallback string) string {
	if ns, slug := listing.str("namespace"), listing.ItemSlug(); ns != "" && slug != "" {
		return ns + "/" + slug
	}
	return fallback
}

// promptMarker records the managed-ownership marker with the prompt identity so
// a later reconcile can remove only the Caracal-authored file it wrote, never a
// user file or another project's prompt at a shared location.
func promptMarker(qualified string) string {
	if qualified == "" {
		return managedPromptMarker + " -->"
	}
	return managedPromptMarker + " " + qualified + " -->"
}

// renderPromptFile renders one native prompt file for a harness format,
// prepending the managed marker.
func renderPromptFile(format string, listing Listing, template, qualified string) string {
	body := strings.TrimRight(template, " \t\n")
	desc := strings.SplitN(strings.ReplaceAll(listing.strOr("description", ""), "\n", " "), "\n", 2)[0]
	marker := promptMarker(qualified)
	switch format {
	case "copilot_prompt", "claude_command":
		var fm strings.Builder
		fm.WriteString("---\ndescription: ")
		fm.WriteString(jsonString(desc))
		fm.WriteByte('\n')
		if hint := promptArgumentHint(listing); hint != "" {
			fm.WriteString("argument-hint: ")
			fm.WriteString(jsonString(hint))
			fm.WriteByte('\n')
		}
		fm.WriteString("---\n")
		return fm.String() + "\n" + marker + "\n\n" + body + "\n"
	default:
		return marker + "\n\n" + body + "\n"
	}
}

// promptArgumentHint renders the prompt's declared template variables as the
// harness's argument-hint so a native prompt advertises the inputs it expects.
// Variables are discoverability metadata only: Caracal does not rewrite the
// template body into a harness-native substitution syntax.
func promptArgumentHint(listing Listing) string {
	names := promptVariableNames(listing)
	if len(names) == 0 {
		return ""
	}
	return "[" + strings.Join(names, "] [") + "]"
}

// promptVariableNames extracts variable names from the stored variables list,
// which carries either bare names or objects with a name field.
func promptVariableNames(listing Listing) []string {
	raw, ok := listing["variables"].([]any)
	if !ok {
		return nil
	}
	names := []string{}
	for _, v := range raw {
		switch t := v.(type) {
		case string:
			if s := strings.TrimSpace(t); s != "" {
				names = append(names, s)
			}
		case map[string]any:
			if s, _ := t["name"].(string); strings.TrimSpace(s) != "" {
				names = append(names, strings.TrimSpace(s))
			}
		}
	}
	return names
}

// promptSectionLines renders the embedded prompt block: one heading and body
// per attached prompt, using the same canonical names as native files.
func promptSectionLines(req *Request, names map[string]string) []string {
	lines := []string{}
	for _, comp := range req.Agent.Components {
		if comp.Type != "prompt" {
			continue
		}
		listing, ok := req.PromptListings[comp.ID]
		if !ok {
			continue
		}
		name := promptResourceName(req, comp.ID, names)
		if template := listing.str("template"); template != "" {
			lines = append(lines, "### "+name, "", strings.TrimRight(template, " \t\n"), "")
		} else {
			lines = append(lines, "- **"+name+"**")
		}
	}
	return lines
}

// promptEmbedSection returns the "## Prompts" block for structured embedded
// harnesses (e.g. Kiro) whose agent file does not carry the rules content.
func promptEmbedSection(req *Request) string {
	if len(req.PromptListings) == 0 {
		return ""
	}
	lines := promptSectionLines(req, promptNames(req))
	if len(lines) == 0 {
		return ""
	}
	return strings.Join(append([]string{"## Prompts", ""}, lines...), "\n")
}

// hookHandlerCommand resolves the shell command a command-based harness runs
// for a hook component. HTTP handlers are wrapped as a curl POST so harnesses
// without a native HTTP hook type still deliver the event; script components
// resolve to their on-disk path. Returns "" when the component carries neither
// a command, a script, nor a URL.
func hookHandlerCommand(hc hookConfig, scriptsDir string) string {
	handlerConfig := hc.dict("handler_config")
	if hc.str("handler_type") == "http" {
		hookURL := str(handlerConfig["url"])
		if hookURL == "" {
			return ""
		}
		return fmt.Sprintf("curl -s -X POST -H 'Content-Type: application/json' -d @- %s", hookURL)
	}
	if filename := hc.str("script_filename"); filename != "" && scriptsDir != "" {
		return scriptsDir + "/" + filename
	}
	return str(handlerConfig["command"])
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
		command := hookHandlerCommand(hc, scriptsDir)
		if command == "" {
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

// mergeCodexHookComponents folds Registry Hook components into a Codex hooks
// config. Codex uses the Claude-style matcher-group shape
// ({event:[{matcher,hooks:[{type:command,command}]}]}) at .codex/hooks.json.
func mergeCodexHookComponents(hooksContent map[string]any, hookConfigs []hookConfig) {
	spec, ok := specOf("codex")
	if !ok {
		return
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
		codexEvent := event
		if mapped, mok := spec.HookEventsMap[event]; mok {
			codexEvent = mapped
		}
		command := hookHandlerCommand(hc, spec.HookScriptsDir)
		if command == "" {
			continue
		}
		group := map[string]any{
			"matcher": strOr(hc.dict("handler_config")["matcher"], ""),
			"hooks":   []any{map[string]any{"type": "command", "command": command}},
		}
		entries, _ := hooksDict[codexEvent].([]any)
		hooksDict[codexEvent] = append(entries, group)
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
	if !ok || len(spec.Skills) == 0 || !spec.SupportsSkill() {
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
