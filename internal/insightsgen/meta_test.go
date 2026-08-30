// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/garudex-labs/caracal/internal/clickhouse"
)

// fakeCH scripts QueryJSON responses by call number.
type fakeCH struct {
	calls    int
	fn       func(call int, sql string, settings clickhouse.Settings) ([]map[string]any, error)
	sqls     []string
	settings []clickhouse.Settings
}

func (f *fakeCH) QueryJSON(_ context.Context, sql string, settings clickhouse.Settings) ([]map[string]any, error) {
	f.calls++
	f.sqls = append(f.sqls, sql)
	f.settings = append(f.settings, settings)
	return f.fn(f.calls, sql, settings)
}

func TestScalarCoercions(t *testing.T) {
	if str("x") != "x" || str(3) != "" || str(nil) != "" {
		t.Error("str must only pass through strings")
	}
	if asMap(map[string]any{"a": 1}) == nil || asMap("x") != nil {
		t.Error("asMap must only pass through maps")
	}
	if len(asList([]any{1})) != 1 || asList("x") != nil {
		t.Error("asList must only pass through lists")
	}
	if asInt64(float64(3.9)) != 3 {
		t.Errorf("asInt64 float64 = %d", asInt64(float64(3.9)))
	}
	if asInt64(json.Number("2.5")) != 2 {
		t.Errorf("asInt64 json.Number = %d", asInt64(json.Number("2.5")))
	}
	if asInt64("7") != 0 {
		t.Error("asInt64 must not coerce strings")
	}
	if asFloat(float64(1.5)) != 1.5 || asFloat(json.Number("2.5")) != 2.5 || asFloat(nil) != 0 {
		t.Error("asFloat coercion")
	}
}

func TestContentTextShapes(t *testing.T) {
	if got := contentText("plain"); got != "plain" {
		t.Errorf("string: %q", got)
	}
	blocks := []any{
		map[string]any{"type": "text", "text": "one"},
		map[string]any{"type": "tool_use", "name": "x"},
		"loose string",
		map[string]any{"type": "text", "text": "two"},
	}
	if got := contentText(blocks); got != "one two" {
		t.Errorf("blocks: %q", got)
	}
	if contentText(nil) != "" || contentText(float64(42)) != "" {
		t.Error("nil and non-content values must render empty")
	}
}

func TestParseEventTime(t *testing.T) {
	ok := []string{
		"2026-01-02T10:00:00Z",
		"2026-01-02T10:00:00.5+05:30",
		"2026-01-02T10:00:00.123456789-07:00",
		"2026-01-02T10:00:00",
	}
	for _, ts := range ok {
		if _, parsed := parseEventTime(ts); !parsed {
			t.Errorf("%q must parse", ts)
		}
	}
	got, parsed := parseEventTime("2026-01-02T10:00:00Z")
	if !parsed || !got.Equal(time.Date(2026, 1, 2, 10, 0, 0, 0, time.UTC)) {
		t.Errorf("Z timestamp = %v", got)
	}
	for _, ts := range []string{"", "02 Jan 2026", "garbage"} {
		if _, parsed := parseEventTime(ts); parsed {
			t.Errorf("%q must not parse", ts)
		}
	}
}

func TestTruncateRunesRespectsRuneBoundaries(t *testing.T) {
	if got := truncateRunes("h\u00e9llo", 2); got != "h\u00e9" {
		t.Errorf("multibyte truncation: %q", got)
	}
	if got := truncateRunes("ab", 5); got != "ab" {
		t.Errorf("short input unchanged: %q", got)
	}
	if got := truncateRunes("", 0); got != "" {
		t.Errorf("empty: %q", got)
	}
}

func TestFileExtAndCountNewlines(t *testing.T) {
	if got := fileExt("A/B.GO"); got != ".go" {
		t.Errorf("fileExt lowercases: %q", got)
	}
	if got := fileExt("noext"); got != "" {
		t.Errorf("no extension: %q", got)
	}
	if got := countNewlines("a\nb\n"); got != 2 {
		t.Errorf("countNewlines = %d", got)
	}
}

func TestExtractSessionMetaMessageShape(t *testing.T) {
	lines := []string{
		`{"type":"session","cwd":"/home/user/projects/myapp","timestamp":"2026-01-02T10:00:00Z"}`,
		"",
		`not json`,
		`{"type":"message","timestamp":"2026-01-02T10:00:00Z","message":{"role":"user","content":"Fix the login bug please"}}`,
		`{"type":"message","timestamp":"2026-01-02T10:00:10Z","message":{"role":"assistant","model":"gpt-5","usage":{"input":100,"output":50,"cacheRead":10,"cacheWrite":5,"cost":{"total":0.25}},"content":[{"type":"toolCall","id":"t1","name":"edit","arguments":{"path":"main.go","edits":[{"oldText":"a\nb","newText":"c"}]}},{"type":"toolCall","id":"t1","name":"edit","arguments":{}}]}}`,
		`{"type":"message","timestamp":"2026-01-02T10:00:15Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"t2","name":"bash","arguments":"{\"command\":\"git add . && git commit -m x && git push\"}"}]}}`,
		`{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","id":"t3","name":"mcp__github__search"},{"type":"toolCall","id":"t4","name":"subagent"},{"type":"toolCall","id":"t5","name":"write","arguments":{"file_path":"notes.md","content":"line1\nline2"}}]}}`,
		`{"type":"message","timestamp":"2026-01-02T10:00:20Z","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}`,
		`{"type":"message","message":{"role":"toolResult","isError":true,"toolName":"bash","content":"command failed with exit code 1"}}`,
		`{"type":"message","message":{"role":"toolResult","isError":true,"content":"file not found"}}`,
		`{"type":"message","message":{"role":"toolResult","isError":false,"content":"ok"}}`,
	}
	meta := extractSessionMeta("sess-1", lines)

	if meta.ProjectPath != "/home/user/projects/myapp" {
		t.Errorf("ProjectPath = %q", meta.ProjectPath)
	}
	if meta.UserMessageCount != 2 || meta.AssistantMessageCount != 3 || meta.TotalMessages != 8 {
		t.Errorf("message counts = %d user, %d assistant, %d total",
			meta.UserMessageCount, meta.AssistantMessageCount, meta.TotalMessages)
	}
	if meta.FirstPrompt != "Fix the login bug please" {
		t.Errorf("FirstPrompt = %q", meta.FirstPrompt)
	}
	if meta.InputTokens != 100 || meta.OutputTokens != 50 || meta.CacheReadTokens != 10 || meta.CacheWriteTokens != 5 {
		t.Errorf("tokens = %d/%d cache %d/%d",
			meta.InputTokens, meta.OutputTokens, meta.CacheReadTokens, meta.CacheWriteTokens)
	}
	if meta.TotalCost != 0.25 {
		t.Errorf("TotalCost = %v", meta.TotalCost)
	}
	usage := meta.ModelUsage["gpt-5"]
	if usage == nil || usage.InputTokens != 100 || usage.Cost != 0.25 || usage.Messages != 1 {
		t.Errorf("gpt-5 usage = %+v", usage)
	}
	wantTools := map[string]int{"edit": 1, "bash": 1, "mcp__github__search": 1, "subagent": 1, "write": 1}
	if !reflect.DeepEqual(meta.ToolCounts, wantTools) {
		t.Errorf("ToolCounts = %v (duplicate tool ids must dedupe)", meta.ToolCounts)
	}
	if meta.toolCallTotal() != 5 {
		t.Errorf("toolCallTotal = %d", meta.toolCallTotal())
	}
	if !meta.UsesMCP || !meta.UsesSubagent {
		t.Error("mcp__ and subagent tools must flag the session")
	}
	if meta.GitCommits != 1 || meta.GitPushes != 1 {
		t.Errorf("git = %d commits, %d pushes", meta.GitCommits, meta.GitPushes)
	}
	if meta.Languages["Go"] != 1 || meta.Languages["Markdown"] != 1 {
		t.Errorf("Languages = %v", meta.Languages)
	}
	if meta.LinesAdded != 3 || meta.LinesRemoved != 2 {
		t.Errorf("lines = +%d -%d", meta.LinesAdded, meta.LinesRemoved)
	}
	if meta.FilesModified != 2 {
		t.Errorf("FilesModified = %d", meta.FilesModified)
	}
	if meta.UserInterruptions != 1 {
		t.Errorf("UserInterruptions = %d", meta.UserInterruptions)
	}
	if !reflect.DeepEqual(meta.UserResponseTimes, []float64{5}) {
		t.Errorf("UserResponseTimes = %v", meta.UserResponseTimes)
	}
	if len(meta.MessageHours) != 2 {
		t.Errorf("MessageHours = %v", meta.MessageHours)
	}
	if meta.ToolErrors != 2 {
		t.Errorf("ToolErrors = %d", meta.ToolErrors)
	}
	wantCats := map[string]int{"command_failed": 1, "file_not_found": 1}
	if !reflect.DeepEqual(meta.ToolErrorCategories, wantCats) {
		t.Errorf("ToolErrorCategories = %v", meta.ToolErrorCategories)
	}
	if meta.StartTime != "2026-01-02T10:00:00Z" || meta.EndTime != "2026-01-02T10:00:20Z" {
		t.Errorf("times = %q .. %q", meta.StartTime, meta.EndTime)
	}
	if meta.DurationSeconds != 20 {
		t.Errorf("DurationSeconds = %v", meta.DurationSeconds)
	}
}

func TestExtractSessionMetaStructuredShape(t *testing.T) {
	lines := []string{
		`{"kind":"Prompt","data":{"meta":{"timestamp":1735725600.5},"content":[{"kind":"text","data":"Build a CLI"}]}}`,
		`{"kind":"AssistantMessage","data":{"meta":{"timestamp":1735725660},"content":[{"kind":"toolUse","data":{"name":"write","input":{"path":"app.py","content":"print(1)\nprint(2)"}}},{"kind":"toolUse","data":{"name":"edit","input":{"file_path":"app.py","old_string":"x","new_string":"y\nz"}}},{"kind":"toolUse","data":{"name":"bash","input":{"command":"git commit -m msg"}}}]}}`,
		`{"kind":"ToolResults","data":{}}`,
	}
	meta := extractSessionMeta("sess-2", lines)

	if meta.UserMessageCount != 1 || meta.AssistantMessageCount != 1 || meta.TotalMessages != 3 {
		t.Errorf("counts = %d/%d/%d",
			meta.UserMessageCount, meta.AssistantMessageCount, meta.TotalMessages)
	}
	if meta.FirstPrompt != "Build a CLI" {
		t.Errorf("FirstPrompt = %q", meta.FirstPrompt)
	}
	wantTools := map[string]int{"write": 1, "edit": 1, "bash": 1}
	if !reflect.DeepEqual(meta.ToolCounts, wantTools) {
		t.Errorf("ToolCounts = %v", meta.ToolCounts)
	}
	if meta.Languages["Python"] != 2 {
		t.Errorf("Languages = %v", meta.Languages)
	}
	if meta.LinesAdded != 4 || meta.LinesRemoved != 1 {
		t.Errorf("lines = +%d -%d", meta.LinesAdded, meta.LinesRemoved)
	}
	if meta.GitCommits != 1 || meta.GitPushes != 0 {
		t.Errorf("git = %d/%d", meta.GitCommits, meta.GitPushes)
	}
	if meta.FilesModified != 1 {
		t.Errorf("FilesModified = %d", meta.FilesModified)
	}
	if meta.DurationSeconds != 59.5 {
		t.Errorf("DurationSeconds = %v", meta.DurationSeconds)
	}
}

func TestRankedPairs(t *testing.T) {
	counts := map[string]int{"a": 1, "b": 3, "c": 3}
	order := []string{"a", "b", "c"}
	got := rankedPairs(counts, order, 2)
	want := []pair{{"b", 3}, {"c", 3}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("limited = %v, want %v (ties keep first-seen order)", got, want)
	}
	all := rankedPairs(counts, order, 0)
	if len(all) != 3 || all[2].Key != "a" {
		t.Errorf("unlimited = %v", all)
	}
}

func TestPairMarshalsAsTuple(t *testing.T) {
	blob, err := json.Marshal(pair{Key: "x", Count: 2})
	if err != nil {
		t.Fatal(err)
	}
	if string(blob) != `["x",2]` {
		t.Errorf("pair JSON = %s", blob)
	}
}

func TestOrderedCount(t *testing.T) {
	c := newOrderedCount()
	c.add("b", 2)
	c.add("a", 1)
	c.add("b", 3)
	if !reflect.DeepEqual(c.order, []string{"b", "a"}) {
		t.Errorf("order = %v", c.order)
	}
	if c.counts["b"] != 5 || c.counts["a"] != 1 {
		t.Errorf("counts = %v", c.counts)
	}
}

func TestAggregateMetas(t *testing.T) {
	metas := []*sessionMeta{
		{
			SessionID: "s1", DurationSeconds: 3600, TotalMessages: 10,
			InputTokens: 1000, OutputTokens: 500, TotalCost: 5, Credits: 2,
			Harness: "kiro", ProjectPath: "/a/b/proj1",
			StartTime:  "2026-01-01T10:00:00Z",
			ToolCounts: map[string]int{"read": 10, "edit": 5},
			Languages:  map[string]int{"Go": 3},
			ModelUsage: map[string]*modelUsage{
				"m-exp": {InputTokens: 1000, Cost: 5, Messages: 5},
			},
			ToolErrorCategories: map[string]int{"other": 1},
			LinesAdded:          100, LinesRemoved: 50, FilesModified: 3,
			GitCommits: 2, GitPushes: 1, ToolErrors: 1, UserInterruptions: 2,
			UsesSubagent: true, UsesMCP: true,
		},
		{
			SessionID: "s2", InputTokens: 20000, OutputTokens: 5000,
			Harness: "claude-code", ProjectPath: "/a/b/proj1",
			StartTime:  "2026-01-02T09:00:00Z",
			ToolCounts: map[string]int{"read": 2},
			ModelUsage: map[string]*modelUsage{
				"m-sub": {InputTokens: 20000, OutputTokens: 5000, Messages: 3},
			},
		},
		{SessionID: "s3", StartTime: "2026-01-01T23:00:00Z"},
	}
	agg := aggregateMetas(metas)

	if agg.TotalSessions != 3 || agg.TotalMessages != 10 {
		t.Errorf("sessions/messages = %d/%d", agg.TotalSessions, agg.TotalMessages)
	}
	if agg.TotalDurationHours != 1 {
		t.Errorf("TotalDurationHours = %v", agg.TotalDurationHours)
	}
	if agg.DaysActive != 2 {
		t.Errorf("DaysActive = %d", agg.DaysActive)
	}
	if !reflect.DeepEqual(agg.Harnesses, []string{"claude-code", "kiro"}) {
		t.Errorf("Harnesses = %v (must be sorted)", agg.Harnesses)
	}
	if agg.SessionsWithTokens != 2 || agg.SessionsWithCredits != 1 {
		t.Errorf("token/credit sessions = %d/%d", agg.SessionsWithTokens, agg.SessionsWithCredits)
	}
	if agg.TotalInputTokens != 21000 || agg.TotalCost != 5 || agg.TotalCredits != 2 {
		t.Errorf("totals = %d tokens, %v cost, %v credits",
			agg.TotalInputTokens, agg.TotalCost, agg.TotalCredits)
	}
	if agg.SessionsUsingSubag != 1 || agg.SessionsUsingMCP != 1 {
		t.Errorf("subagent/mcp = %d/%d", agg.SessionsUsingSubag, agg.SessionsUsingMCP)
	}
	if agg.Projects.counts["proj1"] != 2 {
		t.Errorf("Projects = %v", agg.Projects.counts)
	}
	wantTop := []pair{{"read", 12}, {"edit", 5}}
	if !reflect.DeepEqual(agg.TopTools, wantTop) {
		t.Errorf("TopTools = %v", agg.TopTools)
	}
	if agg.ModelUsage["m-exp"].Sessions != 1 || agg.ModelUsage["m-sub"].Sessions != 1 {
		t.Error("per-model session counts must track sessions, not messages")
	}
	// m-sub burned 25k tokens at zero cost, which marks a credit plan.
	if agg.ModelTiers["m-sub"] != "subscription" {
		t.Errorf("m-sub tier = %q", agg.ModelTiers["m-sub"])
	}
	if agg.ModelTiers["m-exp"] != "mid" {
		t.Errorf("m-exp tier = %q", agg.ModelTiers["m-exp"])
	}
	if agg.ModelUsage["m-exp"].CostPer1K != 5 {
		t.Errorf("m-exp CostPer1K = %v", agg.ModelUsage["m-exp"].CostPer1K)
	}
}

func TestAggregateMetasModelTierSpread(t *testing.T) {
	agg := aggregateMetas([]*sessionMeta{{
		SessionID: "s1",
		ModelUsage: map[string]*modelUsage{
			"model-high": {InputTokens: 500, OutputTokens: 500, Cost: 10},
			"model-mid":  {InputTokens: 500, OutputTokens: 500, Cost: 1},
			"model-low":  {InputTokens: 500, OutputTokens: 500, Cost: 0.0003},
		},
	}})
	want := map[string]string{"model-high": "high", "model-mid": "mid", "model-low": "low"}
	if !reflect.DeepEqual(agg.ModelTiers, want) {
		t.Errorf("ModelTiers = %v, want %v", agg.ModelTiers, want)
	}
}

func TestModelsByCostOrdersDescending(t *testing.T) {
	agg := aggregateMetas([]*sessionMeta{{
		SessionID: "s1",
		ModelUsage: map[string]*modelUsage{
			"cheap": {InputTokens: 100, Cost: 1},
		},
	}, {
		SessionID: "s2",
		ModelUsage: map[string]*modelUsage{
			"pricey": {InputTokens: 100, Cost: 9},
		},
	}})
	got := agg.modelsByCost()
	if len(got) != 2 || got[0] != "pricey" || got[1] != "cheap" {
		t.Errorf("modelsByCost = %v", got)
	}
}

func TestRoundTo(t *testing.T) {
	if got := roundTo(1.23455, 4); got != 1.2346 {
		t.Errorf("roundTo(1.23455, 4) = %v", got)
	}
	if got := roundTo(-1.25, 1); got != -1.3 {
		t.Errorf("half away from zero: %v", got)
	}
	if got := roundTo(2.5, 0); got != 3 {
		t.Errorf("roundTo(2.5, 0) = %v", got)
	}
}

func TestIDArrayDropsUnsafeIDs(t *testing.T) {
	literal, kept := idArray([]string{
		"abc", "evil'id", "ok_1:2.A-x", "", strings.Repeat("a", 129), "a b",
	})
	if literal != "['abc','ok_1:2.A-x']" || kept != 2 {
		t.Errorf("idArray = %q kept %d", literal, kept)
	}
	literal, kept = idArray(nil)
	if literal != "[]" || kept != 0 {
		t.Errorf("empty idArray = %q kept %d", literal, kept)
	}
}

func TestVersionFilterPredicates(t *testing.T) {
	want := "({agent_version:String} = '' OR v = {agent_version:String} " +
		"OR ({agent_version:String} = '1.0.0' AND v = ''))"
	if got := versionFilter("v", false); got != want {
		t.Errorf("plain = %q", got)
	}
	wantNullable := "({agent_version:String} = '' OR coalesce(v, '') = {agent_version:String} " +
		"OR ({agent_version:String} = '1.0.0' AND coalesce(v, '') = ''))"
	if got := versionFilter("v", true); got != wantNullable {
		t.Errorf("nullable = %q", got)
	}
}

func TestChRowAccessors(t *testing.T) {
	row := map[string]any{"s": "x", "f": 2.5, "fs": "3.5", "i": "7"}
	if chString(row, "s") != "x" || chString(row, "missing") != "" {
		t.Error("chString")
	}
	if chFloat(row, "f") != 2.5 || chFloat(row, "fs") != 3.5 || chFloat(row, "missing") != 0 {
		t.Error("chFloat must parse numeric strings")
	}
	if chInt(row, "i") != 7 {
		t.Error("chInt")
	}
}

func TestStatRows(t *testing.T) {
	got := statRows([]map[string]any{
		{"session_id": "s1", "total_credits": "2.5", "harness": "kiro", "layer_hash": "abc"},
		{"total_credits": "9"},
	})
	want := map[string]sessionStat{
		"s1": {Credits: 2.5, Harness: "kiro", LayerHash: "abc"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("statRows = %v (rows without session_id must be skipped)", got)
	}
}

func TestFetchSessionStatsPrefersAggregate(t *testing.T) {
	ch := &fakeCH{fn: func(call int, sql string, _ clickhouse.Settings) ([]map[string]any, error) {
		return []map[string]any{
			{"session_id": "s1", "total_credits": "1.5", "harness": "pi", "layer_hash": "h"},
		}, nil
	}}
	e := &Engine{CH: ch}
	got := e.fetchSessionStats(context.Background(), "aid", "aname", "2026-01-01", "2026-01-31", "")
	if ch.calls != 1 || !strings.Contains(ch.sqls[0], "session_stats_agg") {
		t.Errorf("aggregate path must issue one aggregate query, got %d calls", ch.calls)
	}
	if got["s1"].Credits != 1.5 || got["s1"].Harness != "pi" {
		t.Errorf("stats = %v", got)
	}
}

func TestFetchSessionStatsFallsBackToEvents(t *testing.T) {
	ch := &fakeCH{fn: func(call int, sql string, _ clickhouse.Settings) ([]map[string]any, error) {
		if call == 1 {
			return nil, errors.New("aggregate down")
		}
		return []map[string]any{{"session_id": "s2", "total_credits": "3"}}, nil
	}}
	e := &Engine{CH: ch}
	got := e.fetchSessionStats(context.Background(), "aid", "aname", "a", "b", "")
	if ch.calls != 2 || !strings.Contains(ch.sqls[1], "session_events") {
		t.Errorf("fallback must query session_events, calls = %d", ch.calls)
	}
	if got["s2"].Credits != 3 {
		t.Errorf("fallback stats = %v", got)
	}
}

func TestFetchSessionStatsBothPathsFail(t *testing.T) {
	ch := &fakeCH{fn: func(int, string, clickhouse.Settings) ([]map[string]any, error) {
		return nil, errors.New("down")
	}}
	e := &Engine{CH: ch}
	got := e.fetchSessionStats(context.Background(), "aid", "aname", "a", "b", "")
	if len(got) != 0 {
		t.Errorf("want empty map, got %v", got)
	}
}

func TestFetchAllSessionTranscripts(t *testing.T) {
	ch := &fakeCH{fn: func(call int, sql string, settings clickhouse.Settings) ([]map[string]any, error) {
		switch call {
		case 1:
			return []map[string]any{
				{"session_id": "s1"}, {"session_id": "s2"}, {"session_id": "bad'id"},
			}, nil
		case 2:
			ids := settings["param_ids"]
			if strings.Contains(ids, "bad") {
				return nil, errors.New("unsafe id leaked into query")
			}
			return []map[string]any{
				{"session_id": "s1", "raw_line": "l1"},
				{"session_id": "s1", "raw_line": "l2"},
				{"session_id": "s2", "raw_line": "m1"},
			}, nil
		}
		return nil, errors.New("unexpected call")
	}}
	e := &Engine{CH: ch}
	all, order := e.fetchAllSessionTranscripts(context.Background(), "aid", "aname", "a", "b", "")
	if !reflect.DeepEqual(order, []string{"s1", "s2"}) {
		t.Errorf("order = %v", order)
	}
	if !reflect.DeepEqual(all["s1"], []string{"l1", "l2"}) || !reflect.DeepEqual(all["s2"], []string{"m1"}) {
		t.Errorf("transcripts = %v", all)
	}
}

func TestFetchAllSessionTranscriptsNoSessions(t *testing.T) {
	ch := &fakeCH{fn: func(int, string, clickhouse.Settings) ([]map[string]any, error) {
		return nil, nil
	}}
	e := &Engine{CH: ch}
	all, order := e.fetchAllSessionTranscripts(context.Background(), "aid", "aname", "a", "b", "")
	if len(all) != 0 || order != nil {
		t.Errorf("want empty result, got %v %v", all, order)
	}
	if ch.calls != 1 {
		t.Errorf("no transcript batch may run without session ids, calls = %d", ch.calls)
	}
}

func TestExtractAllSessionMetasEnrichesFromStats(t *testing.T) {
	ch := &fakeCH{fn: func(call int, sql string, _ clickhouse.Settings) ([]map[string]any, error) {
		switch call {
		case 1:
			return []map[string]any{{"session_id": "sess1"}}, nil
		case 2:
			return []map[string]any{{
				"session_id": "sess1",
				"raw_line":   `{"type":"message","message":{"role":"user","content":"hello"}}`,
			}}, nil
		case 3:
			return []map[string]any{{
				"session_id": "sess1", "total_credits": "3.5", "harness": "kiro", "layer_hash": "h1",
			}}, nil
		}
		return nil, errors.New("unexpected call")
	}}
	e := &Engine{CH: ch}
	metas := e.extractAllSessionMetas(context.Background(), "aid", "aname", "a", "b", "2.0.0")
	if len(metas) != 1 {
		t.Fatalf("metas = %d", len(metas))
	}
	m := metas[0]
	if m.SessionID != "sess1" || m.UserMessageCount != 1 {
		t.Errorf("meta = %+v", m)
	}
	if m.Credits != 3.5 || m.Harness != "kiro" || m.LayerHash != "h1" || m.AgentVersion != "2.0.0" {
		t.Errorf("enrichment = credits %v harness %q layer %q version %q",
			m.Credits, m.Harness, m.LayerHash, m.AgentVersion)
	}
}
