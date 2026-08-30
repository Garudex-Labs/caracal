// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/garudex-labs/caracal/internal/tenancy"
)

// draftBody is a decoded request body with validation-error accumulation.
type draftBody struct {
	raw  map[string]any
	errs []fieldError
	// analyzerErr carries the skill content analyzer's plain-detail rejection.
	analyzerErr *apiError
}

func (b *draftBody) fail(kind, key, msg string, ctx map[string]any) {
	b.errs = append(b.errs, fieldError{
		Type: kind, Loc: []string{"body", key}, Msg: msg, Input: b.raw[key], Ctx: ctx,
	})
}

func (b *draftBody) str(key, def string) string {
	v, present := b.raw[key]
	if !present || v == nil {
		return def
	}
	s, ok := v.(string)
	if !ok {
		b.fail("string_type", key, "Input should be a valid string", nil)
		return def
	}
	return s
}

func (b *draftBody) nstr(key string) *string {
	v, present := b.raw[key]
	if !present || v == nil {
		return nil
	}
	s, ok := v.(string)
	if !ok {
		b.fail("string_type", key, "Input should be a valid string", nil)
		return nil
	}
	return &s
}

func (b *draftBody) strList(key string, def []string) []string {
	v, present := b.raw[key]
	if !present || v == nil {
		return def
	}
	items, ok := v.([]any)
	if !ok {
		b.fail("list_type", key, "Input should be a valid list", nil)
		return def
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		s, ok := item.(string)
		if !ok {
			b.fail("string_type", key, "Input should be a valid string", nil)
			return def
		}
		out = append(out, s)
	}
	return out
}

// nStrList keeps genuinely absent or null lists null.
func (b *draftBody) nStrList(key string) []string {
	if v, present := b.raw[key]; !present || v == nil {
		return nil
	}
	return b.strList(key, nil)
}

func (b *draftBody) dict(key string, def map[string]any) map[string]any {
	v, present := b.raw[key]
	if !present || v == nil {
		return def
	}
	d, ok := v.(map[string]any)
	if !ok {
		b.fail("dict_type", key, "Input should be a valid dictionary", nil)
		return def
	}
	return d
}

func (b *draftBody) ndict(key string) map[string]any {
	if v, present := b.raw[key]; !present || v == nil {
		return nil
	}
	return b.dict(key, nil)
}

func (b *draftBody) intVal(key string, def int) int {
	v, present := b.raw[key]
	if !present || v == nil {
		return def
	}
	switch n := v.(type) {
	case float64:
		if n == float64(int(n)) {
			return int(n)
		}
		b.fail("int_from_float", key, "Input should be a valid integer, got a number with a fractional part", nil)
	case string:
		var parsed int
		if _, err := fmt.Sscanf(n, "%d", &parsed); err == nil && fmt.Sprintf("%d", parsed) == strings.TrimSpace(n) {
			return parsed
		}
		b.fail("int_parsing", key, "Input should be a valid integer, unable to parse string as an integer", nil)
	default:
		b.fail("int_type", key, "Input should be a valid integer", nil)
	}
	return def
}

func (b *draftBody) uuidNull(key string) *uuid.UUID {
	v, present := b.raw[key]
	if !present || v == nil {
		return nil
	}
	s, ok := v.(string)
	if !ok {
		b.fail("uuid_type", key, "UUID input should be a string, bytes or UUID object", nil)
		return nil
	}
	id, err := uuid.Parse(s)
	if err != nil {
		reason := uuidErrorText(s)
		b.fail("uuid_parsing", key, "Input should be a valid UUID, "+reason, map[string]any{"error": reason})
		return nil
	}
	return &id
}

func (b *draftBody) visibility() string {
	v := b.str("visibility", "public")
	switch v {
	case "public", "project", "private":
		return v
	}
	b.fail("literal_error", "visibility", "Input should be 'public', 'project' or 'private'",
		map[string]any{"expected": "'public', 'project' or 'private'"})
	return "public"
}

// harnessList validates and normalizes the supported-harness tokens.
func (b *draftBody) harnessList(valid []string) []string {
	tokens := b.strList("supported_harnesses", []string{})
	normalized := make([]string, 0, len(tokens))
	invalid := []string{}
	for _, token := range tokens {
		token = strings.ReplaceAll(token, "_", "-")
		normalized = append(normalized, token)
		found := false
		for _, v := range valid {
			if token == v {
				found = true
				break
			}
		}
		if !found {
			invalid = append(invalid, token)
		}
	}
	if len(invalid) > 0 {
		msg := fmt.Sprintf("Invalid harness(s): %s. Valid options: %s",
			strings.Join(invalid, ", "), strings.Join(valid, ", "))
		// The upstream contract serializes the raised error object as {}.
		b.fail("value_error", "supported_harnesses", "Value error, "+msg, map[string]any{"error": map[string]any{}})
	}
	return normalized
}

func (b *draftBody) option(key, def string, valid []string) string {
	v := b.str(key, def)
	for _, option := range valid {
		if v == option {
			return v
		}
	}
	msg := fmt.Sprintf("Invalid %s '%s'. Valid options: %s", key, v, strings.Join(valid, ", "))
	b.fail("value_error", key, "Value error, "+msg, map[string]any{"error": map[string]any{}})
	return def
}

// namedEntryList normalizes typed env-var and header payloads for storage.
func (b *draftBody) namedEntryList(key string, nullable bool) any {
	v, present := b.raw[key]
	if !present || v == nil {
		if nullable {
			return nil
		}
		return []namedEntry{}
	}
	items, ok := v.([]any)
	if !ok {
		b.fail("list_type", key, "Input should be a valid list", nil)
		if nullable {
			return nil
		}
		return []namedEntry{}
	}
	out := make([]namedEntry, 0, len(items))
	for _, item := range items {
		d, ok := item.(map[string]any)
		if !ok {
			b.fail("model_type", key, "Input should be a valid dictionary or object", nil)
			continue
		}
		entry := namedEntry{Required: true}
		name, ok := d["name"].(string)
		if !ok {
			b.fail("missing", key, "Field required", nil)
			continue
		}
		entry.Name = name
		if desc, ok := d["description"].(string); ok {
			entry.Description = desc
		}
		if req, ok := d["required"].(bool); ok {
			entry.Required = req
		}
		out = append(out, entry)
	}
	return out
}

// slashCommand validates the request's slash command at the schema layer:
// format failures are field errors, and the normalized name is what the
// content analyzer compares against.
func (b *draftBody) slashCommand() (string, bool) {
	v, present := b.raw["slash_command"]
	if !present || v == nil {
		return "", true
	}
	s, ok := v.(string)
	if !ok {
		b.fail("string_type", "slash_command", "Input should be a valid string", nil)
		return "", false
	}
	normalized, err := normalizeSlashCommand(s)
	if err != nil {
		b.fail("value_error", "slash_command",
			"Value error, slash_command must match ^[a-z0-9][a-z0-9_-]{0,63}$", map[string]any{"error": map[string]any{}})
		return "", false
	}
	return normalized, true
}

var sandboxRuntimeTypes = []string{"docker", "lxc", "firecracker", "wasm"}
var sandboxNetworkPolicies = []string{"none", "host", "bridge", "restricted"}

// draftLabels carries the two per-family error-message spellings.
var draftLabels = map[string]struct{ exists, conflict string }{
	"mcps":      {"MCP server", "listing"},
	"skills":    {"Skill", "skill"},
	"hooks":     {"Hook", "hook"},
	"prompts":   {"Prompt", "prompt"},
	"sandboxes": {"Sandbox", "sandbox"},
}

// versionInsertOnly are stored columns kept off the version wire shape.
var versionInsertOnly = map[string][]string{
	"mcps":   {"changelog"},
	"skills": {"delivery_mode", "script_content", "script_filename"},
}

// draftVersionFields extracts the family's version-column values.
func draftVersionFields(f Family, b *draftBody, validHarnesses []string) map[string]any {
	fields := map[string]any{
		"description":         b.str("description", ""),
		"supported_harnesses": b.harnessList(validHarnesses),
	}
	switch f.Prefix {
	case "skills":
		requested, ok := b.slashCommand()
		var command string
		if ok {
			command, b.analyzerErr = analyzeSkillMD(b.str("skill_md_content", ""), requested)
		}
		fields["skill_path"] = b.str("skill_path", "/")
		fields["git_url"] = b.nstr("git_url")
		fields["git_ref"] = b.nstr("git_ref")
		fields["skill_md_content"] = b.nstr("skill_md_content")
		deliveryMode := b.str("delivery_mode", "git_fetch")
		if deliveryMode == "" {
			deliveryMode = "git_fetch"
		}
		fields["delivery_mode"] = deliveryMode
		fields["script_content"] = b.nstr("script_content")
		fields["script_filename"] = b.nstr("script_filename")
		fields["target_agents"] = b.strList("target_agents", []string{})
		fields["task_type"] = b.str("task_type", "general")
		if command != "" {
			fields["slash_command"] = command
		} else {
			fields["slash_command"] = nil
		}
	case "mcps":
		command := b.nstr("command")
		url := b.nstr("url")
		transport := b.nstr("transport")
		if transport == nil {
			// Wire inference: remote-only drafts are sse, command drafts stdio.
			if url != nil && command == nil {
				v := "sse"
				transport = &v
			} else if command != nil {
				v := "stdio"
				transport = &v
			}
		}
		fields["transport"] = transport
		fields["framework"] = b.nstr("framework")
		fields["docker_image"] = b.nstr("docker_image")
		fields["command"] = command
		fields["args"] = b.nStrList("args")
		fields["url"] = url
		fields["headers"] = b.namedEntryList("headers", true)
		fields["auto_approve"] = b.nStrList("auto_approve")
		fields["environment_variables"] = b.namedEntryList("environment_variables", false)
		fields["setup_instructions"] = b.nstr("setup_instructions")
		fields["changelog"] = b.nstr("changelog")
		fields["source_url"] = b.nstr("git_url")
	case "hooks":
		fields["event"] = b.str("event", "PreToolUse")
		fields["execution_mode"] = b.str("execution_mode", "async")
		fields["priority"] = b.intVal("priority", 100)
		fields["handler_type"] = b.str("handler_type", "command")
		fields["handler_config"] = b.dict("handler_config", map[string]any{})
		fields["scope"] = b.str("scope", "agent")
		fields["tool_filter"] = b.nStrList("tool_filter")
		fields["script_content"] = b.nstr("script_content")
		fields["script_filename"] = b.nstr("script_filename")
		fields["source_url"] = b.nstr("source_url")
		fields["source_ref"] = b.nstr("source_ref")
		fields["source_path"] = b.nstr("source_path")
		fields["requirements"] = b.nStrList("requirements")
	case "prompts":
		fields["category"] = b.str("category", "general")
		fields["template"] = b.str("template", "")
		fields["variables"] = b.raw["variables"]
		if fields["variables"] == nil {
			fields["variables"] = []any{}
		}
		fields["model_hints"] = b.ndict("model_hints")
		fields["tags"] = b.strList("tags", []string{})
	case "sandboxes":
		fields["runtime_type"] = b.option("runtime_type", "docker", sandboxRuntimeTypes)
		fields["image"] = b.str("image", "")
		fields["resource_limits"] = b.dict("resource_limits", map[string]any{})
		fields["network_policy"] = b.option("network_policy", "none", sandboxNetworkPolicies)
		fields["entrypoint"] = b.nstr("entrypoint")
		fields["runtime_config"] = b.dict("runtime_config", map[string]any{})
		fields["source_url"] = b.nstr("source_url")
		fields["source_ref"] = b.nstr("source_ref")
		fields["sandbox_path"] = b.nstr("sandbox_path")
	}
	return fields
}

// userFor loads the tenancy identity behind a viewer.
func (s *Store) userFor(ctx context.Context, viewer *Viewer) (tenancy.User, error) {
	var username *string
	var email string
	err := s.DB.QueryRow(ctx, "SELECT username, email FROM users WHERE id = $1", viewer.ID).Scan(&username, &email)
	if err != nil {
		return tenancy.User{}, err
	}
	user := tenancy.User{ID: viewer.ID, Email: email, Role: viewer.Role}
	if username != nil {
		user.Username = *username
	}
	return user, nil
}

// AmbientProjectID resolves the header-claimed active project; access is
// validated per the tenancy policy (project membership, or org owner/admin)
// and anyone else sees the same 404 as a nonexistent project.
func (s *Store) AmbientProjectID(ctx context.Context, r *http.Request, viewer *Viewer) (*uuid.UUID, error) {
	projectSlug := strings.ToLower(strings.TrimSpace(r.Header.Get("X-Caracal-Project")))
	if projectSlug == "" {
		return nil, nil
	}
	orgSlug := strings.ToLower(strings.TrimSpace(r.Header.Get("X-Caracal-Org")))
	if orgSlug == "" {
		return nil, &apiError{Status: 422, Detail: "Project scope requires an organization scope"}
	}
	var orgID uuid.UUID
	err := s.DB.QueryRow(ctx, "SELECT id FROM organizations WHERE slug = $1", orgSlug).Scan(&orgID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, &apiError{Status: 404, Detail: "Organization not found"}
	}
	if err != nil {
		return nil, err
	}
	var projectID uuid.UUID
	err = s.DB.QueryRow(ctx,
		"SELECT id FROM projects WHERE organization_id = $1 AND slug = $2", orgID, projectSlug).Scan(&projectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, &apiError{Status: 404, Detail: "Project not found"}
	}
	if err != nil {
		return nil, err
	}
	var orgRole, projectRole string
	err = s.DB.QueryRow(ctx,
		`SELECT COALESCE(m.role::text, ''), COALESCE(pm.role::text, '')
		 FROM organization_memberships m
		 LEFT JOIN project_memberships pm ON pm.project_id = $2 AND pm.user_id = m.user_id
		 WHERE m.organization_id = $1 AND m.user_id = $3`, orgID, projectID, viewer.ID).
		Scan(&orgRole, &projectRole)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !tenancy.CanAccessProject(orgRole, projectRole)) {
		return nil, &apiError{Status: 404, Detail: "Project not found"}
	}
	if err != nil {
		return nil, err
	}
	return &projectID, nil
}

// isUniqueViolation matches the identity-conflict commit contract.
func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// CreateDraft resolves the publish target and creates the listing with its
// first version in draft status, atomically.
func (s *Store) CreateDraft(ctx context.Context, f Family, viewer *Viewer, b *draftBody, ambient *uuid.UUID, validHarnesses []string) (map[string]any, error) {
	name, present := b.raw["name"].(string)
	if !present {
		b.errs = append(b.errs, fieldError{Type: "missing", Loc: []string{"body", "name"}, Msg: "Field required", Input: b.raw})
	}
	version := b.str("version", "0.1.0")
	owner := b.str("owner", "")
	visibility := b.visibility()
	category := ""
	if f.Prefix == "mcps" {
		category = b.str("category", "other")
	}
	versionFields := draftVersionFields(f, b, validHarnesses)
	if len(b.errs) > 0 {
		return nil, &validationError{Errs: b.errs}
	}
	// The content analyzer rejects before target resolution, like the API.
	if b.analyzerErr != nil {
		return nil, b.analyzerErr
	}

	user, err := s.userFor(ctx, viewer)
	if err != nil {
		return nil, err
	}
	// An explicit body project outranks the ambient header; membership is
	// validated either way.
	if explicit := b.uuidNull("project_id"); explicit != nil {
		ambient = explicit
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

	displayOwner := owner
	if displayOwner == "" {
		displayOwner = user.DisplayHandle()
	}

	listingID, err := s.insertDraft(ctx, f, insertDraftParams{
		Name: name, Namespace: target.Namespace, Slug: target.Slug, Category: category,
		Owner: displayOwner, IsPrivate: target.IsPrivate(),
		ProjectID: target.ProjectID, SubmittedBy: viewer.ID, Scope: target.Scope(),
		Version: version, VersionFields: versionFields,
	})
	if isUniqueViolation(err) {
		return nil, &apiError{Status: 409,
			Detail: fmt.Sprintf("A %s with this namespace and slug already exists", labels.conflict)}
	}
	if err != nil {
		return nil, err
	}

	row, err := s.Resolve(ctx, f, listingID, viewer, false)
	if err != nil || row == nil {
		return nil, fmt.Errorf("draft readback: %w", err)
	}
	return row, nil
}

type insertDraftParams struct {
	Name, Namespace, Slug, Category, Owner, Scope, Version string
	IsPrivate                                              bool
	ProjectID                                              *uuid.UUID
	SubmittedBy                                            uuid.UUID
	VersionFields                                          map[string]any
	// Status defaults to draft; Reviewed stamps the reviewer columns.
	Status   string
	Reviewed bool
	// Notify runs inside the insert transaction after the version lands.
	Notify func(tx pgx.Tx, listingID, versionID string) error
}

// jsonColumns are version columns stored as JSON documents.
var jsonColumns = map[string]bool{
	"args": true, "headers": true, "auto_approve": true, "environment_variables": true,
	"handler_config": true, "tool_filter": true, "requirements": true, "variables": true,
	"model_hints": true, "tags": true, "resource_limits": true, "runtime_config": true,
	"supported_harnesses": true, "target_agents": true,
}

// jsonParam marshals structured values for JSON columns; nil stays NULL.
func jsonParam(value any) (any, error) {
	if value == nil {
		return nil, nil
	}
	blob, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return string(blob), nil
}

// insertStmt accumulates columns, casts, and values for one INSERT.
type insertStmt struct {
	cols, placeholders []string
	vals               []any
	err                error
}

func (i *insertStmt) raw(col, expr string) {
	i.cols = append(i.cols, col)
	i.placeholders = append(i.placeholders, expr)
}

func (i *insertStmt) val(col string, v any) {
	cast := ""
	if jsonColumns[col] || col == "co_authors" {
		var err error
		if v, err = jsonParam(v); err != nil {
			i.err = err
			return
		}
		cast = "::json"
	}
	i.vals = append(i.vals, v)
	i.cols = append(i.cols, col)
	i.placeholders = append(i.placeholders, fmt.Sprintf("$%d%s", len(i.vals), cast))
}

func (i *insertStmt) sql(table string) string {
	return fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s) RETURNING id::text",
		table, strings.Join(i.cols, ", "), strings.Join(i.placeholders, ", "))
}

func (s *Store) insertDraft(ctx context.Context, f Family, p insertDraftParams) (string, error) {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	listing := &insertStmt{}
	listing.raw("id", "gen_random_uuid()")
	listing.val("name", p.Name)
	listing.val("namespace", p.Namespace)
	listing.val("slug", p.Slug)
	if f.Prefix == "mcps" {
		listing.val("category", p.Category)
	}
	listing.val("owner", p.Owner)
	listing.val("is_private", p.IsPrivate)
	listing.val("project_id", p.ProjectID)
	listing.val("submitted_by", p.SubmittedBy)
	listing.val("co_authors", []string{})
	listing.val("unique_agents", 0)
	listing.raw("created_at", "now()")
	listing.raw("updated_at", "now()")
	listing.val("ownership_scope", p.Scope)
	if listing.err != nil {
		return "", listing.err
	}

	var listingID string
	if err := tx.QueryRow(ctx, listing.sql(f.ListingTable), listing.vals...).Scan(&listingID); err != nil {
		return "", err
	}

	version := &insertStmt{}
	version.raw("id", "gen_random_uuid()")
	version.val("listing_id", listingID)
	version.val("version", p.Version)
	status := p.Status
	if status == "" {
		status = "draft"
	}
	version.val("status", status)
	version.val("download_count", 0)
	version.val("released_by", p.SubmittedBy)
	version.raw("released_at", "now()")
	if p.Reviewed {
		version.val("reviewed_by", p.SubmittedBy)
		version.raw("reviewed_at", "now()")
	}
	version.raw("created_at", "now()")
	version.raw("is_editing", "FALSE")
	version.val("description", p.VersionFields["description"])
	version.val("supported_harnesses", p.VersionFields["supported_harnesses"])
	for _, key := range versionExtras[f.Prefix] {
		if value, tracked := p.VersionFields[key]; tracked {
			version.val(key, value)
		}
	}
	for _, key := range versionInsertOnly[f.Prefix] {
		if value, tracked := p.VersionFields[key]; tracked {
			version.val(key, value)
		}
	}
	if f.Prefix == "mcps" {
		version.val("mcp_validated", false)
	}
	if f.Prefix == "skills" {
		validated := false
		if v, ok := p.VersionFields["validated"].(bool); ok {
			validated = v
		}
		version.val("validated", validated)
	}
	if version.err != nil {
		return "", version.err
	}

	var versionID string
	if err := tx.QueryRow(ctx, version.sql(f.VersionTable), version.vals...).Scan(&versionID); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx, fmt.Sprintf(
		"UPDATE %s SET latest_version_id = $1 WHERE id = $2", f.ListingTable), versionID, listingID); err != nil {
		return "", err
	}
	if p.Notify != nil {
		if err := p.Notify(tx, listingID, versionID); err != nil {
			return "", err
		}
	}
	return listingID, tx.Commit(ctx)
}

// validationError carries accumulated request-validation failures.
type validationError struct {
	Errs []fieldError
}

func (e *validationError) Error() string { return "request validation failed" }
