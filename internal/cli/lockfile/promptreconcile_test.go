// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package lockfile

import (
	"os"
	"path/filepath"
	"testing"
)

const managedBody = "---\ndescription: x\n---\n\n<!-- caracal-managed: prompt acme/review -->\n\nBody\n"

func TestFileHasManagedPromptMarker(t *testing.T) {
	dir := t.TempDir()
	managed := filepath.Join(dir, "m.md")
	if err := os.WriteFile(managed, []byte(managedBody), 0o644); err != nil {
		t.Fatal(err)
	}
	user := filepath.Join(dir, "u.md")
	if err := os.WriteFile(user, []byte("# my own prompt\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !fileHasManagedPromptMarker(managed) {
		t.Error("managed file not detected")
	}
	if fileHasManagedPromptMarker(user) {
		t.Error("user file falsely detected as managed")
	}
	if fileHasManagedPromptMarker(filepath.Join(dir, "missing.md")) {
		t.Error("missing file reported as managed")
	}
}

// TestPruneStaleManagedPrompts is the safety core: only a stale, managed,
// unreferenced file is removed; user files, referenced files, and currently
// written files survive.
func TestPruneStaleManagedPrompts(t *testing.T) {
	dir := t.TempDir()
	write := func(name, content string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	stale := write("stale.md", managedBody)
	userOwned := write("user.md", "hand written, no marker\n")
	referencedFile := write("ref.md", managedBody)
	current := write("cur.md", managedBody)

	oldAbs := map[string]bool{stale: true, userOwned: true, referencedFile: true}
	newAbs := map[string]bool{current: true}
	referenced := map[string]bool{referencedFile: true}

	deleted := pruneStaleManagedPrompts(oldAbs, newAbs, referenced)

	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Error("stale managed file was not deleted")
	}
	if _, err := os.Stat(userOwned); err != nil {
		t.Error("user-authored file was wrongly deleted")
	}
	if _, err := os.Stat(referencedFile); err != nil {
		t.Error("still-referenced file was wrongly deleted")
	}
	if _, err := os.Stat(current); err != nil {
		t.Error("currently written file was wrongly deleted")
	}
	if len(deleted) != 1 || deleted[0] != stale {
		t.Errorf("deleted = %v, want [%s]", deleted, stale)
	}
}

func TestResolveManagedPromptPath(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home directory")
	}
	if got := resolveManagedPromptPath("~/.codex/prompts/x.md", "/proj"); got != filepath.Join(home, ".codex/prompts/x.md") {
		t.Errorf("home resolve = %s", got)
	}
	if got := resolveManagedPromptPath(".claude/commands/x.md", "/proj"); got != filepath.Join("/proj", ".claude/commands/x.md") {
		t.Errorf("workspace resolve = %s", got)
	}
	if got := resolveManagedPromptPath(".claude/commands/x.md", ""); got != "" {
		t.Errorf("workspace path without a directory should not resolve, got %s", got)
	}
}
