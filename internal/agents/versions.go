// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import (
	"context"
	"time"

	"github.com/garudex-labs/caracal/internal/registry"
)

// wireTimeISO renders aware datetimes the way plain-dict responses do:
// +00:00 offset, microseconds only when nonzero.
func wireTimeISO(v any) any {
	t, ok := v.(time.Time)
	if !ok {
		return nil
	}
	t = t.UTC()
	if t.Nanosecond() == 0 {
		return t.Format("2006-01-02T15:04:05+00:00")
	}
	return t.Format("2006-01-02T15:04:05.000000+00:00")
}

type versionSummary struct {
	ID                 string  `json:"id"`
	AgentID            string  `json:"agent_id"`
	Version            string  `json:"version"`
	Description        string  `json:"description"`
	Status             string  `json:"status"`
	IsPrerelease       bool    `json:"is_prerelease"`
	DownloadCount      int64   `json:"download_count"`
	SupportedHarnesses []any   `json:"supported_harnesses"`
	ReleasedBy         string  `json:"released_by"`
	ReleasedAt         any     `json:"released_at"`
	CreatedAt          any     `json:"created_at"`
	RejectionReason    *string `json:"rejection_reason"`
	ComponentCount     int64   `json:"component_count"`
}

type versionComponent struct {
	ComponentType   string  `json:"component_type"`
	ComponentID     string  `json:"component_id"`
	Name            string  `json:"name"`
	ResolvedVersion string  `json:"resolved_version"`
	Status          *string `json:"status"`
}

type versionDetail struct {
	versionSummary
	Prompt                     string             `json:"prompt"`
	ModelName                  string             `json:"model_name"`
	ModelConfigJSON            map[string]any     `json:"model_config_json"`
	ModelsByHarness            map[string]any     `json:"models_by_harness"`
	ExternalMcps               []any              `json:"external_mcps"`
	YamlSnapshot               *string            `json:"yaml_snapshot"`
	HarnessConfigs             map[string]any     `json:"harness_configs"`
	RequiredCapabilities       []any              `json:"required_capabilities"`
	InferredSupportedHarnesses []any              `json:"inferred_supported_harnesses"`
	SuccessCriteria            map[string]any     `json:"success_criteria"`
	Components                 []versionComponent `json:"components"`
}

type versionPage struct {
	Items    []versionSummary `json:"items"`
	Total    int              `json:"total"`
	Page     int              `json:"page"`
	PageSize int              `json:"page_size"`
}

const versionColumns = `v.id::text AS id, v.agent_id::text AS agent_id, v.version, v.description,
	v.status, v.is_prerelease, v.download_count, v.supported_harnesses,
	v.released_by::text AS released_by, v.released_at, v.created_at, v.rejection_reason,
	(SELECT count(*) FROM agent_components ac WHERE ac.agent_version_id = v.id) AS component_count`

func versionSummaryOf(row map[string]any) versionSummary {
	return versionSummary{
		ID:                 rowStr(row, "id", ""),
		AgentID:            rowStr(row, "agent_id", ""),
		Version:            rowStr(row, "version", ""),
		Description:        rowStr(row, "description", ""),
		Status:             rowStr(row, "status", ""),
		IsPrerelease:       rowBool(row, "is_prerelease"),
		DownloadCount:      rowInt(row, "download_count"),
		SupportedHarnesses: rowList(row, "supported_harnesses"),
		ReleasedBy:         rowStr(row, "released_by", ""),
		ReleasedAt:         wireTimeISO(row["released_at"]),
		CreatedAt:          wireTimeISO(row["created_at"]),
		RejectionReason:    rowNStr(row, "rejection_reason"),
		ComponentCount:     rowInt(row, "component_count"),
	}
}

// Versions lists an agent's versions newest first. Unapproved versions are
// reserved for owners and reviewers; the total deliberately counts every
// version regardless of the caller's gate.
func (s *Store) Versions(ctx context.Context, agentRow map[string]any, viewer *registry.Viewer, page, pageSize int) (*versionPage, error) {
	agentID := rowStr(agentRow, "id", "")
	statusGate := ""
	if !mayViewUnapproved(permission(agentRow, viewer), viewer) {
		statusGate = " AND v.status = 'approved'"
	}
	rows, err := s.DB.Query(ctx, `SELECT `+versionColumns+` FROM agent_versions v
		WHERE v.agent_id = $1`+statusGate+`
		ORDER BY v.created_at DESC OFFSET $2 LIMIT $3`,
		agentID, (page-1)*pageSize, pageSize)
	if err != nil {
		return nil, err
	}
	collected := registry.CollectRows(rows)
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	var total int
	if err := s.DB.QueryRow(ctx, `SELECT count(*) FROM agent_versions WHERE agent_id = $1`, agentID).Scan(&total); err != nil {
		return nil, err
	}
	items := make([]versionSummary, 0, len(collected))
	for _, row := range collected {
		items = append(items, versionSummaryOf(row))
	}
	return &versionPage{Items: items, Total: total, Page: page, PageSize: pageSize}, nil
}

// Version returns one version's full detail with resolved component names
// and current listing statuses. A nil detail means not found.
func (s *Store) Version(ctx context.Context, agentRow map[string]any, viewer *registry.Viewer, version string) (*versionDetail, error) {
	agentID := rowStr(agentRow, "id", "")
	statusGate := ""
	if !mayViewUnapproved(permission(agentRow, viewer), viewer) {
		statusGate = " AND v.status = 'approved'"
	}
	rows, err := s.DB.Query(ctx, `SELECT `+versionColumns+`,
		v.prompt, v.model_name, v.model_config_json, v.models_by_harness,
		v.external_mcps, v.yaml_snapshot, v.harness_configs,
		v.required_capabilities, v.inferred_supported_harnesses, v.success_criteria
		FROM agent_versions v WHERE v.agent_id = $1 AND v.version = $2`+statusGate,
		agentID, version)
	if err != nil {
		return nil, err
	}
	collected := registry.CollectRows(rows)
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(collected) == 0 {
		return nil, nil
	}
	row := collected[0]

	links, err := s.Components(ctx, rowStr(row, "id", ""))
	if err != nil {
		return nil, err
	}
	components := make([]versionComponent, 0, len(links))
	for _, link := range links {
		name := rowStr(link, "component_name", "")
		if name == "" {
			name = rowStr(link, "ref_name", "")
		}
		components = append(components, versionComponent{
			ComponentType:   rowStr(link, "component_type", ""),
			ComponentID:     rowStr(link, "component_id", ""),
			Name:            name,
			ResolvedVersion: rowStr(link, "resolved_version", ""),
			Status:          rowNStr(link, "ref_status"),
		})
	}
	return &versionDetail{
		versionSummary:             versionSummaryOf(row),
		Prompt:                     rowStr(row, "prompt", ""),
		ModelName:                  rowStr(row, "model_name", ""),
		ModelConfigJSON:            rowDict(row, "model_config_json"),
		ModelsByHarness:            rowDict(row, "models_by_harness"),
		ExternalMcps:               rowList(row, "external_mcps"),
		YamlSnapshot:               rowNStr(row, "yaml_snapshot"),
		HarnessConfigs:             rowNDict(row, "harness_configs"),
		RequiredCapabilities:       rowList(row, "required_capabilities"),
		InferredSupportedHarnesses: rowList(row, "inferred_supported_harnesses"),
		SuccessCriteria:            rowNDict(row, "success_criteria"),
		Components:                 components,
	}, nil
}
