// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"context"
	"encoding/json"
	"log/slog"
	"regexp"
	"sort"
	"strings"

	"github.com/garudex-labs/caracal/internal/clickhouse"
)

// layerGroup is one layer-hash cohort's metrics.
type layerGroup struct {
	AgentVersion       string  `json:"agent_version"`
	LayerHash          string  `json:"layer_hash"`
	Sessions           int     `json:"sessions"`
	Users              int     `json:"users"`
	AvgPrompts         float64 `json:"avg_prompts"`
	AvgToolCalls       float64 `json:"avg_tool_calls"`
	AvgDurationSeconds float64 `json:"avg_duration_seconds"`
	AvgCost            float64 `json:"avg_cost"`
	AvgTokens          int64   `json:"avg_tokens"`
	ToolErrorRate      float64 `json:"tool_error_rate"`
	SuccessProxy       float64 `json:"success_proxy"`
}

func median(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	ordered := append([]float64{}, values...)
	sort.Float64s(ordered)
	mid := len(ordered) / 2
	if len(ordered)%2 == 1 {
		return ordered[mid]
	}
	return (ordered[mid-1] + ordered[mid]) / 2
}

// robustOutlierLabels labels layer cohorts using median/MAD so outliers do
// not poison means.
func robustOutlierLabels(groups []layerGroup) map[string]string {
	labels := map[string]string{}
	if len(groups) < 3 {
		for _, g := range groups {
			labels[g.LayerHash] = "normal"
		}
		return labels
	}
	values := make([]float64, 0, len(groups))
	for _, g := range groups {
		values = append(values, g.SuccessProxy)
	}
	med := median(values)
	deviations := make([]float64, 0, len(values))
	for _, v := range values {
		deviations = append(deviations, absFloat(v-med))
	}
	mad := median(deviations)
	if mad == 0 {
		mad = 1e-9
	}
	for _, g := range groups {
		robustZ := 0.6745 * (g.SuccessProxy - med) / mad
		switch {
		case robustZ >= 2.5:
			labels[g.LayerHash] = "positive_outlier"
		case robustZ <= -2.5:
			labels[g.LayerHash] = "negative_outlier"
		default:
			labels[g.LayerHash] = "normal"
		}
	}
	return labels
}

func absFloat(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}

func confidenceForGroups(groups []layerGroup, significant bool) string {
	totalSessions := 0
	multiUserGroups := 0
	for _, g := range groups {
		totalSessions += g.Sessions
		if g.Users >= 2 {
			multiUserGroups++
		}
	}
	switch {
	case totalSessions < 10 || len(groups) < 2:
		return "insufficient_data"
	case significant && totalSessions >= 30 && multiUserGroups >= 2:
		return "high"
	case significant && totalSessions >= 15:
		return "medium"
	default:
		return "low"
	}
}

// detectLayerGroups groups sessions by layer hash and computes metrics per
// group, largest first.
func (e *Engine) detectLayerGroups(ctx context.Context, agentID, agentName, periodStart, periodEnd, agentVersion string) []layerGroup {
	sql := `
		SELECT
			if(
				agent_version = '' AND {agent_version:String} = '` + legacyUnversioned + `',
				'` + legacyUnversioned + `',
				agent_version
			) AS agent_version,
			layer_hash,
			count() AS sessions,
			uniq(user_id) AS users,
			avg(prompt_count) AS avg_prompts,
			avg(tool_call_count) AS avg_tool_calls,
			avg(toFloat64(last_event_time - first_event_time)) AS avg_duration_seconds,
			sum(total_credits) / count() AS avg_cost,
			sum(input_tokens + output_tokens) / count() AS avg_tokens,
			-- Tool error proxy: more results than calls means retries or errors.
			countIf(tool_result_count > tool_call_count * 1.5) / count() AS tool_error_rate,
			-- Success proxy: sessions that ran long enough to do real work.
			countIf(event_count > 5 AND prompt_count >= 1) / count() AS success_proxy
		FROM session_stats_agg FINAL
		WHERE (agent_id = {agent_id:String} OR agent_id = {agent_name:String})
		  AND last_event_time >= {t_start:String}
		  AND last_event_time <= {t_end:String}
		  AND layer_hash != ''
		  AND ` + versionFilter("agent_version", false) + `
		GROUP BY
			if(
				agent_version = '' AND {agent_version:String} = '` + legacyUnversioned + `',
				'` + legacyUnversioned + `',
				agent_version
			),
			layer_hash
		HAVING sessions >= 3
		ORDER BY sessions DESC
		LIMIT 20
		FORMAT JSON`
	rows, err := e.CH.QueryJSON(ctx, sql, clickhouse.Settings{
		"param_agent_id":      agentID,
		"param_agent_name":    agentName,
		"param_t_start":       periodStart,
		"param_t_end":         periodEnd,
		"param_agent_version": agentVersion,
	})
	if err != nil {
		slog.Warn("layer group read failed", "error", err)
		return nil
	}
	groups := make([]layerGroup, 0, len(rows))
	for _, row := range rows {
		groups = append(groups, layerGroup{
			AgentVersion:       chString(row, "agent_version"),
			LayerHash:          chString(row, "layer_hash"),
			Sessions:           chInt(row, "sessions"),
			Users:              chInt(row, "users"),
			AvgPrompts:         roundTo(chFloat(row, "avg_prompts"), 1),
			AvgToolCalls:       roundTo(chFloat(row, "avg_tool_calls"), 1),
			AvgDurationSeconds: roundTo(chFloat(row, "avg_duration_seconds"), 0),
			AvgCost:            roundTo(chFloat(row, "avg_cost"), 4),
			AvgTokens:          int64(chFloat(row, "avg_tokens")),
			ToolErrorRate:      roundTo(chFloat(row, "tool_error_rate"), 3),
			SuccessProxy:       roundTo(chFloat(row, "success_proxy"), 3),
		})
	}
	return groups
}

var hexRe = regexp.MustCompile(`^[0-9a-fA-F]+$`)

// fetchLayerSnapshots reads stored layer snapshots for a list of hashes,
// scoped to the project. Hashes are rejected unless strictly hex.
func (e *Engine) fetchLayerSnapshots(ctx context.Context, projectID string, layerHashes []string) map[string]map[string]any {
	out := map[string]map[string]any{}
	safe := []string{}
	for _, h := range layerHashes {
		if hexRe.MatchString(h) {
			safe = append(safe, "'"+h+"'")
		}
	}
	if len(safe) == 0 {
		return out
	}
	rows, err := e.CH.QueryJSON(ctx, `
		SELECT hash, content
		FROM layer_snapshots FINAL
		WHERE project_id = {project_id:String}
		  AND hash IN ({hashes:Array(String)})
		FORMAT JSON`, clickhouse.Settings{
		"param_project_id": projectID,
		"param_hashes":     "[" + strings.Join(safe, ",") + "]",
	})
	if err != nil {
		slog.Warn("layer snapshot read failed", "error", err)
		return out
	}
	for _, row := range rows {
		var content map[string]any
		if json.Unmarshal([]byte(chString(row, "content")), &content) != nil {
			continue
		}
		if hash := chString(row, "hash"); hash != "" {
			out[hash] = content
		}
	}
	return out
}

// snapshotFiles flattens a snapshot to {harness/path: hash}.
func snapshotFiles(snap map[string]any) map[string]string {
	out := map[string]string{}
	for harnessName, filesAny := range asMap(snap["harnesses"]) {
		for _, fileAny := range asList(filesAny) {
			file := asMap(fileAny)
			if file == nil {
				continue
			}
			out[harnessName+"/"+str(file["path"])] = str(file["hash"])
		}
	}
	return out
}

// diffSnapshots summarizes what differs between two layer snapshots.
func diffSnapshots(snapA, snapB map[string]any) map[string]any {
	filesA := snapshotFiles(snapA)
	filesB := snapshotFiles(snapB)
	added := []string{}
	removed := []string{}
	modified := []string{}
	for path := range filesB {
		if _, ok := filesA[path]; !ok {
			added = append(added, path)
		}
	}
	for path, hashA := range filesA {
		hashB, ok := filesB[path]
		if !ok {
			removed = append(removed, path)
		} else if hashA != hashB {
			modified = append(modified, path)
		}
	}
	sort.Strings(added)
	sort.Strings(removed)
	sort.Strings(modified)
	return map[string]any{"added": added, "removed": removed, "modified": modified}
}

// extractContentSummary pulls a brief, anonymized excerpt of the behavioral
// files (rules, agents, skills) out of a snapshot.
func extractContentSummary(snap map[string]any) string {
	const maxChars = 1500
	lines := []string{}
	charCount := 0
	for harnessName, filesAny := range asMap(snap["harnesses"]) {
		for _, fileAny := range asList(filesAny) {
			file := asMap(fileAny)
			if file == nil {
				continue
			}
			path := str(file["path"])
			content := str(file["content"])
			if content == "" {
				continue
			}
			behavioral := false
			for _, marker := range []string{"CLAUDE.md", "AGENTS.md", "agents/", "skills/", "rules/"} {
				if strings.Contains(path, marker) {
					behavioral = true
					break
				}
			}
			if !behavioral {
				continue
			}
			snippet := content
			if len(snippet) > 500 {
				snippet = snippet[:500]
			}
			entry := "[" + harnessName + ":" + path + "]\n" + snippet
			if charCount+len(entry) > maxChars {
				break
			}
			lines = append(lines, entry)
			charCount += len(entry)
		}
	}
	if len(lines) == 0 {
		return "(no behavioral content captured)"
	}
	return strings.Join(lines, "\n---\n")
}

func snapshotCanonical(snap map[string]any) any {
	drift := asMap(snap["drift"])
	if drift == nil {
		return nil
	}
	value, present := drift["is_canonical"]
	if !present {
		return nil
	}
	return value
}

// buildVersionImpactData assembles the cross-user configuration impact
// block, fetching snapshot content only when the metric gap justifies it.
// A nil result means insufficient data.
func (e *Engine) buildVersionImpactData(ctx context.Context, agentID, agentName, periodStart, periodEnd, agentVersion, projectID string) map[string]any {
	groups := e.detectLayerGroups(ctx, agentID, agentName, periodStart, periodEnd, agentVersion)
	if len(groups) < 2 {
		return nil
	}

	bestSuccess, worstSuccess := groups[0].SuccessProxy, groups[0].SuccessProxy
	bestError, worstError := groups[0].ToolErrorRate, groups[0].ToolErrorRate
	totalSessions, totalUsers := 0, 0
	for _, g := range groups {
		bestSuccess = maxFloat(bestSuccess, g.SuccessProxy)
		worstSuccess = minFloat(worstSuccess, g.SuccessProxy)
		bestError = minFloat(bestError, g.ToolErrorRate)
		worstError = maxFloat(worstError, g.ToolErrorRate)
		totalSessions += g.Sessions
		totalUsers += g.Users
	}
	successGap := bestSuccess - worstSuccess
	errorGap := worstError - bestError
	outlierLabels := robustOutlierLabels(groups)

	anyOutlier := false
	for _, label := range outlierLabels {
		if label != "normal" {
			anyOutlier = true
			break
		}
	}
	// At least a 20-point success gap or 15-point error gap; outlier labels
	// add sensitivity without letting outliers poison means.
	significant := successGap >= 0.20 || errorGap >= 0.15 || anyOutlier
	confidence := confidenceForGroups(groups, significant)

	if !significant {
		lightweight := []map[string]any{}
		for _, g := range groups[:min(5, len(groups))] {
			lightweight = append(lightweight, map[string]any{
				"layer_hash":      g.LayerHash,
				"sessions":        g.Sessions,
				"users":           g.Users,
				"success_proxy":   g.SuccessProxy,
				"tool_error_rate": g.ToolErrorRate,
				"outlier_label":   outlierLabels[g.LayerHash],
			})
		}
		return map[string]any{
			"group_count":    len(groups),
			"total_sessions": totalSessions,
			"total_users":    totalUsers,
			"significant":    false,
			"confidence":     confidence,
			"groups":         lightweight,
			"finding":        "No significant performance difference between configurations.",
		}
	}

	topHashes := []string{}
	for _, g := range groups[:min(5, len(groups))] {
		topHashes = append(topHashes, g.LayerHash)
	}
	snapshots := e.fetchLayerSnapshots(ctx, projectID, topHashes)

	groupsWithData := []layerGroup{}
	for _, g := range groups {
		if _, ok := snapshots[g.LayerHash]; ok {
			groupsWithData = append(groupsWithData, g)
		}
	}
	if len(groupsWithData) < 2 {
		return nil
	}

	canonicalSessions, dirtySessions, canonicalUsers, dirtyUsers := 0, 0, 0, 0
	for _, g := range groupsWithData {
		if isCanonical, ok := snapshotCanonical(snapshots[g.LayerHash]).(bool); ok {
			if isCanonical {
				canonicalSessions += g.Sessions
				canonicalUsers += g.Users
			} else {
				dirtySessions += g.Sessions
				dirtyUsers += g.Users
			}
		}
	}

	sortedBySuccess := append([]layerGroup{}, groupsWithData...)
	sort.SliceStable(sortedBySuccess, func(i, j int) bool {
		return sortedBySuccess[i].SuccessProxy > sortedBySuccess[j].SuccessProxy
	})
	bestGroup := sortedBySuccess[0]
	worstGroup := sortedBySuccess[len(sortedBySuccess)-1]
	bestSnap := snapshots[bestGroup.LayerHash]
	worstSnap := snapshots[worstGroup.LayerHash]

	inspirationCandidates := []map[string]any{}
	isolatedRegressions := []map[string]any{}
	for _, g := range groupsWithData {
		label := outlierLabels[g.LayerHash]
		if g.Sessions < 3 || label == "normal" {
			continue
		}
		snap := snapshots[g.LayerHash]
		candidate := map[string]any{
			"layer_hash":      g.LayerHash,
			"agent_version":   g.AgentVersion,
			"sessions":        g.Sessions,
			"users":           g.Users,
			"success_proxy":   g.SuccessProxy,
			"tool_error_rate": g.ToolErrorRate,
			"is_canonical":    snapshotCanonical(snap),
			"content_summary": extractContentSummary(snap),
			"confidence":      confidence,
		}
		if label == "positive_outlier" {
			candidate["diff_vs_baseline"] = diffSnapshots(worstSnap, snap)
			inspirationCandidates = append(inspirationCandidates, candidate)
		} else {
			candidate["diff_vs_best"] = diffSnapshots(bestSnap, snap)
			candidate["baseline_policy"] = "excluded_from_canonical_mean"
			isolatedRegressions = append(isolatedRegressions, candidate)
		}
	}

	groupRows := []map[string]any{}
	for _, g := range groupsWithData {
		groupRows = append(groupRows, map[string]any{
			"layer_hash":           g.LayerHash,
			"sessions":             g.Sessions,
			"users":                g.Users,
			"success_proxy":        g.SuccessProxy,
			"tool_error_rate":      g.ToolErrorRate,
			"avg_cost":             g.AvgCost,
			"avg_duration_seconds": g.AvgDurationSeconds,
			"outlier_label":        outlierLabels[g.LayerHash],
			"is_canonical":         snapshotCanonical(snapshots[g.LayerHash]),
		})
	}

	return map[string]any{
		"group_count":     len(groups),
		"total_sessions":  totalSessions,
		"total_users":     totalUsers,
		"significant":     true,
		"confidence":      confidence,
		"success_gap_pct": roundTo(successGap*100, 1),
		"error_gap_pct":   roundTo(errorGap*100, 1),
		"canonical_dirty_summary": map[string]any{
			"canonical_sessions": canonicalSessions,
			"dirty_sessions":     dirtySessions,
			"canonical_users":    canonicalUsers,
			"dirty_users":        dirtyUsers,
		},
		"groups": groupRows,
		"best_config": map[string]any{
			"layer_hash":      bestGroup.LayerHash,
			"metrics":         bestGroup,
			"content_summary": extractContentSummary(bestSnap),
			"versions":        pinnedVersions(bestSnap),
		},
		"worst_config": map[string]any{
			"layer_hash":      worstGroup.LayerHash,
			"metrics":         worstGroup,
			"content_summary": extractContentSummary(worstSnap),
			"versions":        pinnedVersions(worstSnap),
		},
		"config_diff_best_vs_worst": diffSnapshots(bestSnap, worstSnap),
		"inspiration_candidates":    inspirationCandidates,
		"isolated_regressions":      isolatedRegressions,
	}
}

func pinnedVersions(snap map[string]any) map[string]any {
	if versions := asMap(snap["pinned_versions"]); versions != nil {
		return versions
	}
	return map[string]any{}
}

func maxFloat(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

func minFloat(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}
