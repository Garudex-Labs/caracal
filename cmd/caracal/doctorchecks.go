// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"crypto/sha256"
	"embed"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/cli/api"
	"github.com/garudex-labs/caracal/internal/cli/config"
	"github.com/garudex-labs/caracal/internal/cli/lockfile"
	"github.com/garudex-labs/caracal/internal/harness"
)

//go:embed assets/opencode-plugin.ts assets/pi-caracal.ts
var doctorAssets embed.FS

// caracalHookMarkers identifies managed hook entries across generations.
var caracalHookMarkers = []string{
	"caracal-hook", "caracal-stop-hook", "caracal_cli.hooks.session_push",
	"caracal_cli.hooks.kiro_session_push", "caracal_cli.hooks.cursor_session_push",
	"caracal_cli.hooks.antigravity_session_push", "caracal_cli.hooks.kiro_hook",
	"caracal_cli.hooks.kiro_stop_hook", "caracal_cli.hooks.copilot_cli_hook",
	"caracal_cli.hooks.copilot_cli_stop_hook", "caracal_cli.hooks.buffer_event",
	"caracal_cli.hooks.flush_buffer", "caracal_cli", "/api/v1/telemetry/hooks",
	"/api/v1/otel/hooks", "hook session-push",
}

func isCaracalHookEntry(entry *omap) bool {
	if entry == nil {
		return false
	}
	haystack := entry.str("command") + entry.str("url") + entry.str("bash")
	for _, marker := range caracalHookMarkers {
		if strings.Contains(haystack, marker) {
			return true
		}
	}
	return false
}

func isCaracalMatcherGroup(group *omap) bool {
	if group == nil {
		return false
	}
	if group.has("_caracal") {
		return true
	}
	for _, rawHook := range group.array("hooks") {
		if hook, ok := rawHook.(*omap); ok && isCaracalHookEntry(hook) {
			return true
		}
	}
	return false
}

// hookCommandFor returns the managed session-push invocation.
func hookCommandFor(harnessName string) string {
	exe, err := os.Executable()
	if err != nil {
		exe = "caracal"
	}
	return exe + " hook session-push --harness " + harnessName
}

func loadJSONObjectQuiet(path string) *omap {
	blob, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	lines := strings.Split(string(blob), "\n")
	kept := lines[:0]
	for _, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), "//") {
			continue
		}
		kept = append(kept, line)
	}
	value, err := decodeOrderedJSON([]byte(strings.Join(kept, "\n")))
	if err != nil {
		return nil
	}
	object, _ := value.(*omap)
	return object
}

func writeDoctorJSON(path string, doc *omap) error {
	blob, err := marshalOrdered(doc)
	if err != nil {
		return err
	}
	pretty, err := indentJSON(blob)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	mode := os.FileMode(0o644)
	if info, err := os.Stat(path); err == nil {
		mode = info.Mode().Perm()
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(append(pretty, '\n')); err != nil {
		_ = tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	_ = os.Chmod(tmp.Name(), mode)
	return os.Rename(tmp.Name(), path)
}

// ── lockfile reconciliation ────────────────────────────────────────

type lockfileChange struct {
	Label string
	Field string
	Old   any
	New   any
	apply func()
}

var reconcileItemTypes = map[string]bool{
	"agent": true, "mcp": true, "skill": true, "hook": true, "prompt": true,
}

// planLockfileReconciliation fetches canonical metadata for lockfile refs.
func planLockfileReconciliation(client *api.Client) (*lockfile.File, []lockfileChange, []string, error) {
	data, registry, err := lockfile.ReadRegistry(false)
	if err != nil {
		return nil, nil, nil, err
	}
	type refEntry struct {
		entry *lockfile.Entry
		label string
	}
	refs := map[[2]string][]refEntry{}
	addRef := func(itemType, itemID string, entry *lockfile.Entry, label string) {
		refs[[2]string{itemType, itemID}] = append(refs[[2]string{itemType, itemID}], refEntry{entry, label})
	}
	for harnessName, section := range registry.Harnesses {
		if section == nil {
			continue
		}
		for i := range section.Agents {
			agent := &section.Agents[i]
			if agent.ID != "" {
				addRef("agent", agent.ID, agent, fmt.Sprintf("%s agent %s", harnessName, agent.ID[:min(8, len(agent.ID))]))
			}
		}
		for i := range section.Standalone {
			item := &section.Standalone[i]
			itemType := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(item.Type)), "s")
			if reconcileItemTypes[itemType] && item.ID != "" {
				addRef(itemType, item.ID, item, fmt.Sprintf("%s %s %s", harnessName, itemType, item.ID[:min(8, len(item.ID))]))
			}
		}
	}
	changes := []lockfileChange{}
	requestItems := []map[string]string{}
	validRefs := map[[2]string][]refEntry{}
	for key, entries := range refs {
		parsed, err := uuid.Parse(key[1])
		if err != nil {
			continue
		}
		canonical := parsed.String()
		validRefs[[2]string{key[0], canonical}] = entries
		requestItems = append(requestItems, map[string]string{"type": key[0], "id": canonical})
	}
	if len(requestItems) == 0 {
		return data, changes, nil, nil
	}
	sort.Slice(requestItems, func(i, j int) bool {
		return requestItems[i]["id"] < requestItems[j]["id"]
	})
	raw, cerr := client.Do("POST", "/api/v1/registry/reconcile", nil,
		map[string]any{"items": requestItems}, "Reconcile installed registry state", "installed registry state")
	if cerr != nil {
		return nil, nil, nil, fmt.Errorf("%s", cerr.Message)
	}
	var results []struct {
		Type          string  `json:"type"`
		ID            string  `json:"id"`
		Found         bool    `json:"found"`
		Name          *string `json:"name"`
		Namespace     *string `json:"namespace"`
		Slug          *string `json:"slug"`
		QualifiedName *string `json:"qualified_name"`
		Status        string  `json:"status"`
	}
	if err := json.Unmarshal(raw, &results); err != nil {
		return nil, nil, nil, err
	}
	addChange := func(entry *lockfile.Entry, label, field string, old, newValue any, apply func()) {
		if fmt.Sprint(old) == fmt.Sprint(newValue) && old != nil {
			return
		}
		if old == nil && newValue == nil {
			return
		}
		changes = append(changes, lockfileChange{Label: label, Field: field, Old: old, New: newValue, apply: apply})
	}
	for _, result := range results {
		entries := validRefs[[2]string{result.Type, result.ID}]
		for _, ref := range entries {
			entry := ref.entry
			if !result.Found {
				continue
			}
			if result.Name != nil && entry.Name != *result.Name {
				name := *result.Name
				addChange(entry, ref.label, "name", entry.Name, name, func() { entry.Name = name })
			}
			if result.Namespace != nil && entry.Namespace != *result.Namespace {
				namespace := *result.Namespace
				addChange(entry, ref.label, "namespace", entry.Namespace, namespace, func() { entry.Namespace = namespace })
			}
			if result.Slug != nil && entry.Slug != *result.Slug {
				slug := *result.Slug
				addChange(entry, ref.label, "slug", entry.Slug, slug, func() { entry.Slug = slug })
			}
			if result.QualifiedName != nil && entry.QualifiedName != *result.QualifiedName {
				qualified := *result.QualifiedName
				addChange(entry, ref.label, "qualified_name", entry.QualifiedName, qualified, func() { entry.QualifiedName = qualified })
			}
		}
	}
	return data, changes, nil, nil
}

// ── diagnose checks ────────────────────────────────────────────────

func checkCaracalConfig(issues *[]string) {
	path := config.File()
	blob, err := os.ReadFile(path)
	if err != nil {
		*issues = append(*issues, "~/.caracal/config.json not found. Run `caracal auth login` first.")
		return
	}
	var cfg map[string]any
	if json.Unmarshal(blob, &cfg) != nil {
		*issues = append(*issues, "~/.caracal/config.json is not valid JSON.")
		return
	}
	if config.Str(cfg, "access_token") == "" {
		*issues = append(*issues, "No access token in ~/.caracal/config.json. Run `caracal auth login`.")
	}
	serverURL := config.Str(cfg, "server_url")
	if serverURL == "" {
		*issues = append(*issues, "No server_url in ~/.caracal/config.json. Run `caracal auth login`.")
		return
	}
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(serverURL + "/health")
	if err != nil {
		*issues = append(*issues, fmt.Sprintf("Cannot reach Caracal server at %s: %v", serverURL, err))
		return
	}
	_ = resp.Body.Close()
	if resp.StatusCode != 200 {
		*issues = append(*issues, fmt.Sprintf("Caracal server at %s returned status %d.", serverURL, resp.StatusCode))
	}
}

func eventGroupsContain(settings *omap, events []string, marker string) bool {
	hooks := settings.object("hooks")
	if hooks == nil {
		return false
	}
	for _, event := range events {
		for _, rawGroup := range hooks.array(event) {
			group, _ := rawGroup.(*omap)
			if group == nil {
				continue
			}
			for _, rawHook := range group.array("hooks") {
				if hook, ok := rawHook.(*omap); ok && strings.Contains(hook.str("command"), marker) {
					return true
				}
			}
		}
	}
	return false
}

func checkClaudeCode(home string, issues, warnings *[]string) {
	path := filepath.Join(home, ".claude", "settings.json")
	if _, err := os.Stat(path); err != nil {
		return
	}
	settings := loadJSONObjectQuiet(path)
	if settings == nil {
		*issues = append(*issues, fmt.Sprintf("%s: not valid JSON.", path))
		return
	}
	if truthy(settings.get("disableAllHooks")) {
		*issues = append(*issues, fmt.Sprintf("%s: `disableAllHooks` is true. Caracal hooks will not fire.", path))
	}
	hasPush := eventGroupsContain(settings, []string{"UserPromptSubmit", "Stop"}, "caracal_cli.hooks.session_push") ||
		eventGroupsContain(settings, []string{"UserPromptSubmit", "Stop"}, "hook session-push")
	if !hasPush {
		*warnings = append(*warnings, "Claude Code session push hooks not installed. Run `caracal doctor patch --harness claude-code` to inject them.")
	}
	legacy := false
	if hooks := settings.object("hooks"); hooks != nil {
		for _, event := range hooks.keys {
			for _, rawGroup := range hooks.array(event) {
				group, _ := rawGroup.(*omap)
				if group == nil {
					continue
				}
				for _, rawHook := range group.array("hooks") {
					hook, _ := rawHook.(*omap)
					if hook == nil {
						continue
					}
					command := hook.str("command")
					for _, marker := range []string{"caracal-hook", "caracal-stop-hook", "/api/v1/telemetry/hooks"} {
						if strings.Contains(command, marker) {
							legacy = true
						}
					}
				}
			}
		}
	}
	if legacy {
		*warnings = append(*warnings, "Legacy Caracal hooks detected (old hook scripts). Run `caracal doctor cleanup --harness claude-code` to remove them.")
	}
}

func checkKiro(home string, _, warnings *[]string) {
	agentsDir := filepath.Join(home, ".kiro", "agents")
	entries, err := os.ReadDir(agentsDir)
	if err != nil || len(entries) == 0 {
		return
	}
	found := false
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		profile := loadJSONObjectQuiet(filepath.Join(agentsDir, entry.Name()))
		if profile == nil {
			continue
		}
		hooks := profile.object("hooks")
		if hooks == nil {
			continue
		}
		for _, event := range hooks.keys {
			for _, rawHook := range hooks.array(event) {
				hook, _ := rawHook.(*omap)
				if hook == nil {
					continue
				}
				command := hook.str("command")
				if strings.Contains(command, "caracal_cli.hooks.session_push --harness kiro") ||
					strings.Contains(command, "hook session-push --harness kiro") {
					found = true
				}
			}
		}
	}
	if !found {
		*warnings = append(*warnings, "Kiro acknowledged session hooks not installed in any agent config. Pull the Kiro agent again to refresh its attributed hooks.")
	}
}

func checkCursor(home string, issues, warnings *[]string) {
	if _, err := os.Stat(filepath.Join(home, ".cursor")); err != nil {
		return
	}
	path := filepath.Join(home, ".cursor", "hooks.json")
	blob, err := os.ReadFile(path)
	warn := func() {
		*warnings = append(*warnings, "Cursor session push hooks not installed. Run `caracal doctor patch --harness cursor` to inject them.")
	}
	if err != nil {
		warn()
		return
	}
	value, err := decodeOrderedJSON(blob)
	doc, _ := value.(*omap)
	if err != nil || doc == nil {
		*issues = append(*issues, fmt.Sprintf("%s: not valid JSON.", path))
		return
	}
	hooks := doc.object("hooks")
	found := false
	if hooks != nil {
		for _, event := range []string{"beforeSubmitPrompt", "stop"} {
			for _, rawEntry := range hooks.array(event) {
				entry, _ := rawEntry.(*omap)
				if entry == nil {
					continue
				}
				command := entry.str("command")
				if strings.Contains(command, "hooks.session_push --harness cursor") ||
					strings.Contains(command, "hook session-push --harness cursor") {
					found = true
				}
			}
		}
	}
	if !found {
		warn()
	}
}

func checkCodex(home string, issues, warnings *[]string) {
	codexDir := filepath.Join(home, ".codex")
	if _, err := os.Stat(codexDir); err != nil {
		return
	}
	settings := loadJSONObjectQuiet(filepath.Join(codexDir, "hooks.json"))
	hasPush := settings != nil && (eventGroupsContain(settings, []string{"UserPromptSubmit", "Stop"}, "hooks.session_push --harness codex") ||
		eventGroupsContain(settings, []string{"UserPromptSubmit", "Stop"}, "hook session-push --harness codex"))
	if !hasPush {
		*warnings = append(*warnings, "Codex session push hooks not installed. Run `caracal doctor patch --harness codex` to inject them.")
	}
	configPath := filepath.Join(codexDir, "config.toml")
	if blob, err := os.ReadFile(configPath); err == nil {
		if strings.Contains(string(blob), "codex_hooks = false") {
			*issues = append(*issues, fmt.Sprintf("%s: `codex_hooks = false`. Caracal hooks will not fire.", configPath))
		}
	}
}

func copilotHookMatch(entry *omap, markers []string) bool {
	haystack := entry.str("command") + entry.str("bash")
	for _, marker := range markers {
		if strings.Contains(haystack, marker) {
			return true
		}
	}
	return false
}

func checkCopilot(home, cwd string, _, warnings *[]string) {
	if _, err := os.Stat(filepath.Join(home, ".vscode")); err != nil {
		return
	}
	markers := []string{"copilot_vscode_session_push", "run_hook.ps1", "hooks.session_push --harness copilot", "hook session-push --harness copilot"}
	found := false
	for _, path := range []string{
		filepath.Join(home, ".copilot", "hooks", "caracal.json"),
		filepath.Join(cwd, ".github", "hooks", "caracal.json"),
	} {
		doc := loadJSONObjectQuiet(path)
		if doc == nil {
			continue
		}
		hooks := doc.object("hooks")
		if hooks == nil {
			continue
		}
		for _, event := range hooks.keys {
			for _, rawEntry := range hooks.array(event) {
				if entry, ok := rawEntry.(*omap); ok && copilotHookMatch(entry, markers) {
					found = true
				}
			}
		}
	}
	if !found {
		*warnings = append(*warnings, "Copilot (VS Code) session push hooks not installed. Run `caracal doctor patch --harness copilot` to inject them.")
	}
}

func checkCopilotCLI(home string, issues, warnings *[]string) {
	if _, err := os.Stat(filepath.Join(home, ".copilot")); err != nil {
		return
	}
	path := filepath.Join(home, ".copilot", "hooks", "caracal.json")
	warn := func() {
		*warnings = append(*warnings, "Copilot CLI session push hooks not installed. Run `caracal doctor patch --harness copilot-cli` to inject them.")
	}
	blob, err := os.ReadFile(path)
	if err != nil {
		warn()
		return
	}
	value, err := decodeOrderedJSON(blob)
	doc, _ := value.(*omap)
	if err != nil || doc == nil {
		*issues = append(*issues, fmt.Sprintf("%s: not valid JSON.", path))
		return
	}
	hooks := doc.object("hooks")
	found := false
	if hooks != nil {
		for _, event := range []string{"sessionStart", "sessionEnd", "userPromptSubmitted"} {
			for _, rawEntry := range hooks.array(event) {
				entry, _ := rawEntry.(*omap)
				if entry == nil {
					continue
				}
				bash := entry.str("bash")
				if strings.Contains(bash, "copilot_cli_session_push") ||
					strings.Contains(bash, "hooks.session_push --harness copilot-cli") ||
					strings.Contains(bash, "hook session-push --harness copilot-cli") {
					found = true
				}
			}
		}
	}
	if !found {
		warn()
	}
}

func checkOpencode(home string, issues, warnings *[]string) {
	base := filepath.Join(home, ".config", "opencode")
	if _, err := os.Stat(base); err != nil {
		return
	}
	path := filepath.Join(base, "plugins", "caracal-plugin.ts")
	blob, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			*warnings = append(*warnings, "OpenCode caracal plugin not installed. Run `caracal doctor patch --harness opencode` to inject it.")
		} else {
			*issues = append(*issues, fmt.Sprintf("%s: failed to read OpenCode plugin: %v", path, err))
		}
		return
	}
	desired, _ := doctorAssets.ReadFile("assets/opencode-plugin.ts")
	if sha256.Sum256(blob) == sha256.Sum256(desired) {
		return
	}
	content := string(blob)
	if strings.Contains(content, "offline stub") || strings.Contains(content, "event: async () => {}") {
		*warnings = append(*warnings, "OpenCode caracal plugin is an offline stub. Run `caracal doctor patch --harness opencode` to update it.")
		return
	}
	*warnings = append(*warnings, "OpenCode caracal plugin is stale or modified. Run `caracal doctor patch --harness opencode` to update it.")
}

func antigravityConfigDir(home string) string {
	dir := filepath.Join(home, ".gemini", "config")
	if _, err := os.Stat(dir); err == nil {
		return dir
	}
	return ""
}

func checkAntigravity(home string, issues, warnings *[]string) {
	dir := antigravityConfigDir(home)
	if dir == "" {
		return
	}
	path := filepath.Join(dir, "hooks.json")
	warn := func() {
		*warnings = append(*warnings, "Antigravity session push hooks not installed. Run `caracal doctor patch --harness antigravity` to inject them.")
	}
	blob, err := os.ReadFile(path)
	if err != nil {
		warn()
		return
	}
	value, err := decodeOrderedJSON(blob)
	doc, _ := value.(*omap)
	if err != nil || doc == nil {
		*issues = append(*issues, fmt.Sprintf("%s: not valid JSON.", path))
		return
	}
	group := doc.object("caracal-telemetry")
	if group == nil {
		warn()
		return
	}
	found := false
	for _, event := range []string{"PreInvocation", "Stop"} {
		for _, rawEntry := range group.array(event) {
			entry, _ := rawEntry.(*omap)
			if entry == nil {
				continue
			}
			command := entry.str("command")
			if strings.Contains(command, "antigravity_session_push") ||
				strings.Contains(command, "hook session-push --harness antigravity") {
				found = true
			}
		}
	}
	if !found {
		warn()
	}
}

func gooseAgentsHome(home string) string {
	if root := os.Getenv("GOOSE_PATH_ROOT"); root != "" && filepath.IsAbs(root) {
		return filepath.Join(root, ".agents")
	}
	return filepath.Join(home, ".agents")
}

func gooseDetected(home string) bool {
	for _, dir := range []string{filepath.Join(home, ".config", "goose"), filepath.Join(home, ".local", "share", "goose")} {
		if info, err := os.Stat(dir); err == nil && info.IsDir() {
			return true
		}
	}
	return false
}

func checkGoose(home string, issues, warnings *[]string) {
	if !gooseDetected(home) {
		return
	}
	path := filepath.Join(gooseAgentsHome(home), "plugins", "caracal", "hooks", "hooks.json")
	blob, err := os.ReadFile(path)
	if err != nil {
		*warnings = append(*warnings, "Goose session push hooks not installed. Run `caracal doctor patch --harness goose` to update them.")
		return
	}
	value, err := decodeOrderedJSON(blob)
	doc, _ := value.(*omap)
	if err != nil || doc == nil {
		*issues = append(*issues, fmt.Sprintf("%s: not valid JSON object.", path))
		return
	}
	hooks := doc.object("hooks")
	stale := []string{}
	for _, event := range []string{"SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"} {
		current := false
		if hooks != nil {
			for _, rawRule := range hooks.array(event) {
				rule, _ := rawRule.(*omap)
				if rule == nil {
					continue
				}
				for _, rawHandler := range rule.array("hooks") {
					handler, _ := rawHandler.(*omap)
					if handler == nil {
						continue
					}
					command := handler.str("command")
					if strings.Contains(command, "hooks.session_push --harness goose") ||
						strings.Contains(command, "hook session-push --harness goose") {
						current = true
					}
				}
			}
		}
		if !current {
			stale = append(stale, event)
		}
	}
	if len(stale) == 4 {
		*warnings = append(*warnings, "Goose session push hooks not installed. Run `caracal doctor patch --harness goose` to update them.")
	} else if len(stale) > 0 {
		*warnings = append(*warnings, fmt.Sprintf("Goose session push hooks are missing or stale for: %s. Run `caracal doctor patch --harness goose` to update them.", strings.Join(stale, ", ")))
	}
}

func checkPi(home string, issues, warnings *[]string) {
	agentDir := filepath.Join(home, ".pi", "agent")
	if _, err := os.Stat(agentDir); err != nil {
		return
	}
	desired, _ := doctorAssets.ReadFile("assets/pi-caracal.ts")
	extensionPath := filepath.Join(agentDir, "extensions", "caracal.ts")
	current, readErr := os.ReadFile(extensionPath)
	settings := loadJSONObjectQuiet(filepath.Join(agentDir, "settings.json"))
	legacy := false
	if settings != nil {
		for _, rawPkg := range settings.array("packages") {
			source := ""
			switch pkg := rawPkg.(type) {
			case string:
				source = pkg
			case *omap:
				source = pkg.str("source")
			}
			if source == "npm:caracal-pi" || strings.HasPrefix(source, "npm:caracal-pi@") {
				legacy = true
			}
		}
	}
	if readErr != nil || !stringsEqualBytes(current, desired) {
		state := "not installed"
		if readErr == nil {
			state = "stale"
		}
		*warnings = append(*warnings, fmt.Sprintf("Caracal Pi extension is %s. Doctor can install %s directly.", state, extensionPath))
	} else if legacy {
		*warnings = append(*warnings, "Legacy npm:caracal-pi registration remains. Doctor can remove it.")
	}
	_ = issues
}

func stringsEqualBytes(a, b []byte) bool { return string(a) == string(b) }

// harnessSkillTargets reports installed harnesses missing the core skill.
func missingCaracalSkillHarnesses(home string) []string {
	registry := harness.MustLoad()
	markers := map[string][]string{
		"cursor": {".cursor"}, "kiro": {".kiro"}, "claude-code": {".claude"},
		"codex": {".codex"}, "copilot": {".vscode/extensions/github.copilot-*", ".vscode/extensions/github.copilot-chat-*"},
		"copilot-cli": {".copilot"}, "opencode": {".config/opencode"},
		"antigravity": {".gemini/antigravity-cli", ".gemini/config"},
		"goose":       {".config/goose", ".local/share/goose"}, "pi": {".pi"},
	}
	missing := []string{}
	for _, name := range registry.Names() {
		spec, _ := registry.Spec(name)
		// A harness that does not consume native Agent Skills can never be
		// "missing" the core skill; skip it rather than report a false gap.
		if spec == nil || !spec.EmitsSkillMd() || spec.Skills == nil || spec.Skills["user"] == "" {
			continue
		}
		installed := false
		for _, marker := range markers[name] {
			if strings.ContainsAny(marker, "*?[") {
				if matches, _ := filepath.Glob(filepath.Join(home, marker)); len(matches) > 0 {
					installed = true
				}
			} else if _, err := os.Stat(filepath.Join(home, marker)); err == nil {
				installed = true
			}
		}
		if !installed {
			continue
		}
		target := strings.Replace(spec.Skills["user"], "{name}", "caracal", 1)
		if strings.HasPrefix(target, "~/") {
			target = filepath.Join(home, target[2:])
		}
		if info, err := os.Stat(target); err != nil || info.IsDir() {
			missing = append(missing, spec.DisplayName)
		}
	}
	return missing
}
