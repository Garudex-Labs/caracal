// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/garudex-labs/caracal/internal/alerts"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/tenancy"
)

// Canonical valid-option lists for constrained submit fields.
var (
	mcpCategories = []string{"browser-automation", "cloud-platforms", "code-execution", "communication",
		"databases", "developer-tools", "devops", "file-systems", "finance", "knowledge-memory", "monitoring",
		"multimedia", "productivity", "search", "security", "version-control", "ai-ml", "data-analytics", "general"}
	mcpFrameworks      = []string{"python", "docker", "typescript", "go"}
	skillTaskTypes     = []string{"code-review", "code-generation", "testing", "documentation", "debugging", "refactoring", "deployment", "security-audit", "performance", "general"}
	hookEvents         = []string{"PreToolUse", "PostToolUse", "Notification", "Stop", "SubagentStop", "SessionStart", "UserPromptSubmit"}
	hookHandlerTypes   = []string{"command", "http"}
	hookExecutionModes = []string{"async", "sync", "blocking"}
	hookScopes         = []string{"agent", "session", "global"}
	promptCategories   = []string{"system-prompt", "code-review", "code-generation", "testing", "documentation", "debugging", "general"}
)

// reqStr enforces a required string field in schema order.
func (b *draftBody) reqStr(key string) string {
	raw, present := b.raw[key]
	if !present {
		b.errs = append(b.errs, fieldError{Type: "missing", Loc: []string{"body", key}, Msg: "Field required", Input: b.raw})
		return ""
	}
	s, ok := raw.(string)
	if !ok {
		b.errs = append(b.errs, fieldError{Type: "string_type", Loc: []string{"body", key}, Msg: "Input should be a valid string", Input: raw})
		return ""
	}
	return s
}

// optionCheck applies the canonical option validator to a present value.
func (b *draftBody) optionCheck(key, value, label string, valid []string) {
	for _, v := range valid {
		if value == v {
			return
		}
	}
	b.fail("value_error", key,
		fmt.Sprintf("Value error, Invalid %s '%s'. Valid options: %s", label, value, strings.Join(valid, ", ")),
		map[string]any{"error": map[string]any{}})
}

// modelError is a whole-request validator failure.
func (b *draftBody) modelError(msg string) {
	b.errs = append(b.errs, fieldError{Type: "value_error", Loc: []string{"body"},
		Msg: "Value error, " + msg, Input: b.raw, Ctx: map[string]any{"error": map[string]any{}}})
}

// validateSubmit applies the publish-request contract in field order.
func validateSubmit(f Family, b *draftBody) (name, version, description, owner string) {
	name = b.reqStr("name")
	version = b.reqStr("version")
	description = b.reqStr("description")
	switch f.Prefix {
	case "mcps":
		if _, present := b.raw["description"]; present && description == "" {
			b.errs = append(b.errs, fieldError{Type: "string_too_short", Loc: []string{"body", "description"},
				Msg: "String should have at least 1 character", Input: description,
				Ctx: map[string]any{"min_length": 1}})
		}
		if category := b.reqStr("category"); category != "" {
			b.optionCheck("category", category, "category", mcpCategories)
		}
		owner = b.reqStr("owner")
		if fw := b.nstr("framework"); fw != nil {
			found := false
			for _, v := range mcpFrameworks {
				if *fw == v {
					found = true
				}
			}
			if !found {
				b.fail("value_error", "framework",
					fmt.Sprintf("Value error, Invalid framework '%s'. Valid options: %s", *fw, strings.Join(mcpFrameworks, ", ")),
					map[string]any{"error": map[string]any{}})
			}
		}
	case "skills":
		owner = b.reqStr("owner")
		if taskType := b.reqStr("task_type"); taskType != "" {
			b.optionCheck("task_type", taskType, "task_type", skillTaskTypes)
		}
	case "hooks":
		owner = b.reqStr("owner")
		if event := b.reqStr("event"); event != "" {
			b.optionCheck("event", event, "event", hookEvents)
		}
		if mode := b.str("execution_mode", "async"); mode != "async" {
			b.optionCheck("execution_mode", mode, "execution_mode", hookExecutionModes)
		}
		if handlerType := b.reqStr("handler_type"); handlerType != "" {
			b.optionCheck("handler_type", handlerType, "handler_type", hookHandlerTypes)
		}
		if scope := b.str("scope", "agent"); scope != "agent" {
			b.optionCheck("scope", scope, "scope", hookScopes)
		}
	case "prompts":
		owner = b.reqStr("owner")
		if category := b.reqStr("category"); category != "" {
			b.optionCheck("category", category, "category", promptCategories)
		}
		b.reqStr("template")
	case "sandboxes":
		owner = b.reqStr("owner")
		// runtime_type and network_policy option checks live in the shared
		// field extractor; only presence is enforced here.
		b.reqStr("runtime_type")
		b.reqStr("image")
	}
	// Model-level rules run after field validation, mirroring the schema.
	if len(b.errs) == 0 {
		switch f.Prefix {
		case "mcps":
			if b.str("git_url", "") == "" && b.str("command", "") == "" && b.str("url", "") == "" {
				b.modelError("At least one of git_url, command, or url must be provided")
			}
		case "sandboxes":
			runtimeType := b.str("runtime_type", "")
			image := b.str("image", "")
			cfg := b.dict("runtime_config", map[string]any{})
			switch {
			case (runtimeType == "docker" || runtimeType == "lxc") && image == "":
				b.modelError(fmt.Sprintf("image is required for %s sandboxes", runtimeType))
			case runtimeType == "docker" && image != "" && (strings.Contains(image, "://") || !ociImageRE.MatchString(image)):
				b.modelError("docker image must be an OCI/Docker image reference")
			case runtimeType == "firecracker":
				_, hasConfig := cfg["config_path"]
				_, hasKernel := cfg["kernel_image_path"]
				_, hasRootfs := cfg["rootfs_path"]
				if !hasConfig && (!hasKernel || !hasRootfs) {
					b.modelError("firecracker sandboxes require runtime_config.config_path or kernel_image_path/rootfs_path")
				}
			case runtimeType == "wasm" && image == "":
				if _, hasModule := cfg["module"]; !hasModule {
					b.modelError("wasm sandboxes require image or runtime_config.module pointing to a WASI module")
				}
			}
		}
	}
	return name, version, description, owner
}

// ociImageRE matches plausible image references the way the schema does.
var ociImageRE = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$`)

// skillSubmission carries the resolved skill fields after content analysis.
type skillSubmission struct {
	Name, Description, SlashCommand string
	SkillPath, SkillMDContent       string
	Validated                       bool
}

var githubRepoRE = regexp.MustCompile(`^(?:https?://|git@)github\.com[:/](?P<owner>[^/]+)/(?P<repo>[^/]+?)(?:\.git)?/?$`)
var installedSkillPrefixRE = regexp.MustCompile(`^(?:\.claude|\.kiro|\.cursor|\.agents|\.copilot|\.codex|\.opencode|\.gemini)/`)

// normalizeSkillPath strips slashes and a trailing SKILL.md component.
func normalizeSkillPath(skillPath string) string {
	clean := strings.Trim(skillPath, "/")
	lower := strings.ToLower(clean)
	if lower == "skill.md" {
		return ""
	}
	if strings.HasSuffix(lower, "/skill.md") {
		return clean[:strings.LastIndex(clean, "/")]
	}
	return clean
}

// buildRawSkillURL locates SKILL.md over raw content hosting.
func buildRawSkillURL(gitURL, skillPath, gitRef string) string {
	skillPath = normalizeSkillPath(skillPath)
	skillMD := "SKILL.md"
	if skillPath != "" {
		skillMD = skillPath + "/SKILL.md"
	}
	if m := githubRepoRE.FindStringSubmatch(strings.TrimRight(gitURL, "/")); m != nil {
		return fmt.Sprintf("https://raw.githubusercontent.com/%s/%s/%s/%s", m[1], m[2], gitRef, skillMD)
	}
	base := strings.TrimRight(gitURL, "/")
	base = strings.TrimSuffix(base, ".git")
	return fmt.Sprintf("%s/raw/%s/%s", base, gitRef, skillMD)
}

// discoverSkillPath finds a lone SKILL.md in a GitHub repo via the trees API.
func discoverSkillPath(ctx context.Context, client *http.Client, gitURL, gitRef string) string {
	m := githubRepoRE.FindStringSubmatch(strings.TrimRight(gitURL, "/"))
	if m == nil {
		return ""
	}
	req, err := http.NewRequestWithContext(ctx,
		http.MethodGet, fmt.Sprintf("https://api.github.com/repos/%s/%s/git/trees/%s?recursive=1", m[1], m[2], gitRef), nil)
	if err != nil {
		return ""
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "Caracal-Skill-Validator")
	resp, err := client.Do(req)
	if err != nil {
		return ""
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return ""
	}
	var payload struct {
		Tree []struct {
			Path string `json:"path"`
		} `json:"tree"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&payload); err != nil {
		return ""
	}
	all := []string{}
	canonical := []string{}
	for _, entry := range payload.Tree {
		if entry.Path == "SKILL.md" || strings.HasSuffix(entry.Path, "/SKILL.md") {
			all = append(all, entry.Path)
			if !installedSkillPrefixRE.MatchString(entry.Path) {
				canonical = append(canonical, entry.Path)
			}
		}
	}
	candidates := canonical
	if len(candidates) == 0 {
		candidates = all
	}
	if len(candidates) != 1 {
		return ""
	}
	path := candidates[0]
	if idx := strings.LastIndex(path, "/SKILL.md"); idx >= 0 {
		return path[:idx]
	}
	return "/"
}

// fetchSkillMD retrieves and frontmatter-validates SKILL.md from a repo.
func (s *Store) fetchSkillMD(ctx context.Context, gitURL, skillPath, gitRef string) (content, name, description, slash, resolvedPath string, aerr *apiError) {
	// Outbound fetches honor the shared SSRF policy.
	if alerts.IsPrivateURL(ctx, gitURL) {
		return "", "", "", "", "", &apiError{Status: 422,
			Detail: fmt.Sprintf("Network error fetching SKILL.md: repository URL resolves to a private/internal address: %s", gitURL)}
	}
	skillPath = normalizeSkillPath(skillPath)
	if skillPath == "" {
		skillPath = "/"
	}
	rawURL := buildRawSkillURL(gitURL, skillPath, gitRef)
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Get(rawURL)
	if err != nil {
		return "", "", "", "", "", &apiError{Status: 422, Detail: fmt.Sprintf("Network error fetching SKILL.md: %v", err)}
	}
	if resp.StatusCode == http.StatusNotFound && strings.Trim(skillPath, "/") == "" {
		_ = resp.Body.Close()
		if discovered := discoverSkillPath(ctx, client, gitURL, gitRef); discovered != "" {
			skillPath = discovered
			rawURL = buildRawSkillURL(gitURL, skillPath, gitRef)
			resp, err = client.Get(rawURL)
			if err != nil {
				return "", "", "", "", "", &apiError{Status: 422, Detail: fmt.Sprintf("Network error fetching SKILL.md: %v", err)}
			}
		} else {
			return "", "", "", "", "", &apiError{Status: 422,
				Detail: fmt.Sprintf("SKILL.md not found at '%s'. Check that git_url, skill_path, and git_ref are correct.", rawURL)}
		}
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusNotFound {
		return "", "", "", "", "", &apiError{Status: 422,
			Detail: fmt.Sprintf("SKILL.md not found at '%s'. Check that git_url, skill_path, and git_ref are correct.", rawURL)}
	}
	if resp.StatusCode != http.StatusOK {
		return "", "", "", "", "", &apiError{Status: 422,
			Detail: fmt.Sprintf("Failed to fetch SKILL.md (HTTP %d): '%s'", resp.StatusCode, rawURL)}
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return "", "", "", "", "", &apiError{Status: 422, Detail: fmt.Sprintf("Network error fetching SKILL.md: %v", err)}
	}
	content = string(body)
	fm, aerr := skillFrontmatterMap(content)
	if aerr != nil {
		return "", "", "", "", "", aerr
	}
	fmSlash, aerr := analyzeSkillMD(content, "")
	if aerr != nil {
		return "", "", "", "", "", aerr
	}
	name, _ = fm["name"].(string)
	description, _ = fm["description"].(string)
	if strings.TrimSpace(name) == "" {
		return "", "", "", "", "", &apiError{Status: 422, Detail: "SKILL.md frontmatter missing required field: 'name'"}
	}
	if strings.TrimSpace(description) == "" {
		return "", "", "", "", "", &apiError{Status: 422, Detail: "SKILL.md frontmatter missing required field: 'description'"}
	}
	return content, strings.TrimSpace(name), strings.TrimSpace(description), fmSlash, skillPath, nil
}

// resolveSkillSubmission applies the frontmatter-wins resolution rules.
func (s *Store) resolveSkillSubmission(ctx context.Context, b *draftBody, name, description string) (*skillSubmission, *apiError) {
	out := &skillSubmission{
		Name:           name,
		Description:    description,
		SkillPath:      b.str("skill_path", "/"),
		SkillMDContent: b.str("skill_md_content", ""),
	}
	slash, hasSlash := b.slashCommand()
	slashSet := hasSlash
	deliveryMode := b.str("delivery_mode", "git_fetch")
	if deliveryMode == "" {
		deliveryMode = "git_fetch"
	}
	gitURL := b.str("git_url", "")

	if deliveryMode == "registry_direct" {
		if out.SkillMDContent == "" {
			return nil, &apiError{Status: 422, Detail: "skill_md_content is required for registry_direct delivery"}
		}
		fm, aerr := skillFrontmatterMap(out.SkillMDContent)
		if aerr != nil {
			return nil, aerr
		}
		normalized, aerr := analyzeSkillMD(out.SkillMDContent, slash)
		if aerr != nil {
			return nil, aerr
		}
		if fmName, ok := fm["name"].(string); ok && out.Name == "" {
			out.Name = fmName
		}
		if fmDesc, ok := fm["description"].(string); ok && out.Description == "" {
			out.Description = fmDesc
		}
		if normalized != "" {
			slash = normalized
		}
		out.Validated = true
	} else if gitURL != "" {
		content, fmName, fmDesc, fmSlash, resolvedPath, aerr := s.fetchSkillMD(ctx, gitURL, out.SkillPath, b.str("git_ref", "main"))
		if aerr != nil {
			return nil, aerr
		}
		out.Validated = true
		if out.SkillMDContent == "" {
			out.SkillMDContent = content
		}
		if resolvedPath != "" && strings.Trim(out.SkillPath, "/") == "" {
			out.SkillPath = resolvedPath
		}
		if out.Name == "" {
			out.Name = fmName
		}
		if out.Description == "" {
			out.Description = fmDesc
		}
		if !slashSet {
			if fmSlash != "" {
				slash = fmSlash
			}
		} else if fmSlash != "" && slash != fmSlash {
			return nil, &apiError{Status: 422, Detail: "slash_command does not match SKILL.md frontmatter command"}
		}
	}

	if out.SkillMDContent != "" {
		normalized, aerr := analyzeSkillMD(out.SkillMDContent, slash)
		if aerr != nil {
			return nil, aerr
		}
		if normalized != "" {
			slash = normalized
		}
	}
	if out.Name == "" {
		return nil, &apiError{Status: 422, Detail: "name is required"}
	}
	if out.Description == "" {
		return nil, &apiError{Status: 422, Detail: "description is required"}
	}
	normalized, aerr := normalizeSlashCommand(slash)
	if aerr != nil {
		return nil, &apiError{Status: 422, Detail: "Invalid slash_command: " + strings.TrimPrefix(aerr.Detail, "Invalid slash command: ")}
	}
	out.SlashCommand = normalized
	return out, nil
}

// SubmitDirect publishes a new listing straight into review (or auto-approval
// for personal-scope publishes) with its first version.
func (s *Store) SubmitDirect(ctx context.Context, f Family, viewer *Viewer, b *draftBody, ambient *uuid.UUID, validHarnesses []string, mirror *Mirror) (map[string]any, error) {
	name, version, description, owner := validateSubmit(f, b)
	visibility := b.visibility()
	category := ""
	if f.Prefix == "mcps" {
		category = b.str("category", "")
	}
	versionFields := draftVersionFields(f, b, validHarnesses)
	if len(b.errs) > 0 {
		return nil, &validationError{Errs: b.errs}
	}
	if b.analyzerErr != nil {
		return nil, b.analyzerErr
	}

	var skill *skillSubmission
	if f.Prefix == "skills" {
		resolved, aerr := s.resolveSkillSubmission(ctx, b, name, description)
		if aerr != nil {
			return nil, aerr
		}
		skill = resolved
		name = skill.Name
		versionFields["description"] = skill.Description
		versionFields["skill_path"] = skill.SkillPath
		versionFields["validated"] = skill.Validated
		if skill.SkillMDContent != "" {
			versionFields["skill_md_content"] = skill.SkillMDContent
		}
		if skill.SlashCommand != "" {
			versionFields["slash_command"] = skill.SlashCommand
		} else {
			versionFields["slash_command"] = nil
		}
	}

	user, err := s.userFor(ctx, viewer)
	if err != nil {
		return nil, err
	}
	resolver := &tenancy.Resolver{DB: s.DB}
	target, err := resolver.ResolvePublishTarget(ctx, user, name, tenancy.PublishOptions{
		Visibility: visibility, ProjectID: ambient,
	})
	var tErr *tenancy.Error
	if errors.As(err, &tErr) {
		return nil, &apiError{Status: tErr.Status, Detail: tErr.Detail}
	}
	if err != nil {
		return nil, err
	}

	labels := draftLabels[f.Prefix]
	if f.Prefix == "mcps" {
		// A submitter may replace their own unapproved listing in place.
		var existingID, existingBy, existingStatus string
		err := s.DB.QueryRow(ctx,
			`SELECT l.id::text, l.submitted_by::text, COALESCE(v.status::text, 'draft')
			 FROM mcp_listings l LEFT JOIN mcp_versions v ON l.latest_version_id = v.id
			 WHERE l.namespace = $1 AND l.slug = $2`,
			target.Namespace, target.Slug).Scan(&existingID, &existingBy, &existingStatus)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		if err == nil {
			if existingBy == viewer.ID.String() && existingStatus != "approved" {
				if _, err := s.DB.Exec(ctx, `DELETE FROM mcp_listings WHERE id = $1`, existingID); err != nil {
					return nil, err
				}
			} else {
				return nil, &apiError{Status: 409,
					Detail: fmt.Sprintf("Approved MCP server '%s/%s' already exists", target.Namespace, target.Slug)}
			}
		}
	} else {
		var exists bool
		if err := s.DB.QueryRow(ctx, fmt.Sprintf(
			"SELECT EXISTS (SELECT 1 FROM %s WHERE namespace = $1 AND slug = $2)", f.ListingTable),
			target.Namespace, target.Slug).Scan(&exists); err != nil {
			return nil, err
		}
		if exists {
			return nil, &apiError{Status: 409,
				Detail: fmt.Sprintf("%s '%s/%s' already exists", labels.exists, target.Namespace, target.Slug)}
		}
	}

	// Every publish target is personal now; an explicit owner still wins.
	displayOwner := owner
	if displayOwner == "" {
		displayOwner = target.Owner
	}
	status := "pending"
	if target.AutoApprove {
		status = "approved"
	}

	listingID, err := s.insertDraft(ctx, f, insertDraftParams{
		Name: name, Namespace: target.Namespace, Slug: target.Slug, Category: category,
		Owner: displayOwner, IsPrivate: target.IsPrivate(),
		ProjectID: target.ProjectID, SubmittedBy: viewer.ID, Scope: target.Scope(),
		Version: version, VersionFields: versionFields,
		Status: status, Reviewed: target.AutoApprove,
		Notify: func(tx pgx.Tx, newListingID, _ string) error {
			if target.AutoApprove {
				return nil // self-approved publishes notify nobody
			}
			row := map[string]any{
				"id": newListingID, "name": name,
				"namespace": target.Namespace, "slug": target.Slug,
				"version": version, "is_private": target.IsPrivate(),
			}
			if target.ProjectID != nil {
				projectStr := target.ProjectID.String()
				row["project_id"] = projectStr
			}
			return s.notifyReviewRequested(ctx, tx, row, f.Name, viewer.ID)
		},
	})
	if isUniqueViolation(err) {
		return nil, &apiError{Status: 409,
			Detail: fmt.Sprintf("A %s with this namespace and slug already exists", labels.conflict)}
	}
	if err != nil {
		return nil, err
	}

	if f.Prefix == "mcps" {
		if analysis := b.ndict("client_analysis"); analysis != nil {
			if err := s.storeClientAnalysis(ctx, listingID, analysis); err != nil {
				return nil, err
			}
		} else if gitURL := b.str("git_url", ""); gitURL != "" && mirror != nil {
			go s.validateMcpBackground(listingID, gitURL, mirror)
		}
	}

	row, err := s.Resolve(ctx, f, listingID, viewer, false)
	if err != nil || row == nil {
		return nil, fmt.Errorf("submit readback: %w", err)
	}
	return row, nil
}

// storeClientAnalysis records CLI-side validation results and adopts the
// discovered launch fields onto the fresh version row.
func (s *Store) storeClientAnalysis(ctx context.Context, listingID string, analysis map[string]any) error {
	str := func(key string) string { v, _ := analysis[key].(string); return v }
	list := func(key string) []any { v, _ := analysis[key].([]any); return v }

	if _, err := s.DB.Exec(ctx, `DELETE FROM mcp_validation_results WHERE listing_id = $1`, listingID); err != nil {
		return err
	}
	framework := str("framework")
	hasEntry := str("entry_point") != "" || framework != ""
	tools := list("tools")
	issues := list("issues")

	sets := []string{"mcp_validated = TRUE"}
	args := []any{listingID}
	if framework != "" {
		args = append(args, framework)
		sets = append(sets, fmt.Sprintf("framework = $%d", len(args)))
	}
	if command := str("command"); command != "" {
		args = append(args, command)
		sets = append(sets, fmt.Sprintf("command = COALESCE(command, $%d)", len(args)))
	}
	if rawArgs, ok := analysis["args"].([]any); ok && len(rawArgs) > 0 {
		blob, err := json.Marshal(rawArgs)
		if err != nil {
			return err
		}
		args = append(args, string(blob))
		sets = append(sets, fmt.Sprintf("args = COALESCE(args, $%d::json)", len(args)))
	}
	if image := str("docker_image"); image != "" {
		args = append(args, image)
		sets = append(sets, fmt.Sprintf("docker_image = COALESCE(docker_image, $%d)", len(args)))
	}
	if _, err := s.DB.Exec(ctx, fmt.Sprintf(
		`UPDATE mcp_versions SET %s WHERE id = (SELECT latest_version_id FROM mcp_listings WHERE id = $1)`,
		strings.Join(sets, ", ")), args...); err != nil {
		return err
	}

	detail := "Client-side analysis: no recognized MCP framework detected"
	if hasEntry {
		detail = "Client-side analysis: found entry point"
		if framework != "" {
			detail += fmt.Sprintf(" (%s)", framework)
		}
	}
	if _, err := s.DB.Exec(ctx,
		`INSERT INTO mcp_validation_results (id, listing_id, stage, passed, details, run_at)
		 VALUES (gen_random_uuid(), $1, 'clone_and_inspect', $2, $3, now())`, listingID, hasEntry, detail); err != nil {
		return err
	}
	if len(tools) > 0 || len(issues) > 0 {
		manifestDetail := fmt.Sprintf("Client-side analysis: %d tool(s) found", len(tools))
		if len(issues) > 0 {
			parts := make([]string, 0, len(issues))
			for _, issue := range issues {
				if s, ok := issue.(string); ok {
					parts = append(parts, s)
				}
			}
			manifestDetail += "\nIssues:\n- " + strings.Join(parts, "\n- ")
		}
		if _, err := s.DB.Exec(ctx,
			`INSERT INTO mcp_validation_results (id, listing_id, stage, passed, details, run_at)
			 VALUES (gen_random_uuid(), $1, 'manifest_validation', $2, $3, now())`,
			listingID, len(issues) == 0, manifestDetail); err != nil {
			return err
		}
	}
	return nil
}

// validateMcpBackground mirrors the repository and records whether a FastMCP
// entry point exists, off the request path.
func (s *Store) validateMcpBackground(listingID, gitURL string, m *Mirror) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	dir, err := m.cloneOrUpdate(ctx, gitURL, "main")
	passed := false
	detail := ""
	if err != nil {
		detail = err.Error()
	} else {
		passed, detail = validateMCPComponent(dir)
	}
	if _, err := s.DB.Exec(ctx, `DELETE FROM mcp_validation_results WHERE listing_id = $1`, listingID); err != nil {
		return
	}
	if _, err := s.DB.Exec(ctx,
		`INSERT INTO mcp_validation_results (id, listing_id, stage, passed, details, run_at)
		 VALUES (gen_random_uuid(), $1, 'clone_and_inspect', $2, $3, now())`, listingID, passed, detail); err != nil {
		return
	}
	_, _ = s.DB.Exec(ctx,
		`UPDATE mcp_versions SET mcp_validated = TRUE
		 WHERE id = (SELECT latest_version_id FROM mcp_listings WHERE id = $1)`, listingID)
}

// submitDirect is the publish route handler shared by the five families.
func (h *Handler) submitDirect(f Family) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4<<20))
		if err != nil || len(strings.TrimSpace(string(raw))) == 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
				{Type: "missing", Loc: []string{"body"}, Msg: "Field required", Input: nil},
			})
			return
		}
		body := &draftBody{raw: map[string]any{}}
		if err := json.Unmarshal(raw, &body.raw); err != nil {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
				{Type: "json_invalid", Loc: []string{"body", "0"}, Msg: "JSON decode error", Input: map[string]any{}},
			})
			return
		}
		ambient, err := h.Store.AmbientProjectID(r.Context(), r, viewer)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		row, err := h.Store.SubmitDirect(r.Context(), f, viewer, body, ambient, h.ValidHarnesses, h.Mirror)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, detail(f, row, nil, nil))
	})
}
