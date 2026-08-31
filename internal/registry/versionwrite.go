// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/garudex-labs/caracal/internal/harnessgen"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/inbox"
)

// publishSemverRE accepts X.Y.Z with an optional prerelease suffix.
var publishSemverRE = regexp.MustCompile(`^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$`)

// versionManagedFields are owned by the publish workflow, never snapshotted.
var versionManagedFields = map[string]bool{
	"id": true, "listing_id": true, "version": true, "description": true, "changelog": true,
	"status": true, "rejection_reason": true, "download_count": true, "released_by": true,
	"released_at": true, "reviewed_by": true, "reviewed_at": true, "created_at": true,
	"is_editing": true, "editing_since": true, "editing_by": true,
}

// parseSemverTuple compares X.Y.Z ignoring any prerelease suffix; unparseable
// versions sort lowest.
func parseSemverTuple(v string) [3]int {
	base, _, _ := strings.Cut(v, "-")
	parts := strings.Split(base, ".")
	out := [3]int{}
	for i := 0; i < len(parts) && i < 3; i++ {
		n, err := strconv.Atoi(parts[i])
		if err != nil {
			return [3]int{}
		}
		out[i] = n
	}
	return out
}

func semverGTE(a, b [3]int) bool {
	if a[0] != b[0] {
		return a[0] > b[0]
	}
	if a[1] != b[1] {
		return a[1] > b[1]
	}
	return a[2] >= b[2]
}

// Per-family extra-field vocabulary for version publishing.
var versionAllowedExtras = map[string]map[string]bool{
	"hooks": set("event", "execution_mode", "priority", "handler_type", "handler_config", "scope",
		"tool_filter", "source_url", "source_ref", "source_path", "resolved_sha",
		"script_content", "script_filename", "requirements", "file_pattern"),
	"skills": set("skill_path", "git_url", "git_ref", "skill_md_content", "target_agents",
		"task_type", "slash_command", "has_scripts"),
	"prompts": set("category", "template", "variables", "tags"),
	"mcps":    set("source_url", "source_ref", "resolved_sha", "transport", "framework", "docker_image", "command", "args", "url", "headers", "auto_approve", "environment_variables", "setup_instructions"),
}

var versionRequiredExtras = map[string][]string{
	"hooks":   {"event", "handler_type"},
	"skills":  {"task_type"},
	"prompts": {"category", "template"},
}

// versionExtraTypes are the expected JSON shapes per field.
var versionExtraTypes = map[string]string{
	"event": "str", "execution_mode": "str", "handler_type": "str", "scope": "str",
	"skill_path": "str", "git_url": "str", "git_ref": "str", "skill_md_content": "str",
	"task_type": "str", "slash_command": "str", "category": "str", "template": "str",
	"source_url": "str", "source_ref": "str", "resolved_sha": "str", "transport": "str",
	"framework": "str", "docker_image": "str", "command": "str", "url": "str",
	"setup_instructions": "str",
	"priority":           "integer",
	"has_scripts":        "bool", "has_templates": "bool", "is_power": "bool",
	"handler_config": "dict", "input_schema": "dict", "output_schema": "dict",
	"mcp_server_config": "dict",
	"tool_filter":       "list", "file_pattern": "list", "target_agents": "list", "triggers": "list",
	"activation_keywords": "list", "tags": "list", "variables": "list", "args": "list",
	"headers": "list", "auto_approve": "list", "environment_variables": "list",
}

func set(keys ...string) map[string]bool {
	out := make(map[string]bool, len(keys))
	for _, k := range keys {
		out[k] = true
	}
	return out
}

func goJSONTypeName(v any) string {
	switch v.(type) {
	case string:
		return "str"
	case bool:
		return "bool"
	case float64:
		return "float"
	case map[string]any:
		return "dict"
	case []any:
		return "list"
	}
	return "NoneType"
}

// matchesExtraType mirrors the publish-time type checks. JSON integers arrive
// as float64 and pass the integer check only when whole.
func matchesExtraType(expected string, v any) (bool, string) {
	got := goJSONTypeName(v)
	switch expected {
	case "str", "dict", "list", "bool":
		if got == expected {
			return true, got
		}
		// bool is rejected for int explicitly upstream; nothing more here.
		return false, got
	case "integer":
		if got == "bool" {
			return false, "bool"
		}
		if f, ok := v.(float64); ok {
			if f == float64(int64(f)) {
				return true, "int"
			}
			return false, "float"
		}
		return false, got
	}
	return true, got
}

// validateVersionExtras ports the per-type extra validation with its exact
// message contract. Returns the clean field map.
func validateVersionExtras(f Family, extra map[string]any) (map[string]any, *apiError) {
	componentType := f.Name
	allowed := versionAllowedExtras[f.Prefix]
	required := versionRequiredExtras[f.Prefix]

	if len(extra) == 0 {
		if len(required) > 0 {
			return nil, &apiError{Status: 422,
				Detail: fmt.Sprintf("Missing required fields for %s: %s", componentType, strings.Join(required, ", "))}
		}
		return map[string]any{}, nil
	}
	unknown := []string{}
	for k := range extra {
		if !allowed[k] {
			unknown = append(unknown, k)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		return nil, &apiError{Status: 422,
			Detail: fmt.Sprintf("Unknown fields for %s: %s", componentType, strings.Join(unknown, ", "))}
	}
	missing := []string{}
	for _, k := range required {
		if _, present := extra[k]; !present {
			missing = append(missing, k)
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		return nil, &apiError{Status: 422,
			Detail: fmt.Sprintf("Missing required fields for %s: %s", componentType, strings.Join(missing, ", "))}
	}
	for _, k := range required {
		if v := extra[k]; v == nil || v == "" {
			return nil, &apiError{Status: 422, Detail: fmt.Sprintf("Required field '%s' cannot be empty", k)}
		}
	}
	for k, v := range extra {
		if v == nil {
			continue
		}
		expected, tracked := versionExtraTypes[k]
		if !tracked {
			continue
		}
		if ok, got := matchesExtraType(expected, v); !ok {
			// The bool-for-integer rejection is worded differently upstream.
			if expected == "integer" && got == "bool" {
				return nil, &apiError{Status: 422,
					Detail: fmt.Sprintf("Field '%s' must be an integer, got %s", k, got)}
			}
			return nil, &apiError{Status: 422,
				Detail: fmt.Sprintf("Field '%s' must be a %s, got %s", k, expected, got)}
		}
	}
	clean := map[string]any{}
	for k, v := range extra {
		clean[k] = v
	}
	if f.Prefix == "mcps" {
		cmd, _ := clean["command"].(string)
		var argList []string
		if raw, ok := clean["args"].([]any); ok {
			for _, a := range raw {
				if s, ok := a.(string); ok {
					argList = append(argList, s)
				}
			}
		}
		if err := harnessgen.ValidateMcpCommand(cmd, argList); err != nil {
			return nil, &apiError{Status: 422, Detail: err.Error()}
		}
	}
	if f.Prefix == "skills" {
		slash := ""
		slashPresent := false
		if raw, present := clean["slash_command"]; present {
			slashPresent = true
			s, _ := raw.(string)
			normalized, aerr := normalizeSlashCommand(s)
			if aerr != nil {
				return nil, &apiError{Status: 422,
					Detail: "Invalid skill metadata: " + strings.TrimPrefix(aerr.Detail, "Invalid slash command: ")}
			}
			slash = normalized
			clean["slash_command"] = normalized
		}
		if content, present := clean["skill_md_content"]; present {
			s, _ := content.(string)
			request := ""
			if slashPresent {
				request = slash
			}
			normalized, aerr := analyzeSkillMD(s, request)
			if aerr != nil {
				return nil, &apiError{Status: 422,
					Detail: "Invalid skill metadata: " + strings.TrimPrefix(aerr.Detail, "Invalid slash command: ")}
			}
			if normalized != "" {
				clean["slash_command"] = normalized
			}
		}
	}
	return clean, nil
}

// snapshotVersionRow reads a version row's inheritable columns.
func (s *Store) snapshotVersionRow(ctx context.Context, f Family, versionID string) (map[string]any, error) {
	rows, err := s.DB.Query(ctx, fmt.Sprintf(`SELECT * FROM %s WHERE id = $1`, f.VersionTable), versionID)
	if err != nil {
		return nil, err
	}
	matches := collectRows(rows)
	rows.Close()
	if len(matches) == 0 {
		return map[string]any{}, nil
	}
	snapshot := map[string]any{}
	for col, value := range matches[0] {
		if !versionManagedFields[col] {
			snapshot[col] = value
		}
	}
	return snapshot, nil
}

// insertVersionRow writes a new pending version from a snapshot plus the
// workflow-managed values, notifying reviewers in the same transaction.
func (s *Store) insertVersionRow(ctx context.Context, f Family, listingRow map[string]any,
	snapshot map[string]any, version string, description any, changelog *string, viewer *Viewer) (string, error) {
	stmt := &insertStmt{}
	stmt.raw("id", "gen_random_uuid()")
	stmt.val("listing_id", rowStr(listingRow, "id", ""))
	stmt.val("version", version)
	stmt.val("description", description)
	stmt.val("changelog", changelog)
	stmt.val("status", "pending")
	stmt.val("download_count", 0)
	stmt.val("released_by", viewer.ID)
	stmt.raw("released_at", "now()")
	stmt.raw("created_at", "now()")
	stmt.raw("is_editing", "FALSE")
	cols := make([]string, 0, len(snapshot))
	for col := range snapshot {
		cols = append(cols, col)
	}
	sort.Strings(cols)
	for _, col := range cols {
		stmt.val(col, snapshot[col])
	}
	if stmt.err != nil {
		return "", stmt.err
	}

	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	var versionID string
	if err := tx.QueryRow(ctx, stmt.sql(f.VersionTable), stmt.vals...).Scan(&versionID); err != nil {
		return "", err
	}
	fanRow := map[string]any{}
	for k, v := range listingRow {
		fanRow[k] = v
	}
	fanRow["version"] = version
	if err := s.notifyReviewRequested(ctx, tx, fanRow, f.Name, viewer.ID); err != nil {
		return "", err
	}
	return versionID, tx.Commit(ctx)
}

// PublishVersion creates the next pending version of a listing.
func (s *Store) PublishVersion(ctx context.Context, f Family, identifier string, body map[string]any, viewer *Viewer) (json.RawMessage, error) {
	errs := []fieldError{}
	version, _ := body["version"].(string)
	if _, present := body["version"]; !present {
		errs = append(errs, fieldError{Type: "missing", Loc: []string{"body", "version"}, Msg: "Field required", Input: body})
	}
	description, _ := body["description"].(string)
	if _, present := body["description"]; !present {
		errs = append(errs, fieldError{Type: "missing", Loc: []string{"body", "description"}, Msg: "Field required", Input: body})
	}
	if len(errs) > 0 {
		return nil, &validationError{Errs: errs}
	}
	if !publishSemverRE.MatchString(version) {
		return nil, &apiError{Status: 422, Detail: fmt.Sprintf("Invalid semver string: '%s'", version)}
	}

	row, err := s.Resolve(ctx, f, identifier, viewer, false)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, &apiError{Status: 404, Detail: "Listing not found"}
	}
	if rowPermission(row, viewer) != "owner" {
		return nil, &apiError{Status: 403, Detail: "Only the listing owner can publish versions"}
	}
	listingID := rowStr(row, "id", "")
	var exists bool
	if err := s.DB.QueryRow(ctx, fmt.Sprintf(
		`SELECT EXISTS (SELECT 1 FROM %s WHERE listing_id = $1 AND version = $2)`, f.VersionTable),
		listingID, version).Scan(&exists); err != nil {
		return nil, err
	}
	if exists {
		return nil, &apiError{Status: 409, Detail: fmt.Sprintf("Version '%s' already exists for this listing", version)}
	}

	extra := map[string]any{}
	if raw, ok := body["extra"].(map[string]any); ok {
		for k, v := range raw {
			extra[k] = v
		}
	}
	// Required extras inherit from the listing's current values when omitted.
	for _, field := range versionRequiredExtras[f.Prefix] {
		if _, present := extra[field]; !present {
			if value, tracked := row[field]; tracked && value != nil {
				extra[field] = value
			}
		}
	}
	extraFields, aerr := validateVersionExtras(f, extra)
	if aerr != nil {
		return nil, aerr
	}

	snapshot := map[string]any{}
	if latest := rowNStr(row, "latest_version_id"); latest != nil {
		snapshot, err = s.snapshotVersionRow(ctx, f, *latest)
		if err != nil {
			return nil, err
		}
	}
	if _, requested := body["supported_harnesses"]; requested {
		harnesses, _ := body["supported_harnesses"].([]any)
		if harnesses == nil {
			harnesses = []any{}
		}
		snapshot["supported_harnesses"] = harnesses
	}
	for k, v := range extraFields {
		snapshot[k] = v
	}

	var changelog *string
	if v, ok := body["changelog"].(string); ok {
		changelog = &v
	}
	versionID, err := s.insertVersionRow(ctx, f, row, snapshot, version, description, changelog, viewer)
	if err != nil {
		return nil, err
	}
	return s.renderVersion(ctx, f, versionID, nil)
}

// renderVersion re-reads one version row onto the wire.
func (s *Store) renderVersion(ctx context.Context, f Family, versionID string, extraKeys map[string]any) (json.RawMessage, error) {
	rows, err := s.DB.Query(ctx, fmt.Sprintf(
		`SELECT *, id::text AS id, listing_id::text AS listing_id, released_by::text AS released_by
		 FROM %s WHERE id = $1`, f.VersionTable), versionID)
	if err != nil {
		return nil, err
	}
	matches := collectRows(rows)
	rows.Close()
	if len(matches) == 0 {
		return nil, fmt.Errorf("version readback: %s", versionID)
	}
	wire, err := versionWire(f, matches[0])
	if err != nil {
		return nil, err
	}
	if len(extraKeys) == 0 {
		return wire, nil
	}
	var doc map[string]any
	if err := json.Unmarshal(wire, &doc); err != nil {
		return nil, err
	}
	for k, v := range extraKeys {
		doc[k] = v
	}
	return json.Marshal(doc)
}

// ReviewVersion applies an approve or reject decision to a pending version.
func (s *Store) ReviewVersion(ctx context.Context, f Family, identifier, version, action string, reason *string, viewer *Viewer) (map[string]any, error) {
	row, err := s.Resolve(ctx, f, identifier, viewer, false)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, &apiError{Status: 404, Detail: "Listing not found"}
	}
	listingID := rowStr(row, "id", "")

	where := []string{"listing_id = $1", "version = $2"}
	args := []any{listingID, version}
	if !mayViewUnapproved(rowPermission(row, viewer), viewer) {
		where = append(where, "status = 'approved'")
	}
	var versionID, status string
	var releasedBy *uuid.UUID
	err = s.DB.QueryRow(ctx, fmt.Sprintf(
		`SELECT id::text, status::text, released_by FROM %s WHERE %s`, f.VersionTable, strings.Join(where, " AND ")),
		args...).Scan(&versionID, &status, &releasedBy)
	if err != nil {
		return nil, &apiError{Status: 404, Detail: "Version not found"}
	}
	if status != "pending" {
		return nil, &apiError{Status: 422,
			Detail: fmt.Sprintf("Version is '%s', only pending versions can be reviewed", status)}
	}

	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	newStatus := "rejected"
	var storedReason *string
	if action == "approve" {
		newStatus = "approved"
		if _, err := tx.Exec(ctx, fmt.Sprintf(
			`UPDATE %s SET status = 'approved', rejection_reason = NULL, reviewed_by = $2, reviewed_at = now()
			 WHERE id = $1`, f.VersionTable), versionID, viewer.ID); err != nil {
			return nil, err
		}
		// Latest only moves forward.
		bump := true
		if latest := rowNStr(row, "latest_version_id"); latest != nil {
			current := rowStr(row, "version", "")
			bump = semverGTE(parseSemverTuple(version), parseSemverTuple(current))
		}
		if bump {
			if _, err := tx.Exec(ctx, fmt.Sprintf(
				`UPDATE %s SET latest_version_id = $1, updated_at = now() WHERE id = $2`, f.ListingTable),
				versionID, listingID); err != nil {
				return nil, err
			}
		}
	} else {
		storedReason = reason
		if _, err := tx.Exec(ctx, fmt.Sprintf(
			`UPDATE %s SET status = 'rejected', rejection_reason = $2, reviewed_by = $3, reviewed_at = now()
			 WHERE id = $1`, f.VersionTable), versionID, reason, viewer.ID); err != nil {
			return nil, err
		}
	}

	if err := s.notifyReviewDecided(ctx, tx, row, f.Name, version, action == "approve", storedReason, releasedBy, viewer.ID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return map[string]any{"version": version, "new_status": newStatus, "reason": storedReason}, nil
}

// notifyReviewDecided tells the version's author the outcome and clears every
// reviewer's open request for it, inside the caller's transaction.
func (s *Store) notifyReviewDecided(ctx context.Context, tx pgx.Tx, row map[string]any, subjectType, version string, approved bool, reason *string, submitter *uuid.UUID, actor uuid.UUID) error {
	fanRow := map[string]any{}
	for k, v := range row {
		fanRow[k] = v
	}
	fanRow["version"] = version
	subject := subjectFromRow(fanRow, subjectType)

	kind := "review_rejected"
	outcome := "Review rejected"
	if approved {
		kind = "review_approved"
		outcome = "Review approved"
	}
	recipients := []uuid.UUID{}
	if submitter != nil {
		recipients = append(recipients, *submitter)
	}
	var context map[string]any
	if reason != nil && *reason != "" {
		context = map[string]any{"reason": *reason}
	}
	if _, err := inbox.Deliver(ctx, tx, kind, recipients, subject, &actor, reason, context, true); err != nil {
		return err
	}
	requestKey, err := inbox.DedupeKeyFor("review_requested", subject, nil)
	if err != nil {
		return err
	}
	_, err = inbox.ResolveMatching(ctx, tx, "review_requested", requestKey, outcome, &actor)
	return err
}

// RestoreVersion derives a new pending version from an approved one.
func (s *Store) RestoreVersion(ctx context.Context, f Family, identifier, version string, reason *string, viewer *Viewer) (json.RawMessage, error) {
	row, err := s.Resolve(ctx, f, identifier, viewer, false)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, &apiError{Status: 404, Detail: "Listing not found"}
	}
	if rowPermission(row, viewer) != "owner" {
		return nil, &apiError{Status: 403, Detail: "Only the listing owner can restore versions"}
	}
	listingID := rowStr(row, "id", "")

	var sourceID, sourceStatus string
	var sourceDescription *string
	err = s.DB.QueryRow(ctx, fmt.Sprintf(
		`SELECT id::text, status::text, description FROM %s WHERE listing_id = $1 AND version = $2`,
		f.VersionTable), listingID, version).Scan(&sourceID, &sourceStatus, &sourceDescription)
	if err != nil {
		return nil, &apiError{Status: 404, Detail: "Version not found"}
	}
	if sourceStatus != "approved" {
		return nil, &apiError{Status: 422, Detail: "Only approved versions can be restored"}
	}

	rows, err := s.DB.Query(ctx, fmt.Sprintf(
		`SELECT version FROM %s WHERE listing_id = $1`, f.VersionTable), listingID)
	if err != nil {
		return nil, err
	}
	highestTuple := [3]int{}
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			rows.Close()
			return nil, err
		}
		if t := parseSemverTuple(v); semverGTE(t, highestTuple) {
			highestTuple = t
		}
	}
	rows.Close()
	next := fmt.Sprintf("%d.%d.%d", highestTuple[0], highestTuple[1], highestTuple[2]+1)

	snapshot, err := s.snapshotVersionRow(ctx, f, sourceID)
	if err != nil {
		return nil, err
	}
	changelog := "Restored from v" + version
	if reason != nil && *reason != "" {
		changelog = changelog + ": " + *reason
	}
	versionID, err := s.insertVersionRow(ctx, f, row, snapshot, next, sourceDescription, &changelog, viewer)
	if err != nil {
		return nil, err
	}
	return s.renderVersion(ctx, f, versionID, map[string]any{"restored_from": version})
}

// inboxTx documents that delivery runs on the caller's transaction.

// versionWriteBody decodes a JSON object request body for version writes.
func versionWriteBody(w http.ResponseWriter, r *http.Request) map[string]any {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4<<20))
	if err != nil || len(strings.TrimSpace(string(raw))) == 0 {
		httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
			{Type: "missing", Loc: []string{"body"}, Msg: "Field required", Input: nil},
		})
		return nil
	}
	body := map[string]any{}
	if err := json.Unmarshal(raw, &body); err != nil {
		httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
			{Type: "json_invalid", Loc: []string{"body", "0"}, Msg: "JSON decode error", Input: map[string]any{}},
		})
		return nil
	}
	return body
}

func (h *Handler) publishVersion(f Family) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		body := versionWriteBody(w, r)
		if body == nil {
			return
		}
		out, err := h.Store.PublishVersion(r.Context(), f, r.PathValue("listing_id"), body, viewer)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write(out) //nolint:errcheck
	})
}

func (h *Handler) reviewVersion(f Family) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		body := versionWriteBody(w, r)
		if body == nil {
			return
		}
		action, _ := body["action"].(string)
		if _, present := body["action"]; !present {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
				{Type: "missing", Loc: []string{"body", "action"}, Msg: "Field required", Input: body},
			})
			return
		}
		if action != "approve" && action != "reject" {
			httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []fieldError{
				{Type: "literal_error", Loc: []string{"body", "action"}, Msg: "Input should be 'approve' or 'reject'",
					Input: body["action"], Ctx: map[string]any{"expected": "'approve' or 'reject'"}},
			})
			return
		}
		var reason *string
		if v, ok := body["reason"].(string); ok {
			reason = &v
		}
		out, err := h.Store.ReviewVersion(r.Context(), f, r.PathValue("listing_id"), r.PathValue("version"), action, reason, viewer)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, out)
	})
}

func (h *Handler) restoreVersion(f Family) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		viewer := requireUser(w, r)
		if viewer == nil {
			return
		}
		body := versionWriteBody(w, r)
		if body == nil {
			return
		}
		var reason *string
		if v, ok := body["reason"].(string); ok {
			reason = &v
		}
		out, err := h.Store.RestoreVersion(r.Context(), f, r.PathValue("listing_id"), r.PathValue("version"), reason, viewer)
		if err != nil {
			writeStoreError(w, r, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		w.Write(out) //nolint:errcheck
	})
}
