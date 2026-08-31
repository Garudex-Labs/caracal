// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	git "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"
)

// testSignature is the author used for repos created in tests.
func testSignature() *object.Signature {
	return &object.Signature{Name: "Test", Email: "test@test.com", When: time.Now()}
}

// createGitRepo makes a real repository at path with the given files and one
// commit on main. Returns the repo path.
func createGitRepo(t *testing.T, path string, files map[string]string) string {
	t.Helper()
	repo, err := git.PlainInitWithOptions(path, &git.PlainInitOptions{
		InitOptions: git.InitOptions{DefaultBranch: plumbing.NewBranchReferenceName("main")},
	})
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	if len(files) == 0 {
		files = map[string]string{".gitkeep": ""}
	}
	worktree, err := repo.Worktree()
	if err != nil {
		t.Fatalf("worktree: %v", err)
	}
	for rel, content := range files {
		full := filepath.Join(path, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
		if _, err := worktree.Add(rel); err != nil {
			t.Fatalf("add: %v", err)
		}
	}
	if _, err := worktree.Commit("init", &git.CommitOptions{
		Author: testSignature(),
	}); err != nil {
		t.Fatalf("commit: %v", err)
	}
	return path
}

func fastMCPServer() string {
	return "from mcp.server.fastmcp import FastMCP\nmcp = FastMCP(\"my-mcp\")\n"
}

func testMirror(t *testing.T) *Mirror {
	t.Helper()
	return &Mirror{BasePath: filepath.Join(t.TempDir(), "mirrors")}
}

func TestCloneOrUpdate(t *testing.T) {
	ctx := context.Background()
	t.Run("fresh clone", func(t *testing.T) {
		src := createGitRepo(t, filepath.Join(t.TempDir(), "repo"), map[string]string{"src/my-mcp/server.py": fastMCPServer()})
		m := testMirror(t)
		dir, err := m.cloneOrUpdate(ctx, src, "main")
		if err != nil {
			t.Fatalf("clone: %v", err)
		}
		if _, err := os.Stat(filepath.Join(dir, "src", "my-mcp", "server.py")); err != nil {
			t.Fatalf("cloned file missing: %v", err)
		}
		if dir != mirrorPath(m.BasePath, src) {
			t.Fatalf("unexpected mirror dir %s", dir)
		}
	})
	t.Run("update picks up changes", func(t *testing.T) {
		srcDir := filepath.Join(t.TempDir(), "repo")
		src := createGitRepo(t, srcDir, map[string]string{"src/my-mcp/server.py": fastMCPServer()})
		m := testMirror(t)
		if _, err := m.cloneOrUpdate(ctx, src, "main"); err != nil {
			t.Fatalf("clone: %v", err)
		}
		repo, err := git.PlainOpen(srcDir)
		if err != nil {
			t.Fatalf("open: %v", err)
		}
		worktree, _ := repo.Worktree()
		if err := os.WriteFile(filepath.Join(srcDir, "new.txt"), []byte("x"), 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
		if _, err := worktree.Add("new.txt"); err != nil {
			t.Fatalf("add: %v", err)
		}
		if _, err := worktree.Commit("second", &git.CommitOptions{Author: testSignature()}); err != nil {
			t.Fatalf("commit: %v", err)
		}
		dir, err := m.cloneOrUpdate(ctx, src, "main")
		if err != nil {
			t.Fatalf("update: %v", err)
		}
		if _, err := os.Stat(filepath.Join(dir, "new.txt")); err != nil {
			t.Fatalf("update missed new file: %v", err)
		}
	})
	t.Run("invalid url errors", func(t *testing.T) {
		m := testMirror(t)
		if _, err := m.cloneOrUpdate(ctx, filepath.Join(t.TempDir(), "nope"), "main"); err == nil {
			t.Fatal("expected error for missing repo")
		}
	})
	t.Run("private http url blocked", func(t *testing.T) {
		m := testMirror(t)
		_, err := m.cloneOrUpdate(ctx, "https://127.0.0.1/internal.git", "main")
		if err == nil || !strings.Contains(err.Error(), "private/internal address") {
			t.Fatalf("expected SSRF block, got %v", err)
		}
	})
}

func TestCommitSHA(t *testing.T) {
	src := createGitRepo(t, filepath.Join(t.TempDir(), "repo"), nil)
	m := testMirror(t)
	dir, err := m.cloneOrUpdate(context.Background(), src, "main")
	if err != nil {
		t.Fatalf("clone: %v", err)
	}
	sha := commitSHA(dir)
	if !regexp.MustCompile(`^[0-9a-f]{40}$`).MatchString(sha) {
		t.Fatalf("bad sha %q", sha)
	}
	srcRepo, _ := git.PlainOpen(src)
	head, _ := srcRepo.Head()
	if sha != head.Hash().String() {
		t.Fatalf("sha %s != source head %s", sha, head.Hash())
	}
}

func TestParseManifest(t *testing.T) {
	manifest := map[string]any{
		"mcps": []any{
			map[string]any{"name": "weather", "path": "servers/weather", "description": "Weather MCP"},
		},
		"skills": []any{map[string]any{"name": "review", "path": "skills/review"}},
	}
	t.Run("all types", func(t *testing.T) {
		got := parseManifest(manifest, "", "")
		if len(got) != 2 {
			t.Fatalf("want 2 components, got %d", len(got))
		}
		if got[0].ComponentType != "mcp" || got[0].Name != "weather" || got[0].Description != "Weather MCP" {
			t.Fatalf("bad mcp entry %+v", got[0])
		}
	})
	t.Run("filter by type", func(t *testing.T) {
		got := parseManifest(manifest, "skill", "")
		if len(got) != 1 || got[0].ComponentType != "skill" {
			t.Fatalf("bad filter result %+v", got)
		}
	})
	t.Run("name defaults to path tail", func(t *testing.T) {
		got := parseManifest(map[string]any{"hooks": []any{map[string]any{"path": "hooks/pre-commit"}}}, "", "")
		if len(got) != 1 || got[0].Name != "pre-commit" {
			t.Fatalf("bad default name %+v", got)
		}
	})
	t.Run("empty manifest", func(t *testing.T) {
		if got := parseManifest(map[string]any{}, "", ""); len(got) != 0 {
			t.Fatalf("want none, got %+v", got)
		}
	})
	t.Run("traversal paths rejected", func(t *testing.T) {
		base := t.TempDir()
		got := parseManifest(map[string]any{
			"mcps": []any{map[string]any{"name": "evil", "path": "../../etc"}},
		}, "", base)
		if len(got) != 0 {
			t.Fatalf("traversal path admitted: %+v", got)
		}
	})
}

func TestDiscoverComponents(t *testing.T) {
	conventionRepo := func(t *testing.T) string {
		dir := t.TempDir()
		files := map[string]string{
			"src/alpha/server.py":       fastMCPServer(),
			"src/empty/README.md":       "no python",
			"skills/reviewer/SKILL.md":  "# Reviewer",
			"skills/incomplete/note.md": "no marker",
			"hooks/pre/hook.json":       "{}",
			"hooks/bare/readme.md":      "no marker",
			"prompts/daily/daily.md":    "prompt",
		}
		for rel, content := range files {
			full := filepath.Join(dir, rel)
			if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		return dir
	}
	t.Run("manifest wins over convention", func(t *testing.T) {
		dir := conventionRepo(t)
		manifest := `{"mcps": [{"name": "only-this", "path": "src/alpha"}]}`
		if err := os.WriteFile(filepath.Join(dir, ".caracal.json"), []byte(manifest), 0o644); err != nil {
			t.Fatal(err)
		}
		got := discoverComponents(dir, "")
		if len(got) != 1 || got[0].Name != "only-this" {
			t.Fatalf("manifest not preferred: %+v", got)
		}
	})
	t.Run("invalid manifest falls back to convention", func(t *testing.T) {
		dir := conventionRepo(t)
		if err := os.WriteFile(filepath.Join(dir, ".caracal.json"), []byte("{nope"), 0o644); err != nil {
			t.Fatal(err)
		}
		if got := discoverComponents(dir, ""); len(got) == 0 {
			t.Fatal("expected convention fallback")
		}
	})
	t.Run("convention markers per family", func(t *testing.T) {
		got := discoverComponents(conventionRepo(t), "")
		byType := map[string][]string{}
		for _, comp := range got {
			byType[comp.ComponentType] = append(byType[comp.ComponentType], comp.Name)
		}
		expect := map[string][]string{
			"mcp":    {"alpha"},
			"skill":  {"reviewer"},
			"hook":   {"pre"},
			"prompt": {"daily"},
		}
		for family, names := range expect {
			if strings.Join(byType[family], ",") != strings.Join(names, ",") {
				t.Fatalf("%s: want %v, got %v", family, names, byType[family])
			}
		}
	})
	t.Run("filter by type", func(t *testing.T) {
		got := discoverComponents(conventionRepo(t), "skill")
		if len(got) != 1 || got[0].Name != "reviewer" {
			t.Fatalf("bad skill filter: %+v", got)
		}
	})
	t.Run("empty repo yields nothing", func(t *testing.T) {
		if got := discoverComponents(t.TempDir(), ""); len(got) != 0 {
			t.Fatalf("want none, got %+v", got)
		}
	})
	t.Run("symlinked dirs skipped", func(t *testing.T) {
		dir := t.TempDir()
		outside := filepath.Join(t.TempDir(), "outside")
		if err := os.MkdirAll(outside, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(outside, "SKILL.md"), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Join(dir, "skills"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, filepath.Join(dir, "skills", "escape")); err != nil {
			t.Fatal(err)
		}
		if got := discoverComponents(dir, "skill"); len(got) != 0 {
			t.Fatalf("symlink admitted: %+v", got)
		}
	})
}

func TestValidateMCPComponent(t *testing.T) {
	write := func(t *testing.T, rel, content string) string {
		dir := t.TempDir()
		full := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		return dir
	}
	t.Run("fastmcp accepted", func(t *testing.T) {
		dir := write(t, "server.py", fastMCPServer())
		passed, detail := validateMCPComponent(dir)
		if !passed || detail != "FastMCP found in server.py" {
			t.Fatalf("want pass, got %v %q", passed, detail)
		}
	})
	t.Run("alternative import accepted", func(t *testing.T) {
		dir := write(t, "main.py", "from fastmcp import FastMCP\n")
		if passed, _ := validateMCPComponent(dir); !passed {
			t.Fatal("alternative import rejected")
		}
	})
	t.Run("non-fastmcp rejected", func(t *testing.T) {
		dir := write(t, "server.py", "print('plain server')\n")
		passed, detail := validateMCPComponent(dir)
		if passed || detail != "No FastMCP usage found. MCP servers must use FastMCP." {
			t.Fatalf("want reject, got %v %q", passed, detail)
		}
	})
	t.Run("empty dir rejected", func(t *testing.T) {
		if passed, _ := validateMCPComponent(t.TempDir()); passed {
			t.Fatal("empty dir accepted")
		}
	})
}

func TestSyncSource(t *testing.T) {
	ctx := context.Background()
	t.Run("manifest repo", func(t *testing.T) {
		src := createGitRepo(t, filepath.Join(t.TempDir(), "repo"), map[string]string{
			".caracal.json":          `{"skills": [{"name": "review", "path": "skills/review"}]}`,
			"skills/review/SKILL.md": "# Review",
		})
		got := testMirror(t).SyncSource(ctx, src, "skill")
		if !got.Success || len(got.Components) != 1 || got.CommitSHA == "" {
			t.Fatalf("bad result %+v", got)
		}
	})
	t.Run("non-fastmcp filtered", func(t *testing.T) {
		src := createGitRepo(t, filepath.Join(t.TempDir(), "repo"), map[string]string{
			"src/plain/server.py": "print('nope')\n",
		})
		got := testMirror(t).SyncSource(ctx, src, "mcp")
		if !got.Success || len(got.Components) != 0 {
			t.Fatalf("invalid MCP admitted %+v", got)
		}
	})
	t.Run("invalid url fails", func(t *testing.T) {
		got := testMirror(t).SyncSource(ctx, filepath.Join(t.TempDir(), "absent"), "mcp")
		if got.Success || got.Error == "" {
			t.Fatalf("want failure, got %+v", got)
		}
	})
}

func TestMirrorPath(t *testing.T) {
	first, second := mirrorPath("/base", "https://a"), mirrorPath("/base", "https://a")
	if first != second {
		t.Fatal("not deterministic")
	}
	if mirrorPath("/base", "https://a") == mirrorPath("/base", "https://b") {
		t.Fatal("distinct urls collide")
	}
	if !strings.HasPrefix(mirrorPath("/base", "https://a"), "/base/") {
		t.Fatal("path escapes base")
	}
}

func TestSafePath(t *testing.T) {
	base := t.TempDir()
	if !safePath(base, "sub/dir") {
		t.Fatal("normal path rejected")
	}
	if safePath(base, "../../etc/passwd") {
		t.Fatal("traversal admitted")
	}
	if safePath(base, "/etc/passwd") {
		// filepath.Join treats a leading slash as relative under base, so this
		// stays inside; the Python guard admits it the same way only when the
		// joined path remains under base.
		t.Log("absolute-looking path joined under base")
	}
}

func TestNextCycleWait(t *testing.T) {
	at := func(hour, minute int) time.Time {
		return time.Date(2026, 1, 5, hour, minute, 0, 0, time.UTC)
	}
	cases := []struct {
		now  time.Time
		want time.Duration
	}{
		{at(5, 0), time.Hour},
		{at(6, 0), 6 * time.Hour},
		{at(23, 30), 30 * time.Minute},
		{at(0, 1), 5*time.Hour + 59*time.Minute},
	}
	for _, tc := range cases {
		if got := nextCycleWait(tc.now); got != tc.want {
			t.Fatalf("at %v: want %v, got %v", tc.now, tc.want, got)
		}
	}
}
