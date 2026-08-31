// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"time"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/registry"
)

// gamingPatterns flag prompt text that manipulates evaluation; reviewers see
// warnings, nothing auto-rejects.
var gamingPatterns = []struct{ Category, Pattern string }{
	{"eval_manipulation", `always\s+(report|indicate|show)\s+(success|completion|satisfaction)`},
	{"eval_manipulation", `never\s+(report|indicate|show)\s+(error|failure|problem)`},
	{"eval_manipulation", `if\s+(being\s+)?evaluat`},
	{"eval_manipulation", `if\s+this\s+is\s+a\s+test`},
	{"eval_manipulation", `when\s+(being\s+)?observed`},
	{"eval_manipulation", `when\s+(being\s+)?monitored`},
	{"metric_inflation", `report\s+task\s+as\s+complete`},
	{"metric_inflation", `always\s+express\s+satisfaction`},
	{"metric_inflation", `suppress\s+error`},
	{"metric_inflation", `hide\s+(error|failure|problem)`},
	{"telemetry_awareness", `(caracal|telemetry|hook|trace|metric)`},
	{"telemetry_awareness", `if\s+.*log(ging|ged)`},
}

var compiledGaming = func() []struct {
	Category string
	Pattern  string
	RE       *regexp.Regexp
} {
	out := make([]struct {
		Category string
		Pattern  string
		RE       *regexp.Regexp
	}, 0, len(gamingPatterns))
	for _, p := range gamingPatterns {
		out = append(out, struct {
			Category string
			Pattern  string
			RE       *regexp.Regexp
		}{p.Category, p.Pattern, regexp.MustCompile("(?i)" + p.Pattern)})
	}
	return out
}()

// scanForGaming returns the reviewer-facing flag summary for a prompt.
func scanForGaming(prompt string) map[string]any {
	flags := []map[string]any{}
	categories := map[string]any{}
	counts := map[string]int{}
	if prompt != "" {
		for _, p := range compiledGaming {
			for _, loc := range p.RE.FindAllStringIndex(prompt, -1) {
				start, end := loc[0], loc[1]
				ctxStart, ctxEnd := start-50, end+50
				if ctxStart < 0 {
					ctxStart = 0
				}
				if ctxEnd > len(prompt) {
					ctxEnd = len(prompt)
				}
				flags = append(flags, map[string]any{
					"pattern":      p.Pattern,
					"matched_text": prompt[start:end],
					"context":      prompt[ctxStart:ctxEnd],
					"severity":     "warning",
					"category":     p.Category,
				})
				counts[p.Category]++
			}
		}
	}
	for k, v := range counts {
		categories[k] = v
	}
	return map[string]any{
		"has_flags":  len(flags) > 0,
		"flag_count": len(flags),
		"categories": categories,
		"flags":      flags,
	}
}

const editLockTTL = 30 * time.Minute

// UpdateFields carries the optional update inputs; nil means unchanged.
type UpdateFields struct {
	Name             *string
	Version          *string
	VersionBumpType  *string
	Description      *string
	Category         *string
	Owner            *string
	Prompt           *string
	ModelName        *string
	ModelConfigJSON  map[string]any
	ModelsByHarness  map[string]any
	Supported        []string
	McpServerIDs     []string
	HasMcpServerIDs  bool
	Components       []componentRef
	ComponentConfigs []map[string]any
	HasComponents    bool
	ExternalMcps     []externalMcp
	HasExternalMcps  bool
	SuccessCriteria  map[string]any
	HasSuccess       bool
	Visibility       *string
}

// replaceComponents swaps a version's component links for the given set.
func replaceComponents(ctx context.Context, tx registry.PGQuerier, exec interface {
	Exec(ctx context.Context, sql string, args ...any) (int64, error)
}, versionID string, refs []componentRef, overrides []map[string]any, onlyMcp bool, resolved map[string]string) error {
	deleteSQL := `DELETE FROM agent_components WHERE agent_version_id = $1`
	if onlyMcp {
		deleteSQL += ` AND component_type = 'mcp'`
	}
	if _, err := exec.Exec(ctx, deleteSQL, versionID); err != nil {
		return err
	}
	for i, ref := range refs {
		version, ok := resolved[ref.ComponentType+"/"+ref.ComponentID]
		if !ok {
			version = "latest"
		}
		var overrideJSON *string
		if i < len(overrides) && len(overrides[i]) > 0 {
			blob, _ := json.Marshal(overrides[i])
			s := string(blob)
			overrideJSON = &s
		}
		if _, err := exec.Exec(ctx, `INSERT INTO agent_components (id, agent_version_id,
			component_type, component_id, component_name, resolved_version, order_index,
			config_override, created_at)
			VALUES (gen_random_uuid(), $1, $2, $3, '', $4, $5, $6, now())`,
			versionID, ref.ComponentType, ref.ComponentID, version, i, overrideJSON); err != nil {
			return err
		}
	}
	return nil
}

// resolveCurrentVersions maps refs to their listing's current version string.
func (s *Store) resolveCurrentVersions(ctx context.Context, refs []componentRef) (map[string]string, map[string]bool, error) {
	byType := map[string][]string{}
	for _, ref := range refs {
		byType[ref.ComponentType] = append(byType[ref.ComponentType], ref.ComponentID)
	}
	versions := map[string]string{}
	skillSlash := map[string]bool{}
	for typeName, ids := range byType {
		f, known := registry.Families[typeName+"s"]
		if !known || len(ids) == 0 {
			continue
		}
		extra := ""
		if typeName == "skill" {
			extra = ", v.slash_command"
		}
		rows, err := s.DB.Query(ctx, fmt.Sprintf(`SELECT l.id::text, v.version%s
			FROM %s l LEFT JOIN %s v ON l.latest_version_id = v.id WHERE l.id = ANY($1)`,
			extra, f.ListingTable, f.VersionTable), ids)
		if err != nil {
			return nil, nil, err
		}
		for rows.Next() {
			var id string
			var version, slash *string
			dests := []any{&id, &version}
			if typeName == "skill" {
				dests = append(dests, &slash)
			}
			if err := rows.Scan(dests...); err != nil {
				rows.Close()
				return nil, nil, err
			}
			if version != nil {
				versions[typeName+"/"+id] = *version
			}
			if slash != nil && *slash != "" {
				skillSlash[id] = true
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, nil, err
		}
	}
	return versions, skillSlash, nil
}

// refreshInference recomputes required capabilities from the stored links.
func (s *Store) refreshInference(ctx context.Context, versionID string, externalMcps []any) error {
	links, err := s.Components(ctx, versionID)
	if err != nil {
		return err
	}
	refs := make([]componentRef, 0, len(links))
	skillIDs := []string{}
	for _, link := range links {
		ref := componentRef{
			ComponentType: rowStr(link, "component_type", ""),
			ComponentID:   rowStr(link, "component_id", ""),
		}
		refs = append(refs, ref)
		if ref.ComponentType == "skill" {
			skillIDs = append(skillIDs, ref.ComponentID)
		}
	}
	skillSlash := map[string]bool{}
	if len(skillIDs) > 0 {
		rows, err := s.DB.Query(ctx, `SELECT l.id::text, v.slash_command
			FROM skill_listings l LEFT JOIN skill_versions v ON l.latest_version_id = v.id
			WHERE l.id = ANY($1)`, skillIDs)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id string
			var slash *string
			if err := rows.Scan(&id, &slash); err != nil {
				rows.Close()
				return err
			}
			if slash != nil && *slash != "" {
				skillSlash[id] = true
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
	}
	required := inferRequiredFeatures(refs, len(externalMcps) > 0, skillSlash)
	requiredJSON, _ := json.Marshal(required)
	inferredJSON, _ := json.Marshal(computeSupportedHarnesses(required))
	_, err = s.Exec(ctx, `UPDATE agent_versions SET required_capabilities = $1,
		inferred_supported_harnesses = $2 WHERE id = $3`,
		string(requiredJSON), string(inferredJSON), versionID)
	return err
}

// refreshSnapshot rebuilds the canonical snapshot from stored state.
func (s *Store) refreshSnapshot(ctx context.Context, versionID string) error {
	rows, err := s.DB.Query(ctx, `SELECT v.version, v.description, v.prompt, v.model_name,
		v.models_by_harness, v.external_mcps, v.supported_harnesses, v.model_config_json,
		v.success_criteria FROM agent_versions v WHERE v.id = $1`, versionID)
	if err != nil {
		return err
	}
	collected := registry.CollectRows(rows)
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(collected) == 0 {
		return fmt.Errorf("version %s not found", versionID)
	}
	links, err := s.Components(ctx, versionID)
	if err != nil {
		return err
	}
	snapshot := renderYAMLSnapshot(collected[0], snapshotEntries(links))
	_, err = s.Exec(ctx, `UPDATE agent_versions SET yaml_snapshot = $1 WHERE id = $2`, snapshot, versionID)
	return err
}

// editLockState reads the latest version's editing lock.
func (s *Store) editLockState(ctx context.Context, versionID string) (bool, *uuid.UUID, *time.Time, error) {
	var isEditing bool
	var by *uuid.UUID
	var since *time.Time
	err := s.DB.QueryRow(ctx, `SELECT is_editing, editing_by, editing_since
		FROM agent_versions WHERE id = $1`, versionID).Scan(&isEditing, &by, &since)
	return isEditing, by, since, err
}

func lockExpired(since *time.Time) bool {
	return since == nil || time.Since(*since) > editLockTTL
}

// AcquireEditLock locks a version for one editor; an active foreign lock
// answers 409.
func (s *Store) AcquireEditLock(ctx context.Context, versionID string, userID uuid.UUID) error {
	isEditing, by, since, err := s.editLockState(ctx, versionID)
	if err != nil {
		return err
	}
	if isEditing && !lockExpired(since) && (by == nil || *by != userID) {
		return &errInstall{409, "This item is currently being edited by another user. Please try again later."}
	}
	_, err = s.Exec(ctx, `UPDATE agent_versions SET is_editing = true,
		editing_since = now(), editing_by = $1 WHERE id = $2`, userID, versionID)
	return err
}

// ReleaseEditLock clears the lock.
func (s *Store) ReleaseEditLock(ctx context.Context, versionID string) error {
	_, err := s.Exec(ctx, `UPDATE agent_versions SET is_editing = false,
		editing_since = NULL, editing_by = NULL WHERE id = $1`, versionID)
	return err
}
