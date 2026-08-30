// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
)

// maxFacetSessions caps how many sessions get full transcript and facet
// extraction.
const maxFacetSessions = 50

// pipelineInput carries everything the report pipeline needs.
type pipelineInput struct {
	AgentName              string
	AgentID                string
	AgentVersion           string
	ComparisonAgentVersion string
	PeriodStart            string
	PeriodEnd              string
	PreviousMetrics        map[string]any
	AgentConfig            map[string]any
	Scope                  registryScope
	Progress               func(phase string, current, total int, message string)
}

// reportContent is the pipeline's output, persisted by the runner.
type reportContent struct {
	Metrics          map[string]any
	Narrative        map[string]any
	SessionsAnalyzed int
	ModelsUsed       []string
	FacetsSummary    any
	Regressions      []any
	CrossUsers       map[string]any
}

func emitProgress(input *pipelineInput, phase string, current, total int, message string) {
	if input.Progress != nil {
		input.Progress(phase, current, total, message)
	}
}

// GenerateReportContent runs the full pipeline: deterministic metadata,
// facet extraction, version analysis, section generation, and reuse
// grounding.
func (e *Engine) GenerateReportContent(ctx context.Context, input *pipelineInput) *reportContent {
	slog.Info("insight pipeline started",
		"agent", input.AgentName, "agent_id", input.AgentID,
		"agent_version", input.AgentVersion, "period", input.PeriodStart+" to "+input.PeriodEnd)

	emitProgress(input, "extracting_metadata", 1, 9, "Extracting deterministic session metadata")

	// Step 1: deterministic metadata from raw JSONL.
	sessionMetas := e.extractAllSessionMetas(ctx, input.AgentID, input.AgentName,
		input.PeriodStart, input.PeriodEnd, input.AgentVersion)
	if len(sessionMetas) == 0 {
		slog.Warn("no sessions in period", "agent_id", input.AgentID)
		return emptyReport()
	}

	emitProgress(input, "building_transcripts", 2, 9, "Building session transcripts")
	agg := aggregateMetas(sessionMetas)

	sessionIDs := make([]string, 0, len(sessionMetas))
	metasByID := map[string]*sessionMeta{}
	for _, m := range sessionMetas {
		sessionIDs = append(sessionIDs, m.SessionID)
		metasByID[m.SessionID] = m
	}
	facetsBySession, err := e.loadCachedFacetsBatch(ctx, sessionIDs)
	if err != nil {
		slog.Warn("cached facet read failed", "error", err)
		facetsBySession = map[string]map[string]any{}
	}
	slog.Info("cached facets loaded", "count", len(facetsBySession))

	// Transcripts only for the top sessions that still need facets.
	topSessions := rankSessionsForFacets(sessionMetas, facetsBySession, maxFacetSessions)
	transcripts := e.buildTranscripts(ctx, topSessions)
	slog.Info("transcripts built", "count", len(transcripts))

	emitProgress(input, "extracting_facets", 3, 9, "Extracting qualitative session facets")
	maxConcurrent := e.Config.Int(ctx, "insights.facet_concurrency", 25)
	if maxConcurrent < 1 {
		maxConcurrent = 1
	}
	for sid, facets := range e.extractFacetsBatch(ctx, transcripts, input.AgentID, maxConcurrent) {
		facetsBySession[sid] = facets
	}
	allFacets := []map[string]any{}
	for _, sid := range sessionIDs {
		if facets := facetsBySession[sid]; len(facets) > 0 {
			allFacets = append(allFacets, facets)
		}
	}
	slog.Info("facets extracted", "count", len(allFacets))

	emitProgress(input, "analyzing_versions", 4, 9, "Analyzing versions, layers, and dirty cohorts")

	modelEfficiency, estimatedWaste := analyzeModelEfficiency(sessionMetas, facetsBySession, agg)
	componentUtilization := analyzeComponentUtilization(input.AgentConfig, sessionMetas, allFacets)

	// Facet a bounded prior-version cohort for A/B comparison.
	comparisonCohort := e.buildComparisonCohort(ctx, input, maxConcurrent)

	// Step 4: the data block section prompts read.
	facetsAgg := aggregateFacets(allFacets)
	cacheRead := agg.TotalCacheReadToks
	cacheWrite := agg.TotalCacheWriteToks
	inputTokens := agg.TotalInputTokens
	var cacheHitRate any
	if denominator := inputTokens + cacheRead + cacheWrite; denominator > 0 {
		cacheHitRate = roundTo(float64(cacheRead)/float64(denominator)*100, 1)
	}
	dataBlock := buildDataBlock(input.AgentName, agg, facetsAgg, allFacets,
		input.PeriodStart, input.PeriodEnd, input.AgentConfig,
		modelEfficiency, estimatedWaste, componentUtilization)
	if comparisonCohort != nil {
		if blob, err := json.MarshalIndent(comparisonCohort, "", "  "); err == nil {
			dataBlock += "\n\n## Prior Version Comparison Cohort\n" + string(blob)
		}
	}

	// Step 4b: version impact analysis; never fatal.
	versionImpact := e.buildVersionImpactData(ctx, input.AgentID, input.AgentName,
		input.PeriodStart, input.PeriodEnd, input.AgentVersion, DefaultProjectID)
	if versionImpact != nil {
		if blob, err := json.MarshalIndent(versionImpact, "", "  "); err == nil {
			dataBlock += "\n\n## Version Impact\n" + string(blob)
			slog.Info("version impact detected", "groups", versionImpact["group_count"])
		}
	}

	// Step 4c: shortlist reusable registry components, driven by this
	// report's own signals; an empty offer just omits the catalog block.
	registrySignals := buildSignals(agg, facetsAgg, input.AgentConfig)
	registryOffer := e.buildCatalog(ctx, input.Scope, registrySignals)

	// Step 5: narrative sections plus one synthesis pass.
	emitProgress(input, "generating_sections", 7, 9, "Generating report sections")
	narrative := e.generateSections(ctx, dataBlock, input.PreviousMetrics, registryOffer)

	// Ground every reuse suggestion before anything renders it: an id the
	// model invented must never reach the UI as a real component link.
	e.validateReuseSuggestions(ctx, narrative, registryOffer, input.Scope)
	narrative["registry_match"] = registryOffer.summary(countReused(narrative))

	emitProgress(input, "synthesizing", 8, 9, "Synthesizing report")
	slog.Info("insight pipeline complete", "sessions", len(sessionMetas), "facets", len(allFacets))

	var facetsSummaryValue any
	if facetsAgg != nil {
		facetsSummaryValue = facetsAgg
	} else {
		facetsSummaryValue = map[string]any{}
	}

	metrics := map[string]any{
		"rich": buildRichMetrics(agg, cacheRead, cacheWrite, inputTokens, cacheHitRate,
			modelEfficiency, estimatedWaste, comparisonCohort, versionImpact, componentUtilization),
		"overview": map[string]any{
			"total_sessions": agg.TotalSessions,
			"unique_users":   1,
		},
	}

	return &reportContent{
		Metrics:          metrics,
		Narrative:        narrative,
		SessionsAnalyzed: len(sessionMetas),
		ModelsUsed:       []string{},
		FacetsSummary:    facetsSummaryValue,
		Regressions:      []any{},
		CrossUsers:       map[string]any{},
	}
}

// rankSessionsForFacets orders sessions by activity weight and keeps the
// ones without cached facets.
func rankSessionsForFacets(metas []*sessionMeta, cached map[string]map[string]any, limit int) []*sessionMeta {
	ranked := append([]*sessionMeta{}, metas...)
	sort.SliceStable(ranked, func(i, j int) bool {
		return ranked[i].DurationSeconds*float64(ranked[i].toolCallTotal()) >
			ranked[j].DurationSeconds*float64(ranked[j].toolCallTotal())
	})
	top := []*sessionMeta{}
	for _, m := range ranked {
		if _, ok := cached[m.SessionID]; ok {
			continue
		}
		top = append(top, m)
		if len(top) == limit {
			break
		}
	}
	return top
}

func (e *Engine) buildTranscripts(ctx context.Context, metas []*sessionMeta) map[string]string {
	transcripts := map[string]string{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, meta := range metas {
		wg.Add(1)
		go func(sid string) {
			defer wg.Done()
			transcript := e.buildSessionTranscript(ctx, sid)
			if strings.TrimSpace(transcript) == "" {
				return
			}
			mu.Lock()
			transcripts[sid] = transcript
			mu.Unlock()
		}(meta.SessionID)
	}
	wg.Wait()
	return transcripts
}

// extractFacetsBatch extracts facets with a concurrency ceiling.
func (e *Engine) extractFacetsBatch(ctx context.Context, transcripts map[string]string, agentID string, maxConcurrent int) map[string]map[string]any {
	out := map[string]map[string]any{}
	if len(transcripts) == 0 {
		return out
	}
	semaphore := make(chan struct{}, maxConcurrent)
	var mu sync.Mutex
	var wg sync.WaitGroup
	for sid, transcript := range transcripts {
		wg.Add(1)
		go func(sid, transcript string) {
			defer wg.Done()
			semaphore <- struct{}{}
			defer func() { <-semaphore }()
			facets := e.extractAndCacheFacets(ctx, sid, agentID, transcript)
			if len(facets) == 0 {
				return
			}
			mu.Lock()
			out[sid] = facets
			mu.Unlock()
		}(sid, transcript)
	}
	wg.Wait()
	return out
}

// buildComparisonCohort facets a bounded prior-version cohort so the
// version comparison section reads real data rather than stale aggregates.
func (e *Engine) buildComparisonCohort(ctx context.Context, input *pipelineInput, maxConcurrent int) map[string]any {
	if input.ComparisonAgentVersion == "" || input.ComparisonAgentVersion == input.AgentVersion {
		return nil
	}
	priorMetas := e.extractAllSessionMetas(ctx, input.AgentID, input.AgentName,
		input.PeriodStart, input.PeriodEnd, input.ComparisonAgentVersion)
	if len(priorMetas) == 0 {
		return nil
	}
	priorAgg := aggregateMetas(priorMetas)
	priorIDs := make([]string, 0, len(priorMetas))
	for _, m := range priorMetas {
		priorIDs = append(priorIDs, m.SessionID)
	}
	priorFacets, err := e.loadCachedFacetsBatch(ctx, priorIDs)
	if err != nil {
		slog.Warn("prior cohort facet read failed", "error", err)
		priorFacets = map[string]map[string]any{}
	}
	priorTop := rankSessionsForFacets(priorMetas, priorFacets, min(maxFacetSessions, 25))
	priorTranscripts := e.buildTranscripts(ctx, priorTop)
	for sid, facets := range e.extractFacetsBatch(ctx, priorTranscripts, input.AgentID, maxConcurrent) {
		priorFacets[sid] = facets
	}
	facetsList := []map[string]any{}
	for _, sid := range priorIDs {
		if facets := priorFacets[sid]; len(facets) > 0 {
			facetsList = append(facetsList, facets)
		}
	}
	slog.Info("prior version cohort faceted",
		"current_version", input.AgentVersion, "prior_version", input.ComparisonAgentVersion,
		"sessions", len(priorMetas), "facets", len(facetsList))
	var priorFacetsSummary any
	if summary := aggregateFacets(facetsList); summary != nil {
		priorFacetsSummary = summary
	} else {
		priorFacetsSummary = map[string]any{}
	}
	return map[string]any{
		"current_version":        input.AgentVersion,
		"prior_version":          input.ComparisonAgentVersion,
		"prior_sessions":         len(priorMetas),
		"prior_metrics":          aggregateSummaryMap(priorAgg),
		"prior_facets_summary":   priorFacetsSummary,
		"prior_faceted_sessions": len(facetsList),
	}
}

// modelEfficiencyFlag is one flagged model/session pairing.
type modelEfficiencyFlag struct {
	Model       string  `json:"model"`
	SessionID   string  `json:"session_id"`
	Date        string  `json:"date"`
	Cost        float64 `json:"cost"`
	Outcome     string  `json:"outcome"`
	SessionType string  `json:"session_type"`
	Complexity  string  `json:"complexity"`
	Flag        string  `json:"flag"`
	Reason      string  `json:"reason"`
}

// analyzeModelEfficiency flags sessions where the model tier and the task
// shape disagree, and estimates the waste.
func analyzeModelEfficiency(metas []*sessionMeta, facetsBySession map[string]map[string]any, agg *metaAggregate) ([]modelEfficiencyFlag, float64) {
	flags := []modelEfficiencyFlag{}
	estimatedWaste := 0.0
	for _, meta := range metas {
		if len(meta.ModelUsage) == 0 {
			continue
		}
		facet := facetsBySession[meta.SessionID]
		if len(facet) == 0 {
			continue
		}

		// Primary model: highest cost, then most messages.
		modelName := ""
		var modelStats *modelUsage
		names := make([]string, 0, len(meta.ModelUsage))
		for name := range meta.ModelUsage {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			u := meta.ModelUsage[name]
			if modelStats == nil || u.Cost > modelStats.Cost ||
				(u.Cost == modelStats.Cost && u.Messages > modelStats.Messages) {
				modelName, modelStats = name, u
			}
		}
		tier := agg.ModelTiers[modelName]
		if tier == "" {
			tier = "mid"
		}

		sessionType := str(facet["session_type"])
		if sessionType == "" {
			sessionType = "single_task"
		}
		complexity := str(facet["complexity"])
		if complexity == "" {
			complexity = "medium"
		}
		outcome := str(facet["outcome"])
		if outcome == "" {
			outcome = "unclear"
		}

		isSimple := sessionType == "quick_question" || sessionType == "single_task" ||
			complexity == "trivial" || complexity == "low" ||
			(meta.UserMessageCount <= 3 && meta.DurationSeconds < 300)
		isComplex := sessionType == "multi_task" || sessionType == "iterative_refinement" ||
			complexity == "high" || complexity == "very_high" ||
			meta.UserMessageCount > 8 || meta.FilesModified > 5
		poorOutcome := outcome == "not_achieved" || outcome == "partially_achieved"
		goodOutcome := outcome == "fully_achieved" || outcome == "mostly_achieved"

		flag := "ok"
		reason := ""
		switch {
		case tier == "subscription":
			modelLower := strings.ToLower(modelName)
			isHeavy := containsAnyOf(modelLower, "opus", "pro", "medium", "large", "o1", "o3") &&
				!containsAnyOf(modelLower, "small", "mini", "flash", "haiku", "lite")
			if isSimple && goodOutcome && isHeavy && modelStats.Messages > 3 {
				flag = "quota_pressure"
				reason = fmt.Sprintf("Used %s (subscription) for a %s %s. "+
					"This model consumes more quota than lighter alternatives within the same plan.",
					modelName, complexity, sessionType)
			}
		case tier == "high" && isSimple && goodOutcome:
			flag = "overspend"
			reason = fmt.Sprintf("Used %s for a %s %s that succeeded. "+
				"A lower-tier model would likely suffice.", modelName, complexity, sessionType)
			estimatedWaste += modelStats.Cost * 0.8
		case tier == "low" && isComplex && poorOutcome:
			flag = "underspend"
			reason = fmt.Sprintf("Used %s for a %s %s that ended with %s. "+
				"A more capable model may have succeeded.", modelName, complexity, sessionType, outcome)
			estimatedWaste += modelStats.Cost
		case tier == "high" && poorOutcome && modelStats.Cost > 0.10:
			flag = "overspend"
			reason = fmt.Sprintf("Spent $%.2f on %s but outcome was %s. "+
				"Tokens were consumed without reaching the goal.", modelStats.Cost, modelName, outcome)
			estimatedWaste += modelStats.Cost * 0.5
		}

		if flag != "ok" {
			flags = append(flags, modelEfficiencyFlag{
				Model:       modelName,
				SessionID:   meta.SessionID,
				Date:        truncateRunes(meta.StartTime, 10),
				Cost:        modelStats.Cost,
				Outcome:     outcome,
				SessionType: sessionType,
				Complexity:  complexity,
				Flag:        flag,
				Reason:      reason,
			})
		}
	}
	sort.SliceStable(flags, func(i, j int) bool { return flags[i].Cost > flags[j].Cost })
	if len(flags) > 20 {
		flags = flags[:20]
	}
	return flags, estimatedWaste
}

func containsAnyOf(haystack string, needles ...string) bool {
	for _, n := range needles {
		if strings.Contains(haystack, n) {
			return true
		}
	}
	return false
}

// analyzeComponentUtilization estimates, deterministically, whether the
// attached skills and hooks were actually observed in use.
func analyzeComponentUtilization(agentConfig map[string]any, metas []*sessionMeta, allFacets []map[string]any) []map[string]any {
	type component struct{ compType, name string }
	components := []component{}
	if agentConfig != nil {
		for _, name := range asList(agentConfig["configured_skills"]) {
			components = append(components, component{"skill", fmt.Sprint(name)})
		}
		for _, name := range asList(agentConfig["configured_hooks"]) {
			components = append(components, component{"hook", fmt.Sprint(name)})
		}
	}
	if len(components) == 0 {
		return []map[string]any{}
	}
	parts := []string{}
	for _, m := range metas {
		parts = append(parts, m.FirstPrompt)
	}
	for _, f := range allFacets {
		if len(f) > 0 {
			parts = append(parts, str(f["brief_summary"]))
		}
	}
	for _, m := range metas {
		tools := make([]string, 0, len(m.ToolCounts))
		for tool := range m.ToolCounts {
			tools = append(tools, tool)
		}
		sort.Strings(tools)
		parts = append(parts, strings.Join(tools, " "))
	}
	searchable := strings.ToLower(strings.Join(parts, "\n"))

	results := []map[string]any{}
	for _, comp := range components {
		key := strings.ReplaceAll(strings.ToLower(comp.name), "-", " ")
		compact := strings.ToLower(comp.name)
		mentions := strings.Count(searchable, key) + strings.Count(searchable, compact)
		status := "unused_or_unobserved"
		confidence := "low"
		if mentions > 0 {
			status = "used"
			confidence = "medium"
		}
		results = append(results, map[string]any{
			"type":              comp.compType,
			"name":              comp.name,
			"observed_mentions": mentions,
			"status":            status,
			"confidence":        confidence,
		})
	}
	return results
}

// aggregateSummaryMap renders the aggregate as the prior-cohort metrics
// object embedded in the comparison block.
func aggregateSummaryMap(agg *metaAggregate) map[string]any {
	modelUsage := map[string]any{}
	for _, model := range agg.modelsByCost() {
		u := agg.ModelUsage[model]
		modelUsage[model] = map[string]any{
			"input_tokens":       u.InputTokens,
			"output_tokens":      u.OutputTokens,
			"cost":               u.Cost,
			"messages":           u.Messages,
			"sessions":           u.Sessions,
			"tier":               u.Tier,
			"cost_per_1k_tokens": u.CostPer1K,
		}
	}
	return map[string]any{
		"total_sessions":           agg.TotalSessions,
		"total_messages":           agg.TotalMessages,
		"total_duration_hours":     agg.TotalDurationHours,
		"total_input_tokens":       agg.TotalInputTokens,
		"total_output_tokens":      agg.TotalOutputTokens,
		"total_cache_read_tokens":  agg.TotalCacheReadToks,
		"total_cache_write_tokens": agg.TotalCacheWriteToks,
		"total_cost":               agg.TotalCost,
		"total_credits":            agg.TotalCredits,
		"total_lines_added":        agg.TotalLinesAdded,
		"total_lines_removed":      agg.TotalLinesRemoved,
		"total_files_modified":     agg.TotalFilesModified,
		"git_commits":              agg.GitCommits,
		"git_pushes":               agg.GitPushes,
		"total_tool_errors":        agg.TotalToolErrors,
		"total_interruptions":      agg.TotalInterruptions,
		"sessions_using_subagent":  agg.SessionsUsingSubag,
		"sessions_using_mcp":       agg.SessionsUsingMCP,
		"days_active":              agg.DaysActive,
		"harnesses":                agg.Harnesses,
		"sessions_with_tokens":     agg.SessionsWithTokens,
		"sessions_with_credits":    agg.SessionsWithCredits,
		"top_tools":                agg.TopTools,
		"top_languages":            agg.TopLanguages,
		"tool_error_categories":    agg.ToolErrorCategories.counts,
		"projects":                 agg.Projects.counts,
		"model_usage":              modelUsage,
		"model_tiers":              agg.ModelTiers,
	}
}

// buildRichMetrics is the stat-card payload the frontend reads.
func buildRichMetrics(agg *metaAggregate, cacheRead, cacheWrite, inputTokens int64, cacheHitRate any,
	modelEfficiency []modelEfficiencyFlag, estimatedWaste float64,
	comparisonCohort map[string]any, versionImpact map[string]any, componentUtilization []map[string]any,
) map[string]any {
	modelUsage := map[string]any{}
	for _, model := range agg.modelsByCost() {
		u := agg.ModelUsage[model]
		modelUsage[model] = map[string]any{
			"cost":     u.Cost,
			"messages": u.Messages,
			"sessions": u.Sessions,
			"tier":     u.Tier,
		}
	}
	efficiency := modelEfficiency
	if len(efficiency) > 10 {
		efficiency = efficiency[:10]
	}
	topTools := agg.TopTools
	if len(topTools) > 15 {
		topTools = topTools[:15]
	}
	topLanguages := agg.TopLanguages
	if len(topLanguages) > 10 {
		topLanguages = topLanguages[:10]
	}
	var canonicalDirty any
	inspiration := []any{}
	regressions := []any{}
	if versionImpact != nil {
		canonicalDirty = versionImpact["canonical_dirty_summary"]
		if v, ok := versionImpact["inspiration_candidates"].([]map[string]any); ok {
			for _, item := range v {
				inspiration = append(inspiration, item)
			}
		}
		if v, ok := versionImpact["isolated_regressions"].([]map[string]any); ok {
			for _, item := range v {
				regressions = append(regressions, item)
			}
		}
	}
	var comparison any
	if comparisonCohort != nil {
		comparison = comparisonCohort
	}
	return map[string]any{
		"total_sessions":                  agg.TotalSessions,
		"total_messages":                  agg.TotalMessages,
		"active_hours":                    roundTo(agg.TotalDurationHours, 1),
		"days_active":                     agg.DaysActive,
		"lines_added":                     agg.TotalLinesAdded,
		"lines_removed":                   agg.TotalLinesRemoved,
		"files_modified":                  agg.TotalFilesModified,
		"git_commits":                     agg.GitCommits,
		"git_pushes":                      agg.GitPushes,
		"tool_errors":                     agg.TotalToolErrors,
		"interruptions":                   agg.TotalInterruptions,
		"subagent_sessions":               agg.SessionsUsingSubag,
		"mcp_sessions":                    agg.SessionsUsingMCP,
		"total_cost_usd":                  roundTo(agg.TotalCost, 2),
		"total_credits":                   roundTo(agg.TotalCredits, 4),
		"total_input_tokens":              agg.TotalInputTokens,
		"total_output_tokens":             agg.TotalOutputTokens,
		"total_cache_read_tokens":         cacheRead,
		"total_cache_write_tokens":        cacheWrite,
		"cache_hit_rate_pct":              cacheHitRate,
		"estimated_uncached_input_tokens": inputTokens + cacheRead,
		"cache_tokens_saved":              cacheRead,
		"top_tools":                       topTools,
		"top_languages":                   topLanguages,
		"tool_error_categories":           agg.ToolErrorCategories.counts,
		"projects":                        agg.Projects.counts,
		"harnesses":                       agg.Harnesses,
		"ides":                            []any{},
		"sessions_with_tokens":            agg.SessionsWithTokens,
		"sessions_with_credits":           agg.SessionsWithCredits,
		"model_usage":                     modelUsage,
		"model_efficiency":                efficiency,
		"estimated_waste_usd":             roundTo(estimatedWaste, 2),
		"version_comparison_baseline":     comparison,
		"canonical_dirty_summary":         canonicalDirty,
		"inspiration_candidates":          inspiration,
		"isolated_regressions":            regressions,
		"component_utilization":           componentUtilization,
	}
}

// buildDataBlock renders the focused JSON summary plus session summaries,
// friction details, and user instructions the section prompts read.
func buildDataBlock(agentName string, agg *metaAggregate, facets *facetsSummary, allFacets []map[string]any,
	periodStart, periodEnd string, agentConfig map[string]any,
	modelEfficiency []modelEfficiencyFlag, estimatedWaste float64, componentUtilization []map[string]any,
) string {
	var cacheHitRate any
	if agg.TotalInputTokens != 0 || agg.TotalCacheReadToks != 0 || agg.TotalCacheWriteToks != 0 {
		denominator := max64(1, agg.TotalInputTokens+agg.TotalCacheReadToks+agg.TotalCacheWriteToks)
		cacheHitRate = roundTo(float64(agg.TotalCacheReadToks)/float64(denominator)*100, 1)
	}

	summary := map[string]any{
		"agent":                agentName,
		"period":               periodStart + " to " + periodEnd,
		"sessions":             agg.TotalSessions,
		"sessions_with_facets": 0,
		"date_range":           map[string]any{},
		"messages":             agg.TotalMessages,
		"hours":                int(roundTo(agg.TotalDurationHours, 0)),
		"days_active":          agg.DaysActive,
		"commits":              agg.GitCommits,
		"pushes":               agg.GitPushes,
		"cost_usd":             roundTo(agg.TotalCost, 2),
		"cache_efficiency": map[string]any{
			"cache_read_tokens":  agg.TotalCacheReadToks,
			"cache_write_tokens": agg.TotalCacheWriteToks,
			"input_tokens":       agg.TotalInputTokens,
			"cache_hit_rate_pct": cacheHitRate,
			"cache_tokens_saved": agg.TotalCacheReadToks,
		},
		"lines_added":           agg.TotalLinesAdded,
		"lines_removed":         agg.TotalLinesRemoved,
		"files_modified":        agg.TotalFilesModified,
		"tool_errors":           agg.TotalToolErrors,
		"interruptions":         agg.TotalInterruptions,
		"subagent_sessions":     agg.SessionsUsingSubag,
		"mcp_sessions":          agg.SessionsUsingMCP,
		"top_tools":             limitPairs(agg.TopTools, 10),
		"top_languages":         limitPairs(agg.TopLanguages, 10),
		"tool_error_categories": agg.ToolErrorCategories.counts,
		"projects":              agg.Projects.counts,
		"top_goals":             []pair{},
		"outcomes":              map[string]int{},
		"satisfaction":          map[string]int{},
		"helpfulness":           map[string]int{},
		"friction":              []pair{},
		"success":               []pair{},
		"session_types":         map[string]int{},
		"complexity":            map[string]int{},
	}
	if facets != nil {
		summary["sessions_with_facets"] = facets.SessionsWithFacets
		summary["top_goals"] = limitPairs(facets.GoalCategories, 10)
		summary["outcomes"] = facets.Outcomes
		summary["satisfaction"] = facets.Satisfaction
		summary["helpfulness"] = facets.Helpfulness
		summary["friction"] = limitPairs(facets.FrictionTypes, 10)
		summary["success"] = limitPairs(facets.SuccessFactors, 10)
		summary["session_types"] = facets.SessionTypes
		summary["complexity"] = facets.Complexity
	}

	if len(agg.ModelUsage) > 0 {
		modelLines := []string{}
		for _, model := range agg.modelsByCost() {
			u := agg.ModelUsage[model]
			cpt := "$0"
			if u.CostPer1K != 0 {
				cpt = fmt.Sprintf("$%.4f", u.CostPer1K)
			}
			modelLines = append(modelLines, fmt.Sprintf(
				"  %s: %d sessions, %d msgs, $%.2f total, tier=%s, $/1k-tok=%s",
				model, u.Sessions, u.Messages, u.Cost, u.Tier, cpt))
		}
		summary["model_breakdown"] = modelLines
	}

	summaryJSON, err := json.MarshalIndent(summary, "", "  ")
	if err != nil {
		summaryJSON = []byte("{}")
	}
	sections := []string{string(summaryJSON)}

	if agentConfig != nil {
		if blob, err := json.MarshalIndent(agentConfig, "", "  "); err == nil {
			sections = append(sections, "\n## Agent Configuration\n"+string(blob))
		}
	}

	if len(allFacets) > 0 {
		summaries := []string{}
		start := max(0, len(allFacets)-50)
		for _, f := range allFacets[start:] {
			if len(f) == 0 {
				continue
			}
			brief := str(f["brief_summary"])
			if brief == "" {
				continue
			}
			outcome := str(f["outcome"])
			if outcome == "" {
				outcome = "unclear"
			}
			helpfulness := str(f["agent_helpfulness"])
			if helpfulness == "" {
				helpfulness = "unknown"
			}
			summaries = append(summaries, fmt.Sprintf("- %s (%s, %s)", brief, outcome, helpfulness))
		}
		if len(summaries) > 0 {
			sections = append(sections, "\nSESSION SUMMARIES:\n"+strings.Join(summaries, "\n"))
		}

		frictionDetails := []string{}
		for _, f := range allFacets {
			for _, fpAny := range asList(f["friction_points"]) {
				fp := asMap(fpAny)
				if fp == nil {
					continue
				}
				desc := str(fp["description"])
				if desc == "" {
					continue
				}
				frictionDetails = append(frictionDetails, fmt.Sprintf("- [%s] %s", str(fp["type"]), desc))
			}
		}
		if len(frictionDetails) > 0 {
			if len(frictionDetails) > 30 {
				frictionDetails = frictionDetails[:30]
			}
			sections = append(sections, "\nFRICTION DETAILS:\n"+strings.Join(frictionDetails, "\n"))
		}

		userInstructions := []string{}
		for _, f := range allFacets {
			for _, instrAny := range asList(f["repeated_instructions"]) {
				if instr := str(instrAny); instr != "" {
					userInstructions = append(userInstructions, "- "+instr)
				}
			}
		}
		if len(userInstructions) > 0 {
			if len(userInstructions) > 20 {
				userInstructions = userInstructions[:20]
			}
			sections = append(sections, "\nUSER INSTRUCTIONS TO ASSISTANT:\n"+strings.Join(userInstructions, "\n"))
		}
	}

	if facets != nil && len(facets.RepeatedInstructions) > 0 {
		lines := []string{}
		for _, r := range facets.RepeatedInstructions {
			lines = append(lines, fmt.Sprintf("- %q (frequency: %v)", str(r["instruction"]), r["frequency"]))
			if len(lines) == 10 {
				break
			}
		}
		sections = append(sections, "\nREPEATED INSTRUCTIONS (by frequency):\n"+strings.Join(lines, "\n"))
	}

	if len(componentUtilization) > 0 {
		if blob, err := json.MarshalIndent(componentUtilization, "", "  "); err == nil {
			sections = append(sections, "\nCOMPONENT UTILIZATION:\n"+string(blob))
		}
	}

	if len(modelEfficiency) > 0 {
		effLines := []string{}
		limit := min(10, len(modelEfficiency))
		for _, e := range modelEfficiency[:limit] {
			effLines = append(effLines, fmt.Sprintf(
				"- [%s] %s on %s: $%.2f, %s %s, outcome=%s. %s",
				e.Flag, e.Model, e.Date, e.Cost, e.Complexity, e.SessionType, e.Outcome, e.Reason))
		}
		sections = append(sections, "\nMODEL EFFICIENCY FLAGS:\n"+strings.Join(effLines, "\n"))
		if estimatedWaste > 0 {
			sections = append(sections, fmt.Sprintf("\nEstimated waste from model mismatch: $%.2f", estimatedWaste))
		}
	}

	return strings.Join(sections, "\n")
}

func limitPairs(pairs []pair, limit int) []pair {
	if len(pairs) > limit {
		return pairs[:limit]
	}
	return pairs
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

// emptyReport is the completed shape saved when no sessions exist.
func emptyReport() *reportContent {
	return &reportContent{
		Metrics: map[string]any{},
		Narrative: map[string]any{
			"at_a_glance": map[string]any{
				"health":          "unknown",
				"whats_working":   "No session data available for this period.",
				"whats_hindering": "N/A",
				"quick_win":       "N/A",
			},
		},
		SessionsAnalyzed: 0,
		ModelsUsed:       []string{},
		FacetsSummary:    map[string]any{},
		Regressions:      []any{},
		CrossUsers:       map[string]any{},
	}
}
