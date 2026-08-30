// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	git "github.com/go-git/go-git/v5"
	gitconfig "github.com/go-git/go-git/v5/config"
	"github.com/go-git/go-git/v5/plumbing"

	"github.com/garudex-labs/caracal/internal/alerts"
)

// SettingsReader is the runtime-configuration surface the mirror needs.
type SettingsReader interface {
	String(ctx context.Context, key, fallback string) string
	Bool(ctx context.Context, key string, fallback bool) bool
}

// DiscoveredComponent is one component found inside a mirrored repository.
type DiscoveredComponent struct {
	Name          string
	Path          string // relative to the repository root
	ComponentType string // mcp, skill, hook, prompt, sandbox
	Description   string
}

// SyncResult is the outcome of a full mirror pipeline run.
type SyncResult struct {
	Success    bool
	Components []DiscoveredComponent
	CommitSHA  string
	Error      string
}

// Mirror clones registered git sources and discovers the components they
// carry. Repository URLs pass the shared SSRF guard before any network
// contact unless internal git hosts are explicitly allowed.
type Mirror struct {
	Settings SettingsReader
	// BasePath overrides the mirror directory for tests.
	BasePath string
}

const gitOpTimeout = 120 * time.Second

// basePath resolves the mirror directory: explicit override, then the
// runtime setting, then a directory under the system temp path.
func (m *Mirror) basePath(ctx context.Context) string {
	if m.BasePath != "" {
		return m.BasePath
	}
	if m.Settings != nil {
		if configured := m.Settings.String(ctx, "misc.git_mirror_base_path", ""); configured != "" {
			return configured
		}
	}
	return filepath.Join(os.TempDir(), "caracal_mirrors")
}

// mirrorPath is the content-addressed directory for one repository URL.
func mirrorPath(base, gitURL string) string {
	sum := sha256.Sum256([]byte(gitURL))
	return filepath.Join(base, hex.EncodeToString(sum[:])[:16])
}

// cloneOrUpdate shallow-clones a repository or refreshes an existing mirror.
// Returns the mirror directory.
func (m *Mirror) cloneOrUpdate(ctx context.Context, gitURL, branch string) (string, error) {
	if strings.HasPrefix(gitURL, "http://") || strings.HasPrefix(gitURL, "https://") {
		allowInternal := m.Settings != nil && m.Settings.Bool(ctx, "security.allow_internal_git_urls", false)
		if !allowInternal && alerts.IsPrivateURL(ctx, gitURL) {
			return "", fmt.Errorf("Repository URL resolves to a private/internal address: %s", gitURL)
		}
	}
	base := m.basePath(ctx)
	if err := os.MkdirAll(base, 0o755); err != nil {
		return "", err
	}
	dir := mirrorPath(base, gitURL)

	if repo, err := git.PlainOpen(dir); err == nil {
		if err := m.update(ctx, repo, branch); err != nil {
			// A stale or shallow-corrupted mirror is rebuilt from scratch
			// rather than left broken.
			if rmErr := os.RemoveAll(dir); rmErr != nil {
				return "", err
			}
		} else {
			return dir, nil
		}
	} else if _, statErr := os.Stat(dir); statErr == nil {
		if err := os.RemoveAll(dir); err != nil {
			return "", err
		}
	}

	opCtx, cancel := context.WithTimeout(ctx, gitOpTimeout)
	defer cancel()
	_, err := git.PlainCloneContext(opCtx, dir, false, &git.CloneOptions{
		URL:           gitURL,
		Depth:         1,
		SingleBranch:  true,
		ReferenceName: plumbing.NewBranchReferenceName(branch),
		Tags:          git.NoTags,
	})
	if err != nil {
		_ = os.RemoveAll(dir)
		return "", fmt.Errorf("git clone failed: %w", err)
	}
	return dir, nil
}

// update fetches the branch tip and hard-resets the mirror onto it.
func (m *Mirror) update(ctx context.Context, repo *git.Repository, branch string) error {
	opCtx, cancel := context.WithTimeout(ctx, gitOpTimeout)
	defer cancel()
	spec := gitconfig.RefSpec(fmt.Sprintf("+refs/heads/%s:refs/remotes/origin/%s", branch, branch))
	err := repo.FetchContext(opCtx, &git.FetchOptions{
		RemoteName: "origin",
		RefSpecs:   []gitconfig.RefSpec{spec},
		Depth:      1,
		Force:      true,
		Tags:       git.NoTags,
	})
	if err != nil && !errors.Is(err, git.NoErrAlreadyUpToDate) {
		return fmt.Errorf("git fetch failed: %w", err)
	}
	ref, err := repo.Reference(plumbing.NewRemoteReferenceName("origin", branch), true)
	if err != nil {
		return fmt.Errorf("git reset failed: %w", err)
	}
	worktree, err := repo.Worktree()
	if err != nil {
		return fmt.Errorf("git reset failed: %w", err)
	}
	if err := worktree.Reset(&git.ResetOptions{Commit: ref.Hash(), Mode: git.HardReset}); err != nil {
		return fmt.Errorf("git reset failed: %w", err)
	}
	return nil
}

// commitSHA reads the mirror's HEAD commit, or empty when unreadable.
func commitSHA(dir string) string {
	repo, err := git.PlainOpen(dir)
	if err != nil {
		return ""
	}
	head, err := repo.Head()
	if err != nil {
		return ""
	}
	return head.Hash().String()
}

// componentTypeOrder fixes the discovery order across component families.
var componentTypeOrder = []string{"mcp", "skill", "hook", "prompt", "sandbox"}

// manifestKeys maps component families to their manifest list keys.
var manifestKeys = map[string]string{
	"mcp":     "mcps",
	"skill":   "skills",
	"hook":    "hooks",
	"prompt":  "prompts",
	"sandbox": "sandboxes",
}

// conventionDirs lists the directories scanned per family when no manifest
// is present.
var conventionDirs = map[string][]string{
	"mcp":     {"src", "mcps", "servers"},
	"skill":   {"skills"},
	"hook":    {"hooks"},
	"prompt":  {"prompts"},
	"sandbox": {"sandboxes"},
}

// discoverComponents finds components via the manifest, falling back to a
// convention scan.
func discoverComponents(dir, componentType string) []DiscoveredComponent {
	for _, name := range []string{".caracal.json", "caracal.json"} {
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		var manifest map[string]any
		if err := json.Unmarshal(raw, &manifest); err != nil {
			continue // invalid manifest: fall through to the convention scan
		}
		return parseManifest(manifest, componentType, dir)
	}
	return scanByConvention(dir, componentType)
}

// safePath reports whether base/rel stays inside base.
func safePath(base, rel string) bool {
	baseAbs, err := filepath.Abs(base)
	if err != nil {
		return false
	}
	if resolved, err := filepath.EvalSymlinks(baseAbs); err == nil {
		baseAbs = resolved
	}
	joined := filepath.Join(baseAbs, rel)
	if resolved, err := filepath.EvalSymlinks(joined); err == nil {
		joined = resolved
	}
	return joined == baseAbs || strings.HasPrefix(joined, baseAbs+string(filepath.Separator))
}

// typesToScan narrows discovery to one family when requested.
func typesToScan(componentType string, families map[string][]string) []string {
	if componentType != "" {
		if _, ok := families[componentType]; ok {
			return []string{componentType}
		}
	}
	return componentTypeOrder
}

// parseManifest reads component declarations out of a .caracal.json manifest.
func parseManifest(manifest map[string]any, componentType, dir string) []DiscoveredComponent {
	types := componentTypeOrder
	if componentType != "" {
		if _, ok := manifestKeys[componentType]; ok {
			types = []string{componentType}
		}
	}
	components := []DiscoveredComponent{}
	for _, ctype := range types {
		entries, _ := manifest[manifestKeys[ctype]].([]any)
		for _, item := range entries {
			entry, ok := item.(map[string]any)
			if !ok {
				continue
			}
			compPath, _ := entry["path"].(string)
			if dir != "" && !safePath(dir, compPath) {
				continue
			}
			name, _ := entry["name"].(string)
			if name == "" {
				parts := strings.Split(compPath, "/")
				name = parts[len(parts)-1]
			}
			description, _ := entry["description"].(string)
			components = append(components, DiscoveredComponent{
				Name:          name,
				Path:          compPath,
				ComponentType: ctype,
				Description:   description,
			})
		}
	}
	return components
}

// hasComponentMarker reports whether a directory looks like a component of
// the given family.
func hasComponentMarker(ctype, dir string) bool {
	switch ctype {
	case "mcp":
		return hasPythonFiles(dir)
	case "skill":
		return fileExists(filepath.Join(dir, "SKILL.md"))
	case "hook":
		return fileExists(filepath.Join(dir, "hook.json"))
	case "prompt":
		md, _ := filepath.Glob(filepath.Join(dir, "*.md"))
		txt, _ := filepath.Glob(filepath.Join(dir, "*.txt"))
		return len(md) > 0 || len(txt) > 0
	case "sandbox":
		return fileExists(filepath.Join(dir, "Dockerfile"))
	}
	return true
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// hasPythonFiles reports whether any .py file exists under dir, ignoring
// git internals.
func hasPythonFiles(dir string) bool {
	found := false
	_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() && d.Name() == ".git" {
			return filepath.SkipDir
		}
		if !d.IsDir() && strings.HasSuffix(d.Name(), ".py") {
			found = true
			return filepath.SkipAll
		}
		return nil
	})
	return found
}

// scanByConvention discovers components by walking conventional directories.
func scanByConvention(dir, componentType string) []DiscoveredComponent {
	components := []DiscoveredComponent{}
	for _, ctype := range typesToScan(componentType, conventionDirs) {
		for _, sub := range conventionDirs[ctype] {
			base := filepath.Join(dir, sub)
			entries, err := os.ReadDir(base)
			if err != nil {
				continue
			}
			for _, entry := range entries {
				if entry.Type()&fs.ModeSymlink != 0 || !entry.IsDir() {
					continue
				}
				rel := filepath.Join(sub, entry.Name())
				if !safePath(dir, rel) {
					continue
				}
				if hasComponentMarker(ctype, filepath.Join(base, entry.Name())) {
					components = append(components, DiscoveredComponent{
						Name:          entry.Name(),
						Path:          rel,
						ComponentType: ctype,
					})
				}
			}
		}
	}
	return components
}

var fastMCPPattern = regexp.MustCompile(`FastMCP\(|from\s+mcp\.server\.fastmcp\s+import|from\s+fastmcp\s+import`)

// validateMCPComponent checks that an MCP component uses FastMCP.
func validateMCPComponent(componentPath string) (bool, string) {
	passed := false
	detail := ""
	_ = filepath.WalkDir(componentPath, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() && d.Name() == ".git" {
			return filepath.SkipDir
		}
		if d.IsDir() || d.Type()&fs.ModeSymlink != 0 || !strings.HasSuffix(d.Name(), ".py") {
			return nil
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		if fastMCPPattern.Match(content) {
			passed = true
			detail = fmt.Sprintf("FastMCP found in %s", d.Name())
			return filepath.SkipAll
		}
		return nil
	})
	if passed {
		return true, detail
	}
	return false, "No FastMCP usage found. MCP servers must use FastMCP."
}

// SyncSource runs the full pipeline: clone, discover, validate.
func (m *Mirror) SyncSource(ctx context.Context, gitURL, componentType string) SyncResult {
	dir, err := m.cloneOrUpdate(ctx, gitURL, "main")
	if err != nil {
		return SyncResult{Success: false, Error: err.Error()}
	}
	sha := commitSHA(dir)
	discovered := discoverComponents(dir, componentType)

	valid := []DiscoveredComponent{}
	for _, comp := range discovered {
		if comp.ComponentType == "mcp" {
			if passed, _ := validateMCPComponent(filepath.Join(dir, comp.Path)); !passed {
				continue // invalid MCPs are skipped, not fatal
			}
		}
		valid = append(valid, comp)
	}
	return SyncResult{Success: true, Components: valid, CommitSHA: sha}
}
