// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/spf13/cobra"

	"github.com/garudex-labs/caracal/internal/cli/api"
	"github.com/garudex-labs/caracal/internal/cli/clierr"
	"github.com/garudex-labs/caracal/internal/cli/config"
	"github.com/garudex-labs/caracal/internal/cli/lockfile"
	"github.com/garudex-labs/caracal/internal/cli/ui"
)

// ── patchers ───────────────────────────────────────────────────────

func hookGroupFor(harnessName string) *omap {
	hook := newOmap()
	hook.set("type", "command")
	hook.set("command", hookCommandFor(harnessName))
	group := newOmap()
	meta := newOmap()
	meta.set("version", "11")
	group.set("_caracal", meta)
	group.set("hooks", []any{hook})
	return group
}

func patchClaudeCode(home string, dryRun bool) (bool, error) {
	path := filepath.Join(home, ".claude", "settings.json")
	settings := loadJSONObjectQuiet(path)
	if settings == nil {
		settings = newOmap()
	}
	hooks := settings.object("hooks")
	if hooks == nil {
		hooks = newOmap()
	}
	changed := false
	for _, event := range []string{"UserPromptSubmit", "Stop"} {
		desired := hookGroupFor("claude-code")
		desiredBlob, _ := marshalOrdered([]any{desired})
		current := hooks.array(event)
		foreign := []any{}
		caracalGroups := []any{}
		for _, rawGroup := range current {
			if group, ok := rawGroup.(*omap); ok && isCaracalMatcherGroup(group) {
				caracalGroups = append(caracalGroups, group)
			} else {
				foreign = append(foreign, rawGroup)
			}
		}
		currentBlob, _ := marshalOrdered(caracalGroups)
		if string(currentBlob) != string(desiredBlob) {
			hooks.set(event, append(foreign, desired))
			changed = true
		}
	}
	if changed && !dryRun {
		settings.set("hooks", hooks)
		if err := writeDoctorJSON(path, settings); err != nil {
			return false, err
		}
		_ = config.Save(map[string]any{"hooks_spec_version": "11"})
	}
	return changed, nil
}

func patchKiro(home string, dryRun bool) (bool, error) {
	_, registry, err := lockfile.ReadRegistry(false)
	if err != nil {
		return false, err
	}
	section := registry.Harnesses["kiro"]
	if section == nil || len(section.Agents) == 0 {
		return false, nil
	}
	changed := false
	for _, entry := range section.Agents {
		localName := orDefault(entry.LocalName, orDefault(entry.Slug, entry.Name))
		if localName == "" || entry.ID == "" {
			continue
		}
		var profilePath string
		if entry.Scope == "user" {
			profilePath = filepath.Join(home, ".kiro", "agents", localName+".json")
		} else {
			if entry.Directory == "" {
				continue
			}
			profilePath = filepath.Join(entry.Directory, ".kiro", "agents", localName+".json")
		}
		profile := loadJSONObjectQuiet(profilePath)
		if profile == nil {
			continue
		}
		command := "CARACAL_AGENT_ID=" + entry.ID + " " + hookCommandFor("kiro")
		desired := newOmap()
		for _, event := range []string{"userPromptSubmit", "stop"} {
			hook := newOmap()
			hook.set("command", command)
			desired.set(event, []any{hook})
		}
		hooks := profile.object("hooks")
		if hooks == nil {
			hooks = newOmap()
		}
		profileChanged := false
		for _, event := range desired.keys {
			kept := []any{}
			for _, rawHook := range hooks.array(event) {
				if hook, ok := rawHook.(*omap); ok && !isCaracalHookEntry(hook) {
					kept = append(kept, rawHook)
				}
			}
			desiredHooks := desired.array(event)
			merged := make([]any, 0, len(kept)+len(desiredHooks))
			merged = append(merged, kept...)
			merged = append(merged, desiredHooks...)
			beforeBlob, _ := marshalOrdered(hooks.array(event))
			afterBlob, _ := marshalOrdered(merged)
			if string(beforeBlob) != string(afterBlob) {
				hooks.set(event, merged)
				profileChanged = true
			}
		}
		if profileChanged {
			changed = true
			if !dryRun {
				profile.set("hooks", hooks)
				if err := writeDoctorJSON(profilePath, profile); err != nil {
					return false, err
				}
			}
		}
	}
	return changed, nil
}

func patchCursor(home string, dryRun bool) (bool, error) {
	cursorDir := filepath.Join(home, ".cursor")
	if info, err := os.Stat(cursorDir); err != nil || !info.IsDir() {
		return false, nil
	}
	path := filepath.Join(cursorDir, "hooks.json")
	command := hookCommandFor("cursor")
	existing := loadJSONObjectQuiet(path)
	hooks := newOmap()
	if existing != nil {
		if current := existing.object("hooks"); current != nil {
			hooks = current
		}
	}
	upToDate := true
	for _, event := range []string{"beforeSubmitPrompt", "stop"} {
		found := false
		for _, rawEntry := range hooks.array(event) {
			if entry, ok := rawEntry.(*omap); ok &&
				strings.Contains(entry.str("command"), "hook session-push --harness cursor") {
				found = true
			}
		}
		if !found {
			upToDate = false
		}
	}
	if upToDate {
		return false, nil
	}
	for _, event := range []string{"beforeSubmitPrompt", "stop"} {
		kept := []any{}
		for _, rawEntry := range hooks.array(event) {
			entry, _ := rawEntry.(*omap)
			if entry == nil || (!strings.Contains(entry.str("command"), "cursor_session_push") &&
				!strings.Contains(entry.str("command"), "session_push") &&
				!strings.Contains(entry.str("command"), "session-push")) {
				kept = append(kept, rawEntry)
			}
		}
		hook := newOmap()
		hook.set("command", command)
		hook.set("type", "command")
		hooks.set(event, append(kept, hook))
	}
	if !dryRun {
		doc := newOmap()
		doc.set("version", 1)
		doc.set("hooks", hooks)
		if err := writeDoctorJSON(path, doc); err != nil {
			return false, err
		}
	}
	return true, nil
}

func patchCodex(home string, dryRun bool) (bool, error) {
	codexDir := filepath.Join(home, ".codex")
	changed := false
	hooksPath := filepath.Join(codexDir, "hooks.json")
	existing := loadJSONObjectQuiet(hooksPath)
	hooks := newOmap()
	if existing != nil {
		if current := existing.object("hooks"); current != nil {
			hooks = current
		}
	}
	upToDate := eventGroupsContainOmap(hooks, []string{"UserPromptSubmit", "Stop"}, "hook session-push --harness codex")
	if !upToDate {
		for _, event := range []string{"UserPromptSubmit", "Stop"} {
			kept := []any{}
			for _, rawGroup := range hooks.array(event) {
				group, _ := rawGroup.(*omap)
				remove := false
				if group != nil {
					for _, rawHook := range group.array("hooks") {
						if hook, ok := rawHook.(*omap); ok &&
							(strings.Contains(hook.str("command"), "session_push") ||
								strings.Contains(hook.str("command"), "session-push")) {
							remove = true
						}
					}
				}
				if !remove {
					kept = append(kept, rawGroup)
				}
			}
			hook := newOmap()
			hook.set("type", "command")
			hook.set("command", hookCommandFor("codex"))
			group := newOmap()
			group.set("matcher", "")
			group.set("hooks", []any{hook})
			hooks.set(event, append(kept, group))
		}
		changed = true
		if !dryRun {
			doc := newOmap()
			doc.set("hooks", hooks)
			if err := writeDoctorJSON(hooksPath, doc); err != nil {
				return false, err
			}
		}
	}
	configPath := filepath.Join(codexDir, "config.toml")
	blob, err := os.ReadFile(configPath)
	content := string(blob)
	needsFlag := err != nil || !strings.Contains(content, "codex_hooks") || strings.Contains(content, "codex_hooks = false")
	if needsFlag {
		changed = true
		if !dryRun {
			var next string
			switch {
			case err != nil:
				next = "codex_hooks = true\n"
			case strings.Contains(content, "codex_hooks = false"):
				next = strings.ReplaceAll(content, "codex_hooks = false", "codex_hooks = true")
			default:
				next = "codex_hooks = true\n" + content
			}
			if err := os.MkdirAll(codexDir, 0o755); err != nil {
				return false, err
			}
			if err := os.WriteFile(configPath, []byte(next), 0o644); err != nil {
				return false, err
			}
		}
	}
	return changed, nil
}

func eventGroupsContainOmap(hooks *omap, events []string, marker string) bool {
	for _, event := range events {
		found := false
		for _, rawGroup := range hooks.array(event) {
			group, _ := rawGroup.(*omap)
			if group == nil {
				continue
			}
			for _, rawHook := range group.array("hooks") {
				if hook, ok := rawHook.(*omap); ok && strings.Contains(hook.str("command"), marker) {
					found = true
				}
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func patchCopilotFamily(home, cwd, harnessName string, dryRun bool) (bool, error) {
	var path string
	var events []string
	if harnessName == "copilot" {
		path = filepath.Join(cwd, ".github", "hooks", "caracal.json")
		events = []string{"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"}
	} else {
		path = filepath.Join(home, ".copilot", "hooks", "caracal.json")
		events = []string{"sessionStart", "sessionEnd", "userPromptSubmitted", "preToolUse", "postToolUse"}
	}
	marker := "hook session-push --harness " + harnessName
	existing := loadJSONObjectQuiet(path)
	hooks := newOmap()
	if existing != nil {
		if current := existing.object("hooks"); current != nil {
			hooks = current
		}
	}
	upToDate := true
	for _, event := range events {
		found := false
		for _, rawEntry := range hooks.array(event) {
			if entry, ok := rawEntry.(*omap); ok && copilotHookMatch(entry, []string{marker}) {
				found = true
			}
		}
		if !found {
			upToDate = false
		}
	}
	if upToDate {
		return false, nil
	}
	for _, event := range events {
		kept := []any{}
		for _, rawEntry := range hooks.array(event) {
			entry, _ := rawEntry.(*omap)
			if entry == nil || !copilotHookMatch(entry, []string{"run_hook.ps1", "copilot_cli_session_push", "session_push", "session-push"}) {
				kept = append(kept, rawEntry)
			}
		}
		hook := newOmap()
		hook.set("type", "command")
		if harnessName == "copilot" {
			hook.set("bash", "\""+hookCommandFor("copilot")+" --json-response\"")
			hook.set("command", "powershell -ExecutionPolicy Bypass -File .github/hooks/run_hook.ps1")
			hook.set("timeoutSec", 10)
		} else {
			hook.set("bash", "\""+hookCommandFor("copilot-cli")+"\"")
			hook.set("powershell", hookCommandFor("copilot-cli"))
			hook.set("timeoutSec", 5)
		}
		hooks.set(event, append(kept, hook))
	}
	if !dryRun {
		doc := newOmap()
		doc.set("version", 1)
		doc.set("hooks", hooks)
		if err := writeDoctorJSON(path, doc); err != nil {
			return false, err
		}
		if harnessName == "copilot" {
			ps1Path := filepath.Join(cwd, ".github", "hooks", "run_hook.ps1")
			current, _ := os.ReadFile(ps1Path)
			if !strings.Contains(string(current), "hook session-push --harness copilot") {
				content := "# Caracal session push hook for VS Code Copilot.\n" +
					"$stdinData = [Console]::In.ReadToEnd()\n" +
					"$stdinData | " + hookCommandFor("copilot") + " --json-response 2>$null\n"
				if err := os.WriteFile(ps1Path, []byte(content), 0o644); err != nil {
					return false, err
				}
			}
		}
	}
	return true, nil
}

func patchOpencode(home string, dryRun bool) (bool, error) {
	path := filepath.Join(home, ".config", "opencode", "plugins", "caracal-plugin.ts")
	desired, _ := doctorAssets.ReadFile("assets/opencode-plugin.ts")
	current, err := os.ReadFile(path)
	if err == nil && stringsEqualBytes(current, desired) {
		return false, nil
	}
	if !dryRun {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return false, err
		}
		if err := os.WriteFile(path, desired, 0o644); err != nil {
			return false, err
		}
	}
	return true, nil
}

func patchPi(home string, dryRun bool) (bool, error) {
	agentDir := filepath.Join(home, ".pi", "agent")
	if info, err := os.Stat(agentDir); err != nil || !info.IsDir() {
		return false, nil
	}
	changed := false
	desired, _ := doctorAssets.ReadFile("assets/pi-caracal.ts")
	extensionPath := filepath.Join(agentDir, "extensions", "caracal.ts")
	current, err := os.ReadFile(extensionPath)
	if err != nil || !stringsEqualBytes(current, desired) {
		changed = true
		if !dryRun {
			if err := os.MkdirAll(filepath.Dir(extensionPath), 0o755); err != nil {
				return false, err
			}
			if err := os.WriteFile(extensionPath, desired, 0o644); err != nil {
				return false, err
			}
		}
	}
	settingsPath := filepath.Join(agentDir, "settings.json")
	settings := loadJSONObjectQuiet(settingsPath)
	if settings != nil {
		packages := settings.array("packages")
		kept := []any{}
		for _, rawPkg := range packages {
			source := ""
			switch pkg := rawPkg.(type) {
			case string:
				source = pkg
			case *omap:
				source = pkg.str("source")
			}
			if source == "npm:caracal-pi" || strings.HasPrefix(source, "npm:caracal-pi@") {
				continue
			}
			kept = append(kept, rawPkg)
		}
		if len(kept) != len(packages) {
			changed = true
			if !dryRun {
				settings.set("packages", kept)
				if err := writeDoctorJSON(settingsPath, settings); err != nil {
					return false, err
				}
			}
		}
	}
	return changed, nil
}

func patchAntigravity(home string, dryRun bool) (bool, error) {
	dir := antigravityConfigDir(home)
	if dir == "" {
		return false, nil
	}
	path := filepath.Join(dir, "hooks.json")
	existing := loadJSONObjectQuiet(path)
	if existing == nil {
		existing = newOmap()
	}
	if existing.has("caracal-telemetry") {
		return false, nil
	}
	group := newOmap()
	for _, event := range []string{"PreInvocation", "Stop"} {
		hook := newOmap()
		hook.set("type", "command")
		hook.set("command", hookCommandFor("antigravity"))
		hook.set("timeout", 30)
		group.set(event, []any{hook})
	}
	existing.set("caracal-telemetry", group)
	if !dryRun {
		if err := writeDoctorJSON(path, existing); err != nil {
			return false, err
		}
	}
	return true, nil
}

func patchGoose(home string, dryRun bool) (bool, error) {
	if !gooseDetected(home) {
		return false, nil
	}
	pluginDir := filepath.Join(gooseAgentsHome(home), "plugins", "caracal")
	hooksPath := filepath.Join(pluginDir, "hooks", "hooks.json")
	existing := loadJSONObjectQuiet(hooksPath)
	if existing == nil {
		existing = newOmap()
	}
	hooks := existing.object("hooks")
	if hooks == nil {
		hooks = newOmap()
	}
	merged := newOmap()
	for _, key := range hooks.keys {
		merged.set(key, hooks.get(key))
	}
	changed := false
	for _, event := range []string{"SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"} {
		kept := []any{}
		for _, rawRule := range merged.array(event) {
			rule, _ := rawRule.(*omap)
			caracal := false
			if rule != nil {
				for _, rawHandler := range rule.array("hooks") {
					if handler, ok := rawHandler.(*omap); ok && isCaracalHookEntry(handler) {
						caracal = true
					}
				}
			}
			if !caracal {
				kept = append(kept, rawRule)
			}
		}
		handler := newOmap()
		handler.set("type", "command")
		handler.set("command", hookCommandFor("goose"))
		handler.set("timeout", 30)
		rule := newOmap()
		rule.set("hooks", []any{handler})
		next := make([]any, 0, len(kept)+1)
		next = append(next, kept...)
		next = append(next, rule)
		beforeBlob, _ := marshalOrdered(merged.array(event))
		afterBlob, _ := marshalOrdered(next)
		if string(beforeBlob) != string(afterBlob) {
			merged.set(event, next)
			changed = true
		}
	}
	manifestPath := filepath.Join(pluginDir, "plugin.json")
	manifest := newOmap()
	manifest.set("name", "caracal")
	manifest.set("version", cliVersion)
	manifest.set("description", "Caracal session telemetry for goose")
	manifestCurrent := loadJSONObjectQuiet(manifestPath)
	manifestBlob, _ := marshalOrdered(manifest)
	if manifestCurrent == nil {
		changed = true
	} else {
		currentBlob, _ := marshalOrdered(manifestCurrent)
		if string(currentBlob) != string(manifestBlob) {
			changed = true
		}
	}
	if changed && !dryRun {
		existing.set("hooks", merged)
		if err := writeDoctorJSON(hooksPath, existing); err != nil {
			return false, err
		}
		if err := writeDoctorJSON(manifestPath, manifest); err != nil {
			return false, err
		}
	}
	return changed, nil
}

// ── cleaners ───────────────────────────────────────────────────────

func cleanupClaudeCode(home string, dryRun bool) (bool, error) {
	path := filepath.Join(home, ".claude", "settings.json")
	settings := loadJSONObjectQuiet(path)
	if settings == nil {
		return false, nil
	}
	changed := false
	managedEnv := []string{"CARACAL_HOOKS_URL", "CARACAL_HOOKS_SPEC_VERSION", "CARACAL_USER_ID", "CARACAL_USERNAME", "CARACAL_AGENT_NAME"}
	if env := settings.object("env"); env != nil {
		for _, key := range managedEnv {
			if env.has(key) {
				env.remove(key)
				changed = true
			}
		}
		if env.len() == 0 {
			settings.remove("env")
		}
	}
	if hooks := settings.object("hooks"); hooks != nil {
		for _, event := range append([]string{}, hooks.keys...) {
			kept := []any{}
			for _, rawGroup := range hooks.array(event) {
				if group, ok := rawGroup.(*omap); ok && isCaracalMatcherGroup(group) {
					changed = true
					continue
				}
				kept = append(kept, rawGroup)
			}
			if len(kept) == 0 {
				hooks.remove(event)
			} else {
				hooks.set(event, kept)
			}
		}
		if hooks.len() == 0 {
			settings.remove("hooks")
		}
	}
	if changed && !dryRun {
		if err := writeDoctorJSON(path, settings); err != nil {
			return false, err
		}
	}
	return changed, nil
}

func cleanupKiro(home string, dryRun bool) (bool, error) {
	agentsDir := filepath.Join(home, ".kiro", "agents")
	entries, err := os.ReadDir(agentsDir)
	if err != nil {
		return false, nil
	}
	changed := false
	names := []string{}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".json") {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	for _, name := range names {
		path := filepath.Join(agentsDir, name)
		profile := loadJSONObjectQuiet(path)
		if profile == nil {
			continue
		}
		hooks := profile.object("hooks")
		if hooks == nil {
			continue
		}
		profileChanged := false
		for _, event := range append([]string{}, hooks.keys...) {
			kept := []any{}
			for _, rawHook := range hooks.array(event) {
				if hook, ok := rawHook.(*omap); ok && isCaracalHookEntry(hook) {
					profileChanged = true
					continue
				}
				kept = append(kept, rawHook)
			}
			if len(kept) == 0 {
				hooks.remove(event)
			} else {
				hooks.set(event, kept)
			}
		}
		if profileChanged {
			changed = true
			if !dryRun {
				if err := writeDoctorJSON(path, profile); err != nil {
					return false, err
				}
			}
		}
	}
	return changed, nil
}

func cleanupHookEntriesFile(path string, dryRun bool) (bool, error) {
	doc := loadJSONObjectQuiet(path)
	if doc == nil {
		return false, nil
	}
	hooks := doc.object("hooks")
	if hooks == nil {
		return false, nil
	}
	changed := false
	for _, event := range append([]string{}, hooks.keys...) {
		kept := []any{}
		for _, rawEntry := range hooks.array(event) {
			entry, _ := rawEntry.(*omap)
			if entry != nil {
				haystack := entry.str("command") + entry.str("bash")
				grouped := entry.array("hooks")
				groupMatch := false
				for _, rawHook := range grouped {
					if hook, ok := rawHook.(*omap); ok && isCaracalHookEntry(hook) {
						groupMatch = true
					}
				}
				if strings.Contains(haystack, "session_push") || strings.Contains(haystack, "session-push") || groupMatch {
					changed = true
					continue
				}
			}
			kept = append(kept, rawEntry)
		}
		if len(kept) == 0 {
			hooks.remove(event)
		} else {
			hooks.set(event, kept)
		}
	}
	if hooks.len() == 0 {
		doc.remove("hooks")
	}
	if changed && !dryRun {
		if err := writeDoctorJSON(path, doc); err != nil {
			return false, err
		}
	}
	return changed, nil
}

func cleanupPi(home string, dryRun bool) (bool, error) {
	changed := false
	extensionPath := filepath.Join(home, ".pi", "agent", "extensions", "caracal.ts")
	if _, err := os.Stat(extensionPath); err == nil {
		changed = true
		if !dryRun {
			_ = os.Remove(extensionPath)
		}
	}
	settingsPath := filepath.Join(home, ".pi", "agent", "settings.json")
	settings := loadJSONObjectQuiet(settingsPath)
	if settings != nil {
		packages := settings.array("packages")
		kept := []any{}
		for _, rawPkg := range packages {
			source := ""
			switch pkg := rawPkg.(type) {
			case string:
				source = pkg
			case *omap:
				source = pkg.str("source")
			}
			if source == "npm:caracal-pi" || strings.HasPrefix(source, "npm:caracal-pi@") {
				continue
			}
			kept = append(kept, rawPkg)
		}
		if len(kept) != len(packages) {
			changed = true
			if !dryRun {
				settings.set("packages", kept)
				if err := writeDoctorJSON(settingsPath, settings); err != nil {
					return false, err
				}
			}
		}
	}
	return changed, nil
}

func cleanupCopilot(home, cwd string, dryRun bool) (bool, error) {
	changed := false
	for _, path := range []string{
		filepath.Join(cwd, ".github", "hooks", "caracal.json"),
		filepath.Join(home, ".copilot", "hooks", "caracal.json"),
	} {
		if _, err := os.Stat(path); err == nil {
			changed = true
			if !dryRun {
				_ = os.Remove(path)
			}
		}
	}
	ps1Path := filepath.Join(cwd, ".github", "hooks", "run_hook.ps1")
	if blob, err := os.ReadFile(ps1Path); err == nil {
		content := string(blob)
		if strings.Contains(content, "copilot_vscode_session_push") ||
			strings.Contains(content, "hooks.session_push --harness copilot") ||
			strings.Contains(content, "hook session-push --harness copilot") {
			changed = true
			if !dryRun {
				_ = os.Remove(ps1Path)
			}
		}
	}
	return changed, nil
}

func cleanupRemoveFile(path string, dryRun bool) (bool, error) {
	if _, err := os.Stat(path); err != nil {
		return false, nil
	}
	if !dryRun {
		if err := os.Remove(path); err != nil {
			return false, err
		}
	}
	return true, nil
}

func cleanupGoose(home string, dryRun bool) (bool, error) {
	pluginDir := filepath.Join(gooseAgentsHome(home), "plugins", "caracal")
	if _, err := os.Stat(pluginDir); err != nil {
		return false, nil
	}
	hooksPath := filepath.Join(pluginDir, "hooks", "hooks.json")
	doc := loadJSONObjectQuiet(hooksPath)
	foreign := newOmap()
	if doc != nil {
		if hooks := doc.object("hooks"); hooks != nil {
			for _, event := range hooks.keys {
				kept := []any{}
				for _, rawRule := range hooks.array(event) {
					rule, _ := rawRule.(*omap)
					caracal := false
					if rule != nil {
						for _, rawHandler := range rule.array("hooks") {
							if handler, ok := rawHandler.(*omap); ok && isCaracalHookEntry(handler) {
								caracal = true
							}
						}
					}
					if !caracal {
						kept = append(kept, rawRule)
					}
				}
				if len(kept) > 0 {
					foreign.set(event, kept)
				}
			}
		}
	}
	if foreign.len() > 0 {
		if !dryRun {
			doc.set("hooks", foreign)
			if err := writeDoctorJSON(hooksPath, doc); err != nil {
				return false, err
			}
		}
		return true, nil
	}
	if !dryRun {
		if err := os.RemoveAll(pluginDir); err != nil {
			return false, err
		}
	}
	return true, nil
}

// ── dispatch ───────────────────────────────────────────────────────

func adapterChange(target, action string, dryRun bool) (bool, *clierr.Error) {
	home, _ := os.UserHomeDir()
	cwd, _ := os.Getwd()
	var changed bool
	var err error
	patch := action == "patch"
	switch target {
	case "claude-code":
		if patch {
			changed, err = patchClaudeCode(home, dryRun)
		} else {
			changed, err = cleanupClaudeCode(home, dryRun)
		}
	case "kiro":
		if patch {
			changed, err = patchKiro(home, dryRun)
		} else {
			changed, err = cleanupKiro(home, dryRun)
		}
	case "cursor":
		if patch {
			changed, err = patchCursor(home, dryRun)
		} else {
			changed, err = cleanupHookEntriesFile(filepath.Join(home, ".cursor", "hooks.json"), dryRun)
		}
	case "codex":
		if patch {
			changed, err = patchCodex(home, dryRun)
		} else {
			changed, err = cleanupHookEntriesFile(filepath.Join(home, ".codex", "hooks.json"), dryRun)
		}
	case "copilot":
		if patch {
			changed, err = patchCopilotFamily(home, cwd, "copilot", dryRun)
		} else {
			changed, err = cleanupCopilot(home, cwd, dryRun)
		}
	case "copilot-cli":
		if patch {
			changed, err = patchCopilotFamily(home, cwd, "copilot-cli", dryRun)
		} else {
			changed, err = cleanupRemoveFile(filepath.Join(home, ".copilot", "hooks", "caracal.json"), dryRun)
		}
	case "opencode":
		if patch {
			changed, err = patchOpencode(home, dryRun)
		} else {
			changed, err = cleanupRemoveFile(filepath.Join(home, ".config", "opencode", "plugins", "caracal-plugin.ts"), dryRun)
		}
	case "antigravity":
		if patch {
			changed, err = patchAntigravity(home, dryRun)
		}
	case "goose":
		if patch {
			changed, err = patchGoose(home, dryRun)
		} else {
			changed, err = cleanupGoose(home, dryRun)
		}
	case "pi":
		if patch {
			changed, err = patchPi(home, dryRun)
		} else {
			changed, err = cleanupPi(home, dryRun)
		}
	}
	if err != nil {
		return false, &clierr.Error{
			Category: clierr.Unavailable, Message: fmt.Sprintf("Cannot %s %s harness files.", action, target),
			Operation: "Doctor " + action, Resource: target,
			Remediation: "Check filesystem paths and permissions, then retry.", Detail: err.Error(),
		}
	}
	return changed, nil
}

type patchTarget struct {
	Harness string
	Changed bool
}

func patchTargets(targets []string, dryRun bool) ([]patchTarget, *clierr.Error) {
	results := []patchTarget{}
	for _, target := range targets {
		changed, cerr := adapterChange(target, "patch", dryRun)
		if cerr != nil {
			return nil, cerr
		}
		results = append(results, patchTarget{Harness: target, Changed: changed})
	}
	return results, nil
}

func patchResultDoc(action string, dryRun bool, targets []patchTarget) string {
	anyChanged := false
	parts := make([]string, len(targets))
	for i, target := range targets {
		if target.Changed {
			anyChanged = true
		}
		parts[i] = fmt.Sprintf(`{"harness": %s, "changed": %t}`, jsonString(target.Harness), target.Changed)
	}
	return fmt.Sprintf(`{"action": %s, "dry_run": %t, "changed": %t, "targets": [%s]}`,
		jsonString(action), dryRun, anyChanged, strings.Join(parts, ", "))
}

func validDoctorTargets(values []string, operation string) *clierr.Error {
	for _, value := range values {
		if !contains(validHarnesses, value) {
			return &clierr.Error{
				Category: clierr.Validation, Message: fmt.Sprintf("Unknown harness: %s.", value),
				Operation: operation, Resource: "harness",
				Remediation: "Choose from: " + strings.Join(validHarnesses, ", ") + ".",
			}
		}
	}
	return nil
}

// ── commands ───────────────────────────────────────────────────────

func doctorCommand() *cobra.Command {
	group := &cobra.Command{Use: "doctor", Short: "Diagnose and repair harness telemetry configuration"}
	yes := group.Flags().BoolP("yes", "y", false, "Auto-fix all warnings without prompting")
	mode := outputFlag(group)
	group.RunE = func(_ *cobra.Command, _ []string) error {
		home, _ := os.UserHomeDir()
		cwd, _ := os.Getwd()
		issues := []string{}
		warnings := []string{}
		lockfileChangeDocs := []string{}
		var lockData *lockfile.File
		var lockChanges []lockfileChange
		client, cerr := api.New(cliVersion)
		if cerr == nil {
			data, changes, _, err := planLockfileReconciliation(client)
			if err != nil {
				issues = append(issues, fmt.Sprintf("Lockfile reconciliation failed: %v", err))
			} else {
				lockData = data
				lockChanges = changes
				if len(changes) > 0 {
					warnings = append(warnings, fmt.Sprintf("Registry metadata drift found in %d lockfile field(s).", len(changes)))
				}
				for _, change := range changes {
					lockfileChangeDocs = append(lockfileChangeDocs, fmt.Sprintf(`{"label": %s, "field": %s, "old": %s, "new": %s}`,
						jsonString(change.Label), jsonString(change.Field), jsonAny(change.Old), jsonAny(change.New)))
				}
			}
		}
		checkCaracalConfig(&issues)
		checkClaudeCode(home, &issues, &warnings)
		checkKiro(home, &issues, &warnings)
		checkPi(home, &issues, &warnings)
		checkCursor(home, &issues, &warnings)
		checkCodex(home, &issues, &warnings)
		checkCopilot(home, cwd, &issues, &warnings)
		checkCopilotCLI(home, &issues, &warnings)
		checkOpencode(home, &issues, &warnings)
		checkAntigravity(home, &issues, &warnings)
		checkGoose(home, &issues, &warnings)
		skillMissing := missingCaracalSkillHarnesses(home)
		if len(skillMissing) > 0 {
			warnings = append(warnings, fmt.Sprintf("Caracal AI skill not installed for: %s. LLMs will not have Caracal commands available.", strings.Join(skillMissing, ", ")))
		}
		fixAttempted := false
		patchDoc := "null"
		if len(warnings) > 0 && *yes {
			fixAttempted = true
			if lockData != nil && len(lockChanges) > 0 {
				for _, change := range lockChanges {
					change.apply()
				}
				_ = lockfile.Write(lockData)
			}
			results, cerr := patchTargets(validHarnesses, false)
			if cerr != nil {
				return cerr
			}
			patchDoc = patchResultDoc("patch", false, results)
			_ = syncBundledSkills(home, true)
		}
		issueParts := make([]string, len(issues))
		for i, issue := range issues {
			issueParts[i] = jsonString(issue)
		}
		warningParts := make([]string, len(warnings))
		for i, warning := range warnings {
			warningParts[i] = jsonString(warning)
		}
		skillParts := make([]string, len(skillMissing))
		for i, name := range skillMissing {
			skillParts[i] = jsonString(name)
		}
		doc := fmt.Sprintf(`{"healthy": %t, "issues": [%s], "warnings": [%s], "lockfile_changes": [%s], "skill_missing": [%s], "fix_attempted": %t, "patch": %s}`,
			len(issues) == 0 && len(warnings) == 0, strings.Join(issueParts, ", "), strings.Join(warningParts, ", "),
			strings.Join(lockfileChangeDocs, ", "), strings.Join(skillParts, ", "), fixAttempted, patchDoc)
		if *mode == "json" {
			outputJSONRaw([]byte(doc))
			return nil
		}
		if len(issues) == 0 && len(warnings) == 0 {
			ui.Stdout().Successf("All clear! No issues found.")
			return nil
		}
		for i, issue := range issues {
			fmt.Printf("  %d. %s\n", i+1, issue)
		}
		for i, warning := range warnings {
			fmt.Printf("  %d. %s\n", i+1, warning)
		}
		if len(issues) > 0 {
			return &clierr.Error{Category: clierr.Unexpected, Message: "Aborted!", Operation: "Doctor diagnose"}
		}
		return nil
	}
	group.AddCommand(doctorPatchCommand(), doctorCleanupCommand(), supportGroup())
	return group
}

func jsonAny(value any) string {
	if value == nil {
		return "null"
	}
	blob, err := marshalOrdered(value)
	if err != nil {
		return "null"
	}
	return string(blob)
}

func doctorPatchCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "patch", Short: "Install or repair managed telemetry hooks", Args: cobra.NoArgs}
	allHarnesses := cmd.Flags().Bool("all-harnesses", false, "Patch every registered harness")
	harnessFlags := cmd.Flags().StringArrayP("harness", "i", nil, "Target harness (repeat for multiple)")
	dryRun := cmd.Flags().BoolP("dry-run", "n", false, "Preview without writing")
	mode := outputFlag(cmd)
	cmd.RunE = func(_ *cobra.Command, _ []string) error {
		const op = "Patch Doctor instrumentation"
		if *allHarnesses && len(*harnessFlags) > 0 {
			return validationErr("Choose either --all-harnesses or --harness, not both.", op,
				"harness selection", "Remove one of the conflicting target options.")
		}
		if !*allHarnesses && len(*harnessFlags) == 0 {
			return validationErr("Doctor patch requires a target harness.", op,
				"harness selection", "Add --all-harnesses or at least one --harness.")
		}
		if cerr := validDoctorTargets(*harnessFlags, op); cerr != nil {
			return cerr
		}
		cfg, cerr := config.Load()
		if cerr != nil || config.Str(cfg, "server_url") == "" {
			return &clierr.Error{
				Category: clierr.Auth, Message: "Caracal authentication is not configured.",
				Operation: op, Resource: "CLI configuration",
				Remediation: "Run `caracal auth login` and retry.",
			}
		}
		targets := validHarnesses
		if !*allHarnesses {
			seen := map[string]bool{}
			targets = []string{}
			for _, target := range *harnessFlags {
				if !seen[target] {
					targets = append(targets, target)
					seen[target] = true
				}
			}
		}
		results, cerr := patchTargets(targets, *dryRun)
		if cerr != nil {
			return cerr
		}
		doc := patchResultDoc("patch", *dryRun, results)
		if *mode == "json" {
			outputJSONRaw([]byte(doc))
			return nil
		}
		printDocumentSummary([]byte(doc))
		return nil
	}
	return cmd
}

func doctorCleanupCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "cleanup", Short: "Remove managed telemetry instrumentation", Args: cobra.NoArgs}
	harnessFlag := cmd.Flags().StringP("harness", "i", "", "Target one harness. Default: all.")
	exclude := cmd.Flags().StringArrayP("exclude", "x", nil, "Exclude a harness (repeatable)")
	dryRun := cmd.Flags().BoolP("dry-run", "n", false, "Preview without writing")
	yes := cmd.Flags().BoolP("yes", "y", false, "Skip confirmation")
	mode := outputFlag(cmd)
	cmd.RunE = func(_ *cobra.Command, _ []string) error {
		const op = "Clean up Doctor instrumentation"
		selectors := append([]string{}, *exclude...)
		if *harnessFlag != "" {
			selectors = append(selectors, *harnessFlag)
		}
		if cerr := validDoctorTargets(selectors, op); cerr != nil {
			return cerr
		}
		selected := validHarnesses
		if *harnessFlag != "" {
			selected = []string{*harnessFlag}
		}
		excluded := map[string]bool{}
		for _, name := range *exclude {
			excluded[name] = true
		}
		targets := []string{}
		for _, target := range selected {
			if !excluded[target] {
				targets = append(targets, target)
			}
		}
		if len(targets) == 0 {
			return validationErr("Doctor cleanup has no target harnesses.", op,
				"harness selection", "Remove the conflicting exclusion or select another harness.")
		}
		if !*dryRun && !*yes {
			if *mode == "json" {
				return validationErr("JSON mode cannot prompt before removing telemetry instrumentation.", op,
					"harness instrumentation", "Add --yes to confirm cleanup.")
			}
			if !confirmDanger("Remove Caracal-managed telemetry instrumentation?") {
				return abortErr(op)
			}
		}
		results := []patchTarget{}
		for _, target := range targets {
			changed, cerr := adapterChange(target, "cleanup", *dryRun)
			if cerr != nil {
				return cerr
			}
			results = append(results, patchTarget{Harness: target, Changed: changed})
		}
		doc := patchResultDoc("cleanup", *dryRun, results)
		if *mode == "json" {
			outputJSONRaw([]byte(doc))
			return nil
		}
		printDocumentSummary([]byte(doc))
		return nil
	}
	return cmd
}
