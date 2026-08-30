// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"

	"github.com/garudex-labs/caracal/internal/cli/api"
	"github.com/garudex-labs/caracal/internal/cli/clierr"
	"github.com/garudex-labs/caracal/internal/cli/config"
	"github.com/garudex-labs/caracal/internal/cli/lockfile"
	"github.com/garudex-labs/caracal/internal/cli/ref"
	"github.com/garudex-labs/caracal/internal/cli/ui"
	"github.com/garudex-labs/caracal/internal/harness"
)

const pullOp = "Pull agent"

func pullValidationErr(message, resource, remediation string) *clierr.Error {
	return &clierr.Error{
		Category: clierr.Validation, Message: message,
		Operation: pullOp, Resource: resource, Remediation: remediation,
	}
}

func pullUnavailableErr(message, resource, remediation, detail string) *clierr.Error {
	return &clierr.Error{
		Category: clierr.Unavailable, Message: message,
		Operation: pullOp, Resource: resource, Remediation: remediation, Detail: detail,
	}
}

// pullAssignments parses KEY=VALUE options requiring non-empty values.
func pullAssignments(values []string, label string) (*omap, *clierr.Error) {
	out := newOmap()
	for _, item := range values {
		key, value, found := strings.Cut(item, "=")
		key = strings.TrimSpace(key)
		value = strings.Trim(strings.TrimSpace(value), `"'`)
		if !found || key == "" || value == "" {
			return nil, pullValidationErr(fmt.Sprintf("Invalid %s assignment.", label), label,
				fmt.Sprintf("Use %s=VALUE with a non-empty name and value.", label))
		}
		out.set(key, value)
	}
	return out, nil
}

// collectPullValues fills env or header values from a listing requirement list.
func collectPullValues(items []any, overrides *omap, noPrompt bool, mcpName, kind string, jsonMode bool) *omap {
	out := newOmap()
	required := []*omap{}
	optional := []*omap{}
	for _, raw := range items {
		entry, ok := raw.(*omap)
		if !ok || entry.str("name") == "" {
			continue
		}
		requiredFlag := true
		if flag, ok := entry.get("required").(bool); ok {
			requiredFlag = flag
		}
		if requiredFlag {
			required = append(required, entry)
		} else {
			optional = append(optional, entry)
		}
	}
	if noPrompt {
		for _, entry := range append(required, optional...) {
			name := entry.str("name")
			if overrides.has(name) {
				out.set(name, overrides.get(name))
			}
		}
		return out
	}
	if len(required) > 0 && !jsonMode {
		fmt.Printf("\n%s requires %d %s(s):\n", mcpName, len(required), kind)
	}
	for _, entry := range required {
		name := entry.str("name")
		if overrides.has(name) {
			fmt.Printf("  %s %s (from --%s)\n", ui.Stdout().Success(ui.SymbolOK), name, map[string]string{"environment variable": "env", "header": "header"}[kind])
			out.set(name, overrides.get(name))
			continue
		}
		prompt := "  " + name
		if desc := entry.str("description"); desc != "" {
			prompt += " (" + desc + ")"
		}
		out.set(name, passwordInput(prompt))
	}
	if len(optional) > 0 && !jsonMode {
		fmt.Printf("\n%s: %d optional %s(s):\n", mcpName, len(optional), kind)
	}
	for _, entry := range optional {
		name := entry.str("name")
		if overrides.has(name) {
			out.set(name, overrides.get(name))
			continue
		}
		prompt := "  " + name
		if desc := entry.str("description"); desc != "" {
			prompt += " (" + desc + ")"
		}
		if value := passwordInput(prompt + " (press Enter to skip)"); value != "" {
			out.set(name, value)
		}
	}
	return out
}

// resolvePullPath maps a snippet path under the target directory.
func resolvePullPath(rawPath, targetDir string, allowHome bool) (string, *clierr.Error) {
	if allowHome && (strings.HasPrefix(rawPath, "~/") || strings.HasPrefix(rawPath, `~\`)) {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, rawPath[2:]), nil
	}
	trimmed := rawPath
	if strings.HasPrefix(rawPath, "~/") || strings.HasPrefix(rawPath, `~\`) {
		trimmed = rawPath[2:]
	}
	resolved := filepath.Join(targetDir, trimmed)
	if !isPathSafe(resolved, targetDir) {
		return "", pullValidationErr(fmt.Sprintf("Generated path escapes the target directory: %s.", rawPath),
			rawPath, "Use a safe target directory or report the invalid server config.")
	}
	return resolved, nil
}

// writePullFile writes or merges one generated config file.
func writePullFile(path string, content any, mergeMCP bool) (string, *clierr.Error) {
	_, statErr := os.Stat(path)
	existed := statErr == nil
	conflict := func(err error) *clierr.Error {
		return &clierr.Error{
			Category: clierr.Conflict, Message: fmt.Sprintf("Could not safely merge existing configuration: %s.", path),
			Operation: pullOp, Resource: path,
			Remediation: "Fix or back up the existing configuration, then retry.", Detail: err.Error(),
		}
	}
	writeFail := func(err error) *clierr.Error {
		return pullUnavailableErr(fmt.Sprintf("Could not write generated configuration: %s.", path),
			path, "Check file permissions and available disk space.", err.Error())
	}
	atomicWrite := func(text string) *clierr.Error {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return writeFail(err)
		}
		tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".")
		if err != nil {
			return writeFail(err)
		}
		if _, err := tmp.WriteString(text); err != nil {
			_ = tmp.Close()
			os.Remove(tmp.Name())
			return writeFail(err)
		}
		if err := tmp.Close(); err != nil {
			os.Remove(tmp.Name())
			return writeFail(err)
		}
		if err := os.Rename(tmp.Name(), path); err != nil {
			os.Remove(tmp.Name())
			return writeFail(err)
		}
		return nil
	}
	switch value := content.(type) {
	case string:
		if cerr := atomicWrite(value); cerr != nil {
			return "", cerr
		}
	case *omap:
		rootKey := "mcpServers"
		if value.len() > 0 {
			rootKey = value.keys[0]
		}
		switch {
		case strings.HasSuffix(path, ".yaml") || strings.HasSuffix(path, ".yml"):
			merged, status, err := mergeYAMLConfig(path, value, rootKey, mergeMCP, existed)
			if err != nil {
				return "", conflict(err)
			}
			if cerr := atomicWrite(merged); cerr != nil {
				return "", cerr
			}
			return status, nil
		case strings.HasSuffix(path, ".toml"):
			rendered := dictToTOML(value)
			if existed && mergeMCP {
				existingBlob, err := os.ReadFile(path)
				if err != nil {
					return "", writeFail(err)
				}
				merged, err := mergeTOMLText(string(existingBlob), rendered, value, rootKey, path)
				if err != nil {
					return "", conflict(err)
				}
				if cerr := atomicWrite(merged); cerr != nil {
					return "", cerr
				}
				return "merged", nil
			}
			if cerr := atomicWrite(rendered); cerr != nil {
				return "", cerr
			}
		default:
			if mergeMCP && existed {
				existingBlob, err := os.ReadFile(path)
				if err != nil {
					return "", writeFail(err)
				}
				existingValue, err := decodeOrderedJSON(existingBlob)
				if err != nil {
					return "", conflict(fmt.Errorf("cannot merge unreadable JSON: %s", path))
				}
				existing, ok := existingValue.(*omap)
				if !ok {
					return "", conflict(fmt.Errorf("cannot merge JSON whose top level is not an object: %s", path))
				}
				section, _ := existing.get(rootKey).(*omap)
				if existing.has(rootKey) && section == nil {
					return "", conflict(fmt.Errorf("cannot merge non-object JSON section %s: %s", rootKey, path))
				}
				if section == nil {
					section = newOmap()
					existing.set(rootKey, section)
				}
				if incoming, ok := value.get(rootKey).(*omap); ok {
					for _, key := range incoming.keys {
						section.set(key, incoming.get(key))
					}
				}
				blob, _ := marshalOrdered(existing)
				pretty, err := indentJSON(blob)
				if err != nil {
					return "", writeFail(err)
				}
				if cerr := atomicWrite(string(pretty) + "\n"); cerr != nil {
					return "", cerr
				}
				return "merged", nil
			}
			blob, _ := marshalOrdered(value)
			pretty, err := indentJSON(blob)
			if err != nil {
				return "", writeFail(err)
			}
			if cerr := atomicWrite(string(pretty) + "\n"); cerr != nil {
				return "", cerr
			}
		}
	default:
		blob, _ := json.Marshal(value)
		if cerr := atomicWrite(string(blob)); cerr != nil {
			return "", cerr
		}
	}
	if existed {
		return "updated", nil
	}
	return "created", nil
}

func mergeYAMLConfig(path string, content *omap, rootKey string, mergeMCP, existed bool) (string, string, error) {
	existing := map[string]any{}
	if existed {
		blob, err := os.ReadFile(path)
		if err != nil {
			return "", "", fmt.Errorf("cannot merge unreadable YAML: %s", path)
		}
		var parsed any
		if err := yaml.Unmarshal(blob, &parsed); err != nil {
			return "", "", fmt.Errorf("cannot merge unreadable YAML: %s", path)
		}
		if parsed != nil {
			object, ok := parsed.(map[string]any)
			if !ok {
				return "", "", fmt.Errorf("cannot merge YAML whose top level is not a mapping: %s", path)
			}
			existing = object
		}
	}
	plainContent, _ := plain(content).(map[string]any)
	var payload map[string]any
	if mergeMCP && existed {
		section := existing[rootKey]
		sectionMap, ok := section.(map[string]any)
		if section != nil && !ok {
			return "", "", fmt.Errorf("cannot merge non-mapping YAML section %s: %s", rootKey, path)
		}
		incoming, ok := plainContent[rootKey].(map[string]any)
		if !ok {
			return "", "", fmt.Errorf("incoming YAML section %s is not a mapping", rootKey)
		}
		merged := map[string]any{}
		for key, value := range sectionMap {
			merged[key] = value
		}
		for key, value := range incoming {
			merged[key] = value
		}
		existing[rootKey] = merged
		payload = existing
	} else {
		payload = map[string]any{}
		for key, value := range existing {
			payload[key] = value
		}
		for key, value := range plainContent {
			payload[key] = value
		}
	}
	var buf bytes.Buffer
	encoder := yaml.NewEncoder(&buf)
	encoder.SetIndent(2)
	if err := encoder.Encode(payload); err != nil {
		return "", "", err
	}
	if err := encoder.Close(); err != nil {
		return "", "", err
	}
	status := "created"
	if existed {
		status = "merged"
	}
	return buf.String(), status, nil
}

func dictToTOML(content *omap) string {
	sections := []string{}
	for _, sectionName := range content.keys {
		tables, ok := content.get(sectionName).(*omap)
		if !ok {
			continue
		}
		for _, tableName := range tables.keys {
			server, ok := tables.get(tableName).(*omap)
			if !ok {
				continue
			}
			lines := []string{fmt.Sprintf("[%s.%s]", sectionName, tableName)}
			for _, key := range server.keys {
				value := server.get(key)
				switch v := value.(type) {
				case []any:
					parts := make([]string, len(v))
					for i, item := range v {
						blob, _ := json.Marshal(plain(item))
						parts[i] = string(blob)
					}
					lines = append(lines, fmt.Sprintf("%s = [%s]", key, strings.Join(parts, ", ")))
				case *omap:
					for _, subKey := range v.keys {
						blob, _ := json.Marshal(plain(v.get(subKey)))
						lines = append(lines, fmt.Sprintf("%s.%s = %s", key, subKey, string(blob)))
					}
				case bool:
					lines = append(lines, fmt.Sprintf("%s = %t", key, v))
				case string:
					blob, _ := json.Marshal(v)
					lines = append(lines, fmt.Sprintf("%s = %s", key, string(blob)))
				default:
					lines = append(lines, fmt.Sprintf("%s = %v", key, plain(v)))
				}
			}
			lines = append(lines, "")
			sections = append(sections, strings.Join(lines, "\n"))
		}
	}
	return strings.Join(sections, "\n")
}

func mergeTOMLText(existing, rendered string, content *omap, rootKey, path string) (string, error) {
	tables, ok := content.get(rootKey).(*omap)
	if !ok {
		return "", fmt.Errorf("TOML section %s must be a mapping", rootKey)
	}
	lines := strings.Split(existing, "\n")
	for _, name := range tables.keys {
		header := fmt.Sprintf("[%s.%s]", rootKey, name)
		if !strings.Contains(existing, header) {
			continue
		}
		start := -1
		for i, line := range lines {
			if strings.TrimSpace(line) == header {
				start = i
				break
			}
		}
		if start == -1 {
			return "", fmt.Errorf("cannot safely update existing TOML table %s", header)
		}
		end := len(lines)
		for i := start + 1; i < len(lines); i++ {
			if strings.HasPrefix(strings.TrimSpace(lines[i]), "[") {
				end = i
				break
			}
		}
		lines = append(lines[:start], lines[end:]...)
		existing = strings.Join(lines, "\n")
	}
	if strings.TrimSpace(existing) == "" {
		return strings.TrimRight(rendered, "\n") + "\n", nil
	}
	return strings.TrimRight(existing, " \n") + "\n\n" + strings.TrimRight(rendered, " \n") + "\n", nil
}

// resolveHookPaths rewrites bundled hook script names to concrete paths.
func resolveHookPaths(content string) string {
	for _, name := range []string{"caracal-hook.sh", "caracal-stop-hook.sh"} {
		path, err := exec.LookPath(name)
		if err != nil {
			continue
		}
		content = strings.ReplaceAll(content, `"`+name, `"`+path)
	}
	return content
}

// pullCommand implements the full agent installation workflow.
func pullCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "pull AGENT", Short: "Fetch agent config and write harness files to disk", Args: cobra.ExactArgs(1)}
	harnessFlag := cmd.Flags().StringP("harness", "i", "", "Target harness (cursor, kiro, claude-code, codex, copilot, copilot-cli, opencode, antigravity, pi)")
	directory := cmd.Flags().StringP("dir", "d", ".", "Target directory for written files")
	dryRun := cmd.Flags().BoolP("dry-run", "n", false, "Preview files without writing")
	scope := cmd.Flags().String("scope", "", "Install scope: 'project' or 'user' for harnesses that support both")
	model := cmd.Flags().StringArray("model", nil, "Model override. Accepts '<value>' or '<harness>=<value>'. May be repeated.")
	tools := cmd.Flags().String("tools", "", "Comma-separated tool whitelist (Claude Code only)")
	refreshModels := cmd.Flags().Bool("refresh-models", false, "Bust the local model catalog cache before showing the model picker")
	noPrompt := cmd.Flags().BoolP("no-prompt", "y", false, "Skip interactive prompts")
	envFlags := cmd.Flags().StringArrayP("env", "e", nil, "Non-secret MCP environment setting (KEY=VALUE, repeatable)")
	headerFlags := cmd.Flags().StringArrayP("header", "H", nil, "Non-secret MCP header setting (Header-Name=value, repeatable)")
	version := cmd.Flags().StringP("version", "V", "", "Install a specific version (e.g. '1.2.0'). Defaults to latest.")
	mode := outputFlag(cmd)
	cmd.RunE = func(c *cobra.Command, args []string) error {
		jsonMode := *mode == "json"
		if jsonMode && !*noPrompt {
			return pullValidationErr("JSON mode cannot prompt for installation values.", "agent installation",
				"Add --no-prompt only when no secret values are required; otherwise use interactive table mode.")
		}
		harnessName := strings.ToLower(strings.TrimSpace(*harnessFlag))
		if !contains(validHarnesses, harnessName) {
			return pullValidationErr(fmt.Sprintf("Unknown harness: %s.", harnessName), "target harness",
				"Choose from: "+strings.Join(validHarnesses, ", ")+".")
		}
		registry := harness.MustLoad()
		spec, _ := registry.Spec(harnessName)
		scopeAware := spec != nil && len(spec.ScopeLabels) == 2
		scopeValue := strings.ToLower(strings.TrimSpace(*scope))
		if scopeValue != "" {
			if scopeValue != "project" && scopeValue != "user" {
				return pullValidationErr(fmt.Sprintf("Unknown install scope: %s.", *scope), "install scope",
					"Choose project or user.")
			}
			if !scopeAware {
				return pullValidationErr(fmt.Sprintf("Harness %s does not support an explicit install scope.", harnessName),
					"install scope", "Remove --scope for this harness.")
			}
		}
		if *version != "" && !pep440Re.MatchString(*version) {
			return pullValidationErr(fmt.Sprintf("Invalid semantic version: %s.", *version), "agent version",
				"Use a semantic version such as 1.2.3.")
		}
		envOverrides, cerr := pullAssignments(*envFlags, "environment variable")
		if cerr != nil {
			return cerr
		}
		headerOverrides, cerr := pullAssignments(*headerFlags, "header")
		if cerr != nil {
			return cerr
		}
		modelDefault := ""
		modelOverrides := map[string]string{}
		for _, raw := range *model {
			if key, value, found := strings.Cut(raw, "="); found {
				key = strings.ToLower(strings.TrimSpace(key))
				if !contains(validHarnesses, key) || strings.TrimSpace(value) == "" {
					return pullValidationErr(fmt.Sprintf("Invalid model override: %s.", raw), "model override",
						"Use MODEL or HARNESS=MODEL with a registered harness.")
				}
				modelOverrides[key] = strings.TrimSpace(value)
			} else if strings.TrimSpace(raw) != "" {
				modelDefault = strings.TrimSpace(raw)
			} else {
				return pullValidationErr("Model override cannot be empty.", "model override",
					"Provide a model ID or remove the empty --model option.")
			}
		}
		for key := range modelOverrides {
			if key != harnessName {
				return pullValidationErr(fmt.Sprintf("Model override does not target the selected harness: %s.", key),
					"model override", fmt.Sprintf("Use %s=MODEL or a bare MODEL value.", harnessName))
			}
		}
		if *tools != "" && harnessName != "claude-code" {
			return pullValidationErr(fmt.Sprintf("Harness %s does not support --tools.", harnessName),
				"tool allowlist", "Remove --tools or select claude-code.")
		}
		if *refreshModels && *noPrompt {
			return pullValidationErr("--refresh-models requires the interactive model picker.", "model catalog",
				"Remove --no-prompt or remove --refresh-models.")
		}
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		resolved, cerr := ref.ResolveRegistryReference(client, "agent", args[0], pullOp, "agent installation")
		if cerr != nil {
			return cerr
		}
		targetDir, _ := filepath.Abs(*directory)
		detailRaw, cerr := client.Do("GET", "/api/v1/agents/"+resolved, nil, nil, pullOp, "agent installation")
		if cerr != nil {
			return cerr
		}
		detailValue, _ := decodeOrderedJSON(detailRaw)
		detail, _ := detailValue.(*omap)
		if detail == nil {
			detail = newOmap()
		}
		envValues, headerValues, cerr := collectPullMCPValues(client, detail, envOverrides, headerOverrides, *noPrompt, jsonMode)
		if cerr != nil {
			return cerr
		}
		if !jsonMode {
			fmt.Printf("\nInstall options for %s:\n", harnessName)
		}
		options := newOmap()
		if scopeAware {
			if scopeValue != "" {
				options.set("scope", scopeValue)
			} else {
				defaultScope := "project"
				if spec != nil && spec.DefaultScope != "" {
					defaultScope = spec.DefaultScope
				}
				options.set("scope", defaultScope)
			}
		}
		explicitModel := modelOverrides[harnessName]
		if explicitModel == "" {
			explicitModel = modelDefault
		}
		if explicitModel != "" {
			options.set("model", explicitModel)
		} else if saved := savedHarnessModel(detail, harnessName); saved != "" {
			if !jsonMode {
				fmt.Printf("  Model: %s (from agent)\n", saved)
			}
			options.set("model", saved)
		}
		if *tools != "" && harnessName == "claude-code" {
			options.set("tools", *tools)
		}
		isUserScope := options.str("scope") == "user"
		if isUserScope && !jsonMode {
			fmt.Println("  Files will be written to your home directory (user scope).")
		}
		namespace := detail.str("namespace")
		slug := detail.str("slug")
		if slug == "" {
			slug = orDefault(detail.str("name"), "agent")
		}
		installScope := orDefault(options.str("scope"), "project")
		localName, err := lockfile.LocalRegistryName(harnessName, "agent", namespace, slug, installScope, targetDir)
		if err != nil {
			return pullUnavailableErr("Could not read the local installation lockfile.", "Caracal lockfile",
				"Repair or remove the malformed lockfile, then retry.", err.Error())
		}
		options.set("local_name", localName)
		lockComponents := []map[string]any{}
		for _, rawLink := range detail.array("component_links") {
			link, _ := rawLink.(*omap)
			if link == nil {
				continue
			}
			entry := map[string]any{
				"type":    orDefault(link.str("component_type"), "unknown"),
				"name":    link.str("component_name"),
				"id":      fmt.Sprint(plain(link.get("component_id"))),
				"version": plain(link.get("version_ref")),
			}
			lockComponents = append(lockComponents, entry)
		}
		conflictWarnings, cerr := componentConflicts(harnessName, orDefault(detail.str("name"), resolved), lockComponents)
		if cerr != nil {
			return cerr
		}
		installBody := newOmap()
		installBody.set("harness", harnessName)
		installBody.set("env_values", envValues)
		installBody.set("header_values", headerValues)
		installBody.set("options", options)
		platform := runtime.GOOS
		if platform == "windows" {
			platform = "win32"
		}
		installBody.set("platform", platform)
		if *version != "" {
			installBody.set("version", *version)
		}
		resultRaw, cerr := client.Do("POST", "/api/v1/agents/"+resolved+"/install", nil, installBody, pullOp, "agent installation")
		if cerr != nil {
			return cerr
		}
		resultValue, _ := decodeOrderedJSON(resultRaw)
		result, _ := resultValue.(*omap)
		if result == nil {
			result = newOmap()
		}
		snippet := result.object("config_snippet")
		if snippet == nil || snippet.len() == 0 {
			return pullUnavailableErr("The server returned an empty agent configuration.", "generated agent configuration",
				"Check server compatibility and the agent's harness support.", "")
		}
		written := [][2]string{}
		writeChecked := func(rawPath string, content any, allowHome, mergeMCP bool) *clierr.Error {
			path, cerr := resolvePullPath(rawPath, targetDir, allowHome)
			if cerr != nil {
				return cerr
			}
			if *dryRun {
				written = append(written, [2]string{path, "would write"})
				return nil
			}
			status, cerr := writePullFile(path, content, mergeMCP)
			if cerr != nil {
				return cerr
			}
			written = append(written, [2]string{path, status})
			return nil
		}
		if mcpConfig := snippet.object("mcp_config"); mcpConfig != nil && mcpConfig.str("path") != "" {
			if cerr := writeChecked(mcpConfig.str("path"), mcpConfig.get("content"), isUserScope, true); cerr != nil {
				return cerr
			}
		}
		if hooksConfig := snippet.object("hooks_config"); hooksConfig != nil && hooksConfig.str("path") != "" {
			content := hooksConfig.get("content")
			if text, ok := content.(string); ok {
				content = resolveHookPaths(text)
			} else if object, ok := content.(*omap); ok {
				blob, _ := marshalOrdered(object)
				rewritten := resolveHookPaths(string(blob))
				if value, err := decodeOrderedJSON([]byte(rewritten)); err == nil {
					content = value
				}
			}
			merge, _ := hooksConfig.get("merge").(bool)
			if cerr := writeChecked(hooksConfig.str("path"), content, isUserScope, merge); cerr != nil {
				return cerr
			}
		}
		if profile := snippet.object("agent_profile"); profile != nil && profile.str("path") != "" {
			allowHome := isUserScope
			if harnessName == "cursor" {
				allowHome = false
			}
			content := profile.get("content")
			if text, ok := content.(string); ok {
				content = resolveHookPaths(text)
			}
			if cerr := writeChecked(profile.str("path"), content, allowHome, false); cerr != nil {
				return cerr
			}
		}
		if steering := snippet.object("steering_file"); steering != nil && steering.str("path") != "" {
			if cerr := writeChecked(steering.str("path"), steering.get("content"), isUserScope, false); cerr != nil {
				return cerr
			}
		}
		for _, listKey := range []string{"hook_files", "prompt_files", "skills"} {
			for _, rawEntry := range snippet.array(listKey) {
				entry, _ := rawEntry.(*omap)
				if entry == nil || entry.str("path") == "" {
					continue
				}
				if cerr := writeChecked(entry.str("path"), entry.get("content"), isUserScope, false); cerr != nil {
					return cerr
				}
				executable, _ := entry.get("executable").(bool)
				if executable && !*dryRun {
					lastPath := written[len(written)-1][0]
					if err := os.Chmod(lastPath, 0o755); err != nil {
						return pullUnavailableErr(fmt.Sprintf("Could not mark generated hook executable: %s.", lastPath),
							lastPath, "Check file ownership and permissions.", err.Error())
					}
				}
			}
		}
		failedSkills := []string{}
		scopeStr := "project"
		if isUserScope {
			scopeStr = "user"
		}
		for _, rawComponent := range snippet.array("skill_components") {
			component, _ := rawComponent.(*omap)
			if component == nil {
				continue
			}
			skillName := sanitizeName(orDefault(component.str("name"), "skill"))
			skillDest := ""
			if component.str("path") != "" {
				resolvedPath, cerr := resolvePullPath(component.str("path"), targetDir, isUserScope)
				if cerr != nil {
					return cerr
				}
				skillDest = filepath.Dir(resolvedPath)
			}
			if *dryRun {
				status := "would write"
				if component.str("git_url") != "" {
					status = "would clone"
				}
				placeholder := skillDest
				if placeholder == "" {
					placeholder = "<skill:" + skillName + ">"
				}
				written = append(written, [2]string{placeholder, status})
				continue
			}
			var installedPath string
			if component.str("git_url") != "" {
				installedPath = installSkillFromGitDest(component.str("name"), component.str("git_url"),
					orDefault(component.str("skill_path"), "/"), orDefault(component.str("git_ref"), "main"),
					harnessName, scopeStr, targetDir, skillDest)
				if installedPath == "" {
					failedSkills = append(failedSkills, skillName)
					continue
				}
				written = append(written, [2]string{installedPath, "cloned"})
			} else {
				installedPath = installSkillRegistryDirectDest(component.str("name"), component.str("skill_md_content"),
					component.str("script_content"), component.str("script_filename"), harnessName, scopeStr, targetDir, skillDest)
				if installedPath == "" {
					failedSkills = append(failedSkills, skillName)
					continue
				}
				written = append(written, [2]string{installedPath, "installed"})
			}
		}
		if len(failedSkills) > 0 {
			return pullUnavailableErr(fmt.Sprintf("Failed to install %d agent skill(s).", len(failedSkills)),
				"agent skills", "Check skill source access and content, then retry.", strings.Join(failedSkills, ", "))
		}
		if len(written) == 0 {
			return pullUnavailableErr("The generated agent configuration contained no writable files.",
				"generated agent configuration", "Check agent contents and harness support, then retry.", "")
		}
		warningsList := append([]string{}, conflictWarnings...)
		for _, rawWarning := range result.array("warnings") {
			if text, ok := rawWarning.(string); ok {
				warningsList = append(warningsList, text)
			}
		}
		for _, rawWarning := range snippet.array("_warnings") {
			if text, ok := rawWarning.(string); ok {
				warningsList = append(warningsList, text)
			}
		}
		setupResults := []string{}
		setupFailures := []string{}
		for _, rawCommand := range snippet.array("mcp_setup_commands") {
			argv := stringsOf(rawCommand)
			if len(argv) == 0 {
				continue
			}
			argvBlob, _ := json.Marshal(argv)
			if *dryRun {
				setupResults = append(setupResults, fmt.Sprintf(`{"command": %s, "status": "would_run", "return_code": null}`, string(argvBlob)))
				continue
			}
			process := exec.Command(argv[0], argv[1:]...)
			err := process.Run()
			if err != nil {
				var exitErr *exec.ExitError
				if !errors.As(err, &exitErr) {
					setupResults = append(setupResults, fmt.Sprintf(`{"command": %s, "status": "failed", "return_code": null}`, string(argvBlob)))
					setupFailures = append(setupFailures, fmt.Sprintf("%s not found", argv[0]))
					continue
				}
			}
			code := process.ProcessState.ExitCode()
			status := "completed"
			if code != 0 {
				status = "failed"
				setupFailures = append(setupFailures, fmt.Sprintf("%s exited with code %d", argv[0], code))
			}
			setupResults = append(setupResults, fmt.Sprintf(`{"command": %s, "status": %s, "return_code": %d}`,
				string(argvBlob), jsonString(status), code))
		}
		if len(setupFailures) > 0 {
			return pullUnavailableErr(fmt.Sprintf("Agent files were written, but %d MCP setup command(s) failed.", len(setupFailures)),
				"harness MCP registration", "Fix the reported command and pull the agent again.", strings.Join(setupFailures, "; "))
		}
		agentUUID := fmt.Sprint(plain(detail.get("id")))
		if !truthy(detail.get("id")) {
			agentUUID = resolved
		}
		agentVersion := detail.str("version")
		if agentVersion == "" {
			agentVersion = detail.str("latest_version")
		}
		if !*dryRun {
			var versionPtr *string
			if agentVersion != "" {
				versionPtr = &agentVersion
			}
			if err := lockfile.UpsertAgent(harnessName, lockfile.Entry{
				Name: orDefault(detail.str("name"), resolved), ID: agentUUID, Version: versionPtr,
				Scope: installScope, Directory: targetDir, Components: lockComponents,
				Namespace: namespace, Slug: detail.str("slug"), LocalName: localName,
			}); err != nil {
				return pullUnavailableErr("Agent files were written, but installation tracking failed.", "Caracal lockfile",
					"Repair the local lockfile and pull the agent again.", err.Error())
			}
			if harnessName == "pi" {
				if cerr := persistActiveAgent(agentUUID, orDefault(detail.str("name"), resolved), agentVersion); cerr != nil {
					return cerr
				}
			}
			emitCLIAudit(client, "agent.pull", "agent", agentUUID, orDefault(detail.str("name"), resolved),
				"harness="+harnessName)
		}
		if jsonMode {
			qualified := detail.str("qualified_name")
			if qualified == "" {
				if namespace != "" {
					qualified = namespace + "/" + slug
				} else {
					qualified = slug
				}
			}
			fileParts := make([]string, len(written))
			for i, pair := range written {
				fileParts[i] = fmt.Sprintf(`{"path": %s, "status": %s}`, jsonString(pair[0]), jsonString(pair[1]))
			}
			warningParts := make([]string, len(warningsList))
			for i, warning := range warningsList {
				warningParts[i] = jsonString(warning)
			}
			versionValue := "null"
			if agentVersion != "" {
				versionValue = jsonString(agentVersion)
			}
			doc := fmt.Sprintf(`{"agent": {"id": %s, "qualified_name": %s, "version": %s, "local_name": %s}, "harness": %s, "scope": %s, "dry_run": %t, "target_directory": %s, "files": [%s], "warnings": [%s], "setup_commands": [%s]}`,
				jsonString(agentUUID), jsonString(qualified), versionValue, jsonString(localName),
				jsonString(harnessName), jsonString(installScope), *dryRun, jsonString(targetDir),
				strings.Join(fileParts, ", "), strings.Join(warningParts, ", "), strings.Join(setupResults, ", "))
			outputJSONRaw([]byte(doc))
			return nil
		}
		if *dryRun {
			fmt.Println("\nDry run - no files written:")
		} else {
			plural := "s"
			if len(written) == 1 {
				plural = ""
			}
			fmt.Println()
			ui.Stdout().Successf("Pulled %s config (%d file%s):", harnessName, len(written), plural)
		}
		for _, pair := range written {
			fmt.Printf("  %s  %s\n", pair[1], pair[0])
		}
		for _, warning := range warningsList {
			fmt.Printf("  %s %s\n", ui.Stdout().Warn(ui.SymbolWarn), warning)
		}
		return nil
	}
	return cmd
}

func savedHarnessModel(detail *omap, harnessName string) string {
	if models := detail.object("models_by_harness"); models != nil {
		if value := strings.TrimSpace(models.str(harnessName)); value != "" {
			return value
		}
	}
	if harnessName == "claude-code" {
		return strings.TrimSpace(detail.str("model_name"))
	}
	return ""
}

func collectPullMCPValues(client *api.Client, detail *omap, envOverrides, headerOverrides *omap, noPrompt, jsonMode bool) (*omap, *omap, *clierr.Error) {
	type mcpRef struct{ id, name string }
	refs := []mcpRef{}
	seen := map[string]bool{}
	for _, rawLink := range detail.array("mcp_links") {
		link, _ := rawLink.(*omap)
		if link == nil {
			continue
		}
		id := fmt.Sprint(plain(link.get("mcp_listing_id")))
		if id != "" && !seen[id] {
			refs = append(refs, mcpRef{id, link.str("mcp_name")})
			seen[id] = true
		}
	}
	for _, rawLink := range detail.array("component_links") {
		link, _ := rawLink.(*omap)
		if link == nil || link.str("component_type") != "mcp" {
			continue
		}
		id := fmt.Sprint(plain(link.get("component_id")))
		if id != "" && !seen[id] {
			refs = append(refs, mcpRef{id, link.str("component_name")})
			seen[id] = true
		}
	}
	envValues := newOmap()
	headerValues := newOmap()
	for _, mcp := range refs {
		listingRaw, cerr := client.Do("GET", "/api/v1/mcps/"+mcp.id, nil, nil,
			"Read MCP environment requirements", "agent installation")
		if cerr != nil {
			return nil, nil, cerr
		}
		listingValue, _ := decodeOrderedJSON(listingRaw)
		listing, _ := listingValue.(*omap)
		if listing == nil {
			continue
		}
		mcpName := orDefault(mcp.name, orDefault(listing.str("name"), mcp.id[:min(8, len(mcp.id))]))
		if envList := listing.array("environment_variables"); len(envList) > 0 {
			values := collectPullValues(envList, envOverrides, noPrompt, mcpName, "environment variable", jsonMode)
			if values.len() > 0 {
				envValues.set(mcp.id, values)
			}
		}
		if headerList := listing.array("headers"); len(headerList) > 0 {
			values := collectPullValues(headerList, headerOverrides, noPrompt, mcpName, "header", jsonMode)
			if values.len() > 0 {
				headerValues.set(mcp.id, values)
			}
		}
	}
	return envValues, headerValues, nil
}

func componentConflicts(harnessName, agentName string, components []map[string]any) ([]string, *clierr.Error) {
	_, registry, err := lockfile.ReadRegistry(false)
	if err != nil {
		return nil, pullUnavailableErr("Could not read the local installation lockfile.", "Caracal lockfile",
			"Repair or remove the malformed lockfile, then retry.", err.Error())
	}
	section := registry.Harnesses[harnessName]
	if section == nil {
		return nil, nil
	}
	existing := map[string][][2]string{}
	for _, agent := range section.Agents {
		if agent.Name == agentName {
			continue
		}
		for _, component := range agent.Components {
			name, _ := component["name"].(string)
			version := fmt.Sprint(component["version"])
			if name != "" {
				existing[name] = append(existing[name], [2]string{version, agent.Name})
			}
		}
	}
	warnings := []string{}
	for _, component := range components {
		name, _ := component["name"].(string)
		version := fmt.Sprint(component["version"])
		componentType, _ := component["type"].(string)
		for _, pair := range existing[name] {
			if pair[0] != version {
				warnings = append(warnings, fmt.Sprintf("%s %s: v%s (this agent) vs v%s (from %s)",
					orDefault(componentType, "component"), name, version, pair[0], pair[1]))
			}
		}
	}
	return warnings, nil
}

// persistActiveAgent records the pulled agent in the CLI configuration.
func persistActiveAgent(agentID, name, version string) *clierr.Error {
	if cerr := config.Save(map[string]any{
		"active_agent": map[string]any{"id": agentID, "name": name, "version": version},
	}); cerr != nil {
		return pullUnavailableErr("Agent files and lockfile were updated, but active-agent state could not be persisted.",
			"pi active-agent state", "Fix harness configuration permissions and pull the agent again.", cerr.Message)
	}
	return nil
}

// emitCLIAudit records the action best-effort, never blocking the result.
func emitCLIAudit(client *api.Client, action, resourceType, resourceID, resourceName, detail string) {
	body := newOmap()
	body.set("event_id", uuid.NewString())
	body.set("timestamp", time.Now().UTC().Format("2006-01-02 15:04:05.000"))
	body.set("action", action)
	body.set("resource_type", resourceType)
	body.set("resource_id", resourceID)
	body.set("resource_name", resourceName)
	body.set("detail", detail)
	body.set("sensitivity", "high")
	body.set("source", "cli")
	blob, err := marshalOrdered(body)
	if err != nil {
		return
	}
	cfg, cerr := config.Load()
	if cerr != nil {
		return
	}
	serverURL := strings.TrimRight(config.Str(cfg, "server_url"), "/")
	token := config.Str(cfg, "access_token")
	if serverURL == "" || token == "" {
		return
	}
	req, err := http.NewRequest("POST", serverURL+"/api/v1/audit/cli-event", bytes.NewReader(blob))
	if err != nil {
		return
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	httpClient := &http.Client{Timeout: 5 * time.Second}
	resp, err := httpClient.Do(req)
	if err == nil {
		_ = resp.Body.Close()
	}
	_ = client
}

// installSkillFromGitDest is installSkillFromGit with an explicit destination.
func installSkillFromGitDest(name, gitURL, skillPath, gitRef, harnessName, scope, cwd, dest string) string {
	if dest == "" {
		return installSkillFromGit(name, gitURL, skillPath, gitRef, harnessName, scope, cwd)
	}
	if gitURL == "" {
		return ""
	}
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return ""
	}
	if !sparseCloneSkillDir(gitURL, skillPath, gitRef, dest) {
		return ""
	}
	return dest
}

// installSkillRegistryDirectDest writes registry-direct content to a destination.
func installSkillRegistryDirectDest(name, skillMdContent, scriptContent, scriptFilename, harnessName, scope, cwd, dest string) string {
	if dest == "" {
		return installSkillRegistryDirect(name, skillMdContent, scriptContent, scriptFilename, harnessName, scope, cwd)
	}
	if skillMdContent == "" {
		return ""
	}
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return ""
	}
	if err := os.WriteFile(filepath.Join(dest, "SKILL.md"), []byte(skillMdContent), 0o644); err != nil {
		return ""
	}
	if scriptContent != "" && scriptFilename != "" {
		scriptsDir := filepath.Join(dest, "scripts")
		scriptPath := filepath.Join(scriptsDir, scriptFilename)
		if isPathSafe(scriptPath, scriptsDir) {
			_ = os.MkdirAll(scriptsDir, 0o755)
			mode := os.FileMode(0o644)
			for _, ext := range []string{".sh", ".bash", ".py", ".rb"} {
				if strings.HasSuffix(scriptFilename, ext) {
					mode = 0o755
					break
				}
			}
			_ = os.WriteFile(scriptPath, []byte(scriptContent), mode)
			_ = os.Chmod(scriptPath, mode)
		}
	}
	return dest
}
