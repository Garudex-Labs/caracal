// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/garudex-labs/caracal/internal/clickhouse"
)

// Session ids originate from client-supplied ingest payloads, so they are
// untrusted. Ids are rejected (not escaped) unless they match this
// allowlist; quote-stripping alone would still admit a trailing backslash
// that swallows the closing quote of the array literal.
var safeSessionID = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

// extensionToLanguage detects languages by file extension.
var extensionToLanguage = map[string]string{
	".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
	".py": "Python", ".rb": "Ruby", ".go": "Go", ".rs": "Rust", ".java": "Java",
	".md": "Markdown", ".json": "JSON", ".yaml": "YAML", ".yml": "YAML", ".sh": "Shell",
	".css": "CSS", ".html": "HTML", ".c": "C", ".cpp": "C++", ".cs": "C#",
	".kt": "Kotlin", ".swift": "Swift",
}

// sessionMeta carries the deterministic per-session statistics.
type sessionMeta struct {
	SessionID             string
	ProjectPath           string
	StartTime             string
	EndTime               string
	DurationSeconds       float64
	UserMessageCount      int
	AssistantMessageCount int
	TotalMessages         int
	ToolCounts            map[string]int
	Languages             map[string]int
	GitCommits            int
	GitPushes             int
	InputTokens           int64
	OutputTokens          int64
	CacheReadTokens       int64
	CacheWriteTokens      int64
	TotalCost             float64
	FirstPrompt           string
	UserInterruptions     int
	ToolErrors            int
	ToolErrorCategories   map[string]int
	UsesSubagent          bool
	UsesMCP               bool
	LinesAdded            int
	LinesRemoved          int
	FilesModified         int
	UserResponseTimes     []float64
	MessageHours          []int
	ModelUsage            map[string]*modelUsage
	Credits               float64
	Harness               string
	LayerHash             string
	AgentVersion          string
}

type modelUsage struct {
	InputTokens  int64
	OutputTokens int64
	Cost         float64
	Messages     int
	Sessions     int
	Tier         string
	CostPer1K    float64
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func asList(v any) []any {
	l, _ := v.([]any)
	return l
}

func asInt64(v any) int64 {
	switch n := v.(type) {
	case float64:
		return int64(n)
	case json.Number:
		f, _ := n.Float64()
		return int64(f)
	}
	return 0
}

func asFloat(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case json.Number:
		f, _ := n.Float64()
		return f
	}
	return 0
}

func countNewlines(s string) int {
	return strings.Count(s, "\n")
}

func fileExt(path string) string {
	return strings.ToLower(filepath.Ext(path))
}

// contentText flattens message content (string or block list) to text.
func contentText(content any) string {
	if s, ok := content.(string); ok {
		return s
	}
	if blocks, ok := content.([]any); ok {
		parts := []string{}
		for _, b := range blocks {
			if block := asMap(b); block != nil && str(block["type"]) == "text" {
				parts = append(parts, str(block["text"]))
			}
		}
		return strings.Join(parts, " ")
	}
	if content == nil {
		return ""
	}
	return ""
}

// parseEventTime accepts the timestamp shapes transcripts carry.
func parseEventTime(ts string) (time.Time, bool) {
	ts = strings.Replace(ts, "Z", "+00:00", 1)
	for _, layout := range []string{
		"2006-01-02T15:04:05.999999999-07:00",
		"2006-01-02T15:04:05-07:00",
		"2006-01-02T15:04:05.999999999",
		"2006-01-02T15:04:05",
	} {
		if t, err := time.Parse(layout, ts); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

// extractSessionMeta computes the deterministic statistics of one session
// from its raw JSONL lines. No model call happens here.
func extractSessionMeta(sessionID string, rawLines []string) *sessionMeta {
	meta := &sessionMeta{
		SessionID:           sessionID,
		ToolCounts:          map[string]int{},
		Languages:           map[string]int{},
		ToolErrorCategories: map[string]int{},
		UserResponseTimes:   []float64{},
		MessageHours:        []int{},
		ModelUsage:          map[string]*modelUsage{},
	}
	filesModified := map[string]bool{}
	seenToolIDs := map[string]bool{}
	var lastAssistantTS float64
	haveLastAssistant := false

	trackTime := func(ts string) {
		if ts == "" {
			return
		}
		if meta.StartTime == "" || ts < meta.StartTime {
			meta.StartTime = ts
		}
		if meta.EndTime == "" || ts > meta.EndTime {
			meta.EndTime = ts
		}
	}

	countLanguage := func(filePath string) {
		if filePath == "" {
			return
		}
		if lang, ok := extensionToLanguage[fileExt(filePath)]; ok {
			meta.Languages[lang]++
		}
	}
	countGit := func(args map[string]any) {
		if cmd, ok := args["command"].(string); ok {
			if strings.Contains(cmd, "git commit") {
				meta.GitCommits++
			}
			if strings.Contains(cmd, "git push") {
				meta.GitPushes++
			}
		}
	}
	argPath := func(args map[string]any) string {
		if p := str(args["path"]); p != "" {
			return p
		}
		return str(args["file_path"])
	}

	for _, raw := range rawLines {
		if strings.TrimSpace(raw) == "" {
			continue
		}
		var entry map[string]any
		if err := json.Unmarshal([]byte(raw), &entry); err != nil {
			continue
		}

		entryType := str(entry["type"])
		tsStr := str(entry["timestamp"])

		// Structured-transcript shape: {"kind": "Prompt"|"AssistantMessage",
		// "data": {...}} with epoch timestamps inside data.meta.
		if entryKind := str(entry["kind"]); entryKind != "" && entryType == "" {
			data := asMap(entry["data"])
			if data != nil {
				if metaField := asMap(data["meta"]); metaField != nil {
					if epoch := asFloat(metaField["timestamp"]); epoch != 0 {
						sec, frac := math.Modf(epoch)
						trackTime(time.Unix(int64(sec), int64(frac*1e9)).UTC().Format("2006-01-02T15:04:05.999999-07:00"))
					}
				}
				switch entryKind {
				case "Prompt":
					meta.UserMessageCount++
					meta.TotalMessages++
					textParts := []string{}
					for _, item := range asList(data["content"]) {
						if m := asMap(item); m != nil && str(m["kind"]) == "text" {
							textParts = append(textParts, str(m["data"]))
						}
					}
					if meta.FirstPrompt == "" && len(textParts) > 0 {
						meta.FirstPrompt = truncateRunes(strings.Join(textParts, "\n"), 200)
					}
				case "AssistantMessage":
					meta.AssistantMessageCount++
					meta.TotalMessages++
					for _, item := range asList(data["content"]) {
						m := asMap(item)
						if m == nil || str(m["kind"]) != "toolUse" {
							continue
						}
						toolData := asMap(m["data"])
						if toolData == nil {
							continue
						}
						toolName := str(toolData["name"])
						if toolName == "" {
							toolName = "unknown"
						}
						meta.ToolCounts[toolName]++
						args := asMap(toolData["input"])
						if args == nil {
							continue
						}
						filePath := argPath(args)
						countLanguage(filePath)
						switch {
						case toolName == "write" && filePath != "":
							filesModified[filePath] = true
							if content, ok := args["content"].(string); ok && content != "" {
								meta.LinesAdded += countNewlines(content) + 1
							}
						case toolName == "edit" && filePath != "":
							filesModified[filePath] = true
							old := str(args["oldStr"])
							if old == "" {
								old = str(args["old_string"])
							}
							updated := str(args["newStr"])
							if updated == "" {
								updated = str(args["new_string"])
							}
							if old != "" {
								meta.LinesRemoved += countNewlines(old) + 1
							}
							if updated != "" {
								meta.LinesAdded += countNewlines(updated) + 1
							}
						case toolName == "bash":
							countGit(args)
						}
					}
				case "ToolResults":
					meta.TotalMessages++
				}
			}
			continue
		}

		trackTime(tsStr)

		if entryType == "session" {
			meta.ProjectPath = str(entry["cwd"])
			continue
		}
		if entryType != "message" {
			continue
		}
		msg := asMap(entry["message"])
		if msg == nil {
			continue
		}
		role := str(msg["role"])
		meta.TotalMessages++

		var msgTS float64
		haveMsgTS := false
		if tsStr != "" {
			if t, ok := parseEventTime(tsStr); ok {
				msgTS = float64(t.UnixNano()) / 1e9
				haveMsgTS = true
			}
		}

		switch role {
		case "assistant":
			meta.AssistantMessageCount++
			if haveMsgTS {
				lastAssistantTS = msgTS
				haveLastAssistant = true
			}

			usage := asMap(msg["usage"])
			msgModel := str(msg["model"])
			if len(usage) > 0 {
				msgIn := asInt64(usage["input"])
				msgOut := asInt64(usage["output"])
				meta.InputTokens += msgIn
				meta.OutputTokens += msgOut
				meta.CacheReadTokens += asInt64(usage["cacheRead"])
				meta.CacheWriteTokens += asInt64(usage["cacheWrite"])
				msgCost := 0.0
				if cost := asMap(usage["cost"]); cost != nil {
					if total := asFloat(cost["total"]); total != 0 {
						msgCost = total
						meta.TotalCost += msgCost
					}
				}
				if msgModel != "" {
					u := meta.usageFor(msgModel)
					u.InputTokens += msgIn
					u.OutputTokens += msgOut
					u.Cost += msgCost
					u.Messages++
				}
			} else if msgModel != "" {
				meta.usageFor(msgModel).Messages++
			}

			for _, b := range asList(msg["content"]) {
				block := asMap(b)
				if block == nil || str(block["type"]) != "toolCall" {
					continue
				}
				toolName := str(block["name"])
				toolID := str(block["id"])
				if toolID != "" && seenToolIDs[toolID] {
					continue
				}
				if toolID != "" {
					seenToolIDs[toolID] = true
				}
				meta.ToolCounts[toolName]++
				if toolName == "subagent" {
					meta.UsesSubagent = true
				}
				if strings.HasPrefix(toolName, "mcp__") || toolName == "mcp" {
					meta.UsesMCP = true
				}
				args := asMap(block["arguments"])
				if args == nil {
					if s, ok := block["arguments"].(string); ok {
						_ = json.Unmarshal([]byte(s), &args)
					}
				}
				if args == nil {
					args = map[string]any{}
				}
				filePath := argPath(args)
				countLanguage(filePath)
				if toolName == "write" && filePath != "" {
					filesModified[filePath] = true
					content, _ := args["content"].(string)
					meta.LinesAdded += countNewlines(content) + 1
				}
				if toolName == "edit" && filePath != "" {
					filesModified[filePath] = true
					for _, e := range asList(args["edits"]) {
						edit := asMap(e)
						if edit == nil {
							continue
						}
						old := str(edit["oldText"])
						if old == "" {
							old = str(edit["old_string"])
						}
						updated := str(edit["newText"])
						if updated == "" {
							updated = str(edit["new_string"])
						}
						meta.LinesRemoved += countNewlines(old) + 1
						meta.LinesAdded += countNewlines(updated) + 1
					}
				}
				if toolName == "bash" {
					countGit(args)
				}
			}

		case "user":
			text := contentText(msg["content"])
			if strings.TrimSpace(text) == "" {
				continue
			}
			meta.UserMessageCount++
			if meta.FirstPrompt == "" {
				meta.FirstPrompt = truncateRunes(strings.TrimSpace(text), 300)
			}
			if strings.Contains(text, "[Request interrupted by user") {
				meta.UserInterruptions++
			}
			if haveMsgTS {
				sec, frac := math.Modf(msgTS)
				dt := time.Unix(int64(sec), int64(frac*1e9))
				meta.MessageHours = append(meta.MessageHours, dt.Hour())
				if haveLastAssistant {
					gap := msgTS - lastAssistantTS
					if gap > 2 && gap < 3600 {
						meta.UserResponseTimes = append(meta.UserResponseTimes, gap)
					}
				}
			}

		case "toolResult":
			isError, _ := msg["isError"].(bool)
			if !isError {
				continue
			}
			meta.ToolErrors++
			toolName := str(msg["toolName"])
			if toolName == "" {
				toolName = "other"
			}
			errorText := strings.ToLower(contentText(msg["content"]))
			var cat string
			switch {
			case strings.Contains(errorText, "not found") || strings.Contains(errorText, "no such file"):
				cat = "file_not_found"
			case strings.Contains(errorText, "permission"):
				cat = "permission_denied"
			case strings.Contains(errorText, "command failed") || strings.Contains(errorText, "exit code"):
				cat = "command_failed"
			case strings.Contains(strings.ToLower(toolName), "edit") || strings.Contains(errorText, "failed to apply"):
				cat = "edit_failed"
			case strings.Contains(errorText, "reject") || strings.Contains(errorText, "user"):
				cat = "user_rejected"
			case strings.Contains(errorText, "file changed") || strings.Contains(errorText, "modified"):
				cat = "file_changed"
			default:
				cat = "other"
			}
			meta.ToolErrorCategories[cat]++
		}
	}

	meta.FilesModified = len(filesModified)
	if meta.StartTime != "" && meta.EndTime != "" {
		if start, ok := parseEventTime(meta.StartTime); ok {
			if end, ok := parseEventTime(meta.EndTime); ok {
				meta.DurationSeconds = end.Sub(start).Seconds()
			}
		}
	}
	return meta
}

func (m *sessionMeta) usageFor(model string) *modelUsage {
	u, ok := m.ModelUsage[model]
	if !ok {
		u = &modelUsage{}
		m.ModelUsage[model] = u
	}
	return u
}

func (m *sessionMeta) toolCallTotal() int {
	total := 0
	for _, n := range m.ToolCounts {
		total += n
	}
	return total
}

// sessionStat is the aggregate-table enrichment of one session.
type sessionStat struct {
	Credits   float64
	Harness   string
	LayerHash string
}

// fetchSessionStats reads credits, harness, and layer hash per session,
// preferring the aggregate table.
func (e *Engine) fetchSessionStats(ctx context.Context, agentID, agentName, periodStart, periodEnd, agentVersion string) map[string]sessionStat {
	params := clickhouse.Settings{
		"param_agent_id":      agentID,
		"param_agent_name":    agentName,
		"param_t_start":       periodStart,
		"param_t_end":         periodEnd,
		"param_agent_version": agentVersion,
	}
	rows, err := e.CH.QueryJSON(ctx, `
		SELECT session_id, total_credits, harness, layer_hash
		FROM session_stats_agg FINAL
		WHERE (agent_id = {agent_id:String} OR agent_id = {agent_name:String})
		  AND last_event_time >= {t_start:String}
		  AND last_event_time <= {t_end:String}
		  AND `+versionFilter("agent_version", false)+`
		GROUP BY session_id, total_credits, harness, layer_hash
		FORMAT JSON`, params)
	if err == nil {
		return statRows(rows)
	}
	slog.Warn("session stats aggregate read failed", "error", err)

	rows, err = e.CH.QueryJSON(ctx, `
		SELECT
			session_id,
			max(credits) AS total_credits,
			anyIf(harness, harness != '') AS harness,
			anyIf(layer_hash, layer_hash IS NOT NULL AND layer_hash != '') AS layer_hash
		FROM session_events FINAL
		WHERE (agent_id = {agent_id:String} OR agent_id = {agent_name:String})
		  AND timestamp >= {t_start:String}
		  AND timestamp <= {t_end:String}
		  AND `+versionFilter("agent_version", true)+`
		GROUP BY session_id
		FORMAT JSON`, params)
	if err != nil {
		slog.Warn("session stats fallback read failed", "error", err)
		return map[string]sessionStat{}
	}
	return statRows(rows)
}

func statRows(rows []map[string]any) map[string]sessionStat {
	out := map[string]sessionStat{}
	for _, row := range rows {
		sid := chString(row, "session_id")
		if sid == "" {
			continue
		}
		out[sid] = sessionStat{
			Credits:   chFloat(row, "total_credits"),
			Harness:   chString(row, "harness"),
			LayerHash: chString(row, "layer_hash"),
		}
	}
	return out
}

const transcriptBatchSize = 50

// idArray renders session ids as an array literal; unsafe ids are dropped.
func idArray(sessionIDs []string) (string, int) {
	safe := []string{}
	for _, sid := range sessionIDs {
		if safeSessionID.MatchString(sid) {
			safe = append(safe, "'"+sid+"'")
		}
	}
	return "[" + strings.Join(safe, ",") + "]", len(safe)
}

// fetchAllSessionTranscripts loads raw JSONL lines for every session of the
// agent in the period, batched to bound memory.
func (e *Engine) fetchAllSessionTranscripts(ctx context.Context, agentID, agentName, periodStart, periodEnd, agentVersion string) (map[string][]string, []string) {
	params := clickhouse.Settings{
		"param_agent_id":      agentID,
		"param_agent_name":    agentName,
		"param_t_start":       periodStart,
		"param_t_end":         periodEnd,
		"param_agent_version": agentVersion,
	}
	rows, err := e.CH.QueryJSON(ctx, `
		SELECT session_id
		FROM session_stats_agg FINAL
		WHERE (agent_id = {agent_id:String} OR agent_id = {agent_name:String})
		  AND last_event_time >= {t_start:String}
		  AND last_event_time <= {t_end:String}
		  AND `+versionFilter("agent_version", false)+`
		GROUP BY session_id
		ORDER BY min(last_event_time)
		FORMAT JSON`, params)
	if err != nil {
		slog.Warn("session id aggregate read failed", "error", err)
		rows, err = e.CH.QueryJSON(ctx, `
			SELECT DISTINCT session_id
			FROM session_events FINAL
			WHERE (agent_id = {agent_id:String} OR agent_id = {agent_name:String})
			  AND timestamp >= {t_start:String}
			  AND timestamp <= {t_end:String}
			  AND `+versionFilter("agent_version", true)+`
			ORDER BY session_id
			FORMAT JSON`, params)
		if err != nil {
			slog.Error("session id read failed", "error", err)
			return map[string][]string{}, nil
		}
	}
	sessionIDs := []string{}
	for _, row := range rows {
		if sid := chString(row, "session_id"); sid != "" {
			sessionIDs = append(sessionIDs, sid)
		}
	}
	if len(sessionIDs) == 0 {
		return map[string][]string{}, nil
	}

	all := map[string][]string{}
	order := []string{}
	for i := 0; i < len(sessionIDs); i += transcriptBatchSize {
		batch := sessionIDs[i:min(i+transcriptBatchSize, len(sessionIDs))]
		literal, kept := idArray(batch)
		if kept < len(batch) {
			slog.Warn("dropped unsafe session ids", "dropped", len(batch)-kept)
		}
		if kept == 0 {
			continue
		}
		rows, err := e.CH.QueryJSON(ctx, `
			SELECT session_id, raw_line
			FROM session_events FINAL
			WHERE session_id IN ({ids:Array(String)})
			  AND raw_line != ''
			ORDER BY session_id, line_offset
			FORMAT JSON`, clickhouse.Settings{"param_ids": literal})
		if err != nil {
			slog.Warn("transcript batch read failed", "batch_start", i, "error", err)
			continue
		}
		for _, row := range rows {
			sid := chString(row, "session_id")
			if sid == "" {
				continue
			}
			if _, seen := all[sid]; !seen {
				order = append(order, sid)
			}
			all[sid] = append(all[sid], chString(row, "raw_line"))
		}
	}
	return all, order
}

// extractAllSessionMetas fetches transcripts and computes deterministic
// metadata for every session, enriched from the aggregate table.
func (e *Engine) extractAllSessionMetas(ctx context.Context, agentID, agentName, periodStart, periodEnd, agentVersion string) []*sessionMeta {
	transcripts, order := e.fetchAllSessionTranscripts(ctx, agentID, agentName, periodStart, periodEnd, agentVersion)
	stats := e.fetchSessionStats(ctx, agentID, agentName, periodStart, periodEnd, agentVersion)

	metas := make([]*sessionMeta, 0, len(order))
	for _, sid := range order {
		meta := extractSessionMeta(sid, transcripts[sid])
		if stat, ok := stats[sid]; ok {
			meta.Credits = stat.Credits
			meta.Harness = stat.Harness
			meta.LayerHash = stat.LayerHash
		}
		meta.AgentVersion = agentVersion
		metas = append(metas, meta)
	}
	slog.Info("session metadata extracted", "sessions", len(metas))
	return metas
}

// pair is a (label, count) tuple rendered as a two-element array.
type pair struct {
	Key   string
	Count int
}

func (p pair) MarshalJSON() ([]byte, error) {
	return json.Marshal([]any{p.Key, p.Count})
}

// rankedPairs orders a counting map by count descending, first-seen order
// breaking ties.
func rankedPairs(counts map[string]int, order []string, limit int) []pair {
	pairs := make([]pair, 0, len(order))
	for _, key := range order {
		pairs = append(pairs, pair{Key: key, Count: counts[key]})
	}
	sort.SliceStable(pairs, func(i, j int) bool { return pairs[i].Count > pairs[j].Count })
	if limit > 0 && len(pairs) > limit {
		pairs = pairs[:limit]
	}
	return pairs
}

// orderedCount tracks counts with first-seen key order.
type orderedCount struct {
	counts map[string]int
	order  []string
}

func newOrderedCount() *orderedCount { return &orderedCount{counts: map[string]int{}} }

func (c *orderedCount) add(key string, n int) {
	if _, seen := c.counts[key]; !seen {
		c.order = append(c.order, key)
	}
	c.counts[key] += n
}

// metaAggregate is the cross-session summary of deterministic stats.
type metaAggregate struct {
	TotalSessions       int
	TotalMessages       int
	TotalDurationHours  float64
	TotalInputTokens    int64
	TotalOutputTokens   int64
	TotalCacheReadToks  int64
	TotalCacheWriteToks int64
	TotalCost           float64
	TotalCredits        float64
	TotalLinesAdded     int
	TotalLinesRemoved   int
	TotalFilesModified  int
	GitCommits          int
	GitPushes           int
	TotalToolErrors     int
	TotalInterruptions  int
	SessionsUsingSubag  int
	SessionsUsingMCP    int
	ToolCounts          *orderedCount
	Languages           *orderedCount
	ToolErrorCategories *orderedCount
	Projects            *orderedCount
	DaysActive          int
	Harnesses           []string
	SessionsWithTokens  int
	SessionsWithCredits int
	ModelUsage          map[string]*modelUsage
	modelOrder          []string
	ModelTiers          map[string]string
	TopTools            []pair
	TopLanguages        []pair
}

func (a *metaAggregate) usageFor(model string) *modelUsage {
	u, ok := a.ModelUsage[model]
	if !ok {
		u = &modelUsage{}
		a.ModelUsage[model] = u
		a.modelOrder = append(a.modelOrder, model)
	}
	return u
}

// modelsByCost orders models by aggregate cost descending, stable on
// first-seen order.
func (a *metaAggregate) modelsByCost() []string {
	models := append([]string{}, a.modelOrder...)
	sort.SliceStable(models, func(i, j int) bool {
		return a.ModelUsage[models[i]].Cost > a.ModelUsage[models[j]].Cost
	})
	return models
}

// aggregateMetas folds per-session metadata into totals, distributions,
// and cost-tier classifications.
func aggregateMetas(metas []*sessionMeta) *metaAggregate {
	agg := &metaAggregate{
		TotalSessions:       len(metas),
		ToolCounts:          newOrderedCount(),
		Languages:           newOrderedCount(),
		ToolErrorCategories: newOrderedCount(),
		Projects:            newOrderedCount(),
		ModelUsage:          map[string]*modelUsage{},
		ModelTiers:          map[string]string{},
	}
	days := map[string]bool{}
	harnesses := map[string]bool{}

	for _, meta := range metas {
		agg.TotalMessages += meta.TotalMessages
		agg.TotalDurationHours += meta.DurationSeconds / 3600
		agg.TotalInputTokens += meta.InputTokens
		agg.TotalOutputTokens += meta.OutputTokens
		agg.TotalCacheReadToks += meta.CacheReadTokens
		agg.TotalCacheWriteToks += meta.CacheWriteTokens
		agg.TotalCost += meta.TotalCost
		agg.TotalCredits += meta.Credits
		if meta.InputTokens > 0 || meta.OutputTokens > 0 {
			agg.SessionsWithTokens++
		}
		if meta.Credits > 0 {
			agg.SessionsWithCredits++
		}
		if meta.Harness != "" {
			harnesses[meta.Harness] = true
		}
		agg.TotalLinesAdded += meta.LinesAdded
		agg.TotalLinesRemoved += meta.LinesRemoved
		agg.TotalFilesModified += meta.FilesModified
		agg.GitCommits += meta.GitCommits
		agg.GitPushes += meta.GitPushes
		agg.TotalToolErrors += meta.ToolErrors
		agg.TotalInterruptions += meta.UserInterruptions
		if meta.UsesSubagent {
			agg.SessionsUsingSubag++
		}
		if meta.UsesMCP {
			agg.SessionsUsingMCP++
		}
		for tool, count := range meta.ToolCounts {
			agg.ToolCounts.add(tool, count)
		}
		for lang, count := range meta.Languages {
			agg.Languages.add(lang, count)
		}
		for model, usage := range meta.ModelUsage {
			u := agg.usageFor(model)
			u.InputTokens += usage.InputTokens
			u.OutputTokens += usage.OutputTokens
			u.Cost += usage.Cost
			u.Messages += usage.Messages
			u.Sessions++
		}
		for cat, count := range meta.ToolErrorCategories {
			agg.ToolErrorCategories.add(cat, count)
		}
		if meta.ProjectPath != "" {
			parts := strings.Split(meta.ProjectPath, "/")
			proj := parts[len(parts)-1]
			if proj == "" {
				proj = meta.ProjectPath
			}
			agg.Projects.add(proj, 1)
		}
		if meta.StartTime != "" {
			days[truncateRunes(meta.StartTime, 10)] = true
		}
	}

	agg.DaysActive = len(days)
	agg.Harnesses = make([]string, 0, len(harnesses))
	for h := range harnesses {
		agg.Harnesses = append(agg.Harnesses, h)
	}
	sort.Strings(agg.Harnesses)

	agg.TopTools = rankedPairs(agg.ToolCounts.counts, agg.ToolCounts.order, 15)
	agg.TopLanguages = rankedPairs(agg.Languages.counts, agg.Languages.order, 10)

	// Classify models by observed cost per token. Models with significant
	// usage but near-zero cost run on credit-based plans.
	modelCPT := map[string]float64{}
	cptValues := []float64{}
	for model, usage := range agg.ModelUsage {
		totalTok := usage.InputTokens + usage.OutputTokens
		if totalTok > 0 {
			cpt := usage.Cost / float64(totalTok) * 1000
			modelCPT[model] = cpt
			if cpt > 0 {
				cptValues = append(cptValues, cpt)
			}
		}
	}
	sort.Float64s(cptValues)
	cptMedian := 0.01
	if len(cptValues) > 0 {
		cptMedian = cptValues[len(cptValues)/2]
	}
	for model, usage := range agg.ModelUsage {
		totalTok := usage.InputTokens + usage.OutputTokens
		cpt := modelCPT[model]
		var tier string
		switch {
		case (totalTok > 10000 && usage.Cost < 0.01) || (usage.Messages > 20 && cpt < 0.001):
			tier = "subscription"
		case cpt > cptMedian*3:
			tier = "high"
		case cpt < cptMedian*0.4:
			tier = "low"
		default:
			tier = "mid"
		}
		agg.ModelTiers[model] = tier
		usage.Tier = tier
		if cpt != 0 {
			usage.CostPer1K = roundTo(cpt, 4)
		}
	}
	return agg
}

// roundTo rounds half away from zero to the given number of decimals.
func roundTo(v float64, decimals int) float64 {
	scale := math.Pow(10, float64(decimals))
	return math.Round(v*scale) / scale
}
