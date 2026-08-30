// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/garudex-labs/caracal/internal/harnessgen"
	"github.com/garudex-labs/caracal/internal/inbox"
	"github.com/garudex-labs/caracal/internal/registry"
)

// versionComponentRef is one component reference in a release request.
type versionComponentRef struct {
	ComponentType  string         `json:"component_type"`
	ComponentID    string         `json:"component_id"`
	ConfigOverride map[string]any `json:"config_override"`
}

// VersionCreateRequest carries the validated inputs of a version release.
type VersionCreateRequest struct {
	Version         string
	Description     string
	Prompt          string
	ModelName       string
	ModelConfigJSON map[string]any
	ModelsByHarness map[string]any
	ExternalMcps    []externalMcp
	Supported       []string
	Components      []versionComponentRef
	IsPrerelease    bool
	SaveAsDraft     bool
	SuccessCriteria map[string]any
}

// validateComponentsApproved checks component references in composition order,
// requiring each listing to exist within the audience scope and be approved.
func (s *Store) validateComponentsApproved(ctx context.Context, refs []versionComponentRef,
	viewer *registry.Viewer, targetProjectID string) ([]resolutionError, error) {
	byType := map[string][]string{}
	for _, ref := range refs {
		if _, known := registry.Families[ref.ComponentType+"s"]; known {
			byType[ref.ComponentType] = append(byType[ref.ComponentType], ref.ComponentID)
		}
	}
	type listingState struct {
		name   string
		status string
	}
	found := map[string]listingState{}
	for typeName, ids := range byType {
		f := registry.Families[typeName+"s"]
		args := []any{}
		visibility := registry.ScopeSQL("l", "l.submitted_by", viewer, &args)
		scope := "l.is_private = FALSE"
		if targetProjectID != "" {
			args = append(args, targetProjectID)
			scope = fmt.Sprintf("(l.is_private = FALSE OR (l.is_private = TRUE AND l.project_id = $%d))", len(args))
		}
		args = append(args, ids)
		rows, err := s.DB.Query(ctx, fmt.Sprintf(
			`SELECT l.id::text, l.name, COALESCE(v.status, 'draft')
			 FROM %s l LEFT JOIN %s v ON l.latest_version_id = v.id
			 WHERE %s AND %s AND l.id = ANY($%d)`,
			f.ListingTable, f.VersionTable, visibility, scope, len(args)), args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id, name, status string
			if err := rows.Scan(&id, &name, &status); err != nil {
				rows.Close()
				return nil, err
			}
			found[typeName+"/"+id] = listingState{name, status}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	errs := []resolutionError{}
	for _, ref := range refs {
		if _, known := registry.Families[ref.ComponentType+"s"]; !known {
			errs = append(errs, resolutionError{
				ComponentType: ref.ComponentType, ComponentID: ref.ComponentID,
				Reason: fmt.Sprintf("Unknown component type: %s", ref.ComponentType),
			})
			continue
		}
		state, ok := found[ref.ComponentType+"/"+ref.ComponentID]
		if !ok {
			errs = append(errs, resolutionError{
				ComponentType: ref.ComponentType, ComponentID: ref.ComponentID,
				Reason: fmt.Sprintf("%s listing %s not found", ref.ComponentType, ref.ComponentID),
			})
			continue
		}
		if state.status != "approved" {
			errs = append(errs, resolutionError{
				ComponentType: ref.ComponentType, ComponentID: ref.ComponentID,
				Reason: fmt.Sprintf("%s '%s' is not approved (status: %s)", ref.ComponentType, state.name, state.status),
			})
		}
	}
	return errs, nil
}

// reviewerRecipients answers who should hear that this agent needs review.
// Project-shared work notifies that project's leads; public work notifies
// global reviewers plus the owning project's leads.
func reviewerRecipients(ctx context.Context, tx pgx.Tx, agentRow map[string]any) ([]uuid.UUID, error) {
	collect := func(sql string, args ...any) ([]uuid.UUID, error) {
		rows, err := tx.Query(ctx, sql, args...)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		out := []uuid.UUID{}
		for rows.Next() {
			var id uuid.UUID
			if err := rows.Scan(&id); err != nil {
				return nil, err
			}
			out = append(out, id)
		}
		return out, rows.Err()
	}
	projectID := rowNStr(agentRow, "project_id")
	if rowBool(agentRow, "is_private") {
		if projectID == nil {
			return collect(`SELECT id FROM users WHERE role = 'operator'`)
		}
		return collect(`SELECT user_id FROM project_memberships
			WHERE project_id = $1 AND role = 'lead'`, *projectID)
	}
	global, err := collect(`SELECT id FROM users WHERE role IN ('reviewer', 'operator')`)
	if err != nil {
		return nil, err
	}
	if projectID == nil {
		return global, nil
	}
	leads, err := collect(`SELECT user_id FROM project_memberships
		WHERE project_id = $1 AND role = 'lead'`, *projectID)
	if err != nil {
		return nil, err
	}
	seen := map[uuid.UUID]bool{}
	out := []uuid.UUID{}
	for _, id := range append(global, leads...) {
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out, nil
}

// agentSubject builds the inbox subject for one agent row and version.
func agentSubject(agentRow map[string]any, version string) inbox.Subject {
	subject := inbox.Subject{
		Type:      "agent",
		Name:      rowStr(agentRow, "name", ""),
		Namespace: rowNStr(agentRow, "namespace"),
		Slug:      rowNStr(agentRow, "slug"),
		IsPrivate: rowBool(agentRow, "is_private"),
	}
	if id, err := uuid.Parse(rowStr(agentRow, "id", "")); err == nil {
		subject.ID = &id
	}
	if projectID := rowNStr(agentRow, "project_id"); projectID != nil {
		if id, err := uuid.Parse(*projectID); err == nil {
			subject.ProjectID = &id
		}
	}
	if version != "" {
		subject.Version = &version
	}
	return subject
}

// mcpListingsByID loads MCP listings with their current release delegates,
// keyed by id. Validation already vetted the references, so no scope applies.
func mcpListingsByID(ctx context.Context, tx pgx.Tx, ids []string) (map[string]harnessgen.Listing, error) {
	out := map[string]harnessgen.Listing{}
	if len(ids) == 0 {
		return out, nil
	}
	f := registry.Families["mcps"]
	rows, err := tx.Query(ctx, fmt.Sprintf(
		`SELECT %s FROM %s l LEFT JOIN %s v ON l.latest_version_id = v.id WHERE l.id = ANY($1)`,
		familyInstallColumns("mcp"), f.ListingTable, f.VersionTable), ids)
	if err != nil {
		return nil, err
	}
	collected := registry.CollectRows(rows)
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, row := range collected {
		out[rowStr(row, "id", "")] = harnessgen.Listing(row)
	}
	return out, nil
}

// CreateVersion releases a new version of an existing agent: the version row,
// its component links, capability inference, the canonical snapshot, harness
// configs generated at release time, and the review notice when one is owed.
func (s *Store) CreateVersion(ctx context.Context, agentRow map[string]any, viewer *registry.Viewer,
	req *VersionCreateRequest) (map[string]any, error) {
	pool, ok := s.DB.(TxQuerier)
	if !ok {
		return nil, fmt.Errorf("store connection cannot begin transactions")
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	txStore := &Store{DB: tx}
	agentID := rowStr(agentRow, "id", "")

	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM agent_versions WHERE agent_id = $1 AND version = $2)`,
		agentID, req.Version).Scan(&exists); err != nil {
		return nil, err
	}
	if exists {
		return nil, &errInstall{409, fmt.Sprintf("Version '%s' already exists for this agent", req.Version)}
	}

	targetProjectID := ""
	if rowBool(agentRow, "is_private") {
		if projectID := rowNStr(agentRow, "project_id"); projectID != nil {
			targetProjectID = *projectID
		}
	}
	if len(req.Components) > 0 {
		validationErrors, err := txStore.validateComponentsApproved(ctx, req.Components, viewer, targetProjectID)
		if err != nil {
			return nil, err
		}
		if len(validationErrors) > 0 {
			blob, _ := json.Marshal(validationErrors)
			return nil, &errInstall{400, string(blob)}
		}
	}

	var pendingCount int64
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM agent_versions WHERE agent_id = $1 AND status = 'pending'`,
		agentID).Scan(&pendingCount); err != nil {
		return nil, err
	}

	status := "pending"
	if req.SaveAsDraft {
		status = "draft"
	}
	released := time.Now().UTC()
	externals := make([]map[string]any, 0, len(req.ExternalMcps))
	for _, ext := range req.ExternalMcps {
		args := ext.Args
		if args == nil {
			args = []string{}
		}
		env := ext.Env
		if env == nil {
			env = map[string]string{}
		}
		externals = append(externals, map[string]any{
			"name": ext.Name, "command": ext.Command, "args": args, "env": env, "url": ext.URL,
		})
	}
	externalsJSON, _ := json.Marshal(externals)
	modelConfigJSON, _ := json.Marshal(orDict(req.ModelConfigJSON))
	modelsByHarnessJSON, _ := json.Marshal(orDict(req.ModelsByHarness))
	supported := req.Supported
	if supported == nil {
		supported = []string{}
	}
	supportedJSON, _ := json.Marshal(supported)
	var successJSON *string
	if req.SuccessCriteria != nil {
		blob, _ := json.Marshal(req.SuccessCriteria)
		s := string(blob)
		successJSON = &s
	}
	versionID := uuid.NewString()
	var createdAt time.Time
	err = tx.QueryRow(ctx, `INSERT INTO agent_versions (id, agent_id, version, description, prompt,
		model_name, model_config_json, models_by_harness, external_mcps, supported_harnesses,
		required_capabilities, inferred_supported_harnesses, status, is_prerelease,
		rejection_reason, download_count, released_by, released_at, reviewed_by, reviewed_at,
		created_at, is_editing, success_criteria)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '[]', '[]', $11, $12,
		NULL, 0, $13, $14, NULL, NULL, now(), false, $15)
		RETURNING created_at`,
		versionID, agentID, req.Version, req.Description, req.Prompt,
		req.ModelName, string(modelConfigJSON), string(modelsByHarnessJSON),
		string(externalsJSON), string(supportedJSON), status, req.IsPrerelease,
		viewer.ID, released, successJSON).Scan(&createdAt)
	if err != nil {
		return nil, err
	}

	// Component links carry the listing's current release, "latest" fallback.
	refs := make([]componentRef, 0, len(req.Components))
	for _, ref := range req.Components {
		refs = append(refs, componentRef{ComponentType: ref.ComponentType, ComponentID: ref.ComponentID})
	}
	versionByRef, skillSlash, err := txStore.resolveCurrentVersions(ctx, refs)
	if err != nil {
		return nil, err
	}
	for order, ref := range req.Components {
		resolved, ok := versionByRef[ref.ComponentType+"/"+ref.ComponentID]
		if !ok {
			resolved = "latest"
		}
		var overrideJSON *string
		if len(ref.ConfigOverride) > 0 {
			blob, _ := json.Marshal(ref.ConfigOverride)
			s := string(blob)
			overrideJSON = &s
		}
		if _, err := tx.Exec(ctx, `INSERT INTO agent_components (id, agent_version_id, component_type,
			component_id, component_name, resolved_version, order_index, config_override, created_at)
			VALUES (gen_random_uuid(), $1, $2, $3, '', $4, $5, $6, now())`,
			versionID, ref.ComponentType, ref.ComponentID, resolved, order, overrideJSON); err != nil {
			return nil, err
		}
	}

	required := inferRequiredFeatures(refs, len(req.ExternalMcps) > 0, skillSlash)
	requiredJSON, _ := json.Marshal(required)
	inferredJSON, _ := json.Marshal(computeSupportedHarnesses(required))
	if _, err := tx.Exec(ctx, `UPDATE agent_versions SET required_capabilities = $1,
		inferred_supported_harnesses = $2 WHERE id = $3`,
		string(requiredJSON), string(inferredJSON), versionID); err != nil {
		return nil, err
	}

	// The snapshot is always built from the structured fields, so caller
	// text cannot drift from what the database stores.
	links, err := txStore.Components(ctx, versionID)
	if err != nil {
		return nil, err
	}
	snapshotRow := map[string]any{
		"version": req.Version, "description": req.Description, "prompt": req.Prompt,
		"model_name": req.ModelName, "models_by_harness": orDict(req.ModelsByHarness),
		"supported_harnesses": toAnyList(supported), "external_mcps": rawToList(externalsJSON),
		"model_config_json": orDict(req.ModelConfigJSON), "success_criteria": req.SuccessCriteria,
	}
	snapshot := renderYAMLSnapshot(snapshotRow, snapshotEntries(links))
	if _, err := tx.Exec(ctx, `UPDATE agent_versions SET yaml_snapshot = $1 WHERE id = $2`,
		snapshot, versionID); err != nil {
		return nil, err
	}

	// Pre-generate harness configs at release time; requests never generate.
	// supported_harnesses is the caller's authoritative list, while the
	// inferred set stays a display and filtering aid.
	mcpIDs := []string{}
	genComponents := make([]harnessgen.ComponentLink, 0, len(req.Components))
	for order, ref := range req.Components {
		if ref.ComponentType == "mcp" {
			mcpIDs = append(mcpIDs, ref.ComponentID)
		}
		genComponents = append(genComponents, harnessgen.ComponentLink{
			Type: ref.ComponentType, ID: ref.ComponentID,
			OrderIndex: int64(order), ConfigOverride: ref.ConfigOverride,
		})
	}
	mcpListings, err := mcpListingsByID(ctx, tx, mcpIDs)
	if err != nil {
		return nil, err
	}
	requiredAny := make([]any, 0, len(required))
	for _, f := range required {
		requiredAny = append(requiredAny, f)
	}
	genAgent := &harnessgen.Agent{
		ID:                   agentID,
		Name:                 rowStr(agentRow, "name", ""),
		Slug:                 rowStr(agentRow, "slug", ""),
		Description:          req.Description,
		Prompt:               req.Prompt,
		ModelName:            req.ModelName,
		ModelsByHarness:      orDict(req.ModelsByHarness),
		ExternalMcps:         rawToList(externalsJSON),
		RequiredCapabilities: requiredAny,
		Components:           genComponents,
	}
	harnessConfigs := harnessgen.NewConfig()
	failedHarnesses := []string{}
	for _, harnessName := range supported {
		resolvedModel, modelWarnings := harnessgen.ResolveModel(
			harnessName, req.ModelName, orDict(req.ModelsByHarness), "")
		cfg, err := harnessgen.Generate(&harnessgen.Request{
			Agent:         genAgent,
			Harness:       harnessName,
			CaracalURL:    "http://localhost:8080",
			McpListings:   mcpListings,
			ResolvedModel: resolvedModel,
			ModelWarnings: modelWarnings,
		})
		if err != nil {
			failedHarnesses = append(failedHarnesses, harnessName)
			continue
		}
		harnessConfigs.Set(harnessName, cfg)
	}
	storedConfigs, err := harnessConfigs.StoredJSON()
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_versions SET harness_configs = $1::json WHERE id = $2`,
		storedConfigs, versionID); err != nil {
		return nil, err
	}

	// A draft is not in anyone's queue; only a pending release is.
	if status == "pending" {
		recipients, err := reviewerRecipients(ctx, tx, agentRow)
		if err != nil {
			return nil, err
		}
		actorID := viewer.ID
		if _, err := inbox.Deliver(ctx, tx, "review_requested", recipients,
			agentSubject(agentRow, req.Version), &actorID, nil, nil, true); err != nil {
			return nil, err
		}
	}

	// latest_version_id deliberately stays put: approval moves it.
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	warnings := []string{}
	if pendingCount > 0 {
		warnings = append(warnings, fmt.Sprintf("This agent already has %d pending version(s)", pendingCount))
	}
	if len(failedHarnesses) > 0 {
		warnings = append(warnings, fmt.Sprintf(
			"harness config generation failed for: %s. These will 404 until regenerated.",
			strings.Join(failedHarnesses, ", ")))
	}
	result := map[string]any{
		"id":                  versionID,
		"agent_id":            agentID,
		"version":             req.Version,
		"status":              status,
		"description":         req.Description,
		"model_name":          req.ModelName,
		"supported_harnesses": supported,
		"released_by":         viewer.ID.String(),
		"released_at":         wireTimeISO(released),
		"created_at":          wireTimeISO(createdAt),
	}
	if len(warnings) > 0 {
		result["warnings"] = warnings
	}
	return result, nil
}

// ReviewVersion approves or rejects one pending version and tells its
// releaser, clearing every reviewer's open request for it.
func (s *Store) ReviewVersion(ctx context.Context, agentRow map[string]any, viewer *registry.Viewer,
	version, action string, reason *string) (map[string]any, error) {
	pool, ok := s.DB.(TxQuerier)
	if !ok {
		return nil, fmt.Errorf("store connection cannot begin transactions")
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	agentID := rowStr(agentRow, "id", "")

	var versionID, status string
	var releasedBy *uuid.UUID
	err = tx.QueryRow(ctx, `SELECT id::text, status, released_by FROM agent_versions
		WHERE agent_id = $1 AND version = $2`, agentID, version).Scan(&versionID, &status, &releasedBy)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, &errInstall{404, "Version not found"}
	}
	if err != nil {
		return nil, err
	}
	if status != "pending" {
		return nil, &errInstall{422, fmt.Sprintf("Version is '%s', only pending versions can be reviewed", status)}
	}

	approved := action == "approve"
	var newStatus string
	var storedReason *string
	if approved {
		newStatus = "approved"
		if _, err := tx.Exec(ctx, `UPDATE agent_versions SET status = 'approved', rejection_reason = NULL,
			reviewed_by = $1, reviewed_at = now() WHERE id = $2`, viewer.ID, versionID); err != nil {
			return nil, err
		}
		// The newest approved semver becomes the agent's latest.
		var currentVersion *string
		if latestID := rowNStr(agentRow, "latest_version_id"); latestID != nil {
			if err := tx.QueryRow(ctx, `SELECT version FROM agent_versions WHERE id = $1`,
				*latestID).Scan(&currentVersion); err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return nil, err
			}
		}
		promote := currentVersion == nil
		if !promote {
			if nMa, nMi, nPa, ok := parseSemver(version); ok {
				if cMa, cMi, cPa, ok := parseSemver(*currentVersion); ok {
					promote = !semverLess([3]int{nMa, nMi, nPa}, [3]int{cMa, cMi, cPa})
				}
			}
		}
		if promote {
			if _, err := tx.Exec(ctx, `UPDATE agents SET latest_version_id = $1 WHERE id = $2`,
				versionID, agentID); err != nil {
				return nil, err
			}
		}
	} else {
		newStatus = "rejected"
		storedReason = reason
		if _, err := tx.Exec(ctx, `UPDATE agent_versions SET status = 'rejected', rejection_reason = $1,
			reviewed_by = $2, reviewed_at = now() WHERE id = $3`, reason, viewer.ID, versionID); err != nil {
			return nil, err
		}
	}

	// The version's author hears the outcome, and every reviewer's open
	// request item for this version is cleared, all before the commit.
	subject := agentSubject(agentRow, version)
	kind := "review_rejected"
	var body *string
	var context map[string]any
	if approved {
		kind = "review_approved"
	} else if reason != nil && *reason != "" {
		body = reason
		context = map[string]any{"reason": *reason}
	}
	actorID := viewer.ID
	recipients := []uuid.UUID{}
	if releasedBy != nil {
		recipients = append(recipients, *releasedBy)
	}
	if _, err := inbox.Deliver(ctx, tx, kind, recipients, subject, &actorID, body, context, true); err != nil {
		return nil, err
	}
	requestKey, err := inbox.DedupeKeyFor("review_requested", subject, nil)
	if err != nil {
		return nil, err
	}
	detail := "Review rejected"
	if approved {
		detail = "Review approved"
	}
	if _, err := inbox.ResolveMatching(ctx, tx, "review_requested", requestKey, detail, &actorID); err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return map[string]any{"version": version, "new_status": newStatus, "reason": storedReason}, nil
}

// RestoreVersion rolls back by derivation: a new pending version copied from
// an approved one, going through the same release path as any other version.
func (s *Store) RestoreVersion(ctx context.Context, agentRow map[string]any, viewer *registry.Viewer,
	version string, reason *string) (map[string]any, error) {
	agentID := rowStr(agentRow, "id", "")
	rows, err := s.DB.Query(ctx, `SELECT id::text AS id, version, description, prompt, model_name,
		model_config_json, models_by_harness, external_mcps, supported_harnesses, status,
		success_criteria FROM agent_versions WHERE agent_id = $1 AND version = $2`, agentID, version)
	if err != nil {
		return nil, err
	}
	collected := registry.CollectRows(rows)
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(collected) == 0 {
		return nil, &errInstall{404, "Version not found"}
	}
	source := collected[0]
	if rowStr(source, "status", "") != "approved" {
		return nil, &errInstall{422, "Only approved versions can be restored"}
	}

	// The next patch above the highest existing version, pending included,
	// so the restore can never collide with in-flight work.
	verRows, err := s.DB.Query(ctx, `SELECT version FROM agent_versions WHERE agent_id = $1`, agentID)
	if err != nil {
		return nil, err
	}
	highest := [3]int{}
	parsedAny := false
	for verRows.Next() {
		var v string
		if err := verRows.Scan(&v); err != nil {
			verRows.Close()
			return nil, err
		}
		if ma, mi, pa, ok := parseSemver(v); ok {
			parsed := [3]int{ma, mi, pa}
			if !parsedAny || semverLess(highest, parsed) {
				highest = parsed
				parsedAny = true
			}
		}
	}
	verRows.Close()
	if err := verRows.Err(); err != nil {
		return nil, err
	}
	nextVersion := fmt.Sprintf("%d.%d.%d", highest[0], highest[1], highest[2]+1)

	description := "Restored from v" + rowStr(source, "version", "")
	if reason != nil && *reason != "" {
		description += ": " + *reason
	} else if sourceDesc := rowStr(source, "description", ""); sourceDesc != "" {
		description += " - " + sourceDesc
	}

	sourceLinks, err := s.Components(ctx, rowStr(source, "id", ""))
	if err != nil {
		return nil, err
	}
	components := make([]versionComponentRef, 0, len(sourceLinks))
	for _, link := range sourceLinks {
		ref := versionComponentRef{
			ComponentType: rowStr(link, "component_type", ""),
			ComponentID:   rowStr(link, "component_id", ""),
		}
		if override, ok := link["config_override"].(map[string]any); ok {
			ref.ConfigOverride = override
		}
		components = append(components, ref)
	}
	externals := []externalMcp{}
	if blob, err := json.Marshal(rowList(source, "external_mcps")); err == nil {
		_ = json.Unmarshal(blob, &externals)
	}
	supported := make([]string, 0)
	for _, v := range rowList(source, "supported_harnesses") {
		if s, ok := v.(string); ok {
			supported = append(supported, s)
		}
	}
	var successCriteria map[string]any
	if m, ok := source["success_criteria"].(map[string]any); ok {
		successCriteria = m
	}
	req := &VersionCreateRequest{
		Version:         nextVersion,
		Description:     description,
		Prompt:          rowStr(source, "prompt", ""),
		ModelName:       rowStr(source, "model_name", ""),
		ModelConfigJSON: orDict(rowMapOf(source, "model_config_json")),
		ModelsByHarness: orDict(rowMapOf(source, "models_by_harness")),
		ExternalMcps:    externals,
		Supported:       supported,
		Components:      components,
		SuccessCriteria: successCriteria,
	}
	result, err := s.CreateVersion(ctx, agentRow, viewer, req)
	if err != nil {
		return nil, err
	}

	// Record the lineage on the freshly created version.
	if _, err := s.Exec(ctx, `UPDATE agent_versions SET promoted_from = $1 WHERE agent_id = $2 AND version = $3`,
		source["id"], agentID, nextVersion); err != nil {
		return nil, err
	}
	result["restored_from"] = rowStr(source, "version", "")
	return result, nil
}

func rowMapOf(row map[string]any, key string) map[string]any {
	m, _ := row[key].(map[string]any)
	return m
}
