// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/garudex-labs/caracal/internal/harness"
	"github.com/garudex-labs/caracal/internal/harnessgen"
	"github.com/garudex-labs/caracal/internal/registry"
	"github.com/garudex-labs/caracal/internal/resretention"
	"github.com/garudex-labs/caracal/internal/tenancy"
)

// TxQuerier is the transactional pool surface the write plane needs.
type TxQuerier interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

var (
	dangerousCmdRE = regexp.MustCompile(`(?i)^(?:curl|wget|bash|sh|zsh|fish|dash|python|perl|ruby|nc|ncat|netcat|powershell|cmd\.exe)$`)
	agentNameRE    = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`)
	slugCleanRE    = regexp.MustCompile(`[^a-z0-9_-]+`)
)

// validateMcpCommand rejects shell metacharacters (shared with registry MCPs)
// and, for free-form external agent MCPs, disallowed interpreter/network
// programs that would let an agent smuggle arbitrary local execution.
func validateMcpCommand(command string, args []string) error {
	if command == "" {
		return nil
	}
	if err := harnessgen.ValidateMcpCommand(command, args); err != nil {
		return err
	}
	cmdBase := ""
	if fields := strings.Fields(command); len(fields) > 0 {
		cmdBase = fields[0]
	}
	if dangerousCmdRE.MatchString(cmdBase) {
		return fmt.Errorf("MCP command uses a disallowed program: '%s'", cmdBase)
	}
	return nil
}

// slugifyName is the registry slug rule for restore renames.
func slugifyName(value string) (string, error) {
	slug := strings.Trim(slugCleanRE.ReplaceAllString(strings.ToLower(strings.TrimSpace(value)), "-"), "-_")
	if slug == "" {
		return "", fmt.Errorf("Name must contain at least one letter or number")
	}
	if (slug[0] < 'a' || slug[0] > 'z') && (slug[0] < '0' || slug[0] > '9') {
		slug = "item-" + slug
	}
	if len(slug) > 64 {
		slug = strings.TrimRight(slug[:64], "-_")
	}
	return slug, nil
}

// externalMcp is the stored external server shape.
type externalMcp struct {
	Name    string            `json:"name"`
	Command string            `json:"command"`
	Args    []string          `json:"args"`
	Env     map[string]string `json:"env"`
	URL     *string           `json:"url"`
}

// CreateAgentRequest carries the validated creation inputs.
type CreateAgentRequest struct {
	Name             string
	Version          string
	Description      string
	Category         *string
	Owner            string
	Visibility       string
	Prompt           string
	ModelName        string
	ModelConfigJSON  map[string]any
	ModelsByHarness  map[string]any
	SupportedList    []string
	McpServerIDs     []string
	Components       []componentRef
	ComponentConfigs []map[string]any
	ExternalMcps     []externalMcp
	SuccessCriteria  map[string]any
	ProjectID        *uuid.UUID
	// AsDraft saves without entering the review queue.
	AsDraft bool
}

// inferRequiredFeatures derives capability needs from the composition.
func inferRequiredFeatures(refs []componentRef, hasExternalMcps bool, skillSlash map[string]bool) []string {
	features := map[string]bool{}
	for _, ref := range refs {
		switch ref.ComponentType {
		case "mcp":
			features["mcp_servers"] = true
		case "hook":
			features["hooks"] = true
		case "skill":
			if skillSlash[ref.ComponentID] {
				features["skills"] = true
			}
		}
	}
	if hasExternalMcps {
		features["mcp_servers"] = true
	}
	out := make([]string, 0, len(features))
	for f := range features {
		out = append(out, f)
	}
	sort.Strings(out)
	return out
}

// computeSupportedHarnesses lists harnesses covering every required feature.
func computeSupportedHarnesses(required []string) []string {
	reg := harness.MustLoad()
	names := []string{}
	for _, name := range reg.Names() {
		spec, _ := reg.Spec(name)
		ok := true
		for _, feature := range required {
			if !spec.HasCapability(harness.Capability(feature)) {
				ok = false
				break
			}
		}
		if ok {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names
}

// CreateAgent creates the agent, its first version, and component links in
// one transaction, returning the new agent id.
func (s *Store) CreateAgent(ctx context.Context, user tenancy.User, req *CreateAgentRequest) (string, error) {
	pool, ok := s.DB.(TxQuerier)
	if !ok {
		return "", fmt.Errorf("store connection cannot begin transactions")
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	resolver := &tenancy.Resolver{DB: tx}
	target, err := resolver.ResolvePublishTarget(ctx, user, req.Name, tenancy.PublishOptions{
		Visibility: req.Visibility, ProjectID: req.ProjectID,
	})
	if err != nil {
		return "", err
	}

	// A components list supersedes the legacy mcp id list.
	refs := req.Components
	legacyIDs := req.McpServerIDs
	if len(refs) > 0 {
		legacyIDs = nil
	}
	// Components resolve within the agent's owning project audience.
	targetProjectID := ""
	if target.ProjectID != nil {
		targetProjectID = target.ProjectID.String()
	}
	viewer := &registry.Viewer{ID: user.ID, Role: user.Role}
	allRefs := append([]componentRef{}, refs...)
	for _, id := range legacyIDs {
		allRefs = append(allRefs, componentRef{ComponentType: "mcp", ComponentID: id})
	}
	txStore := &Store{DB: tx}
	validationErrors, err := txStore.ValidateComponents(ctx, allRefs, viewer, targetProjectID)
	if err != nil {
		return "", err
	}
	if len(validationErrors) > 0 {
		if len(refs) == 0 {
			// The legacy list reports only the first failure, as a plain string.
			return "", &errInstall{400, validationErrors[0].Reason}
		}
		blob, _ := json.Marshal(validationErrors)
		return "", &errInstall{400, string(blob)}
	}

	for _, ext := range req.ExternalMcps {
		if err := validateMcpCommand(ext.Command, ext.Args); err != nil {
			return "", &errInstall{422, "Invalid MCP command: " + err.Error()}
		}
	}

	var existing *string
	err = tx.QueryRow(ctx, `SELECT id::text FROM agents
		WHERE namespace = $1 AND slug = $2 AND deleted_at IS NULL`,
		target.Namespace, target.Slug).Scan(&existing)
	if err == nil {
		if req.AsDraft {
			return "", &errInstall{409, "A agent with this namespace and slug already exists"}
		}
		return "", &errInstall{409, fmt.Sprintf("Agent '%s/%s' already exists", target.Namespace, target.Slug)}
	}

	owner := req.Owner
	if owner == "" {
		owner = user.Username
	}
	if owner == "" {
		owner = user.Email
	}
	agentID := uuid.NewString()
	versionID := uuid.NewString()
	_, err = tx.Exec(ctx, `INSERT INTO agents (id, name, namespace, slug, owner, category,
		created_by, project_id, is_private, ownership_scope, co_authors,
		created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '[]', now(), now())`,
		agentID, req.Name, target.Namespace, target.Slug, owner, req.Category,
		user.ID, target.ProjectID, target.IsPrivate(), target.Scope())
	if err != nil {
		if strings.Contains(err.Error(), "uq_agents_active_namespace_slug") {
			return "", &errInstall{409, fmt.Sprintf("Agent '%s/%s' already exists", target.Namespace, target.Slug)}
		}
		return "", err
	}

	status := "pending"
	var reviewedBy *uuid.UUID
	var reviewedAt *time.Time
	if req.AsDraft {
		status = "draft"
	} else if target.AutoApprove {
		status = "approved"
		reviewedBy = &user.ID
		now := time.Now().UTC()
		reviewedAt = &now
	}
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
	supported := req.SupportedList
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
	_, err = tx.Exec(ctx, `INSERT INTO agent_versions (id, agent_id, version, description, prompt,
		model_name, model_config_json, models_by_harness, external_mcps, supported_harnesses,
		required_capabilities, inferred_supported_harnesses, status, is_prerelease,
		rejection_reason, download_count, released_by, released_at, reviewed_by, reviewed_at,
		created_at, is_editing, success_criteria)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '[]', '[]', $11, false,
		NULL, 0, $12, now(), $13, $14, now(), false, $15)`,
		versionID, agentID, req.Version, req.Description, req.Prompt,
		req.ModelName, string(modelConfigJSON), string(modelsByHarnessJSON),
		string(externalsJSON), string(supportedJSON), status, user.ID, reviewedBy, reviewedAt, successJSON)
	if err != nil {
		return "", err
	}
	if _, err = tx.Exec(ctx, `UPDATE agents SET latest_version_id = $1 WHERE id = $2`, versionID, agentID); err != nil {
		return "", err
	}

	// Resolve current listing versions for the links.
	versionByRef := map[string]string{}
	skillSlash := map[string]bool{}
	byType := map[string][]string{}
	for _, ref := range allRefs {
		byType[ref.ComponentType] = append(byType[ref.ComponentType], ref.ComponentID)
	}
	for typeName, ids := range byType {
		f, known := registry.Families[typeName+"s"]
		if !known || len(ids) == 0 {
			continue
		}
		extra := ""
		if typeName == "skill" {
			extra = ", v.slash_command"
		}
		rows, err := tx.Query(ctx, fmt.Sprintf(`SELECT l.id::text, v.version%s
			FROM %s l LEFT JOIN %s v ON l.latest_version_id = v.id WHERE l.id = ANY($1)`,
			extra, f.ListingTable, f.VersionTable), ids)
		if err != nil {
			return "", err
		}
		for rows.Next() {
			var id string
			var version *string
			var slash *string
			dests := []any{&id, &version}
			if typeName == "skill" {
				dests = append(dests, &slash)
			}
			if err := rows.Scan(dests...); err != nil {
				rows.Close()
				return "", err
			}
			if version != nil {
				versionByRef[typeName+"/"+id] = *version
			}
			if slash != nil && *slash != "" {
				skillSlash[id] = true
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return "", err
		}
	}
	order := 0
	insertLink := func(ref componentRef, override map[string]any) error {
		resolved, ok := versionByRef[ref.ComponentType+"/"+ref.ComponentID]
		if !ok {
			resolved = "latest"
		}
		var overrideJSON *string
		if len(override) > 0 {
			blob, _ := json.Marshal(override)
			s := string(blob)
			overrideJSON = &s
		}
		_, err := tx.Exec(ctx, `INSERT INTO agent_components (id, agent_version_id, component_type,
			component_id, component_name, resolved_version, order_index, config_override, created_at)
			VALUES (gen_random_uuid(), $1, $2, $3, '', $4, $5, $6, now())`,
			versionID, ref.ComponentType, ref.ComponentID, resolved, order, overrideJSON)
		order++
		return err
	}
	for _, id := range legacyIDs {
		if err := insertLink(componentRef{ComponentType: "mcp", ComponentID: id}, nil); err != nil {
			return "", err
		}
	}
	for i, ref := range refs {
		var override map[string]any
		if i < len(req.ComponentConfigs) {
			override = req.ComponentConfigs[i]
		}
		if err := insertLink(ref, override); err != nil {
			return "", err
		}
	}

	required := inferRequiredFeatures(allRefs, len(req.ExternalMcps) > 0, skillSlash)
	requiredJSON, _ := json.Marshal(required)
	inferredJSON, _ := json.Marshal(computeSupportedHarnesses(required))
	if _, err = tx.Exec(ctx, `UPDATE agent_versions SET required_capabilities = $1,
		inferred_supported_harnesses = $2 WHERE id = $3`,
		string(requiredJSON), string(inferredJSON), versionID); err != nil {
		return "", err
	}

	// Canonical snapshot for the reviewer and the version-diff view.
	links, err := txStore.Components(ctx, versionID)
	if err != nil {
		return "", err
	}
	snapshotRow := map[string]any{
		"version": req.Version, "description": req.Description, "prompt": req.Prompt,
		"model_name": req.ModelName, "models_by_harness": orDict(req.ModelsByHarness),
		"supported_harnesses": toAnyList(supported), "external_mcps": rawToList(externalsJSON),
		"model_config_json": orDict(req.ModelConfigJSON), "success_criteria": req.SuccessCriteria,
	}
	snapshot := renderYAMLSnapshot(snapshotRow, snapshotEntries(links))
	if _, err = tx.Exec(ctx, `UPDATE agent_versions SET yaml_snapshot = $1 WHERE id = $2`, snapshot, versionID); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		if strings.Contains(err.Error(), "uq_agents_active_namespace_slug") {
			return "", &errInstall{409, fmt.Sprintf("Agent '%s/%s' already exists", target.Namespace, target.Slug)}
		}
		return "", err
	}
	return agentID, nil
}

func orDict(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	return m
}

func toAnyList(items []string) []any {
	out := make([]any, 0, len(items))
	for _, s := range items {
		out = append(out, s)
	}
	return out
}

func rawToList(blob []byte) []any {
	var out []any
	_ = json.Unmarshal(blob, &out)
	if out == nil {
		out = []any{}
	}
	return out
}

// snapshotEntries adapts component links to snapshot entry shape.
func snapshotEntries(links []map[string]any) []map[string]any {
	out := make([]map[string]any, 0, len(links))
	for _, link := range links {
		entry := map[string]any{
			"type": rowStr(link, "component_type", ""),
			"id":   rowStr(link, "component_id", ""),
		}
		if name, ok := link["ref_name"].(string); ok {
			entry["name"] = name
			if entry["type"] == "prompt" {
				entry["template"] = ""
			} else {
				entry["description"] = ""
			}
		} else {
			entry["name"] = rowStr(link, "component_id", "")[:8]
		}
		if v := rowStr(link, "resolved_version", ""); v != "" {
			entry["version"] = v
		}
		if override := rowNDict(link, "config_override"); len(override) > 0 {
			entry["config_override"] = override
		}
		out = append(out, entry)
	}
	return out
}

// SoftDelete marks the agent deleted, returning its name and retention dates.
func (s *Store) SoftDelete(ctx context.Context, agentID string, class resretention.ResourceClass, policy resretention.Policy) (string, time.Time, time.Time, error) {
	now := time.Now().UTC()
	var name string
	scheduledPurgeAt := resretention.ScheduledPurgeAt(now, class, policy)
	err := s.DB.QueryRow(ctx, `UPDATE agents
		SET deleted_at = $1,
		    scheduled_purge_at = $1 + make_interval(days => CASE WHEN ownership_scope = 'private' THEN $3 ELSE $4 END)
		WHERE id = $2 AND deleted_at IS NULL RETURNING name`,
		now, agentID, policy.PrivateRetentionDays, policy.ProjectRetentionDays).Scan(&name)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", now, scheduledPurgeAt.UTC(), &errInstall{409, "Agent deletion state changed; refresh and retry"}
	}
	return name, now, scheduledPurgeAt.UTC(), err
}

// Restore clears the deletion mark, optionally renaming; the active
// namespace identity must stay unique.
func (s *Store) Restore(ctx context.Context, row map[string]any, newName string) (string, string, error) {
	agentID := rowStr(row, "id", "")
	name := rowStr(row, "name", "")
	slug := rowStr(row, "slug", "")
	if newName != "" {
		name = newName
		var err error
		slug, err = slugifyName(newName)
		if err != nil {
			return "", "", &errInstall{422, err.Error()}
		}
	}
	var conflict *string
	err := s.DB.QueryRow(ctx, `SELECT id::text FROM agents
		WHERE namespace = $1 AND slug = $2 AND deleted_at IS NULL AND id != $3`,
		rowStr(row, "namespace", ""), slug, agentID).Scan(&conflict)
	if err == nil {
		return "", "", &errInstall{409, fmt.Sprintf("Agent '%s/%s' already exists. Restore with a new name.",
			rowStr(row, "namespace", ""), slug)}
	}
	count, err := s.Exec(ctx, `UPDATE agents SET name = $1, slug = $2, deleted_at = NULL, scheduled_purge_at = NULL
		WHERE id = $3 AND deleted_at IS NOT NULL AND (scheduled_purge_at IS NULL OR scheduled_purge_at > now())`,
		name, slug, agentID)
	if err == nil && count == 0 {
		return "", "", &errInstall{409, "Agent deletion state changed; refresh and retry"}
	}
	return name, slug, err
}

func (s *Store) PurgeDeleted(ctx context.Context, agentID string) (string, error) {
	if _, err := s.Exec(ctx, `DELETE FROM review_issues WHERE subject_type = 'agent' AND subject_id = $1`, agentID); err != nil {
		return "", err
	}
	if _, err := s.Exec(ctx, `DELETE FROM inbox_items WHERE subject_type = 'agent' AND subject_id = $1`, agentID); err != nil {
		return "", err
	}
	var name string
	err := s.DB.QueryRow(ctx, `DELETE FROM agents WHERE id = $1 AND deleted_at IS NOT NULL RETURNING name`, agentID).Scan(&name)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", &errInstall{404, "Deleted agent not found"}
	}
	return name, err
}

func (s *Store) CanAdministerProjectResource(ctx context.Context, projectID, userID uuid.UUID) (bool, error) {
	var allowed bool
	err := s.DB.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM projects p
		LEFT JOIN organization_memberships om
		  ON om.organization_id = p.organization_id AND om.user_id = $2 AND om.role IN ('owner', 'admin')
		LEFT JOIN project_memberships pm
		  ON pm.project_id = p.id AND pm.user_id = $2 AND pm.role = 'lead'
		WHERE p.id = $1 AND (om.user_id IS NOT NULL OR pm.user_id IS NOT NULL)
	)`, projectID, userID).Scan(&allowed)
	return allowed, err
}

// SetLatestVersionStatus flips the latest version between approved and
// archived for the lifecycle routes.
func (s *Store) SetLatestVersionStatus(ctx context.Context, latestVersionID, status string) error {
	_, err := s.Exec(ctx, `UPDATE agent_versions SET status = $1 WHERE id = $2`, status, latestVersionID)
	return err
}
