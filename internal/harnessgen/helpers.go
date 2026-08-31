// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package harnessgen

import (
	"fmt"
	"regexp"
	"strings"
)

var safeNameRE = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)
var unsafeCharRE = regexp.MustCompile(`[^a-zA-Z0-9_-]`)

// sanitizeName normalizes an arbitrary string to a safe identifier.
func sanitizeName(name string) string {
	if safeNameRE.MatchString(name) {
		return name
	}
	return unsafeCharRE.ReplaceAllString(name, "-")
}

var dollarVarRE = regexp.MustCompile(`\$\{([A-Z][A-Z0-9_]+)\}|\$([A-Z][A-Z0-9_]+)`)

// substituteDollarVars replaces $VAR and ${VAR} with values from env,
// keeping the original text when no value is present.
func substituteDollarVars(args []string, env map[string]string) []string {
	if len(env) == 0 {
		return append([]string{}, args...)
	}
	out := make([]string, 0, len(args))
	for _, arg := range args {
		out = append(out, dollarVarRE.ReplaceAllStringFunc(arg, func(m string) string {
			name := strings.Trim(strings.TrimPrefix(m, "$"), "{}")
			if v, ok := env[name]; ok {
				return v
			}
			return m
		}))
	}
	return out
}

// mcpContext is one MCP server normalized for harness formatting.
type mcpContext struct {
	Name        string
	Command     string
	Args        []string
	ServerEnv   map[string]string
	Headers     map[string]string
	Transport   string
	URL         string
	AutoApprove []any
}

// standardEntry is the common MCP entry used by JSON-based harnesses.
func (c *mcpContext) standardEntry() map[string]any {
	if c.URL != "" {
		entry := map[string]any{"type": c.transportOr("sse"), "url": c.URL}
		if len(c.Headers) > 0 {
			entry["headers"] = c.Headers
		}
		if len(c.ServerEnv) > 0 {
			entry["env"] = c.ServerEnv
		}
		if len(c.AutoApprove) > 0 {
			entry["autoApprove"] = c.AutoApprove
			entry["disabled"] = false
		}
		return entry
	}
	entry := map[string]any{"command": c.Command, "args": c.Args, "env": c.ServerEnv}
	if len(c.AutoApprove) > 0 {
		entry["autoApprove"] = c.AutoApprove
		entry["disabled"] = false
	}
	return entry
}

func (c *mcpContext) transportOr(fallback string) string {
	if c.Transport != "" {
		return c.Transport
	}
	return fallback
}

// buildRunCommand picks the server launch command: stored command first,
// then container, framework, or module inference.
func buildRunCommand(name, framework, dockerImage string, serverEnv map[string]string, storedCommand string, storedArgs []string, hasStored bool) []string {
	if hasStored {
		cmd := []string{storedCommand}
		if len(storedArgs) > 0 {
			cmd = append(cmd, substituteDollarVars(storedArgs, serverEnv)...)
		}
		return cmd
	}
	fw := strings.ToLower(framework)
	if dockerImage != "" {
		cmd := []string{"docker", "run", "-i", "--rm"}
		for _, k := range sortedKeys(serverEnv) {
			cmd = append(cmd, "-e", k+"="+serverEnv[k])
		}
		return append(cmd, dockerImage)
	}
	if strings.Contains(fw, "typescript") || strings.Contains(fw, "ts") {
		return []string{"npx", "-y", name}
	}
	if strings.Contains(fw, "go") {
		return []string{name}
	}
	return []string{"python", "-m", name}
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	return keys
}

// buildServerEnv merges declared environment variables with user values.
func buildServerEnv(listing Listing, envValues map[string]string) map[string]string {
	env := map[string]string{}
	for _, v := range listing.list("environment_variables") {
		name := ""
		switch item := v.(type) {
		case map[string]any:
			name, _ = item["name"].(string)
		case string:
			name = item
		}
		if name == "" {
			continue
		}
		env[name] = envValues[name]
	}
	return env
}

// buildMcpContext normalizes one listing before harness-specific formatting.
func buildMcpContext(listing Listing, envValues, headerValues map[string]string, localName string) *mcpContext {
	name := localName
	if name == "" {
		name = listing.ItemSlug()
	}
	name = sanitizeName(name)
	serverEnv := buildServerEnv(listing, envValues)
	transport := strings.ToLower(listing.str("transport"))
	url := ""
	if u := listing.str("url"); u != "" {
		switch transport {
		case "sse", "streamable-http", "":
			url = u
		}
	}
	var runCmd []string
	if url == "" {
		storedCommand, hasStored := listing["command"].(string)
		storedArgs := []string{}
		for _, a := range listing.list("args") {
			if s, ok := a.(string); ok {
				storedArgs = append(storedArgs, s)
			}
		}
		runCmd = buildRunCommand(name, listing.str("framework"), listing.str("docker_image"),
			serverEnv, storedCommand, storedArgs, hasStored)
	}
	command, args := "", []string{}
	if len(runCmd) > 0 {
		command, args = runCmd[0], runCmd[1:]
	}
	headers := map[string]string{}
	for k, v := range headerValues {
		headers[k] = v
	}
	ctx := &mcpContext{
		Name: name, Command: command, Args: args,
		ServerEnv: serverEnv, Headers: headers,
		Transport: transport, URL: url,
		AutoApprove: listing.list("auto_approve"),
	}
	if ctx.Transport == "" {
		ctx.Transport = "sse"
	}
	return ctx
}

// localRegistryNames keeps bare slugs unless one install carries the same
// slug from multiple namespaces; qualified names stay unique and dot-free.
func localRegistryNames(order []string, listings map[string]Listing) map[string]string {
	slugCount := map[string]int{}
	for _, id := range order {
		slugCount[listings[id].ItemSlug()]++
	}
	names := map[string]string{}
	used := map[string]bool{}
	for _, id := range order {
		listing := listings[id]
		slug := listing.ItemSlug()
		candidate := slug
		if slugCount[slug] > 1 {
			candidate = strings.ReplaceAll(listing.str("namespace"), ".", "-") + "-" + slug
		}
		unique, attempt := candidate, 2
		for used[unique] {
			unique = fmt.Sprintf("%s-%d", candidate, attempt)
			attempt++
		}
		used[unique] = true
		names[id] = unique
	}
	return names
}

// listingOrder lists component ids of one type in composition order,
// keeping only those with loaded listings.
func listingOrder(agent *Agent, componentType string, listings map[string]Listing) []string {
	order := []string{}
	seen := map[string]bool{}
	for _, comp := range agent.Components {
		if comp.Type != componentType || seen[comp.ID] {
			continue
		}
		if _, ok := listings[comp.ID]; ok {
			order = append(order, comp.ID)
			seen[comp.ID] = true
		}
	}
	return order
}

// injectAgentID adds the agent identity env var to every server entry.
func injectAgentID(configs *Config, agentID string) {
	for _, name := range configs.Keys() {
		cfg, _ := configs.Get(name)
		entry, ok := cfg.(map[string]any)
		if !ok {
			continue
		}
		env, ok := entry["env"].(map[string]string)
		if ok {
			env["CARACAL_AGENT_ID"] = agentID
			continue
		}
		envAny, ok := entry["env"].(map[string]any)
		if !ok {
			envAny = map[string]any{}
			entry["env"] = envAny
		}
		envAny["CARACAL_AGENT_ID"] = agentID
	}
}

// buildMcpConfigs assembles registry MCP entries plus external servers.
func buildMcpConfigs(req *Request, adapter adapter) *Config {
	configs := NewConfig()
	order := listingOrder(req.Agent, "mcp", req.McpListings)
	localNames := localRegistryNames(order, req.McpListings)
	for _, id := range order {
		listing := req.McpListings[id]
		ctx := buildMcpContext(listing, req.EnvValues[id], req.HeaderValues[id], localNames[id])
		if entry := adapter.agentMcpEntry(ctx); entry != nil {
			configs.Set(ctx.Name, entry)
		}
	}
	for _, extAny := range req.Agent.ExternalMcps {
		ext, ok := extAny.(map[string]any)
		if !ok {
			continue
		}
		name := sanitizeName(str(ext["name"]))
		if name == "" {
			continue
		}
		cmd := strOr(ext["command"], "npx")
		var args []any
		switch v := ext["args"].(type) {
		case []any:
			args = v
		case string:
			for _, part := range strings.Fields(v) {
				args = append(args, part)
			}
		}
		if args == nil {
			args = []any{}
		}
		env, _ := ext["env"].(map[string]any)
		if env == nil {
			env = map[string]any{}
		}
		configs.Set(name, map[string]any{"command": cmd, "args": args, "env": env})
	}
	injectAgentID(configs, req.Agent.ID)
	return configs
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

func strOr(v any, fallback string) string {
	if s, ok := v.(string); ok && s != "" {
		return s
	}
	return fallback
}

// skillConfig is the per-skill metadata handed to harness generators.
type skillConfig map[string]any

// buildSkillConfigs extracts skill metadata in composition order. Harnesses
// whose Skill materializes as something other than a native Agent Skill
// (SKILL.md) receive no skill components: Caracal must not write them a file
// their runtime never reads.
func buildSkillConfigs(req *Request) []skillConfig {
	if spec, ok := specOf(strings.ReplaceAll(req.Harness, "_", "-")); ok && !spec.EmitsSkillMd() {
		return []skillConfig{}
	}
	order := listingOrder(req.Agent, "skill", req.SkillListings)
	localNames := localRegistryNames(order, req.SkillListings)
	skills := []skillConfig{}
	for _, id := range order {
		listing := req.SkillListings[id]
		skills = append(skills, skillConfig{
			"name":             sanitizeName(localNames[id]),
			"description":      listing.str("description"),
			"slash_command":    listing["slash_command"],
			"task_type":        listing.str("task_type"),
			"git_url":          listing["git_url"],
			"git_ref":          listing.strOr("git_ref", "main"),
			"skill_path":       listing.strOr("skill_path", "/"),
			"skill_md_content": listing["skill_md_content"],
			"script_content":   listing["script_content"],
			"script_filename":  listing["script_filename"],
		})
	}
	return skills
}

// hookConfig is the per-hook metadata merged into harness hook files.
type hookConfig map[string]any

func (h hookConfig) str(key string) string {
	s, _ := h[key].(string)
	return s
}

func (h hookConfig) dict(key string) map[string]any {
	d, _ := h[key].(map[string]any)
	return d
}

// buildHookConfigs extracts hook metadata in composition order.
func buildHookConfigs(req *Request) []hookConfig {
	order := listingOrder(req.Agent, "hook", req.HookListings)
	localNames := localRegistryNames(order, req.HookListings)
	hooks := []hookConfig{}
	for _, id := range order {
		listing := req.HookListings[id]
		handlerConfig := listing.dict("handler_config")
		if handlerConfig == nil {
			handlerConfig = map[string]any{}
		}
		hooks = append(hooks, hookConfig{
			"event":           listing["event"],
			"handler_type":    listing.strOr("handler_type", "command"),
			"handler_config":  handlerConfig,
			"name":            localNames[id],
			"script_filename": listing["script_filename"],
			"script_content":  listing["script_content"],
		})
	}
	return hooks
}

// featureLabels translate capability names for compatibility warnings.
var featureLabels = map[string]string{
	"skills":      "slash-command skills",
	"hooks":       "hook bridge",
	"mcp_servers": "MCP servers",
}

// compatibilityWarnings reports required capabilities the harness lacks.
func compatibilityWarnings(agent *Agent, harnessName string) []string {
	spec, ok := specOf(harnessName)
	if !ok {
		return nil
	}
	warnings := []string{}
	for _, reqAny := range agent.RequiredCapabilities {
		feature, _ := reqAny.(string)
		if feature == "" || spec.HasCapability(harnessCapability(feature)) {
			continue
		}
		label := feature
		if l, ok := featureLabels[feature]; ok {
			label = l
		}
		warnings = append(warnings, fmt.Sprintf(
			"This agent requires '%s' but %s does not support it. Some functionality may not work.",
			label, harnessName))
	}
	if spec.AgentSupport == "compatible" {
		mechanism := spec.AgentMechanism
		if mechanism == "" {
			mechanism = "a non-native mechanism"
		}
		warnings = append(warnings, fmt.Sprintf(
			"%s materializes this agent through a compatibility mechanism (%s); it may not appear as a separately selectable agent.",
			harnessName, mechanism))
	}
	if !spec.AgentMulti {
		warnings = append(warnings, fmt.Sprintf(
			"%s activates a single agent/instruction set, so multiple Caracal agents cannot coexist as independently selectable agents here.",
			harnessName))
	}
	return warnings
}

// respaceJSON rewrites compact JSON with ", " and ": " separators.
func respaceJSON(blob []byte) string {
	var out strings.Builder
	inString := false
	escaped := false
	for _, b := range blob {
		if escaped {
			out.WriteByte(b)
			escaped = false
			continue
		}
		switch b {
		case '\\':
			out.WriteByte(b)
			escaped = inString
		case '"':
			out.WriteByte(b)
			inString = !inString
		case ',':
			out.WriteByte(b)
			if !inString {
				out.WriteByte(' ')
			}
		case ':':
			out.WriteByte(b)
			if !inString {
				out.WriteByte(' ')
			}
		default:
			out.WriteByte(b)
		}
	}
	return out.String()
}
