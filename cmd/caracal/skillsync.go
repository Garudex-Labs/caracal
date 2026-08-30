// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"embed"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/garudex-labs/caracal/internal/harness"
)

//go:embed all:assets/skills
var bundledSkillsFS embed.FS

var bundledSkillNames = []string{
	"caracal", "caracal-agents", "caracal-registry", "caracal-ops", "caracal-advanced",
}

// syncBundledSkills installs or refreshes the bundled skill directories for
// every detected harness. Best-effort: returns the display names updated.
func syncBundledSkills(home string, installMissing bool) []string {
	registry := harness.MustLoad()
	markers := map[string][]string{
		"cursor": {".cursor"}, "kiro": {".kiro"}, "claude-code": {".claude"},
		"codex": {".codex"}, "copilot": {".vscode/extensions/github.copilot-*", ".vscode/extensions/github.copilot-chat-*"},
		"copilot-cli": {".copilot"}, "opencode": {".config/opencode"},
		"antigravity": {".gemini/antigravity-cli", ".gemini/config"},
		"goose":       {".config/goose", ".local/share/goose"}, "pi": {".pi"},
	}
	updated := []string{}
	for _, name := range registry.Names() {
		spec, _ := registry.Spec(name)
		if spec == nil || spec.Skills == nil || spec.Skills["user"] == "" {
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
		changed := false
		for _, skillName := range bundledSkillNames {
			target := strings.Replace(spec.Skills["user"], "{name}", skillName, 1)
			if strings.HasPrefix(target, "~/") {
				target = filepath.Join(home, target[2:])
			}
			targetDir := filepath.Dir(target)
			_, statErr := os.Stat(target)
			if statErr != nil && !installMissing {
				continue
			}
			if syncOneBundledSkill(skillName, targetDir) {
				changed = true
			}
		}
		if changed {
			updated = append(updated, spec.DisplayName)
		}
	}
	return updated
}

// syncOneBundledSkill mirrors one embedded skill tree onto disk.
func syncOneBundledSkill(skillName, targetDir string) bool {
	sourceRoot := "assets/skills/" + skillName
	changed := false
	_ = fs.WalkDir(bundledSkillsFS, sourceRoot, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		relative := strings.TrimPrefix(path, sourceRoot+"/")
		destination := filepath.Join(targetDir, relative)
		desired, err := bundledSkillsFS.ReadFile(path)
		if err != nil {
			return nil
		}
		current, readErr := os.ReadFile(destination)
		if readErr == nil && string(current) == string(desired) {
			return nil
		}
		if os.MkdirAll(filepath.Dir(destination), 0o755) != nil {
			return nil
		}
		if os.WriteFile(destination, desired, 0o644) == nil {
			changed = true
		}
		return nil
	})
	return changed
}
