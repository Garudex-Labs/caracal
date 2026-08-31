// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/inbox"
	"github.com/garudex-labs/caracal/internal/tenancy"
)

// ── Registry reconcile ──────────────────────────────────────────────────

// reconcileTypes maps request item types onto their storage.
var reconcileTypes = map[string]bool{"agent": true, "mcp": true, "skill": true, "hook": true, "prompt": true}

// ReconcileItems returns canonical metadata for installed registry ids,
// bounded to one query per type and filtered by row visibility.
func (s *Store) ReconcileItems(ctx context.Context, items []map[string]any, viewer *Viewer) ([]map[string]any, *validationError, error) {
	type key struct{ Type, ID string }
	requested := map[string][]string{}
	order := []key{}
	errs := []fieldError{}
	for i, item := range items {
		itemType, _ := item["type"].(string)
		rawID, _ := item["id"].(string)
		if !reconcileTypes[itemType] {
			errs = append(errs, fieldError{Type: "literal_error", Loc: []string{"body", "items", fmt.Sprint(i), "type"},
				Msg: "Input should be 'agent', 'mcp', 'skill', 'hook' or 'prompt'", Input: item["type"],
				Ctx: map[string]any{"expected": "'agent', 'mcp', 'skill', 'hook' or 'prompt'"}})
			continue
		}
		parsed, err := uuid.Parse(rawID)
		if err != nil {
			errs = append(errs, fieldError{Type: "uuid_parsing", Loc: []string{"body", "items", fmt.Sprint(i), "id"},
				Msg: "Input should be a valid UUID, " + uuidParseHint(rawID), Input: item["id"]})
			continue
		}
		requested[itemType] = append(requested[itemType], parsed.String())
		order = append(order, key{itemType, parsed.String()})
	}
	if len(errs) > 0 {
		return nil, &validationError{Errs: errs}, nil
	}

	privileged := viewer != nil && tenancy.IsGlobalReviewer(viewer.Role)
	found := map[key]map[string]any{}
	for itemType, ids := range requested {
		var sql string
		args := []any{ids}
		if itemType == "agent" {
			where := []string{"l.id = ANY($1::uuid[])"}
			if !privileged {
				args = append(args, viewer.ID)
				where = append(where, fmt.Sprintf("(v.status = 'approved' OR l.created_by = $%d)", len(args)))
			}
			where = append(where, agentVisibilitySQL(viewer, &args))
			sql = `SELECT l.id::text, l.name, l.namespace, l.slug, COALESCE(v.status::text, ''), v.version,
			              (l.deleted_at IS NOT NULL) AS deleted
			       FROM agents l LEFT JOIN agent_versions v ON l.latest_version_id = v.id
			       WHERE ` + strings.Join(where, " AND ")
		} else {
			var f Family
			for _, prefix := range reviewFamilies {
				if Families[prefix].Name == itemType {
					f = Families[prefix]
				}
			}
			where := []string{"l.id = ANY($1::uuid[])", visibilitySQL("l", viewer, &args)}
			sql = fmt.Sprintf(`SELECT l.id::text, l.name, l.namespace, l.slug, COALESCE(v.status::text, ''), v.version,
			              FALSE AS deleted
			       FROM %s l LEFT JOIN %s v ON l.latest_version_id = v.id
			       WHERE %s`, f.ListingTable, f.VersionTable, strings.Join(where, " AND "))
		}
		rows, err := s.DB.Query(ctx, sql, args...)
		if err != nil {
			return nil, nil, err
		}
		for rows.Next() {
			var id, name, namespace, slug, status string
			var latest *string
			var deleted bool
			if err := rows.Scan(&id, &name, &namespace, &slug, &status, &latest, &deleted); err != nil {
				rows.Close()
				return nil, nil, err
			}
			statusOut := any(nil)
			if deleted && itemType == "agent" {
				statusOut = "deleted"
			} else if status != "" {
				statusOut = status
			}
			found[key{itemType, id}] = map[string]any{
				"type": itemType, "id": id, "found": true, "name": name,
				"namespace": namespace, "slug": slug, "qualified_name": namespace + "/" + slug,
				"status": statusOut, "latest_version": latest,
			}
		}
		rows.Close()
	}

	out := make([]map[string]any, 0, len(order))
	for _, k := range order {
		if row, ok := found[k]; ok {
			out = append(out, row)
			continue
		}
		out = append(out, map[string]any{
			"type": k.Type, "id": k.ID, "found": false, "name": nil,
			"namespace": nil, "slug": nil, "qualified_name": nil, "status": nil, "latest_version": nil,
		})
	}
	return out, nil, nil
}

// agentVisibilitySQL matches the shared row-visibility rule on the agents
// table: public rows for everyone, private rows for admins, standing
// creators, and members of the owning project.
func agentVisibilitySQL(viewer *Viewer, args *[]any) string {
	return "(l.deleted_at IS NULL AND " + visibilitySQLCreator("l", "l.created_by", viewer, args) + ")"
}

// ── Ownership transfer ──────────────────────────────────────────────────

// transferEntities maps the route's plural segment onto storage.
var transferEntities = map[string]struct {
	listingTable, versionTable, singular string
	isAgent                              bool
}{
	"mcps":    {"mcp_listings", "mcp_versions", "mcp", false},
	"skills":  {"skill_listings", "skill_versions", "skill", false},
	"hooks":   {"hook_listings", "hook_versions", "hook", false},
	"prompts": {"prompt_listings", "prompt_versions", "prompt", false},
	"agents":  {"agents", "agent_versions", "agent", true},
}

// TransferOwnership moves a listing or agent to another user.
func (s *Store) TransferOwnership(ctx context.Context, entityType, entityID string, target map[string]any, viewer *Viewer) (map[string]any, error) {
	spec, known := transferEntities[entityType]
	if !known {
		return nil, &apiError{Status: 400, Detail: fmt.Sprintf("Invalid entity type: %s", entityType)}
	}
	ownerColumn := "submitted_by"
	if spec.isAgent {
		ownerColumn = "created_by"
	}
	rows, err := s.DB.Query(ctx, fmt.Sprintf(
		`SELECT l.id::text AS id, l.name, l.namespace, l.slug, l.owner, l.is_private,
		        l.%s::text AS owner_id, l.co_authors,
		        l.latest_version_id::text AS latest_version_id, v.version, v.status::text AS status
		 FROM %s l LEFT JOIN %s v ON l.latest_version_id = v.id
		 WHERE l.id::text = $1 OR (l.namespace || '/' || l.slug) = $1 OR l.name = $1
		 LIMIT 1`, ownerColumn, spec.listingTable, spec.versionTable), entityID)
	if err != nil {
		return nil, err
	}
	matches := collectRows(rows)
	rows.Close()
	if len(matches) == 0 {
		return nil, &apiError{Status: 404,
			Detail: fmt.Sprintf("%s%s not found", strings.ToUpper(spec.singular[:1]), spec.singular[1:])}
	}
	entity := matches[0]

	// Authority: only the current owner may transfer.
	if rowStr(entity, "owner_id", "") != viewer.ID.String() {
		return nil, &apiError{Status: 403, Detail: "Only the current owner can transfer ownership"}
	}

	targetUser, aerr, err := s.transferTarget(ctx, target)
	if err != nil {
		return nil, err
	}
	if aerr != nil {
		return nil, aerr
	}
	if rowStr(targetUser, "auth_provider", "") == "deactivated" {
		return nil, &apiError{Status: 422, Detail: "Cannot transfer ownership to a deactivated user"}
	}
	if rowStr(targetUser, "id", "") == viewer.ID.String() {
		return nil, &apiError{Status: 422, Detail: "You already own this item"}
	}

	targetUsername := rowStr(targetUser, "username", "")
	var exists bool
	if err := s.DB.QueryRow(ctx, fmt.Sprintf(
		`SELECT EXISTS (SELECT 1 FROM %s WHERE namespace = $1 AND slug = $2 AND id != $3)`, spec.listingTable),
		targetUsername, rowStr(entity, "slug", ""), rowStr(entity, "id", "")).Scan(&exists); err != nil {
		return nil, err
	}
	if exists {
		return nil, &apiError{Status: 409,
			Detail: fmt.Sprintf("%s/%s already exists", targetUsername, rowStr(entity, "slug", ""))}
	}

	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	newOwner := targetUsername
	if newOwner == "" {
		newOwner = rowStr(targetUser, "email", "")
	}
	blocked := map[string]bool{viewer.ID.String(): true, rowStr(targetUser, "id", ""): true}
	coAuthors := []string{}
	for _, raw := range rowList(entity, "co_authors") {
		if id, ok := raw.(string); ok && !blocked[id] {
			coAuthors = append(coAuthors, id)
		}
	}
	coBlob, err := json.Marshal(coAuthors)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, fmt.Sprintf(
		`UPDATE %s SET owner = $2, namespace = $3, %s = $4, co_authors = $5::json, updated_at = now() WHERE id = $1`,
		spec.listingTable, ownerColumn),
		rowStr(entity, "id", ""), newOwner, targetUsername, rowStr(targetUser, "id", ""), string(coBlob)); err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return map[string]any{
		"id":                rowStr(entity, "id", ""),
		"owner":             newOwner,
		"owner_id":          rowStr(targetUser, "id", ""),
		"previous_owner":    rowStr(entity, "owner", ""),
		"previous_owner_id": rowStr(entity, "owner_id", ""),
		"namespace":         targetUsername,
		"slug":              rowStr(entity, "slug", ""),
		"qualified_name":    targetUsername + "/" + rowStr(entity, "slug", ""),
	}, nil
}

func isGlobalReviewerRole(role string) bool {
	return tenancy.IsGlobalReviewer(role)
}

// transferTarget resolves the requested new owner by id, email, or username.
func (s *Store) transferTarget(ctx context.Context, target map[string]any) (map[string]any, *apiError, error) {
	var where string
	var arg any
	if raw, _ := target["user_id"].(string); raw != "" {
		parsed, err := uuid.Parse(raw)
		if err != nil {
			return nil, &apiError{Status: 422, Detail: "Invalid user ID"}, nil
		}
		where, arg = "id = $1", parsed.String()
	} else if raw, _ := target["email"].(string); raw != "" {
		where, arg = "email = $1", strings.ToLower(strings.TrimSpace(raw))
	} else if raw, _ := target["username"].(string); raw != "" {
		where, arg = "username = $1", strings.TrimPrefix(strings.TrimSpace(raw), "@")
	} else {
		return nil, &apiError{Status: 422, Detail: "Provide a user"}, nil
	}
	rows, err := s.DB.Query(ctx, fmt.Sprintf(
		`SELECT id::text AS id, COALESCE(username, '') AS username, email, COALESCE(auth_provider, '') AS auth_provider
		 FROM users WHERE %s`, where), arg)
	if err != nil {
		return nil, nil, err
	}
	matches := collectRows(rows)
	rows.Close()
	if len(matches) == 0 {
		return nil, &apiError{Status: 404, Detail: "User not found"}, nil
	}
	return matches[0], nil, nil
}

// ── Review issues ───────────────────────────────────────────────────────

// resolveIssueSubject finds the agent or listing an issue attaches to.
func (s *Store) resolveIssueSubject(ctx context.Context, subjectID string) (string, map[string]any, error) {
	parsed, err := uuid.Parse(strings.ToLower(strings.TrimSpace(subjectID)))
	if err == nil {
		agent, err := s.agentRow(ctx, parsed)
		if err != nil {
			return "", nil, err
		}
		if agent != nil {
			return "agent", agent, nil
		}
	}
	f, listing, ferr := s.findReviewListing(ctx, subjectID)
	if ferr != nil || listing == nil {
		return "", nil, ferr
	}
	return f.Name, listing, nil
}

// issueSubjectVisible mirrors the read-path visibility rule for issues.
func (s *Store) issueSubjectVisible(ctx context.Context, subjectType string, subject map[string]any, viewer *Viewer) (bool, error) {
	if subject == nil {
		return false, nil
	}
	if viewer.seesPrivateListings() {
		return true, nil
	}
	if !rowBool(subject, "is_private") {
		return true, nil
	}
	ownerKey := "submitted_by"
	if subjectType == "agent" {
		ownerKey = "created_by"
	}
	if rowStr(subject, ownerKey, "") == viewer.ID.String() {
		return true, nil
	}
	if projectID := rowNStr(subject, "project_id"); projectID != nil {
		var membership string
		err := s.DB.QueryRow(ctx,
			`SELECT user_id::text FROM project_memberships WHERE project_id = $1 AND user_id = $2`, *projectID, viewer.ID).Scan(&membership)
		if err == nil {
			return true, nil
		}
	}
	return false, nil
}

// issueActor renders one participant reference.
func (s *Store) issueActors(ctx context.Context, ids map[string]bool) (map[string]map[string]any, error) {
	out := map[string]map[string]any{}
	if len(ids) == 0 {
		return out, nil
	}
	list := make([]string, 0, len(ids))
	for id := range ids {
		list = append(list, id)
	}
	rows, err := s.DB.Query(ctx,
		`SELECT id::text, username, name FROM users WHERE id = ANY($1::uuid[])`, list)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var username, name *string
		if err := rows.Scan(&id, &username, &name); err != nil {
			return nil, err
		}
		out[id] = map[string]any{"id": id, "username": username, "name": name}
	}
	return out, rows.Err()
}

func issueActorRef(actors map[string]map[string]any, id *string) any {
	if id == nil || *id == "" {
		return nil
	}
	if actor, ok := actors[*id]; ok {
		return actor
	}
	return map[string]any{"id": *id, "username": nil, "name": nil}
}

// issueRow serializes one issue row with its comments.
func (s *Store) issueWire(ctx context.Context, issue map[string]any, comments []map[string]any, actors map[string]map[string]any) map[string]any {
	author := rowStr(issue, "author_id", "")
	resolvedBy := rowNStr(issue, "resolved_by")
	commentDocs := []any{}
	for _, comment := range comments {
		commentAuthor := rowStr(comment, "author_id", "")
		commentDocs = append(commentDocs, map[string]any{
			"id":         rowStr(comment, "id", ""),
			"author":     issueActorRef(actors, &commentAuthor),
			"body":       comment["body"],
			"created_at": wireTimePlus(comment["created_at"]),
		})
	}
	return map[string]any{
		"id":           rowStr(issue, "id", ""),
		"subject_type": rowStr(issue, "subject_type", ""),
		"subject_id":   rowStr(issue, "subject_id", ""),
		"version_id":   rowNStr(issue, "version_id"),
		"context":      issue["context"],
		"title":        rowStr(issue, "title", ""),
		"body":         issue["body"],
		"status":       rowStr(issue, "status", ""),
		"author":       issueActorRef(actors, &author),
		"resolved_by":  issueActorRef(actors, resolvedBy),
		"resolved_at":  wireTimePlus(issue["resolved_at"]),
		"created_at":   wireTimePlus(issue["created_at"]),
		"comments":     commentDocs,
	}
}

// issueComments loads an issue's comments oldest-first.
func (s *Store) issueComments(ctx context.Context, issueID string) ([]map[string]any, error) {
	rows, err := s.DB.Query(ctx,
		`SELECT id::text AS id, author_id::text AS author_id, body, created_at
		 FROM review_issue_comments WHERE issue_id = $1 ORDER BY created_at`, issueID)
	if err != nil {
		return nil, err
	}
	matches := collectRows(rows)
	rows.Close()
	return matches, nil
}

// ListIssues answers GET /review/{subject_id}/issues.
func (s *Store) ListIssues(ctx context.Context, subjectID string, versionID *uuid.UUID, status string, viewer *Viewer) (map[string]any, error) {
	subjectType, subject, err := s.resolveIssueSubject(ctx, subjectID)
	if err != nil {
		return nil, err
	}
	visible, err := s.issueSubjectVisible(ctx, subjectType, subject, viewer)
	if err != nil {
		return nil, err
	}
	if !visible {
		return nil, &apiError{Status: 404, Detail: "Subject not found"}
	}
	where := []string{"subject_type = $1", "subject_id = $2"}
	args := []any{subjectType, rowStr(subject, "id", "")}
	if versionID != nil {
		args = append(args, versionID.String())
		where = append(where, fmt.Sprintf("version_id = $%d", len(args)))
	}
	if status != "" {
		args = append(args, status)
		where = append(where, fmt.Sprintf("status = $%d", len(args)))
	}
	rows, err := s.DB.Query(ctx, fmt.Sprintf(
		`SELECT id::text AS id, subject_type, subject_id::text AS subject_id, version_id::text AS version_id,
		        context, title, body, status::text AS status, author_id::text AS author_id,
		        resolved_by::text AS resolved_by, resolved_at, created_at
		 FROM review_issues WHERE %s ORDER BY created_at DESC`, strings.Join(where, " AND ")), args...)
	if err != nil {
		return nil, err
	}
	issues := collectRows(rows)
	rows.Close()

	actorIDs := map[string]bool{}
	commentsByIssue := map[string][]map[string]any{}
	openCount := 0
	for _, issue := range issues {
		if rowStr(issue, "status", "") == "open" {
			openCount++
		}
		actorIDs[rowStr(issue, "author_id", "")] = true
		if resolved := rowNStr(issue, "resolved_by"); resolved != nil {
			actorIDs[*resolved] = true
		}
		comments, err := s.issueComments(ctx, rowStr(issue, "id", ""))
		if err != nil {
			return nil, err
		}
		commentsByIssue[rowStr(issue, "id", "")] = comments
		for _, comment := range comments {
			actorIDs[rowStr(comment, "author_id", "")] = true
		}
	}
	actors, err := s.issueActors(ctx, actorIDs)
	if err != nil {
		return nil, err
	}
	issueDocs := []any{}
	for _, issue := range issues {
		issueDocs = append(issueDocs, s.issueWire(ctx, issue, commentsByIssue[rowStr(issue, "id", "")], actors))
	}
	return map[string]any{
		"subject_type": subjectType,
		"subject_id":   rowStr(subject, "id", ""),
		"open_count":   openCount,
		"issues":       issueDocs,
	}, nil
}

// CreateIssue answers POST /review/{subject_id}/issues.
func (s *Store) CreateIssue(ctx context.Context, subjectID, title, body, context string, versionID *uuid.UUID, viewer *Viewer) (map[string]any, error) {
	subjectType, subject, err := s.resolveIssueSubject(ctx, subjectID)
	if err != nil {
		return nil, err
	}
	visible, err := s.issueSubjectVisible(ctx, subjectType, subject, viewer)
	if err != nil {
		return nil, err
	}
	if !visible {
		return nil, &apiError{Status: 404, Detail: "Subject not found"}
	}
	resolver := &tenancy.Resolver{DB: s.DB}
	scope, err := resolver.ReviewScopeFor(ctx, tenancy.User{ID: viewer.ID, Role: viewer.Role})
	if err != nil {
		return nil, err
	}
	ownerKey := "submitted_by"
	if subjectType == "agent" {
		ownerKey = "created_by"
	}
	isOwner := rowStr(subject, ownerKey, "") == viewer.ID.String()
	if !scope.CanReview(rowProjectID(subject, "project_id"), rowBool(subject, "is_private")) && !isOwner {
		return nil, &apiError{Status: 403, Detail: "Opening review issues requires review scope or ownership"}
	}

	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var versionArg any
	if versionID != nil {
		versionArg = versionID.String()
	}
	var contextArg any
	if context != "" {
		contextArg = context
	}
	var bodyArg any
	if body != "" {
		bodyArg = body
	}
	var issueID string
	if err := tx.QueryRow(ctx,
		`INSERT INTO review_issues (id, subject_type, subject_id, version_id, context, title, body, status, author_id, created_at, updated_at)
		 VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'open', $7, now(), now()) RETURNING id::text`,
		subjectType, rowStr(subject, "id", ""), versionArg, contextArg, strings.TrimSpace(title), bodyArg, viewer.ID).Scan(&issueID); err != nil {
		return nil, err
	}

	// The change's author hears about the issue when it targets the latest
	// version.
	var versionLabel *string
	if versionID != nil {
		if latest := rowNStr(subject, "latest_version_id"); latest != nil && *latest == versionID.String() {
			if v := rowStr(subject, "version", ""); v != "" {
				versionLabel = &v
			}
		}
	}
	submitter := s.subjectAuthor(ctx, subjectType, subject)
	inboxSubject := subjectFromRow(subject, subjectType)
	if versionLabel != nil {
		inboxSubject.Version = versionLabel
	}
	recipients := []uuid.UUID{}
	if submitter != nil {
		recipients = append(recipients, *submitter)
	}
	trimmedTitle := strings.TrimSpace(title)
	if _, err := inbox.Deliver(ctx, tx, "change_requested", recipients, inboxSubject, &viewer.ID,
		&trimmedTitle, map[string]any{"request_id": issueID}, true); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s.issueByID(ctx, issueID)
}

// subjectAuthor is the latest version's releaser, falling back to the
// listing's own submitter.
func (s *Store) subjectAuthor(ctx context.Context, subjectType string, subject map[string]any) *uuid.UUID {
	versionTable := "agent_versions"
	if subjectType != "agent" {
		for _, prefix := range reviewFamilies {
			if Families[prefix].Name == subjectType {
				versionTable = Families[prefix].VersionTable
			}
		}
	}
	if latest := rowNStr(subject, "latest_version_id"); latest != nil {
		var releasedBy *uuid.UUID
		if err := s.DB.QueryRow(ctx, fmt.Sprintf(
			`SELECT released_by FROM %s WHERE id = $1`, versionTable), *latest).Scan(&releasedBy); err == nil && releasedBy != nil {
			return releasedBy
		}
	}
	ownerKey := "submitted_by"
	if subjectType == "agent" {
		ownerKey = "created_by"
	}
	if raw := rowStr(subject, ownerKey, ""); raw != "" {
		if parsed, err := uuid.Parse(raw); err == nil {
			return &parsed
		}
	}
	return nil
}

// issueByID reloads one issue onto the wire.
func (s *Store) issueByID(ctx context.Context, issueID string) (map[string]any, error) {
	rows, err := s.DB.Query(ctx,
		`SELECT id::text AS id, subject_type, subject_id::text AS subject_id, version_id::text AS version_id,
		        context, title, body, status::text AS status, author_id::text AS author_id,
		        resolved_by::text AS resolved_by, resolved_at, created_at
		 FROM review_issues WHERE id = $1`, issueID)
	if err != nil {
		return nil, err
	}
	matches := collectRows(rows)
	rows.Close()
	if len(matches) == 0 {
		return nil, &apiError{Status: 404, Detail: "Issue not found"}
	}
	issue := matches[0]
	comments, err := s.issueComments(ctx, issueID)
	if err != nil {
		return nil, err
	}
	actorIDs := map[string]bool{rowStr(issue, "author_id", ""): true}
	if resolved := rowNStr(issue, "resolved_by"); resolved != nil {
		actorIDs[*resolved] = true
	}
	for _, comment := range comments {
		actorIDs[rowStr(comment, "author_id", "")] = true
	}
	actors, err := s.issueActors(ctx, actorIDs)
	if err != nil {
		return nil, err
	}
	return s.issueWire(ctx, issue, comments, actors), nil
}

// SetIssueStatus answers PATCH /review/issues/{issue_id}.
func (s *Store) SetIssueStatus(ctx context.Context, issueID uuid.UUID, status string, viewer *Viewer) (map[string]any, error) {
	issue, subjectType, subject, aerr, err := s.loadIssueWithSubject(ctx, issueID, viewer)
	if err != nil || aerr != nil {
		return nil, firstErr(aerr, err)
	}
	resolver := &tenancy.Resolver{DB: s.DB}
	scope, err := resolver.ReviewScopeFor(ctx, tenancy.User{ID: viewer.ID, Role: viewer.Role})
	if err != nil {
		return nil, err
	}
	ownerKey := "submitted_by"
	if subjectType == "agent" {
		ownerKey = "created_by"
	}
	allowed := rowStr(issue, "author_id", "") == viewer.ID.String() ||
		scope.CanReview(rowProjectID(subject, "project_id"), rowBool(subject, "is_private")) ||
		rowStr(subject, ownerKey, "") == viewer.ID.String()
	if !allowed {
		return nil, &apiError{Status: 403, Detail: "Not authorized to change this issue"}
	}
	if rowStr(issue, "status", "") != status {
		if status == "resolved" {
			if _, err := s.DB.Exec(ctx,
				`UPDATE review_issues SET status = 'resolved', resolved_by = $2, resolved_at = now(), updated_at = now() WHERE id = $1`,
				issueID.String(), viewer.ID); err != nil {
				return nil, err
			}
		} else {
			if _, err := s.DB.Exec(ctx,
				`UPDATE review_issues SET status = $2, resolved_by = NULL, resolved_at = NULL, updated_at = now() WHERE id = $1`,
				issueID.String(), status); err != nil {
				return nil, err
			}
		}
	}
	return s.issueByID(ctx, issueID.String())
}

// AddIssueComment answers POST /review/issues/{issue_id}/comments.
func (s *Store) AddIssueComment(ctx context.Context, issueID uuid.UUID, body string, viewer *Viewer) (map[string]any, error) {
	issue, subjectType, subject, aerr, err := s.loadIssueWithSubject(ctx, issueID, viewer)
	if err != nil || aerr != nil {
		return nil, firstErr(aerr, err)
	}
	comments, err := s.issueComments(ctx, issueID.String())
	if err != nil {
		return nil, err
	}

	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var commentID string
	if err := tx.QueryRow(ctx,
		`INSERT INTO review_issue_comments (id, issue_id, author_id, body, created_at)
		 VALUES (gen_random_uuid(), $1, $2, $3, now()) RETURNING id::text`,
		issueID.String(), viewer.ID, body).Scan(&commentID); err != nil {
		return nil, err
	}

	// Participants: issue author, every commenter, and the change's author.
	participantSet := map[string]bool{rowStr(issue, "author_id", ""): true}
	for _, comment := range comments {
		participantSet[rowStr(comment, "author_id", "")] = true
	}
	if author := s.subjectAuthor(ctx, subjectType, subject); author != nil {
		participantSet[author.String()] = true
	}
	recipients := []uuid.UUID{}
	for id := range participantSet {
		if parsed, err := uuid.Parse(id); err == nil {
			recipients = append(recipients, parsed)
		}
	}
	if _, err := inbox.Deliver(ctx, tx, "review_comment", recipients, subjectFromRow(subject, subjectType),
		&viewer.ID, &body, map[string]any{"comment_id": commentID}, true); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s.issueByID(ctx, issueID.String())
}

// loadIssueWithSubject fetches an issue plus its visible subject.
func (s *Store) loadIssueWithSubject(ctx context.Context, issueID uuid.UUID, viewer *Viewer) (map[string]any, string, map[string]any, *apiError, error) {
	rows, err := s.DB.Query(ctx,
		`SELECT id::text AS id, subject_type, subject_id::text AS subject_id, status::text AS status,
		        author_id::text AS author_id, resolved_by::text AS resolved_by
		 FROM review_issues WHERE id = $1`, issueID.String())
	if err != nil {
		return nil, "", nil, nil, err
	}
	matches := collectRows(rows)
	rows.Close()
	if len(matches) == 0 {
		return nil, "", nil, &apiError{Status: 404, Detail: "Issue not found"}, nil
	}
	issue := matches[0]
	subjectType, subject, err := s.resolveIssueSubject(ctx, rowStr(issue, "subject_id", ""))
	if err != nil {
		return nil, "", nil, nil, err
	}
	visible, err := s.issueSubjectVisible(ctx, subjectType, subject, viewer)
	if err != nil {
		return nil, "", nil, nil, err
	}
	if !visible {
		return nil, "", nil, &apiError{Status: 404, Detail: "Subject not found"}, nil
	}
	return issue, subjectType, subject, nil, nil
}

func firstErr(aerr *apiError, err error) error {
	if err != nil {
		return err
	}
	return aerr
}

// ── Handlers ────────────────────────────────────────────────────────────

func tailBody(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil || len(strings.TrimSpace(string(raw))) == 0 {
		httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
			{Type: "missing", Loc: []string{"body"}, Msg: "Field required", Input: nil},
		})
		return nil, false
	}
	body := map[string]any{}
	if err := json.Unmarshal(raw, &body); err != nil {
		httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
			{Type: "json_invalid", Loc: []string{"body", "0"}, Msg: "JSON decode error", Input: map[string]any{}},
		})
		return nil, false
	}
	return body, true
}

func (h *Handler) registryReconcile() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		body, ok := tailBody(w, r)
		if !ok {
			return
		}
		rawItems, _ := body["items"].([]any)
		items := make([]map[string]any, 0, len(rawItems))
		for _, raw := range rawItems {
			if item, isMap := raw.(map[string]any); isMap {
				items = append(items, item)
			}
		}
		out, invalid, err := h.Store.ReconcileItems(r.Context(), items, viewer)
		if invalid != nil {
			writeStoreError(w, r, invalid)
			return
		}
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, out)
	})
}

func (h *Handler) transferOwnership(entityType string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		body, ok := tailBody(w, r)
		if !ok {
			return
		}
		out, err := h.Store.TransferOwnership(r.Context(),
			entityType, r.PathValue("entity_id"), body, viewer)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, out)
	})
}

var issueStatuses = map[string]bool{"open": true, "resolved": true}

func (h *Handler) listIssues() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		var versionID *uuid.UUID
		if raw := r.URL.Query().Get("version_id"); raw != "" {
			parsed, err := uuid.Parse(raw)
			if err != nil {
				httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
					{Type: "uuid_parsing", Loc: []string{"query", "version_id"},
						Msg: "Input should be a valid UUID, " + uuidParseHint(raw), Input: raw},
				})
				return
			}
			versionID = &parsed
		}
		status := r.URL.Query().Get("status")
		if status != "" && !issueStatuses[status] {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
				{Type: "enum", Loc: []string{"query", "status"}, Msg: "Input should be 'open' or 'resolved'",
					Input: status, Ctx: map[string]any{"expected": "'open' or 'resolved'"}},
			})
			return
		}
		out, err := h.Store.ListIssues(r.Context(), r.PathValue("subject_id"), versionID, status, viewer)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, out)
	})
}

func (h *Handler) createIssue() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		body, ok := tailBody(w, r)
		if !ok {
			return
		}
		errs := []fieldError{}
		title, _ := body["title"].(string)
		if _, present := body["title"]; !present {
			errs = append(errs, fieldError{Type: "missing", Loc: []string{"body", "title"}, Msg: "Field required", Input: body})
		} else if title == "" {
			errs = append(errs, fieldError{Type: "string_too_short", Loc: []string{"body", "title"},
				Msg: "String should have at least 1 character", Input: title, Ctx: map[string]any{"min_length": 1}})
		} else if len(title) > 255 {
			errs = append(errs, fieldError{Type: "string_too_long", Loc: []string{"body", "title"},
				Msg: "String should have at most 255 characters", Input: title, Ctx: map[string]any{"max_length": 255}})
		}
		var versionID *uuid.UUID
		if raw, present := body["version_id"]; present && raw != nil {
			str, _ := raw.(string)
			parsed, err := uuid.Parse(str)
			if err != nil {
				errs = append(errs, fieldError{Type: "uuid_parsing", Loc: []string{"body", "version_id"},
					Msg: "Input should be a valid UUID, " + uuidParseHint(str), Input: raw})
			} else {
				versionID = &parsed
			}
		}
		issueContext, _ := body["context"].(string)
		if len(issueContext) > 255 {
			errs = append(errs, fieldError{Type: "string_too_long", Loc: []string{"body", "context"},
				Msg: "String should have at most 255 characters", Input: issueContext, Ctx: map[string]any{"max_length": 255}})
		}
		if len(errs) > 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, errs)
			return
		}
		issueBody, _ := body["body"].(string)
		out, err := h.Store.CreateIssue(r.Context(), r.PathValue("subject_id"), title, issueBody, issueContext, versionID, viewer)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusCreated, out)
	})
}

func (h *Handler) patchIssue() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		errs := []fieldError{}
		issueID := pathUUID(r, "issue_id", &errs)
		if len(errs) > 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, errs)
			return
		}
		body, ok := tailBody(w, r)
		if !ok {
			return
		}
		status, _ := body["status"].(string)
		if _, present := body["status"]; !present {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
				{Type: "missing", Loc: []string{"body", "status"}, Msg: "Field required", Input: body},
			})
			return
		}
		if !issueStatuses[status] {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
				{Type: "enum", Loc: []string{"body", "status"}, Msg: "Input should be 'open' or 'resolved'",
					Input: body["status"], Ctx: map[string]any{"expected": "'open' or 'resolved'"}},
			})
			return
		}
		out, err := h.Store.SetIssueStatus(r.Context(), issueID, status, viewer)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, out)
	})
}

func (h *Handler) addIssueComment() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		errs := []fieldError{}
		issueID := pathUUID(r, "issue_id", &errs)
		if len(errs) > 0 {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, errs)
			return
		}
		body, ok := tailBody(w, r)
		if !ok {
			return
		}
		commentBody, _ := body["body"].(string)
		if _, present := body["body"]; !present {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
				{Type: "missing", Loc: []string{"body", "body"}, Msg: "Field required", Input: body},
			})
			return
		}
		if commentBody == "" {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
				{Type: "string_too_short", Loc: []string{"body", "body"},
					Msg: "String should have at least 1 character", Input: commentBody, Ctx: map[string]any{"min_length": 1}},
			})
			return
		}
		out, err := h.Store.AddIssueComment(r.Context(), issueID, commentBody, viewer)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusCreated, out)
	})
}

// registerTailRoutes mounts reconcile, transfer, and issue routes.
func (h *Handler) registerTailRoutes(mux *http.ServeMux, withAuth func(http.Handler) http.Handler) {
	mux.Handle("POST /api/v1/registry/reconcile", withAuth(h.registryReconcile()))
	for entityType := range transferEntities {
		mux.Handle("POST /api/v1/"+entityType+"/{entity_id}/transfer-ownership", withAuth(h.transferOwnership(entityType)))
	}
	mux.Handle("GET /api/v1/review/{subject_id}/issues", withAuth(h.listIssues()))
	mux.Handle("POST /api/v1/review/{subject_id}/issues", withAuth(h.createIssue()))
	mux.Handle("PATCH /api/v1/review/issues/{issue_id}", withAuth(h.patchIssue()))
	mux.Handle("POST /api/v1/review/issues/{issue_id}/comments", withAuth(h.addIssueComment()))
}

var _ = pgx.ErrNoRows
var _ time.Time
