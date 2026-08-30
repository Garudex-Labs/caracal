// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/internal/clickhouse"
)

func TestFormatTranscriptEvent(t *testing.T) {
	cases := []struct {
		name      string
		eventType string
		toolName  string
		raw       string
		want      string
	}{
		{
			name:      "user prompt nested message",
			eventType: "user_prompt",
			raw:       `{"message":{"content":"hello"}}`,
			want:      "[User]: hello",
		},
		{
			name:      "user prompt top-level content",
			eventType: "user_prompt",
			raw:       `{"content":"hi"}`,
			want:      "[User]: hi",
		},
		{
			name:      "assistant text blocks",
			eventType: "assistant_text",
			raw:       `{"message":{"content":[{"type":"text","text":"working"},{"type":"tool_use"}]}}`,
			want:      "[Assistant]: working",
		},
		{
			name:      "assistant without text renders nothing",
			eventType: "assistant_text",
			raw:       `{"message":{"content":[]}}`,
			want:      "",
		},
		{
			name:      "tool call with row tool name and command",
			eventType: "tool_call",
			toolName:  "bash",
			raw:       `{"input":{"command":"ls -la"}}`,
			want:      "[Tool: bash] ls -la",
		},
		{
			name:      "tool call resolves name and file path from payload",
			eventType: "tool_call",
			raw:       `{"name":"edit","input":{"file_path":"x.go"}}`,
			want:      "[Tool: edit] file: x.go",
		},
		{
			name:      "tool call with nothing known",
			eventType: "tool_call",
			raw:       `{}`,
			want:      "[Tool: unknown] ",
		},
		{
			name:      "successful tool result is suppressed",
			eventType: "tool_result",
			toolName:  "bash",
			raw:       `{"is_error":false,"content":"lots of output"}`,
			want:      "",
		},
		{
			name:      "failed tool result snake case",
			eventType: "tool_result",
			toolName:  "bash",
			raw:       `{"is_error":true,"content":"boom"}`,
			want:      "[Tool Result: bash] ERROR: boom",
		},
		{
			name:      "failed tool result camel case and unknown tool",
			eventType: "tool_result",
			raw:       `{"isError":true,"content":"broke"}`,
			want:      "[Tool Result: unknown] ERROR: broke",
		},
		{
			name:      "unknown event type",
			eventType: "session",
			raw:       `{"cwd":"/x"}`,
			want:      "",
		},
	}
	for _, tc := range cases {
		var parsed map[string]any
		if err := json.Unmarshal([]byte(tc.raw), &parsed); err != nil {
			t.Fatalf("%s: bad fixture: %v", tc.name, err)
		}
		if got := formatTranscriptEvent(tc.eventType, tc.toolName, parsed); got != tc.want {
			t.Errorf("%s: got %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestFormatTranscriptEventTruncatesLongPrompt(t *testing.T) {
	long := strings.Repeat("x", maxPromptChars+50)
	parsed := map[string]any{"message": map[string]any{"content": long}}
	got := formatTranscriptEvent("user_prompt", "", parsed)
	if want := "[User]: " + strings.Repeat("x", maxPromptChars); got != want {
		t.Errorf("truncated length = %d", len(got))
	}
}

func TestToolInputSummary(t *testing.T) {
	if _, ok := toolInputSummary("not a map"); ok {
		t.Error("non-map input must not summarize")
	}
	if got, _ := toolInputSummary(map[string]any{"command": "go test", "path": "x"}); got != "go test" {
		t.Errorf("command wins: %q", got)
	}
	if got, _ := toolInputSummary(map[string]any{"file_path": "a.go"}); got != "file: a.go" {
		t.Errorf("file_path: %q", got)
	}
	if got, _ := toolInputSummary(map[string]any{"path": "b.go"}); got != "file: b.go" {
		t.Errorf("path: %q", got)
	}
	if got, _ := toolInputSummary(map[string]any{"query": "x"}); got != `{"query":"x"}` {
		t.Errorf("generic map marshals: %q", got)
	}
}

func TestTranscriptToolInputFromMessageBlocks(t *testing.T) {
	parsed := map[string]any{"message": map[string]any{"content": []any{
		map[string]any{"type": "text", "text": "ignored"},
		map[string]any{"type": "tool_use", "input": map[string]any{"command": "go vet"}},
	}}}
	if got := transcriptToolInput(parsed); got != "go vet" {
		t.Errorf("tool_use block: %q", got)
	}
	argsBlock := map[string]any{"message": map[string]any{"content": []any{
		map[string]any{"type": "toolCall", "arguments": map[string]any{"path": "c.go"}},
	}}}
	if got := transcriptToolInput(argsBlock); got != "file: c.go" {
		t.Errorf("arguments fallback: %q", got)
	}
	if got := transcriptToolInput(map[string]any{}); got != "" {
		t.Errorf("empty payload: %q", got)
	}
}

func TestTranscriptToolName(t *testing.T) {
	if got := transcriptToolName(map[string]any{"name": "read"}); got != "read" {
		t.Errorf("direct name: %q", got)
	}
	nested := map[string]any{"message": map[string]any{"content": []any{
		map[string]any{"type": "toolCall", "name": "write"},
	}}}
	if got := transcriptToolName(nested); got != "write" {
		t.Errorf("nested name: %q", got)
	}
	if got := transcriptToolName(map[string]any{}); got != "" {
		t.Errorf("missing: %q", got)
	}
}

func TestTranscriptToolResult(t *testing.T) {
	if got := transcriptToolResult(map[string]any{"content": "plain"}); got != "plain" {
		t.Errorf("string content: %q", got)
	}
	blocks := map[string]any{"content": []any{
		map[string]any{"type": "text", "text": "a"},
		"b",
		map[string]any{"type": "image"},
	}}
	if got := transcriptToolResult(blocks); got != "a b" {
		t.Errorf("block content: %q", got)
	}
	if got := transcriptToolResult(map[string]any{"content": float64(42)}); got != "42" {
		t.Errorf("scalar content: %q", got)
	}
}

func TestFormatTranscriptRows(t *testing.T) {
	rows := []map[string]any{
		{"event_type": "user_prompt", "raw_line": `{"message":{"content":"first"}}`},
		{"event_type": "user_prompt", "raw_line": ""},
		{"event_type": "user_prompt", "raw_line": "not json"},
		{"event_type": "tool_result", "tool_name": "bash", "raw_line": `{"is_error":false,"content":"ok"}`},
		{"event_type": "assistant_text", "raw_line": `{"message":{"content":"done"}}`},
	}
	got := formatTranscriptRows(rows)
	want := "[User]: first\n[Assistant]: done"
	if got != want {
		t.Errorf("transcript = %q, want %q", got, want)
	}
}

func TestBuildSessionTranscriptShort(t *testing.T) {
	ch := &fakeCH{fn: func(int, string, clickhouse.Settings) ([]map[string]any, error) {
		return []map[string]any{
			{"event_type": "user_prompt", "raw_line": `{"message":{"content":"do it"}}`},
		}, nil
	}}
	e := &Engine{CH: ch}
	if got := e.buildSessionTranscript(context.Background(), "sid"); got != "[User]: do it" {
		t.Errorf("short transcript = %q", got)
	}
}

func TestBuildSessionTranscriptEmptyAndError(t *testing.T) {
	e := &Engine{CH: &fakeCH{fn: func(int, string, clickhouse.Settings) ([]map[string]any, error) {
		return nil, errors.New("down")
	}}}
	if got := e.buildSessionTranscript(context.Background(), "sid"); got != "" {
		t.Errorf("error path = %q", got)
	}
	e = &Engine{CH: &fakeCH{fn: func(int, string, clickhouse.Settings) ([]map[string]any, error) {
		return nil, nil
	}}}
	if got := e.buildSessionTranscript(context.Background(), "sid"); got != "" {
		t.Errorf("no rows = %q", got)
	}
}

func TestBuildSessionTranscriptSummarizesLongSessions(t *testing.T) {
	text := strings.Repeat("a", maxPromptChars)
	rows := make([]map[string]any, 0, 70)
	for i := 0; i < 70; i++ {
		rows = append(rows, map[string]any{
			"event_type": "user_prompt",
			"raw_line":   `{"message":{"content":"` + text + `"}}`,
		})
	}
	ch := &fakeCH{fn: func(int, string, clickhouse.Settings) ([]map[string]any, error) {
		return rows, nil
	}}
	llm := &recordingCompleter{respond: func(prompt, _ string, _ int) (map[string]any, error) {
		return map[string]any{"summary": "CHUNK-SUMMARY " + strconv.Itoa(len(prompt))}, nil
	}}
	e := &Engine{
		CH:     ch,
		Config: &Config{Settings: fakeSettings{"insights.model_facets": "facet-model"}},
		LLM:    llm,
	}
	got := e.buildSessionTranscript(context.Background(), "1234567890")
	if !strings.HasPrefix(got, "Session: 12345678\n[Long session summarized]\n\n") {
		t.Errorf("summary header:\n%q", got[:min(80, len(got))])
	}
	if !strings.Contains(got, "[Next chunk]") {
		t.Error("multi-chunk transcript must join chunk summaries")
	}
	if calls := len(llm.snapshot()); calls != 2 {
		t.Errorf("chunk summary calls = %d, want 2", calls)
	}
}

func TestSummarizeTranscriptFallsBackToChunkPrefix(t *testing.T) {
	// With no model configured, callModel returns nothing and the raw
	// chunk prefix stands in for the summary.
	e := &Engine{Config: &Config{Settings: fakeSettings{}}}
	transcript := strings.Repeat("z", 3000)
	got := e.summarizeTranscript(context.Background(), "abcdefghij", transcript)
	if !strings.HasPrefix(got, "Session: abcdefgh\n[Long session summarized]\n\n") {
		t.Errorf("header:\n%q", got[:min(80, len(got))])
	}
	if !strings.Contains(got, strings.Repeat("z", 2000)) {
		t.Error("fallback must embed the 2000-char chunk prefix")
	}
	if strings.Contains(got, strings.Repeat("z", 2001)) {
		t.Error("fallback prefix must stop at 2000 chars")
	}
}
