// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
)

// mustOmap decodes a JSON object into an ordered map for helper tests.
func mustOmap(t *testing.T, blob string) *omap {
	t.Helper()
	value, err := decodeOrderedJSON([]byte(blob))
	if err != nil {
		t.Fatalf("decode %q: %v", blob, err)
	}
	object, ok := value.(*omap)
	if !ok {
		t.Fatalf("decoded %q is %T, not an object", blob, value)
	}
	return object
}

// captureStdout runs fn with os.Stdout redirected and returns what it wrote.
func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	fn()
	_ = w.Close()
	os.Stdout = old
	buf := make([]byte, 1<<16)
	n, _ := r.Read(buf)
	_ = r.Close()
	return string(buf[:n])
}

func TestSanitizeNameNormalizes(t *testing.T) {
	cases := map[string]string{
		"My Skill!":   "my-skill",
		"Hello World": "hello-world",
		"  ---  ":     "skill",
		"":            "skill",
		"a__b":        "a__b",
		"UPPER":       "upper",
	}
	for in, want := range cases {
		if got := sanitizeName(in); got != want {
			t.Errorf("sanitizeName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestUserSkillDestMapsHarnessDirs(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if got := userSkillDest("claude-code", "demo"); got != filepath.Join(home, ".claude/skills/demo") {
		t.Errorf("claude-code dest = %q", got)
	}
	// Unknown harnesses fall back to the shared agents directory.
	if got := userSkillDest("mystery", "demo"); got != filepath.Join(home, ".agents/skills/demo") {
		t.Errorf("fallback dest = %q", got)
	}
	// Underscore forms normalize to the hyphenated key.
	if got := userSkillDest("claude_code", "demo"); got != filepath.Join(home, ".claude/skills/demo") {
		t.Errorf("underscore harness dest = %q", got)
	}
	// Destinations come from the canonical harness registry, not a hardcoded
	// map: harnesses whose user skill path is neither ~/.agents nor a guessed
	// default must still land where the harness actually looks.
	if got := userSkillDest("antigravity", "demo"); got != filepath.Join(home, ".gemini/antigravity-cli/skills/demo") {
		t.Errorf("antigravity dest = %q", got)
	}
	if got := userSkillDest("copilot-cli", "demo"); got != filepath.Join(home, ".copilot/skills/demo") {
		t.Errorf("copilot-cli dest = %q", got)
	}
}

func TestIsPathSafeContainsWithinBase(t *testing.T) {
	base := t.TempDir()
	if !isPathSafe(filepath.Join(base, "a", "b"), base) {
		t.Error("nested path must be safe")
	}
	if isPathSafe(filepath.Join(base, "..", "escape"), base) {
		t.Error("parent escape must be unsafe")
	}
	if isPathSafe("/etc/passwd", base) {
		t.Error("absolute foreign path must be unsafe")
	}
}

func TestNormalizeSkillPathStripsSkillMd(t *testing.T) {
	cases := map[string]string{
		"skills/foo/SKILL.md": "skills/foo",
		"SKILL.md":            "",
		"/a/b/":               "a/b",
		"foo":                 "foo",
	}
	for in, want := range cases {
		if got := normalizeSkillPath(in); got != want {
			t.Errorf("normalizeSkillPath(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseEnvFileReadsUppercaseKeys(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".env")
	content := "# comment\n\nAPI_KEY=\"secret\"\nlowercase=skip\nTOKEN=abc\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	values, cerr := parseEnvFile(path, "Install")
	if cerr != nil {
		t.Fatalf("parseEnvFile: %v", cerr)
	}
	if values.str("API_KEY") != "secret" {
		t.Errorf("quoted value not trimmed: %q", values.str("API_KEY"))
	}
	if values.str("TOKEN") != "abc" {
		t.Errorf("TOKEN = %q", values.str("TOKEN"))
	}
	if values.has("lowercase") {
		t.Error("lowercase keys must be skipped")
	}
}

func TestParseEnvFileMissingIsNotFound(t *testing.T) {
	_, cerr := parseEnvFile(filepath.Join(t.TempDir(), "absent.env"), "Install")
	if cerr == nil || cerr.Category != clierr.NotFound {
		t.Fatalf("missing env file must be NotFound, got %v", cerr)
	}
}

func TestInstallSkillRegistryDirectWritesFiles(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dest := installSkillRegistryDirect("Demo Skill", "# skill body", "echo hi", "run.sh", "claude-code", "user", home)
	if dest == "" {
		t.Fatal("install returned empty destination")
	}
	body, err := os.ReadFile(filepath.Join(dest, "SKILL.md"))
	if err != nil || string(body) != "# skill body" {
		t.Errorf("SKILL.md wrong: %v / %q", err, body)
	}
	info, err := os.Stat(filepath.Join(dest, "scripts", "run.sh"))
	if err != nil {
		t.Fatalf("script missing: %v", err)
	}
	if info.Mode().Perm()&0o111 == 0 {
		t.Errorf("shell script must be executable: %v", info.Mode())
	}
}

func TestInstallSkillRegistryDirectEmptyBodyReturnsEmpty(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if dest := installSkillRegistryDirect("Demo", "", "", "", "kiro", "user", home); dest != "" {
		t.Errorf("empty SKILL.md must abort, got %q", dest)
	}
}

func TestCopyTreeReplicatesContents(t *testing.T) {
	src := t.TempDir()
	dst := filepath.Join(t.TempDir(), "out")
	if err := os.MkdirAll(filepath.Join(src, "nested"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "top.txt"), []byte("top"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "nested", "leaf.txt"), []byte("leaf"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := copyTree(src, dst); err != nil {
		t.Fatalf("copyTree: %v", err)
	}
	if body, _ := os.ReadFile(filepath.Join(dst, "top.txt")); string(body) != "top" {
		t.Errorf("top.txt not copied: %q", body)
	}
	if body, _ := os.ReadFile(filepath.Join(dst, "nested", "leaf.txt")); string(body) != "leaf" {
		t.Errorf("nested leaf not copied: %q", body)
	}
}

func TestMergeHookConfigCreatesAndDeduplicates(t *testing.T) {
	root := t.TempDir()
	snippet := mustOmap(t, `{"hooks":{"PreToolUse":[{"cmd":"caracal hook"}]},"version":"1.0"}`)
	target, cerr := mergeHookConfig(".vscode/hooks.json", snippet, root, "Install hook")
	if cerr != nil {
		t.Fatalf("first merge: %v", cerr)
	}
	// A second identical merge must not duplicate the entry.
	if _, cerr := mergeHookConfig(".vscode/hooks.json", snippet, root, "Install hook"); cerr != nil {
		t.Fatalf("second merge: %v", cerr)
	}
	merged := mustOmap(t, readFileString(t, target))
	hooks := merged.object("hooks")
	if hooks == nil || len(hooks.array("PreToolUse")) != 1 {
		t.Errorf("expected one deduped entry, got %v", hooks)
	}
	// A distinct entry for the same event appends.
	other := mustOmap(t, `{"hooks":{"PreToolUse":[{"cmd":"other"}]}}`)
	if _, cerr := mergeHookConfig(".vscode/hooks.json", other, root, "Install hook"); cerr != nil {
		t.Fatalf("third merge: %v", cerr)
	}
	merged = mustOmap(t, readFileString(t, target))
	if got := len(merged.object("hooks").array("PreToolUse")); got != 2 {
		t.Errorf("distinct entry must append, len = %d", got)
	}
}

func TestMergeHookConfigRejectsEscapeAndBadJSON(t *testing.T) {
	root := t.TempDir()
	snippet := mustOmap(t, `{"hooks":{"PreToolUse":[{"cmd":"x"}]}}`)
	_, cerr := mergeHookConfig("../escape.json", snippet, root, "Install hook")
	if cerr == nil || cerr.Category != clierr.Validation {
		t.Errorf("path escape must be Validation, got %v", cerr)
	}
	bad := filepath.Join(root, "bad.json")
	if err := os.WriteFile(bad, []byte("not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, cerr = mergeHookConfig("bad.json", snippet, root, "Install hook")
	if cerr == nil || cerr.Category != clierr.Validation {
		t.Errorf("invalid existing JSON must be Validation, got %v", cerr)
	}
}

func TestContainsJSONValueMatchesByShape(t *testing.T) {
	list := []any{mustOmap(t, `{"a":1,"b":2}`)}
	if !containsJSONValue(list, mustOmap(t, `{"a":1,"b":2}`)) {
		t.Error("equal-shape value must be found")
	}
	if containsJSONValue(list, mustOmap(t, `{"a":1,"b":3}`)) {
		t.Error("different value must not match")
	}
}

func TestRawJSONModeConflictIsValidation(t *testing.T) {
	cerr := rawJSONModeConflict("Install MCP server")
	if cerr.Category != clierr.Validation || cerr.Operation != "Install MCP server" {
		t.Errorf("unexpected conflict error: %+v", cerr)
	}
}

func TestEmitLocalDocAppliesAndReemits(t *testing.T) {
	out := captureStdout(t, func() {
		_ = emitLocalDoc([]byte(`{"a":1}`), func(doc *omap) { doc.set("b", "added") })
	})
	if !strings.Contains(out, `"a"`) || !strings.Contains(out, `"b"`) || !strings.Contains(out, "added") {
		t.Errorf("emitLocalDoc output missing keys: %s", out)
	}
}

func TestMCPInstallRejectsRawJSONCombo(t *testing.T) {
	_, err := runCLI(t, nil, "registry", "mcp", "install", "foo", "--harness", "kiro", "--raw", "-o", "json")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation {
		t.Errorf("raw+json category = %s", cerr.Category)
	}
}

func TestMCPInstallRejectsUnknownHarness(t *testing.T) {
	_, err := runCLI(t, nil, "registry", "mcp", "install", "foo", "--harness", "bogus")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation || !strings.Contains(cerr.Message, "bogus") {
		t.Errorf("unknown harness: %s / %s", cerr.Category, cerr.Message)
	}
}

func TestMCPInstallRejectsInvalidVersion(t *testing.T) {
	_, err := runCLI(t, nil, "registry", "mcp", "install", "foo", "--harness", "kiro", "--version", "not.a.version!")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation {
		t.Errorf("invalid version category = %s", cerr.Category)
	}
}

// readFileString reads a file for assertions, failing the test on error.
func readFileString(t *testing.T, path string) string {
	t.Helper()
	blob, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(blob)
}
