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
)

const facetPrompt = `Analyze this session and extract structured facets.

CRITICAL GUIDELINES:

1. goal_categories: Count ONLY what the USER explicitly asked for.
   - DO NOT count autonomous exploration the assistant decided to do
   - ONLY count when user says "can you...", "please...", "I need...", "let's..."

2. user_satisfaction: Base ONLY on explicit user signals.
   - "Yay!", "great!", "perfect!" -> happy
   - "thanks", "looks good", "that works" -> satisfied
   - "ok, now let's..." (continuing without complaint) -> likely_satisfied
   - "that's not right", "try again" -> dissatisfied
   - "this is broken", "I give up" -> frustrated

3. friction_points: Be specific about what went wrong.
   - misunderstood_request: assistant interpreted the request incorrectly
   - wrong_approach: right goal, wrong solution method
   - buggy_code: code didn't work correctly
   - user_rejected_action: user said no/stop to a proposed action
   - excessive_changes: over-engineered or changed too much
   - slow_or_verbose: took too long or output too much text
   - tool_failed: a tool call errored
   - user_unclear: user's instructions were ambiguous
   - external_issue: problem outside the agent's control

4. repeated_instructions: direct instructions the user gave that should be remembered,
   e.g. "always show diffs before editing". Include only reusable instructions (not one-off requests).

5. If very short or just a warmup, use "warmup_minimal" for goal_categories.

SESSION:
%s

RESPOND WITH ONLY A VALID JSON OBJECT:
{
  "underlying_goal": "<what the user fundamentally wanted to accomplish>",
  "goal_categories": ["<from: debug_investigate, implement_feature, fix_bug, write_script_tool, refactor_code, configure_system, create_pr_commit, analyze_data, understand_codebase, write_tests, write_docs, deploy_infra, warmup_minimal>"],
  "outcome": "<fully_achieved | mostly_achieved | partially_achieved | not_achieved | unclear>",
  "user_satisfaction": "<frustrated | dissatisfied | likely_satisfied | satisfied | happy | unsure>",
  "agent_helpfulness": "<unhelpful | slightly_helpful | moderately_helpful | very_helpful | essential>",
  "session_type": "<single_task | multi_task | iterative_refinement | exploration | quick_question>",
  "complexity": "<trivial | low | medium | high | very_high>",
  "friction_points": [
    {
      "type": "<type from list above>",
      "description": "<specific description of what happened>",
      "severity": "<blocking | major | minor>"
    }
  ],
  "primary_success_factors": ["<from: fast_accurate_search, correct_code_edits, good_explanations, proactive_help, multi_file_changes, good_debugging>"],
  "tools_effective": ["<tool names that worked well>"],
  "tools_problematic": [{"tool": "<name>", "reason": "<why>"}],
  "repeated_instructions": ["<instructions the user repeats to the agent>"],
  "brief_summary": "<one sentence: what user wanted and whether they got it>"
}`

// extractFacets asks the facet model for the structured reading of one
// session transcript. Empty transcripts and failures yield no facets.
func (e *Engine) extractFacets(ctx context.Context, transcript string) map[string]any {
	if len(strings.TrimSpace(transcript)) < 50 {
		return map[string]any{}
	}
	modelOverride := e.Config.String(ctx, "insights.model_facets", "")
	prompt := strings.Replace(facetPrompt, "%s", transcript, 1)
	return e.callModel(ctx, prompt, modelOverride, 4096)
}

// loadCachedFacetsBatch reads previously extracted facets in one query.
func (e *Engine) loadCachedFacetsBatch(ctx context.Context, sessionIDs []string) (map[string]map[string]any, error) {
	out := map[string]map[string]any{}
	if len(sessionIDs) == 0 {
		return out, nil
	}
	rows, err := e.DB.Query(ctx,
		`SELECT session_id, facets FROM insight_session_facets WHERE session_id = ANY($1)`, sessionIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var sid string
		var blob []byte
		if err := rows.Scan(&sid, &blob); err != nil {
			return nil, err
		}
		var facets map[string]any
		if json.Unmarshal(blob, &facets) != nil || len(facets) == 0 || sid == "" {
			continue
		}
		out[sid] = facets
	}
	return out, rows.Err()
}

// storeFacets persists extracted facets, updating an existing row for the
// session when one exists.
func (e *Engine) storeFacets(ctx context.Context, sessionID, agentID string, facets map[string]any) error {
	blob, err := json.Marshal(facets)
	if err != nil {
		return err
	}
	tag, err := e.DB.Exec(ctx,
		`UPDATE insight_session_facets SET facets = $2::json, extracted_at = now() WHERE session_id = $1`,
		sessionID, string(blob))
	if err != nil {
		return err
	}
	if tag.RowsAffected() > 0 {
		return nil
	}
	_, err = e.DB.Exec(ctx,
		`INSERT INTO insight_session_facets (id, agent_id, session_id, extracted_at, facets)
		 VALUES (gen_random_uuid(), $1, $2, now(), $3::json)
		 ON CONFLICT ON CONSTRAINT uq_session_facets_agent_session DO UPDATE
		   SET facets = EXCLUDED.facets, extracted_at = EXCLUDED.extracted_at`,
		agentID, sessionID, string(blob))
	return err
}

// extractAndCacheFacets returns cached facets when present, otherwise
// extracts and persists them.
func (e *Engine) extractAndCacheFacets(ctx context.Context, sessionID, agentID, transcript string) map[string]any {
	cached, err := e.loadCachedFacetsBatch(ctx, []string{sessionID})
	if err == nil {
		if facets := cached[sessionID]; len(facets) > 0 {
			return facets
		}
	}
	facets := e.extractFacets(ctx, transcript)
	if len(facets) > 0 {
		if err := e.storeFacets(ctx, sessionID, agentID, facets); err != nil {
			slog.Warn("facet cache write failed", "session_id", sessionID, "error", err)
		}
	}
	return facets
}

// facetsSummary aggregates per-session facets into distributions for the
// report and the prompt data block.
type facetsSummary struct {
	SessionsWithFacets   int              `json:"sessions_with_facets"`
	GoalCategories       []pair           `json:"goal_categories"`
	Outcomes             map[string]int   `json:"outcomes"`
	Satisfaction         map[string]int   `json:"satisfaction"`
	Helpfulness          map[string]int   `json:"helpfulness"`
	SessionTypes         map[string]int   `json:"session_types"`
	Complexity           map[string]int   `json:"complexity_distribution"`
	FrictionTypes        []pair           `json:"friction_types"`
	SuccessFactors       []pair           `json:"success_factors"`
	ToolsEffective       []pair           `json:"tools_effective"`
	ToolsProblematic     []pair           `json:"tools_problematic"`
	RepeatedInstructions []map[string]any `json:"repeated_instructions"`
}

// aggregateFacets folds per-session facets into summary statistics.
func aggregateFacets(allFacets []map[string]any) *facetsSummary {
	if len(allFacets) == 0 {
		return nil
	}
	goals := newOrderedCount()
	outcomes := map[string]int{}
	satisfaction := map[string]int{}
	helpfulness := map[string]int{}
	sessionTypes := map[string]int{}
	friction := newOrderedCount()
	success := newOrderedCount()
	toolsEffective := newOrderedCount()
	toolsProblematic := newOrderedCount()
	complexities := map[string]int{}
	repeated := []string{}

	strOr := func(f map[string]any, key, fallback string) string {
		if s := str(f[key]); s != "" {
			return s
		}
		return fallback
	}

	for _, f := range allFacets {
		if len(f) == 0 {
			continue
		}
		for _, cat := range asList(f["goal_categories"]) {
			goals.add(str(cat), 1)
		}
		outcomes[strOr(f, "outcome", "unclear")]++
		satisfaction[strOr(f, "user_satisfaction", "unsure")]++
		helpfulness[strOr(f, "agent_helpfulness", "moderately_helpful")]++
		sessionTypes[strOr(f, "session_type", "single_task")]++
		complexities[strOr(f, "complexity", "medium")]++
		for _, fpAny := range asList(f["friction_points"]) {
			fp := asMap(fpAny)
			if fp == nil {
				continue
			}
			friction.add(strOr(fp, "type", "unknown"), 1)
		}
		for _, sf := range asList(f["primary_success_factors"]) {
			success.add(str(sf), 1)
		}
		for _, tool := range asList(f["tools_effective"]) {
			name := str(tool)
			if name == "" {
				name = fmt.Sprint(tool)
			}
			toolsEffective.add(name, 1)
		}
		for _, tpAny := range asList(f["tools_problematic"]) {
			if tp := asMap(tpAny); tp != nil {
				toolsProblematic.add(str(tp["tool"]), 1)
			} else {
				toolsProblematic.add(fmt.Sprint(tpAny), 1)
			}
		}
		for _, instr := range asList(f["repeated_instructions"]) {
			if s := str(instr); s != "" {
				repeated = append(repeated, s)
			}
		}
	}

	instructionCounts := newOrderedCount()
	for _, instr := range repeated {
		instructionCounts.add(strings.ToLower(strings.TrimSpace(instr)), 1)
	}
	keys := append([]string{}, instructionCounts.order...)
	sort.SliceStable(keys, func(i, j int) bool {
		return instructionCounts.counts[keys[i]] > instructionCounts.counts[keys[j]]
	})
	repeatedSummary := []map[string]any{}
	for _, key := range keys {
		if instructionCounts.counts[key] < 2 {
			continue
		}
		repeatedSummary = append(repeatedSummary, map[string]any{
			"instruction": key,
			"frequency":   instructionCounts.counts[key],
		})
		if len(repeatedSummary) == 10 {
			break
		}
	}

	return &facetsSummary{
		SessionsWithFacets:   len(allFacets),
		GoalCategories:       rankedPairs(goals.counts, goals.order, 0),
		Outcomes:             outcomes,
		Satisfaction:         satisfaction,
		Helpfulness:          helpfulness,
		SessionTypes:         sessionTypes,
		Complexity:           complexities,
		FrictionTypes:        rankedPairs(friction.counts, friction.order, 0),
		SuccessFactors:       rankedPairs(success.counts, success.order, 0),
		ToolsEffective:       rankedPairs(toolsEffective.counts, toolsEffective.order, 10),
		ToolsProblematic:     rankedPairs(toolsProblematic.counts, toolsProblematic.order, 10),
		RepeatedInstructions: repeatedSummary,
	}
}
