// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/garudex-labs/caracal/internal/redact"
)

// reportTimeoutMinutes is the longest a report may stay running before the
// reaper considers it stranded by a crash or restart.
const reportTimeoutMinutes = 10

// job is the claimed context of one report to generate.
type job struct {
	ReportID               string
	AgentID                string
	AgentVersion           string
	ComparisonAgentVersion string
	PeriodStart            time.Time
	PeriodEnd              time.Time
	PreviousReportID       string
	TriggeredBy            string
}

// Store drives insight report rows through their lifecycle.
type Store struct {
	DB PGQuerier
}

// ReapStale marks reports stuck in running for too long as failed,
// covering crashes, restarts, and exhausted retries.
func (s *Store) ReapStale(ctx context.Context) (int, error) {
	tag, err := s.DB.Exec(ctx, `
		UPDATE insight_reports
		SET status = 'failed',
		    error_message = $1,
		    completed_at = now(),
		    progress_phase = 'failed',
		    progress_updated_at = now()
		WHERE status = 'running' AND started_at < now() - make_interval(mins => $2)`,
		fmt.Sprintf("Timed out after %d minutes (system may have restarted)", reportTimeoutMinutes),
		reportTimeoutMinutes)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

// ClaimPending atomically moves the oldest pending report to running and
// returns its generation context; nil means nothing is pending.
func (s *Store) ClaimPending(ctx context.Context) (*job, error) {
	row := s.DB.QueryRow(ctx, `
		UPDATE insight_reports
		SET status = 'running',
		    started_at = now(),
		    progress_phase = 'loading_sessions',
		    progress_current = 0,
		    progress_total = 9,
		    progress_percent = 0,
		    progress_message = 'Loading report and agent context',
		    progress_updated_at = now()
		WHERE id = (
			SELECT id FROM insight_reports
			WHERE status = 'pending'
			ORDER BY created_at
			FOR UPDATE SKIP LOCKED
			LIMIT 1
		)
		RETURNING id::text, agent_id::text, coalesce(agent_version, ''),
		          coalesce(comparison_agent_version, ''), period_start, period_end,
		          coalesce(previous_report_id::text, ''), coalesce(triggered_by::text, '')`)
	var j job
	err := row.Scan(&j.ReportID, &j.AgentID, &j.AgentVersion, &j.ComparisonAgentVersion,
		&j.PeriodStart, &j.PeriodEnd, &j.PreviousReportID, &j.TriggeredBy)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &j, nil
}

// UpdateProgress records the pipeline phase on the report row.
func (s *Store) UpdateProgress(ctx context.Context, reportID, phase string, current, total int, message string) {
	percent := 0
	if total > 0 {
		percent = current * 100 / total
	}
	_, err := s.DB.Exec(ctx, `
		UPDATE insight_reports
		SET progress_phase = $2, progress_current = $3, progress_total = $4,
		    progress_percent = $5, progress_message = $6, progress_updated_at = now()
		WHERE id = $1`, reportID, phase, current, total, percent, message)
	if err != nil {
		slog.Debug("progress update failed", "report_id", reportID, "error", err)
	}
}

// AgentName resolves the agent's display name for a report.
func (s *Store) AgentName(ctx context.Context, agentID string) string {
	var name string
	if err := s.DB.QueryRow(ctx, `SELECT name FROM agents WHERE id = $1`, agentID).Scan(&name); err != nil {
		return "Unknown Agent"
	}
	return name
}

// AgentScope builds the reuse scope for an agent: its creator and the
// component ids already attached to the analysed version.
func agentScope(createdBy string, agentConfig map[string]any) registryScope {
	scope := registryScope{}
	if id, err := uuid.Parse(createdBy); err == nil {
		scope.UserID = id
		scope.HasUser = true
	}
	if agentConfig != nil {
		for _, compAny := range asList(agentConfig["current_components"]) {
			comp := asMap(compAny)
			if comp == nil {
				continue
			}
			if id, err := uuid.Parse(str(comp["id"])); err == nil {
				scope.AttachedIDs = append(scope.AttachedIDs, id)
			}
		}
	}
	return scope
}

// AgentCreator resolves the creator id for the reuse scope.
func (s *Store) AgentCreator(ctx context.Context, agentID string) string {
	var createdBy string
	if err := s.DB.QueryRow(ctx,
		`SELECT created_by::text FROM agents WHERE id = $1`, agentID).Scan(&createdBy); err != nil {
		return ""
	}
	return createdBy
}

// LoadAgentConfig summarizes the latest approved version and its
// components; nil when no approved version exists.
func (s *Store) LoadAgentConfig(ctx context.Context, agentID string) (map[string]any, error) {
	row := s.DB.QueryRow(ctx, `
		SELECT v.id::text, v.version, v.model_name, v.supported_harnesses,
		       v.prompt, v.model_config_json, v.external_mcps
		FROM agent_versions v
		WHERE v.agent_id = $1 AND v.status = 'approved'
		ORDER BY v.released_at DESC NULLS LAST, v.created_at DESC
		LIMIT 1`, agentID)
	var versionID, version, modelName, prompt string
	var supportedHarnesses, modelConfig, externalMcps []byte
	err := row.Scan(&versionID, &version, &modelName, &supportedHarnesses, &prompt, &modelConfig, &externalMcps)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	mcpNames := []string{}
	skillNames := []string{}
	hookNames := []string{}
	promptNames := []string{}
	currentComponents := []map[string]any{}
	rows, err := s.DB.Query(ctx, `
		SELECT component_type, component_id::text, coalesce(component_name, ''), coalesce(resolved_version, '')
		FROM agent_components WHERE agent_version_id = $1`, versionID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var compType, compID, compName, resolvedVersion string
		if rows.Scan(&compType, &compID, &compName, &resolvedVersion) != nil {
			continue
		}
		if compName == "" {
			compName = truncateRunes(compID, 8)
		}
		entry := map[string]any{
			"type": compType,
			"id":   compID,
			"name": compName,
		}
		if resolvedVersion != "" {
			entry["resolved_version"] = resolvedVersion
		} else {
			entry["resolved_version"] = nil
		}
		currentComponents = append(currentComponents, entry)
		switch compType {
		case "mcp":
			mcpNames = append(mcpNames, compName)
		case "skill":
			skillNames = append(skillNames, compName)
		case "hook":
			hookNames = append(hookNames, compName)
		case "prompt":
			promptNames = append(promptNames, compName)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	var externals []any
	_ = json.Unmarshal(externalMcps, &externals)
	for _, extAny := range externals {
		ext := asMap(extAny)
		if ext == nil {
			continue
		}
		name := str(ext["name"])
		if name == "" {
			name = str(ext["server_name"])
		}
		if name == "" {
			continue
		}
		duplicate := false
		for _, existing := range mcpNames {
			if existing == name {
				duplicate = true
				break
			}
		}
		if !duplicate {
			mcpNames = append(mcpNames, name)
		}
	}

	var harnesses any = []any{}
	_ = json.Unmarshal(supportedHarnesses, &harnesses)
	config := map[string]any{
		"version":             version,
		"model":               modelName,
		"supported_harnesses": harnesses,
	}
	if prompt != "" {
		config["system_prompt_excerpt"] = redact.Secrets(truncateRunes(prompt, 2000))
		config["system_prompt_length"] = len([]rune(prompt))
	}
	if len(mcpNames) > 0 {
		config["configured_mcps"] = mcpNames
	}
	if len(skillNames) > 0 {
		config["configured_skills"] = skillNames
	}
	if len(hookNames) > 0 {
		config["configured_hooks"] = hookNames
	}
	if len(promptNames) > 0 {
		config["configured_prompts"] = promptNames
	}
	if len(currentComponents) > 0 {
		components := make([]any, 0, len(currentComponents))
		for _, comp := range currentComponents {
			components = append(components, comp)
		}
		config["current_components"] = components
	}
	var modelConfigMap map[string]any
	if json.Unmarshal(modelConfig, &modelConfigMap) == nil && len(modelConfigMap) > 0 {
		config["model_config"] = modelConfigMap
	}
	return config, nil
}

// PreviousMetrics loads the aggregated data of the linked previous report.
func (s *Store) PreviousMetrics(ctx context.Context, previousReportID string) map[string]any {
	if previousReportID == "" {
		return nil
	}
	var blob []byte
	err := s.DB.QueryRow(ctx,
		`SELECT aggregated_data FROM insight_reports WHERE id = $1`, previousReportID).Scan(&blob)
	if err != nil || len(blob) == 0 {
		return nil
	}
	var metrics map[string]any
	if json.Unmarshal(blob, &metrics) != nil {
		return nil
	}
	return metrics
}

// Complete persists the pipeline result, marks the report completed, and
// tells the requester through their inbox in the same transaction.
func (s *Store) Complete(ctx context.Context, j *job, agentName string, content *reportContent) error {
	metricsJSON, err := json.Marshal(content.Metrics)
	if err != nil {
		return err
	}
	narrativeJSON, err := json.Marshal(content.Narrative)
	if err != nil {
		return err
	}
	aggregated := map[string]any{
		"metrics":             content.Metrics,
		"facets_summary":      content.FacetsSummary,
		"regressions":         content.Regressions,
		"cross_user_patterns": content.CrossUsers,
	}
	aggregatedJSON, err := json.Marshal(aggregated)
	if err != nil {
		return err
	}
	var modelUsed *string
	if len(content.ModelsUsed) > 0 {
		joined := ""
		for i, m := range content.ModelsUsed {
			if i > 0 {
				joined += ", "
			}
			joined += m
		}
		modelUsed = &joined
	}

	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `
		UPDATE insight_reports
		SET metrics = $2::json,
		    narrative = $3::json,
		    sessions_analyzed = $4,
		    aggregated_data = $5::json,
		    report_version = 3,
		    llm_model_used = $6,
		    status = 'completed',
		    completed_at = now(),
		    progress_phase = 'completed',
		    progress_percent = 100,
		    progress_message = 'Report completed',
		    progress_updated_at = now()
		WHERE id = $1`,
		j.ReportID, string(metricsJSON), string(narrativeJSON),
		content.SessionsAnalyzed, string(aggregatedJSON), modelUsed); err != nil {
		return err
	}

	// The requester only: scheduled batch reports carry no requester and
	// deliver nothing, so weekly sweeps never fill inboxes.
	if j.TriggeredBy != "" {
		if err := deliverInsightReady(ctx, tx, j.ReportID, j.TriggeredBy, agentName); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// deliverInsightReady writes the report-ready inbox item; a redelivery of
// the same report is absorbed by the dedupe key.
func deliverInsightReady(ctx context.Context, tx pgx.Tx, reportID, userID, agentName string) error {
	label := agentName
	if label == "" {
		label = "insight report"
	}
	itemID := uuid.New()
	tag, err := tx.Exec(ctx, `
		INSERT INTO inbox_items (
		   id, user_id, kind, state, action_required, title, body,
		   subject_type, subject_id, subject_namespace, subject_slug,
		   action_url, action_command, actor_id, project_id, is_private_subject,
		   dedupe_key, payload, created_at)
		VALUES ($1, $2, 'insight_ready', 'open', FALSE, $3, NULL,
		        'insight_report', $4, NULL, NULL, NULL, NULL, NULL, NULL, FALSE,
		        $5, '{}', now())
		ON CONFLICT ON CONSTRAINT uq_inbox_items_user_dedupe DO NOTHING`,
		itemID, userID, truncateRunes("Insight report ready: "+label, 255),
		reportID, truncateRunes("insight_ready:"+reportID, 255))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return nil
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO inbox_item_events (id, item_id, event, actor_id, detail, created_at)
		VALUES ($1, $2, 'created', NULL, NULL, now())`, uuid.New(), itemID)
	return err
}

// Fail marks the report failed with the cause.
func (s *Store) Fail(ctx context.Context, reportID, message string) error {
	_, err := s.DB.Exec(ctx, `
		UPDATE insight_reports
		SET status = 'failed',
		    error_message = $2,
		    completed_at = now(),
		    progress_phase = 'failed',
		    progress_message = $2,
		    progress_updated_at = now()
		WHERE id = $1`, reportID, message)
	return err
}
