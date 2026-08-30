// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"strings"
	"testing"
)

func richReportFixture() map[string]any {
	return map[string]any{
		"id":                       "0f6ed4a1-1111-2222-3333-444455556666",
		"agent_name":               "review-bot",
		"agent_version":            "2.0.0",
		"comparison_agent_version": "1.9.0",
		"period_start":             "2026-08-01T00:00:00Z",
		"period_end":               "2026-08-15T00:00:00Z",
		"sessions_analyzed":        12,
		"metrics": map[string]any{
			"overview": map[string]any{"total_sessions": float64(10)},
			"cost": map[string]any{
				"total_cost_usd":         float64(4.5),
				"avg_cost_per_session":   float64(0.45),
				"cache_efficiency_ratio": float64(0.8),
				"cost_by_model":          map[string]any{"gpt-5": float64(4.5)},
			},
			"tokens":   map[string]any{"total_tokens": float64(123456)},
			"duration": map[string]any{"avg_duration_seconds": float64(600)},
			"rich": map[string]any{
				"total_messages":     float64(40),
				"days_active":        float64(5),
				"git_commits":        float64(6),
				"git_pushes":         float64(2),
				"lines_added":        float64(4000),
				"lines_removed":      float64(120),
				"files_modified":     float64(30),
				"tool_errors":        float64(3),
				"interruptions":      float64(1),
				"subagent_sessions":  float64(2),
				"cache_hit_rate_pct": float64(85.5),
				"cache_tokens_saved": float64(4000),
				"top_tools":          []any{[]any{"read", float64(50)}, []any{"edit", float64(20)}},
			},
			"time_of_day": map[string]any{
				"hourly_counts": map[string]any{"9": float64(4), "14": float64(2)},
			},
		},
		"facets_summary": map[string]any{
			"goal_categories": []any{[]any{"debugging", float64(5)}},
			"repeated_instructions": []any{
				map[string]any{"instruction": "use <tabs> only", "frequency": float64(3)},
			},
		},
		"regressions": []any{},
		"narrative": map[string]any{
			"at_a_glance": map[string]any{
				"health":              "healthy",
				"whats_working":       `<script>alert("xss")</script>`,
				"whats_hindering":     "H-TEXT",
				"quick_win":           "Q-TEXT",
				"ambitious_workflows": "A-TEXT",
			},
			"what_they_work_on": map[string]any{
				"areas": []any{map[string]any{
					"name": "PR review & triage", "sessions": float64(7), "description": "You review PRs.",
				}},
			},
			"usage_patterns": map[string]any{
				"narrative": "You iterate quickly.",
				"top_tasks": []any{map[string]any{"name": "bugfix", "count": float64(4), "description": "small fixes"}},
				"session_profile": map[string]any{
					"avg_duration_minutes": float64(12), "avg_tool_calls": float64(9),
					"avg_prompts": float64(5), "session_type": "single_task",
				},
			},
			"interaction_style": map[string]any{
				"narrative":   "First paragraph.\n\nSecond paragraph.",
				"key_pattern": "you correct fast",
			},
			"what_works": map[string]any{
				"intro": "Solid overall.",
				"strengths": []any{
					map[string]any{"title": "Multi-file edits", "description": "coordinated 46 files"},
				},
			},
			"friction_analysis": map[string]any{
				"intro": "Some friction.",
				"categories": []any{map[string]any{
					"title": "Wrong approach", "severity": "high",
					"description": "It guessed.", "evidence": "3 of 12 sessions",
					"impact": "wasted time",
				}},
			},
			"suggestions": map[string]any{
				"config_additions": []any{map[string]any{
					"addition": `never use "rm -rf"`, "where": "AGENTS.md", "why": "you said so twice",
				}},
				"features_to_try": []any{map[string]any{
					"feature": "Skill", "one_liner": "runs the tests", "why_for_you": "high error rate",
					"example": "---\nname: test-gate\n---",
				}},
				"usage_patterns": []any{map[string]any{
					"title": "Scope first", "suggestion": "state scope upfront",
					"detail": "saves redirects", "copyable_prompt": "Only touch files under internal/",
				}},
			},
			"usage_cost_analysis": map[string]any{
				"summary": "Costs are fine.",
				"opportunities": []any{
					map[string]any{"title": "Cache more", "description": "reuse context"},
				},
			},
			"regression_detection": map[string]any{
				"has_previous_data": true,
				"summary":           "Error rate dropped.",
				"changes": []any{map[string]any{
					"metric": "tool_errors", "direction": "improved",
					"previous_value": "9", "current_value": "3",
					"magnitude_pct": float64(66.7), "significance": "meaningful",
				}},
			},
			"version_comparison": map[string]any{
				"summary": "v2 improved.", "confidence": "medium",
				"changes": []any{map[string]any{
					"metric": "success", "direction": "improved",
					"prior_value": "0.6", "current_value": "0.8",
					"attribution": "prompt changed", "risk": "low", "evidence": "cohort delta",
				}},
			},
			"fun_ending": map[string]any{
				"headline": "You debugged the debugger.", "detail": "session 42",
			},
		},
	}
}

func TestRenderReportHTMLStructure(t *testing.T) {
	html, err := RenderReportHTML(richReportFixture(), "")
	if err != nil {
		t.Fatal(err)
	}
	fragments := []string{
		// Header pulls the agent name from the report and reduces
		// timestamps to dates.
		"<title>Caracal Agent Insights &mdash; review-bot &mdash; 2026-08-01 to 2026-08-15</title>",
		"<h1>review-bot</h1>",
		"Version v2.0.0 &nbsp;&middot;&nbsp; Compared to v1.9.0",
		"12 sessions analyzed",
		"Report 0f6ed4a1",
		// At a Glance.
		"<h2>At a Glance</h2>",
		"HEALTHY",
		"<p>H-TEXT</p>",
		"<p>Q-TEXT</p>",
		// Stats row: overview total_sessions wins over sessions_analyzed,
		// and rich metrics drive the rest.
		`<span class="stat-value">10</span>
      <span class="stat-label">Sessions</span>
      <span class="stat-sub">5 active days</span>`,
		`<span class="stat-sub">4.0 per session</span>`,
		`<span class="stat-value">1.7h</span>`,
		`<span class="stat-value">$4.50</span>`,
		`<span class="stat-value">4k</span>`,
		`<span class="stat-value">85.5%</span>
      <span class="stat-label">Cache Efficiency</span>
      <span class="stat-sub">4k tokens saved</span>`,
		`<span class="stat-label">Subagent Sessions</span>`,
		// Narrative sections.
		"<h2>What They Work On</h2>",
		"<h4>PR review &amp; triage</h4>",
		"<h3>Goal Categories</h3>",
		"<h2>Usage Patterns</h2>",
		`<span class="profile-val">12m</span>`,
		`<span class="profile-val">single_task</span>`,
		`title="09:00: 4 sessions"`,
		"<h2>Interaction Style</h2>",
		"First paragraph.</p><p>Second paragraph.",
		`"you correct fast"`,
		"<h2>What's Working</h2>",
		"<h4>Multi-file edits</h4>",
		"<h2>Where Things Go Wrong</h2>",
		`<span class="severity-badge" style="background:#dc2626;color:white;">HIGH</span>`,
		// Suggestions.
		"Config Additions",
		`data-addition="never use &quot;rm -rf&quot;"`,
		"Features to Try",
		">Skill</span>",
		"Repeated Instructions",
		"use &lt;tabs&gt; only",
		// Cost: ratio 0.8 renders as a percentage.
		"<h2>Usage &amp; Cost Analysis</h2>",
		`<span class="cost-val">80.0%</span>`,
		`<span class="cost-val">123,456</span>`,
		"<code>gpt-5</code></td><td>$4.50</td>",
		"<strong>Cache more</strong>: reuse context",
		// Regression and version comparison.
		"<h2>Regression Flags</h2>",
		"&#8593; improved",
		"<td>66.7%</td>",
		"<h2>Version Comparison</h2>",
		"<h4>success: improved</h4>",
		"0.6 &rarr; 0.8",
		// Fun ending and footer.
		"<h3>You debugged the debugger.</h3>",
		`<div class="footer-brand">CARACAL</div>`,
	}
	for _, frag := range fragments {
		if !strings.Contains(html, frag) {
			t.Errorf("rendered HTML missing fragment:\n%s", frag)
		}
	}
}

func TestRenderReportHTMLEscapesAdversarialValues(t *testing.T) {
	report := richReportFixture()
	report["agent_name"] = `<img src=x onerror=alert(1)>`
	html, err := RenderReportHTML(report, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, banned := range []string{"<img", "<script>alert"} {
		if strings.Contains(html, banned) {
			t.Errorf("unescaped markup %q leaked into output", banned)
		}
	}
	if !strings.Contains(html, "<h1>&lt;img src=x onerror=alert(1)&gt;</h1>") {
		t.Error("agent name must render escaped")
	}
	if !strings.Contains(html, "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;") {
		t.Error("narrative text must render escaped")
	}
}

func TestRenderReportHTMLNilReport(t *testing.T) {
	html, err := RenderReportHTML(nil, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, frag := range []string{
		"<title>Caracal Agent Insights &mdash; Agent &mdash;",
		"<h1>Agent</h1>",
		"0 sessions analyzed",
		`<span class="stat-label">Sessions</span>`,
		`<div class="footer-brand">CARACAL</div>`,
		"</html>",
	} {
		if !strings.Contains(html, frag) {
			t.Errorf("empty report render missing fragment: %s", frag)
		}
	}
	// Narrative-driven sections must be absent without data; the embedded
	// stylesheet still names their classes, so match section markup.
	for _, absent := range []string{"<h2>At a Glance</h2>", "<h2>Regression Flags</h2>", `<div class="fun-card">`} {
		if strings.Contains(html, absent) {
			t.Errorf("empty report must not render %q", absent)
		}
	}
}

func TestRenderReportHTMLNameFallbacks(t *testing.T) {
	html, err := RenderReportHTML(map[string]any{"agent_id": "id-1234"}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(html, "<h1>id-1234</h1>") {
		t.Error("agent_id must back the display name")
	}
	html, err = RenderReportHTML(map[string]any{"agent_name": "ignored"}, "explicit")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(html, "<h1>explicit</h1>") {
		t.Error("the agentName argument must win over report fields")
	}
}

func TestRenderReportHTMLAcceptsRawJSONColumns(t *testing.T) {
	// Report rows may carry metrics and narrative as raw JSON strings.
	html, err := RenderReportHTML(map[string]any{
		"agent_name": "raw-bot",
		"metrics":    `{"cost": {"total_cost_usd": 2.5}}`,
		"narrative":  `{"fun_ending": {"headline": "It worked.", "detail": "somehow"}}`,
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(html, `<span class="cost-val">$2.50</span>`) {
		t.Error("JSON-string metrics must decode")
	}
	if !strings.Contains(html, "<h3>It worked.</h3>") {
		t.Error("JSON-string narrative must decode")
	}
}
