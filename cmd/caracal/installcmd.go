// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/spf13/cobra"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
	"github.com/garudex-labs/caracal/internal/cli/config"
	"github.com/garudex-labs/caracal/internal/cli/lockfile"
	"github.com/garudex-labs/caracal/internal/cli/ref"
	"github.com/garudex-labs/caracal/internal/harness"
	"github.com/garudex-labs/caracal/internal/harnessgen"
)

// ── shared install helpers ─────────────────────────────────────────

func rawJSONModeConflict(operation string) *clierr.Error {
	return &clierr.Error{
		Category: clierr.Validation, Message: "Raw config output and JSON operation output cannot be combined.",
		Operation: operation, Resource: "output options",
		Remediation: "Choose either raw config output or JSON operation output.",
	}
}

// parseAssignments splits repeatable KEY=VALUE flags preserving order.
func parseAssignments(values []string, label, operation string) (*omap, *clierr.Error) {
	out := newOmap()
	for _, pair := range values {
		key, value, found := strings.Cut(pair, "=")
		if !found || strings.TrimSpace(key) == "" {
			return nil, &clierr.Error{
				Category: clierr.Validation, Message: fmt.Sprintf("Invalid %s assignment.", label),
				Operation: operation, Resource: label,
				Remediation: fmt.Sprintf("Provide %s values as KEY=VALUE.", label),
			}
		}
		out.set(strings.TrimSpace(key), strings.Trim(value, `"'`))
	}
	return out, nil
}

// parseEnvFile reads KEY=VALUE lines, skipping comments and blanks.
func parseEnvFile(path, operation string) (*omap, *clierr.Error) {
	abs, _ := filepath.Abs(path)
	blob, err := os.ReadFile(path)
	if err != nil {
		return nil, &clierr.Error{
			Category: clierr.NotFound, Message: "The environment file was not found.",
			Operation: operation, Resource: abs,
			Remediation: "Provide an existing environment file and retry.", Detail: err.Error(),
		}
	}
	out := newOmap()
	for _, line := range strings.Split(string(blob), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, found := strings.Cut(line, "=")
		key = strings.TrimSpace(key)
		if !found || key == "" || key != strings.ToUpper(key) {
			continue
		}
		out.set(key, strings.Trim(strings.TrimSpace(value), `"'`))
	}
	return out, nil
}

// listingVarNames extracts named entries from a listing's requirement list.
func listingVarNames(items []any) []struct {
	Name     string
	Required bool
} {
	out := []struct {
		Name     string
		Required bool
	}{}
	for _, raw := range items {
		entry, ok := raw.(*omap)
		if !ok {
			continue
		}
		name := entry.str("name")
		if name == "" {
			continue
		}
		required := true
		if flag, ok := entry.get("required").(bool); ok {
			required = flag
		}
		out = append(out, struct {
			Name     string
			Required bool
		}{name, required})
	}
	return out
}

// appendLocalKeys re-emits a server document with local keys applied.
func emitLocalDoc(raw []byte, apply func(doc *omap)) error {
	value, err := decodeOrderedJSON(raw)
	if err != nil {
		outputJSONRaw(raw)
		return nil
	}
	doc, ok := value.(*omap)
	if !ok {
		outputJSONRaw(raw)
		return nil
	}
	apply(doc)
	blob, err := marshalOrdered(doc)
	if err != nil {
		return err
	}
	outputJSONRaw(blob)
	return nil
}

// ── mcp install ────────────────────────────────────────────────────

func mcpInstallCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "install NAME", Short: "Install an MCP server into a harness", Args: cobra.ExactArgs(1)}
	harness := cmd.Flags().StringP("harness", "i", "", "Target harness")
	rawFlag := cmd.Flags().Bool("raw", false, "Print the raw config snippet")
	version := cmd.Flags().StringP("version", "V", "", "Version to install")
	envFlags := cmd.Flags().StringArrayP("env", "e", nil, "Environment value as KEY=VALUE")
	headerFlags := cmd.Flags().StringArray("header", nil, "Header value as KEY=VALUE")
	envFile := cmd.Flags().String("env-file", "", "Environment file path")
	noPrompt := cmd.Flags().BoolP("no-prompt", "y", false, "Skip interactive prompts")
	mode := outputFlag(cmd)
	cmd.RunE = func(c *cobra.Command, args []string) error {
		const op = "Install MCP server"
		if *rawFlag && *mode == "json" {
			return rawJSONModeConflict(op)
		}
		if !contains(validHarnesses, *harness) {
			return &clierr.Error{
				Category: clierr.Validation, Message: fmt.Sprintf("Unknown harness: %s.", *harness),
				Operation: op, Resource: "harness",
				Remediation: "Choose one of: " + strings.Join(validHarnesses, ", ") + ".",
			}
		}
		if *version != "" && !pep440Re.MatchString(*version) {
			return &clierr.Error{
				Category: clierr.Validation, Message: "The requested MCP version is invalid.",
				Operation: op, Resource: *version,
				Remediation: "Provide a valid version and retry.",
			}
		}
		envValues, cerr := parseAssignments(*envFlags, "environment variable", op)
		if cerr != nil {
			return cerr
		}
		headerValues, cerr := parseAssignments(*headerFlags, "header", op)
		if cerr != nil {
			return cerr
		}
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		resolved, cerr := ref.ResolveRegistryReference(client, "mcp", args[0], op, "MCP registry")
		if cerr != nil {
			return cerr
		}
		listingRaw, cerr := client.Do("GET", "/api/v1/mcps/"+resolved, nil, nil, op, "MCP registry")
		if cerr != nil {
			return cerr
		}
		if *envFile != "" {
			fileValues, cerr := parseEnvFile(*envFile, op)
			if cerr != nil {
				return cerr
			}
			for _, key := range fileValues.keys {
				if !envValues.has(key) {
					envValues.set(key, fileValues.get(key))
				}
			}
		}
		listingValue, _ := decodeOrderedJSON(listingRaw)
		listing, _ := listingValue.(*omap)
		if listing == nil {
			listing = newOmap()
		}
		skipPrompts := *rawFlag || *mode == "json" || *noPrompt
		fillValues := func(items []any, supplied *omap) {
			for _, entry := range listingVarNames(items) {
				if supplied.has(entry.Name) {
					continue
				}
				if skipPrompts {
					supplied.set(entry.Name, "<"+entry.Name+">")
				} else if entry.Required {
					supplied.set(entry.Name, textInput(entry.Name, ""))
				}
			}
		}
		fillValues(listing.array("environment_variables"), envValues)
		fillValues(listing.array("headers"), headerValues)
		localName, err := lockfile.LocalRegistryName(*harness, "mcp", listing.str("namespace"), listing.str("slug"), "user", "")
		if err != nil {
			localName = listing.str("slug")
		}
		body := newOmap()
		body.set("harness", *harness)
		body.set("local_name", localName)
		body.set("env_values", envValues)
		body.set("header_values", headerValues)
		if *version != "" {
			body.set("version", *version)
		}
		resultRaw, cerr := client.Do("POST", "/api/v1/mcps/"+resolved+"/install", nil, body, op, "MCP registry")
		if cerr != nil {
			return cerr
		}
		if *rawFlag {
			var fields map[string]json.RawMessage
			_ = json.Unmarshal(resultRaw, &fields)
			snippet := fields["config_snippet"]
			if len(snippet) == 0 || string(snippet) == "null" {
				snippet = json.RawMessage("{}")
			}
			printIndented(snippet)
			return nil
		}
		if *mode == "json" {
			outputJSONRaw(resultRaw)
			return nil
		}
		printDocumentSummary(resultRaw)
		return nil
	}
	return cmd
}

// ── skill install ──────────────────────────────────────────────────

var harnessSkillDirs = []struct{ harness, dir string }{
	{"claude-code", ".claude"}, {"cursor", ".cursor"}, {"kiro", ".kiro"}, {"opencode", ".opencode"},
}

var unsafeNameRe = regexp.MustCompile(`[^a-z0-9_-]`)
var multiDashRe = regexp.MustCompile(`-{2,}`)

func sanitizeName(name string) string {
	name = strings.TrimSpace(strings.ToLower(name))
	name = unsafeNameRe.ReplaceAllString(name, "-")
	name = strings.Trim(multiDashRe.ReplaceAllString(name, "-"), "-")
	if name == "" {
		return "skill"
	}
	return name
}

// userSkillDest resolves the user-scope skill directory for a harness from the
// canonical harness registry, so the CLI writes exactly where the harness looks
// for skills. Harnesses that declare no user skill path fall back to the shared
// ~/.agents/skills tree.
func userSkillDest(harnessName, skillName string) string {
	template := "~/.agents/skills/{name}/SKILL.md"
	if spec, ok := harness.MustLoad().Spec(strings.ReplaceAll(harnessName, "_", "-")); ok {
		if p := spec.Skills["user"]; p != "" {
			template = p
		}
	}
	dir := strings.TrimSuffix(strings.ReplaceAll(template, "{name}", skillName), "/SKILL.md")
	if strings.HasPrefix(dir, "~/") {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, dir[2:])
	}
	return dir
}

func isPathSafe(path, base string) bool {
	absPath, err1 := filepath.Abs(path)
	absBase, err2 := filepath.Abs(base)
	if err1 != nil || err2 != nil {
		return false
	}
	rel, err := filepath.Rel(absBase, absPath)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, "../")
}

func normalizeSkillPath(skillPath string) string {
	clean := strings.Trim(skillPath, "/")
	if strings.EqualFold(clean, "skill.md") {
		return ""
	}
	if strings.HasSuffix(strings.ToLower(clean), "/skill.md") {
		return clean[:strings.LastIndex(clean, "/")]
	}
	return clean
}

// compatibleSkillFileInstall writes a single-file Skill (e.g. a Cursor rule) at
// the harness's registry skill path, returning "" for SKILL.md-directory
// harnesses so the caller falls back to the directory installer.
func compatibleSkillFileInstall(harnessName, scope, skillName, content, cwd string) string {
	spec, ok := harness.MustLoad().Spec(strings.ReplaceAll(harnessName, "_", "-"))
	if !ok || spec.EmitsSkillMd() || !spec.SupportsSkill() {
		return ""
	}
	rel := harnessgen.SkillFilePath(harnessName, scope, skillName)
	if rel == "" {
		return ""
	}
	var target string
	if strings.HasPrefix(rel, "~/") {
		home, herr := os.UserHomeDir()
		if herr != nil {
			return ""
		}
		target = filepath.Join(home, rel[2:])
	} else {
		target = filepath.Join(cwd, rel)
		if !isPathSafe(target, cwd) {
			return ""
		}
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return ""
	}
	if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
		return ""
	}
	return target
}

// installSkillRegistryDirect writes SKILL.md plus an optional script.
func installSkillRegistryDirect(name, skillMdContent, scriptContent, scriptFilename, harness, scope, cwd string) string {
	skillName := sanitizeName(name)
	if skillMdContent != "" {
		if dest := compatibleSkillFileInstall(harness, scope, skillName, skillMdContent, cwd); dest != "" {
			return dest
		}
	}
	var dest string
	if scope == "user" {
		dest = userSkillDest(harness, skillName)
	} else {
		base := filepath.Join(cwd, ".agents", "skills")
		dest = filepath.Join(base, skillName)
		if !isPathSafe(dest, base) {
			return ""
		}
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
	if scope == "project" {
		symlinkForHarnesses(cwd, dest, skillName)
	}
	return dest
}

// installSkillFromGit sparse-clones the skill subdirectory.
func installSkillFromGit(name, gitURL, skillPath, gitRef, harness, scope, cwd string) string {
	skillName := sanitizeName(name)
	var dest string
	if scope == "user" {
		dest = userSkillDest(harness, skillName)
	} else {
		base := filepath.Join(cwd, ".agents", "skills")
		dest = filepath.Join(base, skillName)
		if !isPathSafe(dest, base) {
			return ""
		}
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
	if scope == "project" {
		symlinkForHarnesses(cwd, dest, skillName)
	}
	return dest
}

func sparseCloneSkillDir(gitURL, skillPath, gitRef, dest string) bool {
	if gitRef == "" {
		gitRef = "main"
	}
	if exec.Command("git", "--version").Run() != nil {
		return false
	}
	cleanPath := normalizeSkillPath(skillPath)
	tmp, err := os.MkdirTemp("", "caracal-skill-")
	if err != nil {
		return false
	}
	defer os.RemoveAll(tmp)
	run := func(args ...string) error {
		command := exec.Command(args[0], args[1:]...)
		command.Dir = tmp
		return command.Run()
	}
	steps := [][]string{
		{"git", "init"},
		{"git", "remote", "add", "origin", gitURL},
		{"git", "config", "core.sparseCheckout", "true"},
		{"git", "fetch", "--filter=blob:none", "--depth=1", "origin", gitRef},
	}
	for _, step := range steps {
		if run(step...) != nil {
			return false
		}
	}
	sparseFile := filepath.Join(tmp, ".git", "info", "sparse-checkout")
	_ = os.MkdirAll(filepath.Dir(sparseFile), 0o755)
	content := "/\n"
	if cleanPath != "" {
		content = cleanPath + "/\n"
	}
	if os.WriteFile(sparseFile, []byte(content), 0o644) != nil {
		return false
	}
	if run("git", "checkout", "FETCH_HEAD") != nil {
		return false
	}
	src := tmp
	if cleanPath != "" {
		src = filepath.Join(tmp, cleanPath)
	}
	if _, err := os.Stat(src); err != nil {
		return false
	}
	return copyTree(src, dest) == nil
}

func copyTree(src, dest string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, path)
		if rel == "." {
			return os.MkdirAll(dest, 0o755)
		}
		target := filepath.Join(dest, rel)
		if info.IsDir() {
			return os.MkdirAll(target, info.Mode().Perm())
		}
		blob, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, blob, info.Mode().Perm())
	})
}

func symlinkForHarnesses(cwd, canonical, skillName string) {
	resolved, err := filepath.Abs(canonical)
	if err != nil {
		resolved = canonical
	}
	for _, entry := range harnessSkillDirs {
		agentRoot := filepath.Join(cwd, entry.dir)
		if _, err := os.Stat(agentRoot); err != nil {
			continue
		}
		skillsDir := filepath.Join(agentRoot, "skills")
		_ = os.MkdirAll(skillsDir, 0o755)
		link := filepath.Join(skillsDir, skillName)
		if _, err := os.Lstat(link); err == nil {
			continue
		}
		_ = os.Symlink(resolved, link)
	}
}

// activeProjectContext returns the selected Caracal Org/Project, requiring one
// so every install binds to a Project and can never leak across Projects.
func activeProjectContext(op string) (string, string, *clierr.Error) {
	cfg, cerr := config.Load()
	if cerr != nil {
		return "", "", cerr
	}
	org := config.Str(cfg, "default_org")
	project := config.Str(cfg, "default_project")
	if org == "" || project == "" {
		return "", "", &clierr.Error{
			Category:  clierr.Validation,
			Message:   "No active Caracal Project is selected.",
			Operation: op, Resource: "project context",
			Remediation: "Run caracal use ORG/PROJECT to bind installs to a Project, then retry.",
		}
	}
	return org, project, nil
}

// selectedProject returns the active Caracal Org/Project, or empty strings when
// none is selected, for flows that may run without a Project.
func selectedProject() (string, string) {
	cfg, cerr := config.Load()
	if cerr != nil {
		return "", ""
	}
	return config.Str(cfg, "default_org"), config.Str(cfg, "default_project")
}

func skillInstallCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "install NAME", Short: "Install a skill into a harness", Args: cobra.ExactArgs(1)}
	harness := cmd.Flags().StringP("harness", "i", "", "Target harness")
	scope := cmd.Flags().StringP("scope", "s", "project", "Install scope (skills always bind to the active Project's workspace)")
	rawFlag := cmd.Flags().Bool("raw", false, "Print the raw config snippet")
	noWrite := cmd.Flags().Bool("no-write", false, "Skip local file writes")
	version := cmd.Flags().StringP("version", "V", "", "Version to install")
	mode := outputFlag(cmd)
	cmd.RunE = func(c *cobra.Command, args []string) error {
		const op = "Install skill"
		if *rawFlag && *mode == "json" {
			return rawJSONModeConflict(op)
		}
		if *scope == "user" {
			return &clierr.Error{
				Category:  clierr.Validation,
				Message:   "Skills install into the active Project's workspace, never a user-global location.",
				Operation: op, Resource: "scope",
				Remediation: "Drop --scope user; skills are always project-scoped.",
			}
		}
		if *scope != "project" {
			return &clierr.Error{
				Category: clierr.Validation, Message: fmt.Sprintf("Unknown skill scope: %s.", *scope),
				Operation: op, Resource: "scope",
				Remediation: "Skills are always project-scoped; omit --scope.",
			}
		}
		if !contains(validHarnesses, *harness) || !harnessSupportsSkills(*harness) {
			return &clierr.Error{
				Category: clierr.Validation, Message: fmt.Sprintf("Skills are not supported for the %s harness.", *harness),
				Operation: op, Resource: "harness",
				Remediation: "Skills are not supported for this resource on that harness; choose a skill-capable harness.",
			}
		}
		if *version != "" && !pep440Re.MatchString(*version) {
			return &clierr.Error{
				Category: clierr.Validation, Message: "The requested skill version is invalid.",
				Operation: op, Resource: *version,
				Remediation: "Provide a valid version and retry.",
			}
		}
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		resolved, cerr := ref.ResolveRegistryReference(client, "skill", args[0], op, "skill registry")
		if cerr != nil {
			return cerr
		}
		listingRaw, cerr := client.Do("GET", "/api/v1/skills/"+resolved, nil, nil, op, "skill registry")
		if cerr != nil {
			return cerr
		}
		var listing struct {
			Namespace string `json:"namespace"`
			Slug      string `json:"slug"`
		}
		_ = json.Unmarshal(listingRaw, &listing)
		cwd, _ := os.Getwd()
		directory := cwd
		activeOrg, activeProject, cerr := activeProjectContext(op)
		if cerr != nil {
			return cerr
		}
		if boundOrg, boundProject, ok := lockfile.WorkspaceProject(directory); ok &&
			(boundOrg != activeOrg || boundProject != activeProject) {
			return &clierr.Error{
				Category:  clierr.Validation,
				Message:   fmt.Sprintf("This workspace already holds resources for Project %s/%s.", boundOrg, boundProject),
				Operation: op, Resource: directory,
				Remediation: fmt.Sprintf("Materialize %s/%s in a separate workspace, or run caracal use %s/%s here.",
					activeOrg, activeProject, boundOrg, boundProject),
			}
		}
		localName, err := lockfile.LocalRegistryName(*harness, "skill", listing.Namespace, listing.Slug, *scope, directory)
		if err != nil {
			localName = listing.Slug
		}
		body := newOmap()
		body.set("harness", *harness)
		body.set("scope", *scope)
		body.set("local_name", localName)
		if *version != "" {
			body.set("version", *version)
		}
		resultRaw, cerr := client.Do("POST", "/api/v1/skills/"+resolved+"/install", nil, body, op, "skill registry")
		if cerr != nil {
			return cerr
		}
		resultValue, _ := decodeOrderedJSON(resultRaw)
		result, _ := resultValue.(*omap)
		if result == nil {
			result = newOmap()
		}
		snippet := result.object("config_snippet")
		if snippet == nil {
			snippet = result
		}
		if *rawFlag {
			blob, _ := marshalOrdered(snippet)
			printIndented(blob)
			return nil
		}
		skillInfo := snippet.object("skill")
		if skillInfo == nil {
			return &clierr.Error{
				Category: clierr.Unavailable, Message: "The registry returned an invalid skill installation response.",
				Operation: op, Resource: args[0],
				Remediation: "Check server health and version compatibility, then retry.",
			}
		}
		installedPath := ""
		if !*noWrite {
			deliveryMode := skillInfo.str("delivery_mode")
			if deliveryMode == "registry_direct" {
				installedPath = installSkillRegistryDirect(skillInfo.str("name"), skillInfo.str("skill_md_content"),
					skillInfo.str("script_content"), skillInfo.str("script_filename"), *harness, *scope, cwd)
			} else {
				installedPath = installSkillFromGit(skillInfo.str("name"), skillInfo.str("git_url"),
					orDefault(skillInfo.str("skill_path"), "/"), orDefault(skillInfo.str("git_ref"), "main"),
					*harness, *scope, cwd)
			}
			if installedPath == "" {
				return &clierr.Error{
					Category: clierr.Unavailable, Message: "The skill content could not be installed.",
					Operation: op, Resource: args[0],
					Remediation: "Check the skill source and local filesystem, then retry.",
				}
			}
			entryVersion := *version
			if entryVersion == "" {
				entryVersion = skillInfo.str("version")
			}
			if entryVersion == "" {
				entryVersion = skillInfo.str("latest_version")
			}
			componentID := skillInfo.str("id")
			if componentID == "" {
				componentID = resolved
			}
			var versionPtr *string
			if entryVersion != "" {
				versionPtr = &entryVersion
			}
			if err := lockfile.UpsertStandalone(*harness, lockfile.Entry{
				Type: "skill", Name: skillInfo.str("name"), ID: componentID, Version: versionPtr,
				Scope: *scope, Directory: directory, Namespace: listing.Namespace, Slug: listing.Slug,
				LocalName: localName, Org: activeOrg, Project: activeProject,
			}); err != nil {
				category := clierr.Unavailable
				remediation := "Check local storage and retry."
				if os.IsPermission(err) || strings.Contains(err.Error(), "permission denied") {
					category = clierr.Permission
					remediation = "Check lockfile ownership and permissions, then retry."
				}
				return &clierr.Error{
					Category: category, Message: "The skill was written but its installed state could not be recorded.",
					Operation: op, Resource: "installed-state lockfile",
					Remediation: remediation, Detail: err.Error(),
				}
			}
		}
		if *mode == "json" {
			return emitLocalDoc(resultRaw, func(doc *omap) {
				doc.set("write_performed", !*noWrite)
				if installedPath != "" {
					doc.set("installed_path", installedPath)
				} else {
					doc.set("installed_path", nil)
				}
			})
		}
		printDocumentSummary(resultRaw)
		return nil
	}
	return cmd
}

// ── hook install ───────────────────────────────────────────────────

func hookInstallCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "install NAME", Short: "Install a hook into a harness", Args: cobra.ExactArgs(1)}
	harness := cmd.Flags().StringP("harness", "i", "", "Target harness")
	platform := cmd.Flags().StringP("platform", "p", "", "Platform: win32, darwin, or linux")
	rawFlag := cmd.Flags().Bool("raw", false, "Print the raw install response")
	dirFlag := cmd.Flags().StringP("dir", "d", "", "Project directory")
	mode := outputFlag(cmd)
	cmd.RunE = func(c *cobra.Command, args []string) error {
		const op = "Install hook"
		if *rawFlag && *mode == "json" {
			return rawJSONModeConflict(op)
		}
		if !contains(validHarnesses, *harness) {
			return &clierr.Error{
				Category: clierr.Validation, Message: fmt.Sprintf("Unknown harness: %s.", *harness),
				Operation: op, Resource: "harness",
				Remediation: "Choose one of: " + strings.Join(validHarnesses, ", ") + ".",
			}
		}
		if !harnessSupportsRegistryHooks(*harness) {
			return &clierr.Error{
				Category: clierr.Validation, Message: fmt.Sprintf("%s does not support hooks and cannot be a target for this resource.", *harness),
				Operation: op, Resource: "harness",
				Remediation: "Choose a harness that supports hooks. Run caracal doctor to see per-harness capabilities.",
			}
		}
		if *platform != "" && *platform != "win32" && *platform != "darwin" && *platform != "linux" {
			return &clierr.Error{
				Category: clierr.Validation, Message: fmt.Sprintf("Unknown platform: %s.", *platform),
				Operation: op, Resource: "platform",
				Remediation: "Choose win32, darwin, or linux.",
			}
		}
		projectRoot := *dirFlag
		if projectRoot == "" {
			projectRoot, _ = os.Getwd()
		}
		projectRoot, _ = filepath.Abs(projectRoot)
		client, cerr := newClient()
		if cerr != nil {
			return cerr
		}
		resolved, cerr := ref.ResolveRegistryReference(client, "hook", args[0], op, "hook registry")
		if cerr != nil {
			return cerr
		}
		listingRaw, cerr := client.Do("GET", "/api/v1/hooks/"+resolved, nil, nil, op, "hook registry")
		if cerr != nil {
			return cerr
		}
		var listing struct {
			ID        string  `json:"id"`
			Name      string  `json:"name"`
			Version   *string `json:"version"`
			Namespace string  `json:"namespace"`
			Slug      string  `json:"slug"`
		}
		_ = json.Unmarshal(listingRaw, &listing)
		localName, err := lockfile.LocalRegistryName(*harness, "hook", listing.Namespace, listing.Slug, "project", projectRoot)
		if err != nil {
			localName = listing.Slug
		}
		body := newOmap()
		body.set("harness", *harness)
		body.set("platform", *platform)
		body.set("local_name", localName)
		resultRaw, cerr := client.Do("POST", "/api/v1/hooks/"+resolved+"/install", nil, body, op, "hook registry")
		if cerr != nil {
			return cerr
		}
		if *rawFlag {
			printIndented(resultRaw)
			return nil
		}
		resultValue, _ := decodeOrderedJSON(resultRaw)
		result, _ := resultValue.(*omap)
		if result == nil {
			result = newOmap()
		}
		filesWritten := []string{}
		for _, rawEntry := range result.array("files") {
			entry, ok := rawEntry.(*omap)
			if !ok || entry.str("path") == "" {
				return &clierr.Error{
					Category: clierr.Unavailable, Message: "The registry returned an invalid hook file entry.",
					Operation: op, Resource: "hook registry",
					Remediation: "Check server health and version compatibility, then retry.",
				}
			}
			target := filepath.Join(projectRoot, entry.str("path"))
			if !isPathSafe(target, projectRoot) {
				return &clierr.Error{
					Category: clierr.Validation, Message: "The hook contains a file path outside the project directory.",
					Operation: op, Resource: entry.str("path"),
					Remediation: "Correct the hook package path and retry.",
				}
			}
			executable, _ := entry.get("executable").(bool)
			if cerr := writeHookFile(target, entry.str("content"), executable, op); cerr != nil {
				return cerr
			}
			filesWritten = append(filesWritten, target)
		}
		configPathWritten := ""
		configPath := result.str("config_path")
		snippet := result.object("config_snippet")
		if configPath != "" && result.get("config_snippet") != nil {
			if snippet == nil {
				return &clierr.Error{
					Category: clierr.Unavailable, Message: "The registry returned an invalid hook configuration.",
					Operation: op, Resource: "hook registry",
					Remediation: "Check server health and version compatibility, then retry.",
				}
			}
			written, cerr := mergeHookConfig(configPath, snippet, projectRoot, op)
			if cerr != nil {
				return cerr
			}
			configPathWritten = written
		}
		if err := lockfile.UpsertStandalone(*harness, lockfile.Entry{
			Type: "hook", Name: listing.Name, ID: orDefault(listing.ID, resolved), Version: listing.Version,
			Scope: "project", Directory: projectRoot, Namespace: listing.Namespace, Slug: listing.Slug,
			LocalName: localName,
		}); err != nil {
			category := clierr.Unavailable
			remediation := "Check local storage and retry."
			if os.IsPermission(err) || strings.Contains(err.Error(), "permission denied") {
				category = clierr.Permission
				remediation = "Check lockfile ownership and permissions, then retry."
			}
			return &clierr.Error{
				Category: category, Message: "The hook was written but its installed state could not be recorded.",
				Operation: op, Resource: "installed-state lockfile",
				Remediation: remediation, Detail: err.Error(),
			}
		}
		if *mode == "json" {
			return emitLocalDoc(resultRaw, func(doc *omap) {
				written := make([]any, len(filesWritten))
				for i, path := range filesWritten {
					written[i] = path
				}
				doc.set("files_written", written)
				if configPathWritten != "" {
					doc.set("config_path", configPathWritten)
				} else {
					doc.set("config_path", nil)
				}
			})
		}
		printDocumentSummary(resultRaw)
		return nil
	}
	return cmd
}

// writeHookFile writes atomically, preserving an existing mode.
func writeHookFile(target, content string, executable bool, op string) *clierr.Error {
	mode := os.FileMode(0o644)
	if info, err := os.Stat(target); err == nil {
		mode = info.Mode().Perm()
	}
	if executable {
		mode |= 0o111
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return &clierr.Error{Category: clierr.Unexpected, Message: err.Error(), Operation: op, Resource: target}
	}
	tmp, err := os.CreateTemp(filepath.Dir(target), ".hook-*")
	if err != nil {
		return &clierr.Error{Category: clierr.Unexpected, Message: err.Error(), Operation: op, Resource: target}
	}
	tmpName := tmp.Name()
	if _, err := tmp.WriteString(content); err != nil {
		_ = tmp.Close()
		os.Remove(tmpName)
		return &clierr.Error{Category: clierr.Unexpected, Message: err.Error(), Operation: op, Resource: target}
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return &clierr.Error{Category: clierr.Unexpected, Message: err.Error(), Operation: op, Resource: target}
	}
	_ = os.Chmod(tmpName, mode)
	if err := os.Rename(tmpName, target); err != nil {
		os.Remove(tmpName)
		return &clierr.Error{Category: clierr.Unexpected, Message: err.Error(), Operation: op, Resource: target}
	}
	return nil
}

// mergeHookConfig merges the snippet's hook entries into a config file.
func mergeHookConfig(configPath string, snippet *omap, projectRoot, op string) (string, *clierr.Error) {
	var target string
	if strings.HasPrefix(configPath, "~/") || configPath == "~" {
		home, _ := os.UserHomeDir()
		target = filepath.Join(home, strings.TrimPrefix(configPath, "~"))
		if !isPathSafe(target, home) {
			return "", &clierr.Error{
				Category: clierr.Validation, Message: "The hook configuration path is outside the user home directory.",
				Operation: op, Resource: configPath,
				Remediation: "Correct the hook package path and retry.",
			}
		}
	} else {
		target = filepath.Join(projectRoot, configPath)
		if !isPathSafe(target, projectRoot) {
			return "", &clierr.Error{
				Category: clierr.Validation, Message: "The hook configuration path is outside the project directory.",
				Operation: op, Resource: configPath,
				Remediation: "Correct the hook package path and retry.",
			}
		}
	}
	existing := newOmap()
	if blob, err := os.ReadFile(target); err == nil {
		value, err := decodeOrderedJSON(blob)
		if err != nil {
			return "", &clierr.Error{
				Category: clierr.Validation, Message: "The existing hook configuration is not valid JSON.",
				Operation: op, Resource: target,
				Remediation: "Correct the configuration file and retry.",
			}
		}
		object, ok := value.(*omap)
		if !ok {
			return "", &clierr.Error{
				Category: clierr.Validation, Message: "The existing hook configuration must contain a JSON object.",
				Operation: op, Resource: target,
				Remediation: "Correct the configuration file and retry.",
			}
		}
		existing = object
	}
	snippetHooks := snippet.object("hooks")
	if snippetHooks != nil {
		if existing.get("hooks") == nil {
			existing.set("hooks", newOmap())
		}
		existingHooks, ok := existing.get("hooks").(*omap)
		if !ok {
			return "", &clierr.Error{
				Category: clierr.Validation, Message: "The hook configuration has an invalid hooks object.",
				Operation: op, Resource: target,
				Remediation: "Correct the configuration file and retry.",
			}
		}
		for _, event := range snippetHooks.keys {
			newEntries, ok := snippetHooks.get(event).([]any)
			if !ok {
				return "", &clierr.Error{
					Category: clierr.Validation, Message: "The hook configuration event entries must be arrays.",
					Operation: op, Resource: target,
					Remediation: "Correct the configuration file and retry.",
				}
			}
			if existingHooks.get(event) == nil {
				existingHooks.set(event, []any{})
			}
			current, ok := existingHooks.get(event).([]any)
			if !ok {
				return "", &clierr.Error{
					Category: clierr.Validation, Message: "The hook configuration event entries must be arrays.",
					Operation: op, Resource: target,
					Remediation: "Correct the configuration file and retry.",
				}
			}
			for _, entry := range newEntries {
				if !containsJSONValue(current, entry) {
					current = append(current, entry)
				}
			}
			existingHooks.set(event, current)
		}
	}
	if snippet.get("version") != nil {
		existing.set("version", snippet.get("version"))
	}
	blob, err := marshalOrdered(existing)
	if err != nil {
		return "", &clierr.Error{Category: clierr.Unexpected, Message: err.Error(), Operation: op, Resource: target}
	}
	var pretty []byte
	pretty, err = indentJSON(blob)
	if err != nil {
		return "", &clierr.Error{Category: clierr.Unexpected, Message: err.Error(), Operation: op, Resource: target}
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return "", &clierr.Error{Category: clierr.Unexpected, Message: err.Error(), Operation: op, Resource: target}
	}
	if err := os.WriteFile(target, append(pretty, '\n'), 0o644); err != nil {
		return "", &clierr.Error{Category: clierr.Unexpected, Message: err.Error(), Operation: op, Resource: target}
	}
	return target, nil
}

func indentJSON(blob []byte) ([]byte, error) {
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, blob, "", "  "); err != nil {
		return nil, err
	}
	return pretty.Bytes(), nil
}

func containsJSONValue(list []any, candidate any) bool {
	want, err := marshalOrdered(candidate)
	if err != nil {
		return false
	}
	for _, item := range list {
		got, err := marshalOrdered(item)
		if err == nil && string(got) == string(want) {
			return true
		}
	}
	return false
}
