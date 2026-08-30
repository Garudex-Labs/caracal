// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

// RenderReportHTML renders a completed report row as a standalone HTML document.
func RenderReportHTML(report map[string]any, agentName string) (string, error) {
	if report == nil {
		report = map[string]any{}
	}

	metrics := hxMapOf(report["metrics"])
	narrative := hxMapOf(report["narrative"])
	facets := hxMapOf(report["facets_summary"])
	regressionsList := hxListOf(report["regressions"])

	name := agentName
	if name == "" {
		if v, ok := report["agent_name"]; ok && hxTruthy(v) {
			name = hxText(v)
		} else if v, ok := report["agent_id"]; ok {
			name = hxIDText(v)
		} else {
			name = "Agent"
		}
	}

	periodStart := hxPeriodDisplay(hxGet(report, "period_start", ""))
	periodEnd := hxPeriodDisplay(hxGet(report, "period_end", ""))
	sessionsAnalyzed := hxGet(report, "sessions_analyzed", 0)
	reportID := hxIDText(hxGet(report, "id", ""))

	agentVersion := ""
	if hxTruthy(report["agent_version"]) {
		agentVersion = hxText(report["agent_version"])
	}
	comparisonVersion := ""
	if hxTruthy(report["comparison_agent_version"]) {
		comparisonVersion = hxText(report["comparison_agent_version"])
	}

	atAGlance := asMap(narrative["at_a_glance"])
	whatTheyWorkOn := asMap(narrative["what_they_work_on"])
	usagePatterns := asMap(narrative["usage_patterns"])
	whatWorks := asMap(narrative["what_works"])
	friction := asMap(narrative["friction_analysis"])
	suggestions := asMap(narrative["suggestions"])
	usageCost := asMap(narrative["usage_cost_analysis"])
	regression := asMap(narrative["regression_detection"])
	versionComparison := asMap(narrative["version_comparison"])
	funEnding := asMap(narrative["fun_ending"])
	interactionStyle := asMap(narrative["interaction_style"])

	overview := asMap(metrics["overview"])
	tokens := asMap(metrics["tokens"])
	costM := asMap(metrics["cost"])
	duration := asMap(metrics["duration"])
	toolsList := asList(metrics["tools"])
	git := asMap(metrics["git"])
	languages := asMap(metrics["languages"])
	timeOfDay := asMap(metrics["time_of_day"])
	rich := asMap(metrics["rich"])

	var sections []string

	// At a Glance
	if hxTruthy(atAGlance) {
		healthV := hxGet(atAGlance, "health", "mixed")
		sections = append(sections, `
<section class="at-a-glance-section">
  <div class="at-a-glance-card">
    <div class="glance-header">
      <h2>At a Glance</h2>
      `+hxHealthBadge(healthV)+`
    </div>
    <div class="glance-grid">
      <div class="glance-item glance-good">
        <div class="glance-icon">&#10003;</div>
        <div>
          <h4>What's Working</h4>
          <p>`+hxEsc(hxGet(atAGlance, "whats_working", ""))+`</p>
        </div>
      </div>
      <div class="glance-item glance-bad">
        <div class="glance-icon">&#9888;</div>
        <div>
          <h4>What's Hindering</h4>
          <p>`+hxEsc(hxGet(atAGlance, "whats_hindering", ""))+`</p>
        </div>
      </div>
      <div class="glance-item glance-action">
        <div class="glance-icon">&#9889;</div>
        <div>
          <h4>Quick Win</h4>
          <p>`+hxEsc(hxGet(atAGlance, "quick_win", ""))+`</p>
        </div>
      </div>
      <div class="glance-item glance-ambitious">
        <div class="glance-icon">&#127942;</div>
        <div>
          <h4>Ambitious Workflows</h4>
          <p>`+hxEsc(hxGet(atAGlance, "ambitious_workflows", ""))+`</p>
        </div>
      </div>
    </div>
  </div>
</section>`)
	}

	// Stats row: richer transcript-derived metrics win over aggregate ones.
	var totalSessions float64
	if v, ok := overview["total_sessions"]; ok {
		totalSessions, _ = hxNumeric(v)
	} else {
		totalSessions, _ = hxNumeric(sessionsAnalyzed)
	}
	avgDur := hxNumOf(duration, "avg_duration_seconds")
	activeHours := hxNumOf(rich, "active_hours")
	if activeHours == 0 && avgDur != 0 {
		activeHours = avgDur * totalSessions / 3600
	}
	daysActive := hxGet(rich, "days_active", 0)
	totalMessages := hxNumOf(rich, "total_messages")
	commitsV := hxOrValue(hxGet(rich, "git_commits", 0), hxGet(git, "commits", 0))
	gitPushesV := hxOrValue(hxGet(rich, "git_pushes", 0), hxGet(git, "pushes", 0))
	linesAdded, _ := hxNumeric(hxOrValue(hxGet(rich, "lines_added", 0), hxGet(git, "lines_added", 0)))
	linesRemoved, _ := hxNumeric(hxOrValue(hxGet(rich, "lines_removed", 0), hxGet(git, "lines_removed", 0)))
	filesModified, _ := hxNumeric(hxOrValue(hxGet(rich, "files_modified", 0), hxGet(git, "files_modified", 0)))
	totalCost, _ := hxNumeric(hxOrValue(hxGet(rich, "total_cost_usd", 0), hxGet(costM, "total_cost_usd", 0)))
	toolErrorsV := hxGet(rich, "tool_errors", 0)
	interruptionsV := hxGet(rich, "interruptions", 0)
	subagentV := hxGet(rich, "subagent_sessions", 0)
	richTopTools := asList(rich["top_tools"])
	richTopLangs := asList(rich["top_languages"])
	richErrorCats := asMap(rich["tool_error_categories"])
	cacheHitRateV, cacheHitPresent := rich["cache_hit_rate_pct"]
	cacheTokensSaved, _ := hxNumeric(hxOrValue(rich["cache_tokens_saved"], hxGet(rich, "total_cache_read_tokens", 0)))
	canonicalDirty := asMap(rich["canonical_dirty_summary"])

	type hxStat struct{ label, value, sub string }
	var stats []hxStat

	sub := ""
	if hxTruthy(daysActive) {
		sub = hxText(daysActive) + " active days"
	}
	stats = append(stats, hxStat{"Sessions", hxFormatNumberF(totalSessions), sub})

	sub = ""
	if totalMessages != 0 {
		sub = hxF(totalMessages/math.Max(totalSessions, 1), 1) + " per session"
	}
	stats = append(stats, hxStat{"Messages", hxFormatNumberF(totalMessages), sub})

	activeTime := hxF(activeHours*60, 0) + "m"
	if activeHours >= 1 {
		activeTime = hxF(activeHours, 1) + "h"
	}
	stats = append(stats, hxStat{"Active Time", activeTime, ""})

	sub = ""
	if hxTruthy(totalSessions) {
		sub = hxCostF(totalCost/math.Max(totalSessions, 1)) + "/session"
	}
	stats = append(stats, hxStat{"Total Cost", hxCostF(totalCost), sub})

	stats = append(stats, hxStat{"Lines Added", hxTokensF(linesAdded), ""})
	stats = append(stats, hxStat{"Lines Removed", hxTokensF(linesRemoved), ""})

	sub = ""
	if hxTruthy(gitPushesV) {
		sub = hxText(gitPushesV) + " pushes"
	}
	stats = append(stats, hxStat{"Git Commits", hxFormatNumber(commitsV), sub})

	stats = append(stats, hxStat{"Files Modified", hxTokensF(filesModified), ""})
	stats = append(stats, hxStat{"Tool Errors", hxFormatNumber(toolErrorsV), ""})
	stats = append(stats, hxStat{"Interruptions", hxFormatNumber(interruptionsV), ""})

	if cacheHitPresent && cacheHitRateV != nil {
		stats = append(stats, hxStat{
			"Cache Efficiency",
			hxF(hxFloatCoerce(cacheHitRateV), 1) + "%",
			hxTokensF(cacheTokensSaved) + " tokens saved",
		})
	}
	if hxTruthy(subagentV) {
		stats = append(stats, hxStat{"Subagent Sessions", hxFormatNumber(subagentV), ""})
	}

	var statCells strings.Builder
	for _, st := range stats {
		subHTML := ""
		if st.sub != "" {
			subHTML = `<span class="stat-sub">` + hxEscape(st.sub) + `</span>`
		}
		statCells.WriteString(`<div class="stat-item">
      <span class="stat-value">` + hxEscape(st.value) + `</span>
      <span class="stat-label">` + hxEscape(st.label) + `</span>
      ` + subHTML + `
    </div>
`)
	}

	sections = append(sections, `
<section class="stats-row-section">
  <div class="stats-row">
    `+statCells.String()+`
  </div>
</section>`)

	if hxTruthy(canonicalDirty) {
		sections = append(sections, `
<section class="content-section">
  <h2>Canonical vs Dirty Installs</h2>
  <div class="stats-row">
    <div class="stat-item"><span class="stat-value">`+hxFormatNumber(hxGet(canonicalDirty, "canonical_sessions", 0))+`</span><span class="stat-label">Canonical Sessions</span></div>
    <div class="stat-item"><span class="stat-value">`+hxFormatNumber(hxGet(canonicalDirty, "dirty_sessions", 0))+`</span><span class="stat-label">Dirty Sessions</span></div>
    <div class="stat-item"><span class="stat-value">`+hxFormatNumber(hxGet(canonicalDirty, "canonical_users", 0))+`</span><span class="stat-label">Canonical Users</span></div>
    <div class="stat-item"><span class="stat-value">`+hxFormatNumber(hxGet(canonicalDirty, "dirty_users", 0))+`</span><span class="stat-label">Dirty Users</span></div>
  </div>
</section>`)
	}

	// What They Work On
	if areas := asList(whatTheyWorkOn["areas"]); len(areas) > 0 {
		var areaCards strings.Builder
		for _, raw := range areas {
			area := asMap(raw)
			if area == nil {
				continue
			}
			areaCards.WriteString(`
    <div class="area-card">
      <div class="area-header">
        <h4>` + hxEsc(hxGet(area, "name", "")) + `</h4>
        <span class="area-count">` + hxText(hxGet(area, "sessions", 0)) + ` sessions</span>
      </div>
      <p>` + hxEsc(hxGet(area, "description", "")) + `</p>
    </div>`)
		}
		sections = append(sections, `
<section>
  <h2>What They Work On</h2>
  <div class="areas-grid">`+areaCards.String()+`
  </div>
</section>`)
	}

	// Charts
	var chartParts []string
	appendChart := func(title, rows string) {
		chartParts = append(chartParts, `
    <div class="chart-panel">
      <h3>`+title+`</h3>
      `+rows+`
    </div>`)
	}

	if goalCats := asList(facets["goal_categories"]); len(goalCats) > 0 {
		appendChart("Goal Categories", hxCountBarChart(hxPairItems(goalCats, 8), "var(--blue)"))
	}

	if toolDist := asList(usagePatterns["tool_distribution"]); len(toolDist) > 0 {
		limited := toolDist
		if len(limited) > 8 {
			limited = limited[:8]
		}
		items := make([]hxItem, 0, len(limited))
		for _, raw := range limited {
			t := asMap(raw)
			n, _ := hxNumeric(hxGet(t, "calls", hxGet(t, "invocations", 0)))
			items = append(items, hxItem{label: hxGet(t, "tool", hxGet(t, "name", "")), value: n})
		}
		appendChart("Tool Distribution", hxCountBarChart(items, "var(--purple)"))
	} else if len(toolsList) > 0 {
		limited := toolsList
		if len(limited) > 8 {
			limited = limited[:8]
		}
		items := make([]hxItem, 0, len(limited))
		for _, raw := range limited {
			t := asMap(raw)
			n, _ := hxNumeric(hxGet(t, "invocations", 0))
			items = append(items, hxItem{label: hxGet(t, "name", ""), value: n})
		}
		appendChart("Tool Distribution", hxCountBarChart(items, "var(--purple)"))
	}

	if len(languages) > 0 {
		items := hxKVItems(hxSortedKVDesc(languages), 8)
		if len(items) > 0 && items[0].value <= 1.0 {
			for i := range items {
				items[i].value *= 100
			}
		}
		appendChart("Languages", hxPctBarChart(items, "var(--green)"))
	}

	if outcomes := asMap(facets["outcomes"]); len(outcomes) > 0 {
		appendChart("Outcomes", hxCountBarChart(hxKVItems(hxSortedKVDesc(outcomes), 6), "var(--amber)"))
	}

	if satisfaction := asMap(facets["satisfaction"]); len(satisfaction) > 0 {
		appendChart("Satisfaction", hxCountBarChart(hxKVItems(hxSortedKVDesc(satisfaction), 6), "#8b5cf6"))
	}

	if frictionTypes := asList(facets["friction_types"]); len(frictionTypes) > 0 {
		appendChart("Friction Types", hxCountBarChart(hxPairItems(frictionTypes, 8), "var(--red)"))
	}

	if len(richErrorCats) > 0 {
		appendChart("Tool Errors", hxCountBarChart(hxKVItems(hxSortedKVDesc(richErrorCats), 8), "var(--red)"))
	}

	if len(richTopTools) > 0 {
		appendChart("Top Tools", hxCountBarChart(hxPairItems(richTopTools, 10), "var(--purple)"))
	}

	if len(richTopLangs) > 0 {
		appendChart("Languages", hxCountBarChart(hxPairItems(richTopLangs, 10), "var(--green)"))
	}

	if len(chartParts) > 0 {
		sections = append(sections, `
<section>
  <h2>Charts</h2>
  <div class="charts-grid">`+strings.Join(chartParts, "")+`
  </div>
</section>`)
	}

	// Usage Patterns
	if hxTruthy(usagePatterns) {
		usageNarrative := hxGet(usagePatterns, "narrative", "")
		topTasks := asList(usagePatterns["top_tasks"])
		profile := asMap(usagePatterns["session_profile"])

		topTasksHTML := ""
		if len(topTasks) > 0 {
			limited := topTasks
			if len(limited) > 6 {
				limited = limited[:6]
			}
			var li strings.Builder
			for _, raw := range limited {
				if t := asMap(raw); t != nil {
					li.WriteString("<li><strong>" + hxEsc(hxGet(t, "name", "")) + "</strong> (" +
						hxText(hxGet(t, "count", "")) + ") - " + hxEsc(hxGet(t, "description", "")) + "</li>")
				} else {
					li.WriteString("<li>" + hxEscape(hxText(raw)) + "</li>")
				}
			}
			topTasksHTML = `<div class="top-tasks"><h4>Top Tasks</h4><ul>` + li.String() + `</ul></div>`
		}

		profileHTML := ""
		if len(profile) > 0 {
			profileHTML = `
      <div class="session-profile-card">
        <h4>Typical Session Profile</h4>
        <div class="profile-stats">
          <div class="profile-stat"><span class="profile-val">` + hxText(hxGet(profile, "avg_duration_minutes", "?")) + `m</span><span class="profile-lbl">Duration</span></div>
          <div class="profile-stat"><span class="profile-val">` + hxText(hxGet(profile, "avg_tool_calls", "?")) + `</span><span class="profile-lbl">Tool Calls</span></div>
          <div class="profile-stat"><span class="profile-val">` + hxText(hxGet(profile, "avg_prompts", "?")) + `</span><span class="profile-lbl">Prompts</span></div>
          <div class="profile-stat"><span class="profile-val">` + hxEsc(hxGet(profile, "session_type", "?")) + `</span><span class="profile-lbl">Type</span></div>
        </div>
      </div>`
		}

		heatmapHTML := ""
		if hourly := asMap(timeOfDay["hourly_counts"]); len(hourly) > 0 {
			maxHourly := 0.0
			first := true
			for _, v := range hourly {
				f, _ := hxNumeric(v)
				if first || f > maxHourly {
					maxHourly = f
					first = false
				}
			}
			var cells strings.Builder
			for h := 0; h < 24; h++ {
				raw, ok := hourly[strconv.Itoa(h)]
				if !ok {
					raw = 0
				}
				count, _ := hxNumeric(raw)
				intensity := 0.0
				if maxHourly != 0 {
					intensity = count / maxHourly
				}
				opacity := 0.1 + intensity*0.9
				cells.WriteString(`<div class="heatmap-cell" style="opacity:` + hxFloatText(opacity) +
					`" title="` + fmt.Sprintf("%02d:00", h) + `: ` + hxText(raw) + ` sessions">` + strconv.Itoa(h) + `</div>`)
			}
			heatmapHTML = `
      <div class="heatmap-section">
        <h4>Activity by Hour</h4>
        <div class="heatmap-row">` + cells.String() + `</div>
        <div class="heatmap-legend"><span>Less</span><span>More</span></div>
      </div>`
		}

		sections = append(sections, `
<section>
  <h2>Usage Patterns</h2>
  <p class="narrative">`+hxEsc(usageNarrative)+`</p>
  `+topTasksHTML+`
  `+profileHTML+`
  `+heatmapHTML+`
</section>`)
	}

	// Interaction Style
	if hxTruthy(interactionStyle) {
		styleNarrative := hxGet(interactionStyle, "narrative", "")
		keyPattern := hxGet(interactionStyle, "key_pattern", "")
		if hxTruthy(styleNarrative) {
			keyPatternHTML := ""
			if hxTruthy(keyPattern) {
				keyPatternHTML = `
      <div style="margin-top:16px;padding:14px 18px;background:var(--accent-bg);border:1px solid var(--accent-border);border-radius:var(--radius-sm);font-size:14px;font-style:italic;color:var(--accent)">
        "` + hxEsc(keyPattern) + `"
      </div>`
			}
			body := hxEsc(styleNarrative)
			body = strings.ReplaceAll(body, "\n\n", "</p><p>")
			body = strings.ReplaceAll(body, "\n", "<br>")
			sections = append(sections, `
<section>
  <h2>Interaction Style</h2>
  <div style="line-height:1.8;color:var(--text-secondary);font-size:14px">
    `+body+`
  </div>
  `+keyPatternHTML+`
</section>`)
		}
	}

	// What's Working
	if hxTruthy(whatWorks) {
		if strengths := asList(whatWorks["strengths"]); len(strengths) > 0 {
			var strengthCards strings.Builder
			for _, raw := range strengths {
				s := asMap(raw)
				if s == nil {
					continue
				}
				strengthCards.WriteString(`
        <div class="strength-card">
          <h4>` + hxEsc(hxGet(s, "title", "")) + `</h4>
          <p>` + hxEsc(hxGet(s, "description", "")) + `</p>
        </div>`)
			}
			sections = append(sections, `
<section class="whats-working-section">
  <h2>What's Working</h2>
  <p class="section-intro">`+hxEsc(hxGet(whatWorks, "intro", ""))+`</p>
  <div class="strengths-grid">`+strengthCards.String()+`
  </div>
</section>`)
		}
	}

	// Where Things Go Wrong
	if hxTruthy(friction) {
		if categories := asList(friction["categories"]); len(categories) > 0 {
			var frictionCards strings.Builder
			for _, raw := range categories {
				c := asMap(raw)
				if c == nil {
					continue
				}
				sev := hxGet(c, "severity", "low")
				evidence := hxGet(c, "evidence", "")
				evidenceHTML := ""
				if hxTruthy(evidence) {
					evidenceHTML = `<code class="evidence">` + hxEsc(evidence) + `</code>`
				}
				frictionCards.WriteString(`
        <div class="friction-card" style="border-left:4px solid ` + hxSeverityColor(sev) + `">
          <div class="friction-header">
            <h4>` + hxEsc(hxGet(c, "title", "")) + `</h4>
            <span class="severity-badge" style="background:` + hxSeverityColor(sev) + `;color:white;">` + strings.ToUpper(hxEsc(sev)) + `</span>
          </div>
          <p>` + hxEsc(hxGet(c, "description", "")) + `</p>
          ` + evidenceHTML + `
          <p class="impact"><strong>Impact:</strong> ` + hxEsc(hxGet(c, "impact", "")) + `</p>
        </div>`)
			}
			sections = append(sections, `
<section>
  <h2>Where Things Go Wrong</h2>
  <p class="section-intro">`+hxEsc(hxGet(friction, "intro", ""))+`</p>
  <div class="friction-list">`+frictionCards.String()+`
  </div>
</section>`)
		}
	}

	// Suggestions
	if hxTruthy(suggestions) {
		var suggParts []string

		configAdditions := asList(suggestions["config_additions"])
		if len(configAdditions) > 0 {
			var cfgCards strings.Builder
			for _, raw := range configAdditions {
				c := asMap(raw)
				if c == nil {
					continue
				}
				addition := hxGet(c, "addition", "")
				where := hxGet(c, "where", "system_prompt")
				why := hxGet(c, "why", "")
				additionAttr := hxEsc(addition)
				cfgCards.WriteString(`
        <div class="suggestion-card" style="margin-bottom:10px">
          <div style="display:flex;align-items:flex-start;gap:10px">
            <input type="checkbox" class="cfg-check" checked data-addition="` + additionAttr + `" style="margin-top:3px;accent-color:var(--accent);width:15px;height:15px;flex-shrink:0">
            <div>
              <span class="meta-badge" style="margin-bottom:6px;display:inline-block">` + hxEsc(where) + `</span>
              <h4 style="font-size:14px;margin-bottom:4px">` + hxEsc(addition) + `</h4>
              <p class="suggestion-why"><em>Why: ` + hxEsc(why) + `</em></p>
            </div>
          </div>
        </div>`)
			}
			suggParts = append(suggParts, `
      <h3 style="font-size:15px;font-weight:600;margin-bottom:12px">Config Additions</h3>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:16px">Select the ones you want, then copy them all at once.</p>
      <div id="config-list">`+cfgCards.String()+`</div>
      <button class="copy-btn" style="margin-top:12px;padding:8px 18px;font-size:12px" onclick="
        var checks=document.querySelectorAll('.cfg-check:checked');
        var lines=['# Agent config additions (generated by Caracal Insights)',''];
        for(var ch of checks){lines.push(ch.dataset.addition);lines.push('')}
        navigator.clipboard.writeText(lines.join(String.fromCharCode(10)));
        this.textContent='Copied!';setTimeout(()=>this.textContent='Copy All Selected',1500)
      ">Copy All Selected</button>`)
		}

		features := asList(suggestions["features_to_try"])
		if len(features) > 0 {
			var featCards strings.Builder
			for _, raw := range features {
				f := asMap(raw)
				if f == nil {
					continue
				}
				example := hxGet(f, "example", "")
				exampleAttr := hxEsc(example)
				ref := asMap(f["component_ref"])
				// A validated reuse suggestion shows the real component
				// instead of generated content there is nothing to copy from.
				reuseHTML := ""
				if len(ref) > 0 {
					reuseHTML = `<div style="margin-top:10px;padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius-xs);background:var(--bg-alt)"><div style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted);margin-bottom:4px">Already in your registry</div><div style="font-size:13px;font-weight:600">` +
						hxEsc(hxOrValue(ref["qualified_name"], hxGet(ref, "name", ""))) +
						`<span style="font-family:monospace;font-weight:400;color:var(--text-muted);margin-left:8px">v` +
						hxEsc(hxGet(ref, "latest_version", "")) + `</span></div></div>`
				}
				matchReason := hxOrValue(f["match_reason"], "")
				matchHTML := ""
				if hxTruthy(matchReason) {
					matchHTML = `<p style="font-size:12px;color:var(--text-muted);margin-top:8px;font-style:italic">Why this fits: ` + hxEsc(matchReason) + `</p>`
				}
				badge := hxGet(f, "feature", "")
				if len(ref) > 0 {
					badge = "Reuse existing"
				}
				exampleHTML := ""
				if hxTruthy(example) && len(ref) == 0 {
					exampleHTML = `<pre style="background:var(--bg-alt);border:1px solid var(--border);border-radius:var(--radius-xs);padding:12px 14px;font-family:monospace;font-size:12px;color:var(--text-secondary);white-space:pre-wrap;word-break:break-all;margin-top:10px">` + hxEsc(example) + `</pre><button class="copy-btn" style="margin-top:6px" onclick="navigator.clipboard.writeText(this.getAttribute(&quot;data-text&quot;)).then(()=>{this.textContent=&quot;Copied!&quot;;setTimeout(()=>this.textContent=&quot;Copy&quot;,1500)})" data-text="` + exampleAttr + `">Copy</button>`
				}
				featCards.WriteString(`
        <div class="suggestion-card">
          <span class="meta-badge" style="margin-bottom:8px;display:inline-block">` + hxEsc(badge) + `</span>
          <h4 style="font-size:14px;margin-bottom:4px">` + hxEsc(hxGet(f, "one_liner", "")) + `</h4>
          <p style="font-size:13px;color:var(--text-secondary);margin-top:6px">` + hxEsc(hxGet(f, "why_for_you", "")) + `</p>
          ` + reuseHTML + `
          ` + matchHTML + `
          ` + exampleHTML + `
        </div>`)
			}
			suggParts = append(suggParts, `
      <h3 style="font-size:15px;font-weight:600;margin:24px 0 12px">Features to Try</h3>
      <div class="areas-grid">`+featCards.String()+`</div>`)
		}

		patterns := asList(suggestions["usage_patterns"])
		if len(patterns) > 0 {
			var patCards strings.Builder
			for _, raw := range patterns {
				p := asMap(raw)
				if p == nil {
					continue
				}
				prompt := hxGet(p, "copyable_prompt", "")
				promptAttr := hxEsc(prompt)
				promptHTML := ""
				if hxTruthy(prompt) {
					promptHTML = `<pre style="background:var(--bg-alt);border:1px solid var(--border);border-radius:var(--radius-xs);padding:12px 14px;font-family:monospace;font-size:12px;color:var(--text-secondary);white-space:pre-wrap;word-break:break-all;margin-top:10px">` + hxEsc(prompt) + `</pre><button class="copy-btn" style="margin-top:6px" onclick="navigator.clipboard.writeText(this.getAttribute(&quot;data-text&quot;)).then(()=>{this.textContent=&quot;Copied!&quot;;setTimeout(()=>this.textContent=&quot;Copy&quot;,1500)})" data-text="` + promptAttr + `">Copy</button>`
				}
				patCards.WriteString(`
        <div class="suggestion-card">
          <h4 style="font-size:14px;margin-bottom:4px">` + hxEsc(hxGet(p, "title", "")) + `</h4>
          <p style="font-size:13px;color:var(--text-secondary);margin-top:6px">` + hxEsc(hxGet(p, "suggestion", "")) + `</p>
          <p style="font-size:12px;color:var(--text-muted);margin-top:8px">` + hxEsc(hxGet(p, "detail", "")) + `</p>
          ` + promptHTML + `
        </div>`)
			}
			suggParts = append(suggParts, `
      <h3 style="font-size:15px;font-weight:600;margin:24px 0 12px">Usage Patterns</h3>
      <div style="display:flex;flex-direction:column;gap:12px">`+patCards.String()+`</div>`)
		}

		items := asList(suggestions["items"])
		if len(items) > 0 && len(configAdditions) == 0 && len(features) == 0 && len(patterns) == 0 {
			var suggestionCards strings.Builder
			for i, raw := range items {
				idx := i + 1
				item := asMap(raw)
				if item == nil {
					continue
				}
				priority := hxGet(item, "priority", "medium")
				actionText := hxGet(item, "action", "")
				actionAttr := hxEsc(actionText)
				suggestionCards.WriteString(`
        <div class="suggestion-card">
          <div class="suggestion-header">
            <span class="suggestion-num">#` + strconv.Itoa(idx) + `</span>
            <h4>` + hxEsc(hxGet(item, "title", "")) + `</h4>
            <span class="priority-badge" style="background:` + hxPriorityColor(priority) + `;color:white;">` + strings.ToUpper(hxEsc(priority)) + `</span>
          </div>
          <div class="suggestion-action">
            <div class="action-row">
              <span class="action-text">` + hxEsc(actionText) + `</span>
              <button class="copy-btn" onclick="navigator.clipboard.writeText(this.getAttribute('data-text')).then(()=>{this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500)})" data-text="` + actionAttr + `">Copy</button>
            </div>
          </div>
          <p class="suggestion-why"><em>` + hxEsc(hxGet(item, "why", "")) + `</em></p>
        </div>`)
			}
			suggParts = append(suggParts, `<div class="suggestions-list">`+suggestionCards.String()+`</div>`)
		}

		if len(suggParts) > 0 {
			sections = append(sections, `
<section>
  <h2>Suggestions</h2>
  `+strings.Join(suggParts, "")+`
</section>`)
		}
	}

	// Repeated Instructions
	if repeated := asList(facets["repeated_instructions"]); len(repeated) > 0 {
		var rows strings.Builder
		for _, raw := range repeated {
			item := asMap(raw)
			if item == nil {
				continue
			}
			rows.WriteString(`
          <tr>
            <td class="instruction-cell">` + hxEsc(hxGet(item, "instruction", "")) + `</td>
            <td class="freq-cell">` + hxText(hxGet(item, "frequency", 0)) + `</td>
          </tr>`)
		}
		sections = append(sections, `
<section>
  <h2>Repeated Instructions</h2>
  <p class="section-intro">Instructions that appear across multiple sessions, indicating habits or persistent needs.</p>
  <table class="repeated-table">
    <thead><tr><th>Instruction</th><th>Frequency</th></tr></thead>
    <tbody>`+rows.String()+`
    </tbody>
  </table>
</section>`)
	}

	// Usage & Cost Analysis
	if hxTruthy(usageCost) || hxTruthy(costM) {
		costSummary := hxGet(usageCost, "summary", "")
		modelBreakdownV := hxOrValue(usageCost["model_breakdown"], costM["cost_by_model"])
		opportunities := asList(usageCost["opportunities"])

		var modelRows strings.Builder
		if mb := asMap(modelBreakdownV); len(mb) > 0 {
			kvs := hxSortedKVDesc(mb)
			if len(kvs) > 6 {
				kvs = kvs[:6]
			}
			for _, kv := range kvs {
				if n, ok := hxNumeric(kv.raw); ok {
					modelRows.WriteString(`<tr><td><code>` + hxEsc(kv.key) + `</code></td><td>` + hxCostF(n) + `</td></tr>`)
				}
			}
		} else if lst := asList(modelBreakdownV); len(lst) > 0 {
			if len(lst) > 6 {
				lst = lst[:6]
			}
			for _, raw := range lst {
				item := asMap(raw)
				if item == nil {
					continue
				}
				modelName := hxGet(item, "model", "unknown")
				modelCost := hxGet(item, "cost_usd", hxGet(item, "total_cost_usd", 0))
				modelRows.WriteString(`<tr><td><code>` + hxEsc(modelName) + `</code></td><td>` + hxCost(modelCost) + `</td></tr>`)
			}
		}

		var oppHTML strings.Builder
		for _, raw := range opportunities {
			switch t := raw.(type) {
			case string:
				oppHTML.WriteString(`<li>` + hxEsc(t) + `</li>`)
			case map[string]any:
				oppHTML.WriteString(`<li><strong>` + hxEsc(hxGet(t, "title", "")) + `</strong>: ` + hxEsc(hxGet(t, "description", "")) + `</li>`)
			}
		}

		cachePct := "0.0"
		if v, ok := costM["cache_efficiency_ratio"]; ok {
			if f, isNum := hxNumeric(v); isNum {
				val := f
				if f <= 1 {
					val = f * 100
				}
				cachePct = hxFloatText(hxRound1(val))
			} else {
				cachePct = "0"
			}
		}

		summaryHTML := ""
		if hxTruthy(costSummary) {
			summaryHTML = `<p class="narrative">` + hxEsc(costSummary) + `</p>`
		}
		modelHTML := ""
		if modelRows.Len() > 0 {
			modelHTML = `<div class="model-breakdown"><h4>Cost by Model</h4><table><thead><tr><th>Model</th><th>Cost</th></tr></thead><tbody>` + modelRows.String() + `</tbody></table></div>`
		}
		oppDivHTML := ""
		if oppHTML.Len() > 0 {
			oppDivHTML = `<div class="cost-opportunities"><h4>Optimization Opportunities</h4><ul>` + oppHTML.String() + `</ul></div>`
		}

		sections = append(sections, `
<section>
  <h2>Usage &amp; Cost Analysis</h2>
  `+summaryHTML+`
  <div class="cost-grid">
    <div class="cost-card">
      <span class="cost-val">`+hxCost(costM["total_cost_usd"])+`</span>
      <span class="cost-lbl">Total Cost</span>
    </div>
    <div class="cost-card">
      <span class="cost-val">`+hxCost(costM["avg_cost_per_session"])+`</span>
      <span class="cost-lbl">Per Session</span>
    </div>
    <div class="cost-card">
      <span class="cost-val">`+cachePct+`%</span>
      <span class="cost-lbl">Cache Hit Rate</span>
    </div>
    <div class="cost-card">
      <span class="cost-val">`+hxFormatNumber(hxGet(tokens, "total_tokens", 0))+`</span>
      <span class="cost-lbl">Total Tokens</span>
    </div>
  </div>
  `+modelHTML+`
  `+oppDivHTML+`
</section>`)
	}

	// Regression Flags
	hasRegressionNarrative := hxTruthy(regression) && hxTruthy(regression["has_previous_data"])
	if hasRegressionNarrative || len(regressionsList) > 0 {
		changes := asList(hxGet(regression, "changes", nil))
		if len(changes) == 0 {
			changes = regressionsList
		}
		if len(changes) > 0 {
			var changeRows strings.Builder
			for _, raw := range changes {
				ch := asMap(raw)
				if ch == nil {
					continue
				}
				direction := hxGet(ch, "direction", "stable")
				arrow, color := "&#8594;", "var(--text-muted)"
				switch direction {
				case "improved":
					arrow, color = "&#8593;", "var(--green)"
				case "degraded":
					arrow, color = "&#8595;", "var(--red)"
				}
				mag, _ := hxNumeric(hxGet(ch, "magnitude_pct", 0))
				changeRows.WriteString(`
          <tr>
            <td>` + hxEsc(hxGet(ch, "metric", "")) + `</td>
            <td style="color:` + color + `;font-weight:600;">` + arrow + ` ` + hxEsc(direction) + `</td>
            <td>` + hxEscape(hxText(hxGet(ch, "previous_value", ""))) + `</td>
            <td>` + hxEscape(hxText(hxGet(ch, "current_value", ""))) + `</td>
            <td>` + hxF(mag, 1) + `%</td>
            <td>` + hxEsc(hxGet(ch, "significance", "")) + `</td>
          </tr>`)
			}
			sections = append(sections, `
<section class="regression-section">
  <h2>Regression Flags</h2>
  <p class="narrative">`+hxEsc(hxGet(regression, "summary", "Period-over-period changes detected."))+`</p>
  <table class="regression-table">
    <thead><tr><th>Metric</th><th>Direction</th><th>Previous</th><th>Current</th><th>Change</th><th>Significance</th></tr></thead>
    <tbody>`+changeRows.String()+`
    </tbody>
  </table>
</section>`)
		}
	}

	// Version Comparison
	if hxTruthy(versionComparison) {
		var changesHTML strings.Builder
		vcChanges := asList(hxGet(versionComparison, "changes", nil))
		if len(vcChanges) > 8 {
			vcChanges = vcChanges[:8]
		}
		for _, raw := range vcChanges {
			change := asMap(raw)
			changesHTML.WriteString(`
    <div class="insight-card">
      <h4>` + hxEsc(hxGet(change, "metric", "Change")) + `: ` + hxEsc(hxGet(change, "direction", "")) + `</h4>
      <p>` + hxEsc(hxGet(change, "prior_value", "?")) + ` &rarr; ` + hxEsc(hxGet(change, "current_value", "?")) + `</p>
      <p class="muted">Attribution: ` + hxEsc(hxGet(change, "attribution", "unknown")) + ` &middot; Risk: ` + hxEsc(hxGet(change, "risk", "none")) + `</p>
      <p>` + hxEsc(hxGet(change, "evidence", "")) + `</p>
    </div>`)
		}
		sections = append(sections, `
<section class="content-section">
  <h2>Version Comparison</h2>
  <p>`+hxEsc(hxGet(versionComparison, "summary", ""))+`</p>
  <p class="muted">Confidence: `+hxEsc(hxGet(versionComparison, "confidence", ""))+`</p>
  <div class="insights-list">`+changesHTML.String()+`</div>
</section>`)
	}

	// Fun Ending
	if hxTruthy(funEnding) && hxTruthy(funEnding["headline"]) {
		sections = append(sections, `
<section class="fun-ending-section">
  <div class="fun-card">
    <h3>`+hxEsc(hxGet(funEnding, "headline", ""))+`</h3>
    <p>`+hxEsc(hxGet(funEnding, "detail", ""))+`</p>
  </div>
</section>`)
	}

	// Assemble the document.
	bodyContent := strings.Join(sections, "\n")
	nowStr := time.Now().Format("2006-01-02 15:04") + " UTC"

	var versionBits []string
	if agentVersion != "" {
		versionBits = append(versionBits, "Version v"+hxEscape(agentVersion))
	}
	if comparisonVersion != "" {
		versionBits = append(versionBits, "Compared to v"+hxEscape(comparisonVersion))
	}
	versionText := strings.Join(versionBits, " &nbsp;&middot;&nbsp; ")
	subtitleLead := ""
	if versionText != "" {
		subtitleLead = versionText + " &nbsp;&middot;&nbsp;"
	}

	var b strings.Builder
	b.WriteString(hxDocHead)
	b.WriteString("Caracal Agent Insights &mdash; " + hxEsc(name) + " &mdash; " + hxEsc(periodStart) + " to " + hxEsc(periodEnd))
	b.WriteString(hxDocStyle)
	b.WriteString(hxEsc(name))
	b.WriteString(`</h1>
      <p class="subtitle">
        ` + subtitleLead + `
        Period: ` + hxEsc(periodStart) + ` &mdash; ` + hxEsc(periodEnd) + ` &nbsp;&middot;&nbsp;
        ` + hxText(sessionsAnalyzed) + ` sessions analyzed &nbsp;&middot;&nbsp;
        Report ` + hxEscape(truncateRunes(reportID, 8)) + `
      </p>
    </header>

    ` + bodyContent + `

    <footer>
      <div class="footer-brand">CARACAL</div>
      <p>Generated ` + nowStr + `</p>
    </footer>
  </div>
</body>
</html>`)
	return b.String(), nil
}
