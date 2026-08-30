// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/tenancy"
)

// ── Visibility flip ─────────────────────────────────────────────────────

// visibilityEntity maps the route's item type onto storage.
var visibilityEntities = map[string]struct {
	listingTable, versionTable string
	isAgent                    bool
}{
	"mcp":     {"mcp_listings", "mcp_versions", false},
	"skill":   {"skill_listings", "skill_versions", false},
	"hook":    {"hook_listings", "hook_versions", false},
	"prompt":  {"prompt_listings", "prompt_versions", false},
	"sandbox": {"sandbox_listings", "sandbox_versions", false},
	"agent":   {"agents", "agent_versions", true},
}

// viewerLeadsProject reports whether the viewer is a lead of the given project.
func (s *Store) viewerLeadsProject(ctx context.Context, projectID *string, userID uuid.UUID) bool {
	if projectID == nil {
		return false
	}
	pid, err := uuid.Parse(*projectID)
	if err != nil {
		return false
	}
	var role string
	if err := s.DB.QueryRow(ctx,
		`SELECT role FROM project_memberships WHERE project_id = $1 AND user_id = $2`, pid, userID).Scan(&role); err != nil {
		return false
	}
	return role == "lead"
}

// UpdateVisibility flips a listing between public and project-member
// visibility, enforcing the review boundary on the way back to public.
func (s *Store) UpdateVisibility(ctx context.Context, itemType, listingID, visibility string, viewer *Viewer) (map[string]any, error) {
	spec, known := visibilityEntities[itemType]
	if !known {
		return nil, &apiError{Status: 422, Detail: fmt.Sprintf("Invalid item type: %s", itemType)}
	}
	ownerColumn := "submitted_by"
	deletedGuard := ""
	if spec.isAgent {
		ownerColumn = "created_by"
		deletedGuard = " AND l.deleted_at IS NULL"
	}
	rows, err := s.DB.Query(ctx, fmt.Sprintf(
		`SELECT l.id::text AS id, l.name, l.namespace, l.slug, l.is_private,
		        l.project_id::text AS project_id, l.%s::text AS owner_id,
		        l.latest_version_id::text AS latest_version_id, v.version, COALESCE(v.status::text, 'draft') AS status
		 FROM %s l LEFT JOIN %s v ON l.latest_version_id = v.id
		 WHERE (l.id::text = $1 OR (l.namespace || '/' || l.slug) = $1 OR l.name = $1)%s LIMIT 1`,
		ownerColumn, spec.listingTable, spec.versionTable, deletedGuard), listingID)
	if err != nil {
		return nil, err
	}
	matches := collectRows(rows)
	rows.Close()
	if len(matches) == 0 {
		return nil, &apiError{Status: 404, Detail: "Listing not found"}
	}
	listing := matches[0]
	listingUUID := rowStr(listing, "id", "")

	privileged := viewer.seesPrivateListings()
	projectID := rowNStr(listing, "project_id")
	creatorID := rowStr(listing, "owner_id", "")
	if !privileged && creatorID != viewer.ID.String() {
		// Project leads manage their project's shared listings; everyone else
		// sees a private item's not-found face.
		if !s.viewerLeadsProject(ctx, projectID, viewer.ID) {
			if rowBool(listing, "is_private") {
				return nil, &apiError{Status: 404, Detail: "Listing not found"}
			}
			return nil, &apiError{Status: 403, Detail: "Only the listing owner can change visibility"}
		}
	}

	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if visibility == "project" && !spec.isAgent {
		// An approved public agent version may pin this component.
		var pinned string
		err := tx.QueryRow(ctx,
			`SELECT a.id::text FROM agents a
			 JOIN agent_versions av ON av.agent_id = a.id AND av.status = 'approved'
			 JOIN agent_components ac ON ac.agent_version_id = av.id
			 WHERE ac.component_type = $1 AND ac.component_id = $2
			   AND a.is_private = FALSE AND a.deleted_at IS NULL LIMIT 1`,
			itemType, listingUUID).Scan(&pinned)
		if err == nil {
			return nil, &apiError{Status: 409,
				Detail: "Cannot make this component project-only while an approved public agent version uses it"}
		}
	}

	if spec.isAgent {
		// Every installable version's components must stay visible to the
		// agent's new audience.
		conflict, err := s.agentComponentVisibilityConflict(ctx, tx, listingUUID, visibility, projectID)
		if err != nil {
			return nil, err
		}
		if conflict {
			return nil, &apiError{Status: 409,
				Detail: "Agent visibility conflicts with one or more component visibility settings"}
		}
	}

	wasPrivate := rowBool(listing, "is_private")
	namespace := rowStr(listing, "namespace", "")
	isPrivate := visibility == "project"
	if _, err := tx.Exec(ctx, fmt.Sprintf(
		`UPDATE %s SET is_private = $2, ownership_scope = 'project', updated_at = now() WHERE id = $1`,
		spec.listingTable), listingUUID, isPrivate); err != nil {
		return nil, err
	}

	// Project-private going public re-enters global review unless the actor
	// already holds that authority.
	returnedToReview := false
	if wasPrivate && !isPrivate && !isGlobalReviewerRole(viewer.Role) && rowStr(listing, "status", "") == "approved" {
		fk := "listing_id"
		if spec.isAgent {
			fk = "agent_id"
		}
		if _, err := tx.Exec(ctx, fmt.Sprintf(
			`UPDATE %s SET status = 'pending', reviewed_by = NULL, reviewed_at = NULL
			 WHERE %s = $1 AND status = 'approved'`, spec.versionTable, fk), listingUUID); err != nil {
			return nil, err
		}
		returnedToReview = true
		fanRow := map[string]any{
			"id": listing["id"], "name": listing["name"], "namespace": namespace,
			"slug": listing["slug"], "is_private": false, "project_id": listing["project_id"],
			"version": listing["version"],
		}
		if err := s.notifyReviewRequested(ctx, tx, fanRow, itemType, viewer.ID); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	finalStatus := rowStr(listing, "status", "")
	if returnedToReview {
		finalStatus = "pending"
	}
	wireVisibility := "public"
	if isPrivate {
		wireVisibility = "project"
	}
	return map[string]any{
		"id":                 listingUUID,
		"type":               itemType,
		"qualified_name":     namespace + "/" + rowStr(listing, "slug", ""),
		"project_id":         projectID,
		"visibility":         wireVisibility,
		"status":             finalStatus,
		"returned_to_review": returnedToReview,
	}, nil
}

// agentComponentVisibilityConflict checks every installable version's
// component references against the agent's destination audience.
func (s *Store) agentComponentVisibilityConflict(ctx context.Context, tx pgx.Tx, agentID, visibility string, agentProjectID *string) (bool, error) {
	rows, err := tx.Query(ctx,
		`SELECT DISTINCT ac.component_type, ac.component_id::text
		 FROM agent_components ac JOIN agent_versions av ON ac.agent_version_id = av.id
		 WHERE av.agent_id = $1 AND av.status IN ('approved', 'pending')`, agentID)
	if err != nil {
		return false, err
	}
	type ref struct{ ctype, id string }
	refs := []ref{}
	for rows.Next() {
		var r ref
		if err := rows.Scan(&r.ctype, &r.id); err != nil {
			rows.Close()
			return false, err
		}
		refs = append(refs, r)
	}
	rows.Close()
	for _, r := range refs {
		spec, known := visibilityEntities[r.ctype]
		if !known || spec.isAgent {
			continue
		}
		var isPrivate bool
		var componentProject *string
		err := tx.QueryRow(ctx, fmt.Sprintf(
			`SELECT is_private, project_id::text FROM %s WHERE id = $1`, spec.listingTable), r.id).Scan(&isPrivate, &componentProject)
		if err != nil {
			return true, nil // unresolvable reference conflicts by definition
		}
		if !isPrivate {
			continue
		}
		// A project-private component only serves an agent shared with the same project.
		if visibility != "project" || agentProjectID == nil || componentProject == nil || *componentProject != *agentProjectID {
			return true, nil
		}
	}
	return false, nil
}

// ── Agent co-authors ────────────────────────────────────────────────────

// agentForCoAuthors loads an agent row and checks manage permission.
func (s *Store) agentForCoAuthors(ctx context.Context, agentID uuid.UUID, viewer *Viewer, manage bool) (map[string]any, error) {
	agent, err := s.agentRow(ctx, agentID)
	if err != nil {
		return nil, err
	}
	if agent == nil {
		return nil, &apiError{Status: 404, Detail: "Agent not found"}
	}
	if manage {
		if rowStr(agent, "created_by", "") != viewer.ID.String() {
			return nil, &apiError{Status: 403, Detail: "You don't have permission to manage co-authors"}
		}
	}
	return agent, nil
}

// ── Bulk agent creation ─────────────────────────────────────────────────

// BulkCreateAgents creates multiple pending agents, skipping duplicates.
func (s *Store) BulkCreateAgents(ctx context.Context, items []map[string]any, dryRun bool, viewer *Viewer) (map[string]any, error) {
	user, err := s.userFor(ctx, viewer)
	if err != nil {
		return nil, err
	}
	resolver := &tenancy.Resolver{DB: s.DB}
	results := []any{}
	created, skipped, errored := 0, 0, 0
	for _, item := range items {
		name, _ := item["name"].(string)
		target, err := resolver.ResolvePublishTarget(ctx, user, name, tenancy.PublishOptions{Visibility: "public"})
		var tErr *tenancy.Error
		if err != nil {
			detail := "invalid name"
			if errors.As(err, &tErr) {
				detail = tErr.Detail
			}
			results = append(results, map[string]any{"name": name, "status": "error", "error": detail})
			errored++
			continue
		}
		var exists bool
		if err := s.DB.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM agents WHERE namespace = $1 AND slug = $2 AND deleted_at IS NULL)`,
			target.Namespace, target.Slug).Scan(&exists); err != nil {
			return nil, err
		}
		if exists {
			results = append(results, map[string]any{"name": name, "status": "skipped", "agent_id": nil, "error": "Agent with this name already exists"})
			skipped++
			continue
		}
		if dryRun {
			results = append(results, map[string]any{"name": name, "status": "created", "agent_id": nil, "error": nil})
			created++
			continue
		}
		agentID, err := s.bulkInsertAgent(ctx, item, target, viewer)
		if err != nil {
			results = append(results, map[string]any{"name": name, "status": "error", "agent_id": nil, "error": err.Error()})
			errored++
			continue
		}
		results = append(results, map[string]any{"name": name, "status": "created", "agent_id": agentID, "error": nil})
		created++
	}
	return map[string]any{
		"total": len(items), "created": created, "skipped": skipped, "errors": errored,
		"dry_run": dryRun, "results": results,
	}, nil
}

// bulkInsertAgent writes one agent, version, components, and the review
// fan-out in a transaction.
func (s *Store) bulkInsertAgent(ctx context.Context, item map[string]any, target *tenancy.PublishTarget, viewer *Viewer) (string, error) {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	str := func(key, def string) string {
		if v, ok := item[key].(string); ok && v != "" {
			return v
		}
		return def
	}
	name, _ := item["name"].(string)
	owner := str("owner", "")
	if owner == "" {
		if err := s.DB.QueryRow(ctx, `SELECT email FROM users WHERE id = $1`, viewer.ID).Scan(&owner); err != nil {
			return "", err
		}
	}
	var agentID string
	if err := tx.QueryRow(ctx,
		`INSERT INTO agents (id, name, namespace, slug, owner, created_by, project_id,
			is_private, ownership_scope, co_authors, created_at, updated_at)
		 VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, '[]', now(), now()) RETURNING id::text`,
		name, target.Namespace, target.Slug, owner, viewer.ID,
		target.ProjectID, target.IsPrivate(), target.Scope()).Scan(&agentID); err != nil {
		return "", err
	}
	version := str("version", "0.1.0")
	jsonOr := func(key, def string) string {
		if v, ok := item[key]; ok && v != nil {
			if blob, err := json.Marshal(v); err == nil {
				return string(blob)
			}
		}
		return def
	}
	var versionID string
	if err := tx.QueryRow(ctx,
		`INSERT INTO agent_versions (id, agent_id, version, description, prompt, model_name,
			model_config_json, models_by_harness, external_mcps, supported_harnesses,
			required_capabilities, inferred_supported_harnesses, is_prerelease, download_count,
			is_editing, status, released_by, released_at, created_at)
		 VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6::json, $7::json, $8::json, $9::json,
			'[]', '[]', FALSE, 0, FALSE, 'pending', $10, now(), now())
		 RETURNING id::text`,
		agentID, version, str("description", ""), str("prompt", ""), str("model_name", ""),
		jsonOr("model_config_json", "{}"), jsonOr("models_by_harness", "{}"),
		jsonOr("external_mcps", "[]"), jsonOr("supported_harnesses", "[]"), viewer.ID).Scan(&versionID); err != nil {
		return "", err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE agents SET latest_version_id = $1 WHERE id = $2`, versionID, agentID); err != nil {
		return "", err
	}
	components, _ := item["components"].([]any)
	for i, raw := range components {
		comp, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		ctype := "mcp"
		if v, ok := comp["component_type"].(string); ok && v != "" {
			ctype = v
		}
		componentID, _ := comp["component_id"].(string)
		componentName, _ := comp["component_name"].(string)
		resolved := "latest"
		if spec, known := visibilityEntities[ctype]; known && !spec.isAgent {
			var v *string
			_ = tx.QueryRow(ctx, fmt.Sprintf(
				`SELECT v.version FROM %s l JOIN %s v ON l.latest_version_id = v.id WHERE l.id::text = $1`,
				spec.listingTable, spec.versionTable), componentID).Scan(&v)
			if v != nil {
				resolved = *v
			}
		}
		var override any
		if raw, present := comp["config_override"]; present && raw != nil {
			blob, err := json.Marshal(raw)
			if err != nil {
				return "", err
			}
			override = string(blob)
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO agent_components (id, agent_version_id, component_type, component_id, component_name,
			        resolved_version, order_index, config_override, created_at)
			 VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7::json, now())`,
			versionID, ctype, componentID, componentName, resolved, i, override); err != nil {
			return "", err
		}
	}
	fanRow := map[string]any{
		"id": agentID, "name": name, "namespace": target.Namespace,
		"slug": target.Slug, "is_private": false, "version": version,
	}
	if err := s.notifyReviewRequested(ctx, tx, fanRow, "agent", viewer.ID); err != nil {
		return "", err
	}
	return agentID, tx.Commit(ctx)
}

// ── MCP repository analysis ─────────────────────────────────────────────

var (
	fastMCPNameRE = regexp.MustCompile(`FastMCP\(\s*["']([^"']+)["']`)
	toolDefRE     = regexp.MustCompile(`@\w+\.tool\(\)[^\n]*\n(?:\s*(?:async\s+)?def\s+(\w+))`)
	envVarRE      = regexp.MustCompile(`os\.environ(?:\.get)?[\[(]\s*["']([A-Z][A-Z0-9_]+)["']`)
)

// AnalyzeRepo mirrors and inspects an MCP repository without creating a
// listing. Extraction is signature-based; unreadable repos answer with the
// error field rather than failing the request.
func (s *Store) AnalyzeRepo(ctx context.Context, gitURL string, mirror *Mirror) map[string]any {
	empty := map[string]any{"name": "", "description": "", "version": "0.1.0", "tools": []any{},
		"environment_variables": []any{}, "issues": []any{}, "error": "",
		"command": nil, "args": nil, "framework": nil}
	dir, err := mirror.cloneOrUpdate(ctx, gitURL, "main")
	if err != nil {
		msg := strings.ToLower(err.Error())
		switch {
		case strings.Contains(msg, "private/internal address"):
			empty["error"] = err.Error()
		case strings.Contains(msg, "authentication"), strings.Contains(msg, "403"), strings.Contains(msg, "404"):
			empty["error"] = "Repository is private or not accessible. Configure GIT_CLONE_TOKEN for private repos."
		case strings.Contains(msg, "not found"), strings.Contains(msg, "does not exist"):
			empty["error"] = "Repository not found. Check the URL."
		default:
			empty["error"] = "Failed to clone repository. Check the URL and try again."
		}
		return empty
	}

	name := ""
	tools := []any{}
	envVars := map[string]bool{}
	entryRel := ""
	_ = filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			if d != nil && d.IsDir() && d.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(d.Name(), ".py") {
			return nil
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		text := string(content)
		for _, m := range envVarRE.FindAllStringSubmatch(text, -1) {
			envVars[m[1]] = true
		}
		if name == "" {
			if m := fastMCPNameRE.FindStringSubmatch(text); m != nil {
				name = m[1]
				if rel, rerr := filepath.Rel(dir, path); rerr == nil {
					entryRel = rel
				}
				for _, t := range toolDefRE.FindAllStringSubmatch(text, -1) {
					tools = append(tools, map[string]any{"name": t[1], "description": ""})
				}
			}
		}
		return nil
	})

	if name == "" {
		// Repo-name fallback mirrors the non-Python detection path.
		base := strings.TrimSuffix(filepath.Base(strings.TrimRight(gitURL, "/")), ".git")
		out := map[string]any{"name": base, "description": "", "version": "0.1.0",
			"tools": []any{}, "environment_variables": envList(envVars),
			"issues": []any{}, "error": "", "command": nil, "args": nil, "framework": nil}
		return out
	}
	return map[string]any{
		"name": name, "description": "", "version": "0.1.0", "tools": tools,
		"environment_variables": envList(envVars), "issues": []any{}, "error": "",
		"command": "python", "args": []any{entryRel}, "framework": "python",
	}
}

func envList(vars map[string]bool) []any {
	out := []any{}
	for name := range vars {
		out = append(out, map[string]any{"name": name, "description": "", "required": true})
	}
	return out
}

// ── Handlers ────────────────────────────────────────────────────────────

func (h *Handler) updateVisibility() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		itemType := r.PathValue("item_type")
		if _, known := visibilityEntities[itemType]; !known {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
				{Type: "literal_error", Loc: []string{"path", "item_type"},
					Msg: "Input should be 'agent', 'mcp', 'skill', 'hook', 'prompt' or 'sandbox'", Input: itemType,
					Ctx: map[string]any{"expected": "'agent', 'mcp', 'skill', 'hook', 'prompt' or 'sandbox'"}},
			})
			return
		}
		body, ok := tailBody(w, r)
		if !ok {
			return
		}
		visibility, _ := body["visibility"].(string)
		if visibility != "public" && visibility != "project" {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
				{Type: "literal_error", Loc: []string{"body", "visibility"},
					Msg: "Input should be 'public' or 'project'", Input: body["visibility"],
					Ctx: map[string]any{"expected": "'public' or 'project'"}},
			})
			return
		}
		out, err := h.Store.UpdateVisibility(r.Context(), itemType, r.PathValue("listing_id"), visibility, viewer)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, out)
	})
}

func (h *Handler) agentCoAuthors(action string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		errs := []fieldError{}
		agentID := pathUUID(r, "entity_id", &errs)
		if len(errs) > 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, errs)
			return
		}
		switch action {
		case "list":
			agent, err := h.Store.agentForCoAuthors(r.Context(), agentID, viewer, false)
			if err != nil {
				writeStoreError(w, r, err)
				return
			}
			users, err := h.Store.usersByIDs(r.Context(), rowCoAuthors(agent))
			if err != nil {
				writeStoreError(w, r, err)
				return
			}
			httpapi.WriteJSON(w, http.StatusOK, users)
		case "editors":
			if _, err := h.Store.agentForCoAuthors(r.Context(), agentID, viewer, false); err != nil {
				writeStoreError(w, r, err)
				return
			}
			ids, err := h.Store.distinctReleasers(r.Context(), "agent_versions", "agent_id", agentID)
			if err != nil {
				writeStoreError(w, r, err)
				return
			}
			users, err := h.Store.usersByIDs(r.Context(), ids)
			if err != nil {
				writeStoreError(w, r, err)
				return
			}
			httpapi.WriteJSON(w, http.StatusOK, users)
		case "add":
			body, ok := tailBody(w, r)
			if !ok {
				return
			}
			ref := UserRef{}
			if v, isStr := body["user_id"].(string); isStr {
				ref.UserID = v
			}
			if v, isStr := body["email"].(string); isStr {
				ref.Email = v
			}
			if v, isStr := body["username"].(string); isStr {
				ref.Username = v
			}
			out, err := h.Store.AddAgentCoAuthor(r.Context(), agentID, viewer, ref)
			if err != nil {
				writeStoreError(w, r, err)
				return
			}
			httpapi.WriteJSON(w, http.StatusOK, out)
		case "remove":
			userID := pathUUID(r, "user_id", &errs)
			if len(errs) > 0 {
				httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, errs)
				return
			}
			if err := h.Store.RemoveAgentCoAuthor(r.Context(), agentID, userID, viewer); err != nil {
				writeStoreError(w, r, err)
				return
			}
			httpapi.WriteJSON(w, http.StatusOK, map[string]string{"detail": "Co-author removed"})
		}
	})
}

// AddAgentCoAuthor grants a collaborator seat on an agent.
func (s *Store) AddAgentCoAuthor(ctx context.Context, agentID uuid.UUID, viewer *Viewer, ref UserRef) (*coAuthorUser, error) {
	agent, err := s.agentForCoAuthors(ctx, agentID, viewer, true)
	if err != nil {
		return nil, err
	}
	target, err := s.resolveTargetUser(ctx, ref)
	if err != nil {
		return nil, err
	}
	if target.ID == rowStr(agent, "created_by", "") {
		return nil, &apiError{Status: 422, Detail: "Owner is already implicit - no need to add as co-author"}
	}
	coAuthors := rowCoAuthors(agent)
	for _, id := range coAuthors {
		if id == target.ID {
			return nil, &apiError{Status: 409, Detail: "User is already a co-author"}
		}
	}
	blob, err := json.Marshal(append(coAuthors, target.ID))
	if err != nil {
		return nil, err
	}
	if _, err := s.DB.Exec(ctx,
		`UPDATE agents SET co_authors = $2::json, updated_at = now() WHERE id = $1`,
		agentID.String(), string(blob)); err != nil {
		return nil, err
	}
	return target, nil
}

// RemoveAgentCoAuthor revokes a collaborator seat on an agent.
func (s *Store) RemoveAgentCoAuthor(ctx context.Context, agentID, userID uuid.UUID, viewer *Viewer) error {
	agent, err := s.agentForCoAuthors(ctx, agentID, viewer, true)
	if err != nil {
		return err
	}
	coAuthors := rowCoAuthors(agent)
	kept := make([]string, 0, len(coAuthors))
	found := false
	for _, id := range coAuthors {
		if id == userID.String() {
			found = true
			continue
		}
		kept = append(kept, id)
	}
	if !found {
		return &apiError{Status: 404, Detail: "User is not a co-author"}
	}
	blob, err := json.Marshal(kept)
	if err != nil {
		return err
	}
	_, err = s.DB.Exec(ctx,
		`UPDATE agents SET co_authors = $2::json, updated_at = now() WHERE id = $1`,
		agentID.String(), string(blob))
	return err
}

// distinctReleasers lists distinct released_by ids for one parent row.
func (s *Store) distinctReleasers(ctx context.Context, table, fk string, parent uuid.UUID) ([]string, error) {
	rows, err := s.DB.Query(ctx, fmt.Sprintf(
		`SELECT DISTINCT released_by::text FROM %s WHERE %s = $1 AND released_by IS NOT NULL`, table, fk), parent)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (h *Handler) bulkAgents() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		body, ok := tailBody(w, r)
		if !ok {
			return
		}
		rawAgents, present := body["agents"].([]any)
		if !present {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
				{Type: "missing", Loc: []string{"body", "agents"}, Msg: "Field required", Input: body},
			})
			return
		}
		items := make([]map[string]any, 0, len(rawAgents))
		for i, raw := range rawAgents {
			item, isMap := raw.(map[string]any)
			if !isMap {
				continue
			}
			if _, named := item["name"].(string); !named {
				httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
					{Type: "missing", Loc: []string{"body", "agents", fmt.Sprint(i), "name"}, Msg: "Field required", Input: item},
				})
				return
			}
			items = append(items, item)
		}
		dryRun, _ := body["dry_run"].(bool)
		out, err := h.Store.BulkCreateAgents(r.Context(), items, dryRun, viewer)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, out)
	})
}

func (h *Handler) analyzeMcp() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		body, ok := tailBody(w, r)
		if !ok {
			return
		}
		gitURL, _ := body["git_url"].(string)
		if _, present := body["git_url"]; !present {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
				{Type: "missing", Loc: []string{"body", "git_url"}, Msg: "Field required", Input: body},
			})
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, h.Store.AnalyzeRepo(r.Context(), gitURL, h.Mirror))
	})
}

// registerFinalRoutes mounts visibility, agent co-authors, bulk, and analyze.
func (h *Handler) registerFinalRoutes(mux *http.ServeMux, withAuth func(http.Handler) http.Handler) {
	mux.Handle("PATCH /api/v1/registry/{item_type}/{listing_id}/visibility", withAuth(h.updateVisibility()))
	mux.Handle("GET /api/v1/agents/{entity_id}/co-authors", withAuth(h.agentCoAuthors("list")))
	mux.Handle("POST /api/v1/agents/{entity_id}/co-authors", withAuth(h.agentCoAuthors("add")))
	mux.Handle("DELETE /api/v1/agents/{entity_id}/co-authors/{user_id}", withAuth(h.agentCoAuthors("remove")))
	mux.Handle("GET /api/v1/agents/{entity_id}/editors", withAuth(h.agentCoAuthors("editors")))
	mux.Handle("POST /api/v1/bulk/agents", withAuth(h.bulkAgents()))
	mux.Handle("POST /api/v1/mcps/analyze", withAuth(h.analyzeMcp()))
}
