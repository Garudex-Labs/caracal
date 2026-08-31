// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"

	"github.com/garudex-labs/caracal/internal/cli/api"
	"github.com/garudex-labs/caracal/internal/cli/clierr"
	"github.com/garudex-labs/caracal/internal/cli/config"
	"github.com/garudex-labs/caracal/internal/cli/ref"
)

// ── publish target ─────────────────────────────────────────────────

// addPublishTarget validates and applies the visibility target. The owning
// project comes from the active org/project context, not a flag.
func addPublishTarget(payload map[string]any, visibility, cmdPath string) *clierr.Error {
	target := strings.ToLower(strings.TrimSpace(visibility))
	if target == "" {
		target = "project"
	}
	if target != "project" && target != "private" {
		return usageError(cmdPath, "Invalid value for visibility: visibility must be 'project' or 'private'")
	}
	payload["visibility"] = target
	return nil
}

// loadJSONObjectFile reads a CLI-supplied JSON object with categorized failures.
func loadJSONObjectFile(path, operation, noun string) (map[string]any, *clierr.Error) {
	blob, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, &clierr.Error{
				Category: clierr.NotFound, Message: fmt.Sprintf("The %s was not found.", noun),
				Operation: operation, Resource: path,
				Remediation: "Provide an existing JSON file and retry.", Detail: err.Error(),
			}
		}
		return nil, &clierr.Error{Category: clierr.Unexpected, Message: err.Error(), Operation: operation, Resource: path}
	}
	var payload any
	if err := json.Unmarshal(blob, &payload); err != nil {
		return nil, &clierr.Error{
			Category: clierr.Validation, Message: fmt.Sprintf("The %s is not valid JSON.", noun),
			Operation: operation, Resource: path,
			Remediation: "Correct the JSON and retry.", Detail: err.Error(),
		}
	}
	object, ok := payload.(map[string]any)
	if !ok {
		return nil, &clierr.Error{
			Category: clierr.Validation, Message: fmt.Sprintf("The %s must contain a JSON object.", noun),
			Operation: operation, Resource: path,
			Remediation: "Replace the file contents with a JSON object and retry.",
		}
	}
	return object, nil
}

func draftSubmitConflict(operation string) *clierr.Error {
	return &clierr.Error{
		Category: clierr.Validation, Message: "Draft creation and draft submission cannot be requested together.",
		Operation: operation, Resource: "submit options",
		Remediation: "Choose either draft creation or draft submission and retry.",
	}
}

// submitDraftReference submits an existing draft for review.
func submitDraftReference(client *api.Client, singular, plural, reference, op, resource, mode string) error {
	resolved, cerr := ref.ResolveRegistryReference(client, singular, reference, op, resource)
	if cerr != nil {
		return cerr
	}
	raw, cerr := client.Do("POST", "/api/v1/"+plural+"/"+resolved+"/submit", nil, nil, op, resource)
	if cerr != nil {
		return cerr
	}
	if mode == "json" {
		outputJSONRaw(raw)
		return nil
	}
	var doc struct {
		ID any `json:"id"`
	}
	_ = json.Unmarshal(raw, &doc)
	fmt.Printf("Draft submitted for review! ID: %v\n", doc.ID)
	return nil
}

func configUsername() string {
	cfg, cerr := config.Load()
	if cerr != nil {
		return ""
	}
	return config.Str(cfg, "username")
}

// startEditAndPutDraft runs the shared draft edit sequence.
func startEditAndPutDraft(client *api.Client, plural, resolved string, updates map[string]any, op, resource, mode string) error {
	if _, cerr := client.Do("POST", "/api/v1/"+plural+"/"+resolved+"/start-edit", nil, nil, op, resource); cerr != nil {
		return cerr
	}
	raw, cerr := client.Do("PUT", "/api/v1/"+plural+"/"+resolved+"/draft", nil, updates, op, resource)
	if cerr != nil {
		return cerr
	}
	if mode == "json" {
		outputJSONRaw(raw)
		return nil
	}
	var doc struct {
		Name   string `json:"name"`
		Status string `json:"status"`
	}
	_ = json.Unmarshal(raw, &doc)
	fmt.Printf("Updated %s (status: %s)\n", doc.Name, orDefault(doc.Status, "unknown"))
	return nil
}

// ── direct MCP config normalization ────────────────────────────────

var dollarVarRe = regexp.MustCompile(`\$\{?([A-Z][A-Z0-9_]+)\}?`)

var internalEnvVars = map[string]bool{
	"PATH": true, "HOME": true, "USER": true, "SHELL": true, "LANG": true,
	"TERM": true, "PWD": true, "TMPDIR": true, "PYTHONPATH": true,
	"PYTHONDONTWRITEBYTECODE": true, "PYTHONUSERBASE": true, "PYTHONHOME": true,
	"PYTHONUNBUFFERED": true, "VIRTUAL_ENV": true, "NODE_ENV": true,
	"NODE_PATH": true, "NODE_OPTIONS": true, "PORT": true, "HOST": true,
	"DEBUG": true, "APP": true, "LOG_LEVEL": true, "LOGGING_LEVEL": true,
	"HOSTNAME": true, "DISPLAY": true, "EDITOR": true, "PAGER": true,
	"TZ": true, "LC_ALL": true, "LC_CTYPE": true,
}

var allowedEnvVars = map[string]bool{
	"GITHUB_TOKEN": true, "GITHUB_PERSONAL_ACCESS_TOKEN": true, "DOCKER_HOST": true,
}

var filteredEnvPrefixes = []string{
	"CI_", "GITHUB_", "GITLAB_", "CIRCLECI_", "TRAVIS_", "JENKINS_",
	"BUILDKITE_", "DOCKER_", "BUILDKIT_", "COMPOSE_", "NPM_", "PIP_", "UV_", "MCP_LOG_",
}

func isFilteredEnvVar(name string) bool {
	if allowedEnvVars[name] {
		return false
	}
	if internalEnvVars[name] {
		return true
	}
	for _, prefix := range filteredEnvPrefixes {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

func extractDollarVars(args []string, env *omap) []string {
	found := map[string]bool{}
	scan := func(value string) {
		for _, match := range dollarVarRe.FindAllStringSubmatch(value, -1) {
			found[match[1]] = true
		}
	}
	for _, arg := range args {
		scan(arg)
	}
	if env != nil {
		for _, key := range env.keys {
			if text, ok := env.vals[key].(string); ok {
				scan(text)
			}
		}
	}
	names := []string{}
	for name := range found {
		if !isFilteredEnvVar(name) {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names
}

func envVarEntries(env *omap) []any {
	entries := make([]any, 0, env.len())
	for _, key := range env.keys {
		entry := newOmap()
		entry.set("name", key)
		entry.set("description", "")
		entry.set("required", true)
		entries = append(entries, entry)
	}
	return entries
}

// unwrapMCPConfig unwraps nested mcpServers and named-server wrappers.
func unwrapMCPConfig(cfg *omap) (*omap, string) {
	if servers, ok := cfg.get("mcpServers").(*omap); ok {
		if servers.len() == 1 {
			name := servers.keys[0]
			if inner, ok := servers.get(name).(*omap); ok {
				return inner, name
			}
		}
		return cfg, ""
	}
	if truthy(cfg.get("command")) || truthy(cfg.get("url")) || truthy(cfg.get("type")) {
		return cfg, ""
	}
	if cfg.len() == 1 {
		name := cfg.keys[0]
		if inner, ok := cfg.get(name).(*omap); ok {
			if truthy(inner.get("command")) || truthy(inner.get("url")) || truthy(inner.get("type")) {
				return inner, name
			}
		}
	}
	return cfg, ""
}

func truthy(value any) bool {
	switch v := value.(type) {
	case nil:
		return false
	case string:
		return v != ""
	case bool:
		return v
	case float64:
		return v != 0
	case json.Number:
		return v.String() != "0"
	case []any:
		return len(v) > 0
	case *omap:
		return v.len() > 0
	case map[string]any:
		return len(v) > 0
	}
	return true
}

func stringsOf(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if text, ok := item.(string); ok {
			out = append(out, text)
		}
	}
	return out
}

// parseServerJSONManifest parses packages[]/remotes[] manifests.
func parseServerJSONManifest(cfg *omap) *omap {
	manifest := cfg
	serverMeta := cfg.object("server")
	if serverMeta != nil && (truthy(serverMeta.get("remotes")) || truthy(serverMeta.get("packages"))) {
		manifest = serverMeta
	}
	if !manifest.has("packages") && !manifest.has("remotes") {
		return nil
	}
	parsed := newOmap()
	envVars := []any{}
	if serverMeta != nil {
		name := serverMeta.get("title")
		if !truthy(name) {
			name = serverMeta.get("name")
		}
		if truthy(name) {
			parsed.set("_server_name", name)
		}
		if truthy(serverMeta.get("description")) {
			parsed.set("_description", serverMeta.get("description"))
		}
	}
	for _, rawPkg := range manifest.array("packages") {
		pkg, _ := rawPkg.(*omap)
		if pkg == nil {
			continue
		}
		for _, rawArg := range pkg.array("runtimeArguments") {
			arg, _ := rawArg.(*omap)
			if arg == nil {
				continue
			}
			value := arg.str("value")
			if key, _, found := strings.Cut(value, "="); found && key != "" && key == strings.ToUpper(key) {
				entry := newOmap()
				entry.set("name", key)
				entry.set("description", arg.str("description"))
				entry.set("required", true)
				envVars = append(envVars, entry)
			}
		}
	}
	for _, rawRemote := range manifest.array("remotes") {
		remote, _ := rawRemote.(*omap)
		if remote == nil {
			continue
		}
		url := remote.str("url")
		if url != "" && !truthy(parsed.get("url")) {
			parsed.set("url", url)
			transport := remote.str("type")
			if transport == "" {
				transport = "sse"
			}
			parsed.set("transport", transport)
		}
		if variables := remote.object("variables"); variables != nil {
			for _, key := range variables.keys {
				desc := ""
				if meta, ok := variables.get(key).(*omap); ok {
					desc = meta.str("description")
				}
				entry := newOmap()
				entry.set("name", key)
				entry.set("description", desc)
				entry.set("required", true)
				envVars = append(envVars, entry)
			}
		}
	}
	if len(envVars) > 0 {
		parsed.set("environment_variables", envVars)
	}
	if !truthy(parsed.get("url")) && !truthy(manifest.get("remotes")) {
		parsed.set("transport", "stdio")
		parsed.set("framework", "docker")
	}
	return parsed
}

// parseDirectConfig normalizes a JSON config into submit-ready fields.
func parseDirectConfig(cfg *omap) *omap {
	if manifest := parseServerJSONManifest(cfg); manifest != nil {
		return manifest
	}
	inner, serverName := unwrapMCPConfig(cfg)
	parsed := newOmap()
	if serverName != "" {
		parsed.set("_server_name", serverName)
	}
	rawEnv := inner.object("env")
	if truthy(inner.get("url")) && !truthy(inner.get("command")) {
		transport := inner.str("type")
		if transport == "" {
			transport = "sse"
		}
		parsed.set("transport", transport)
		parsed.set("url", inner.get("url"))
		switch headers := inner.get("headers").(type) {
		case *omap:
			entries := make([]any, 0, headers.len())
			for _, key := range headers.keys {
				entry := newOmap()
				entry.set("name", key)
				entry.set("value", headers.get(key))
				entry.set("description", "")
				entry.set("required", true)
				entries = append(entries, entry)
			}
			parsed.set("headers", entries)
		case []any:
			parsed.set("headers", headers)
		}
		if truthy(inner.get("autoApprove")) {
			parsed.set("auto_approve", inner.get("autoApprove"))
		}
		if rawEnv != nil && rawEnv.len() > 0 {
			parsed.set("environment_variables", envVarEntries(rawEnv))
		}
		merged := newOmap()
		if headers := inner.object("headers"); headers != nil {
			for _, key := range headers.keys {
				merged.set(key, headers.get(key))
			}
		}
		if rawEnv != nil {
			for _, key := range rawEnv.keys {
				merged.set(key, rawEnv.get(key))
			}
		}
		appendDollarVars(parsed, nil, merged)
	} else if truthy(inner.get("command")) {
		parsed.set("transport", "stdio")
		parsed.set("command", inner.get("command"))
		args := stringsOf(inner.get("args"))
		anyArgs, _ := inner.get("args").([]any)
		if anyArgs == nil {
			anyArgs = []any{}
		}
		parsed.set("args", anyArgs)
		command := inner.str("command")
		switch command {
		case "docker":
			parsed.set("framework", "docker")
			for i := len(args) - 1; i >= 0; i-- {
				if !strings.HasPrefix(args[i], "-") {
					parsed.set("docker_image", args[i])
					break
				}
			}
		case "python", "python3":
			parsed.set("framework", "python")
		case "npx", "node":
			parsed.set("framework", "typescript")
		default:
			parsed.set("framework", nil)
		}
		if rawEnv != nil && rawEnv.len() > 0 {
			parsed.set("environment_variables", envVarEntries(rawEnv))
		}
		appendDollarVars(parsed, args, rawEnv)
	}
	return parsed
}

func appendDollarVars(parsed *omap, args []string, env *omap) {
	dollarVars := extractDollarVars(args, env)
	if len(dollarVars) == 0 {
		return
	}
	existing := map[string]bool{}
	entries, _ := parsed.get("environment_variables").([]any)
	for _, rawEntry := range entries {
		if entry, ok := rawEntry.(*omap); ok {
			existing[entry.str("name")] = true
		}
	}
	for _, name := range dollarVars {
		if !existing[name] {
			entry := newOmap()
			entry.set("name", name)
			entry.set("description", "")
			entry.set("required", true)
			entries = append(entries, entry)
			existing[name] = true
		}
	}
	parsed.set("environment_variables", entries)
	parsed.set("_dollar_vars_detected", dollarVars)
}
