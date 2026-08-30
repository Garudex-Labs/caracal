// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package ingest

import (
	"testing"

	"github.com/garudex-labs/caracal/internal/harness"
)

func newCodexBuilder(t *testing.T) *Builder {
	t.Helper()
	b, err := NewBuilder(harness.MustLoad(), "codex")
	if err != nil {
		t.Fatalf("NewBuilder(codex): %v", err)
	}
	b.Now = func() string { return fixedNow }
	b.IngestedAt = fixedIngestedAt
	return b
}

func TestBuilderCodexClassification(t *testing.T) {
	tests := []struct {
		name         string
		raw          string
		wantType     string
		wantRendered int
	}{
		{"user message", `{"type":"event_msg","payload":{"type":"user_message","message":"hi"}}`, "user_prompt", 1},
		{"agent message", `{"type":"event_msg","payload":{"type":"agent_message","message":"ok"}}`, "assistant_text", 1},
		{"token count is meta", `{"type":"event_msg","payload":{"type":"token_count","info":{}}}`, "meta", 1},
		{"other event payload is system", `{"type":"event_msg","payload":{"type":"task_started"}}`, "system", 1},
		{"payload function call", `{"type":"response_item","payload":{"type":"function_call","name":"n","call_id":"c"}}`, "tool_call", 1},
		{"payload function call output", `{"type":"response_item","payload":{"type":"function_call_output","output":"o"}}`, "tool_result", 1},
		{"role user is system", `{"type":"response_item","payload":{"role":"user","content":[]}}`, "system", 1},
		{"assistant tool call block", `{"type":"response_item","payload":{"role":"assistant","content":[{"type":"function_call","name":"x"}]}}`, "tool_call", 1},
		{"assistant tool result block", `{"type":"response_item","payload":{"role":"assistant","content":[{"type":"function_call_output","output":"o"}]}}`, "tool_result", 1},
		{"assistant text", `{"type":"response_item","payload":{"role":"assistant","content":[{"type":"output_text","text":"t"}]}}`, "assistant_text", 1},
		{"developer is system", `{"type":"response_item","payload":{"role":"developer"}}`, "system", 1},
		{"roleless tool result fallthrough", `{"type":"response_item","payload":{"content":[{"type":"function_call_output","output":"o"}]}}`, "tool_result", 1},
		{"roleless plain content is system", `{"type":"response_item","payload":{"content":[{"type":"output_text","text":"t"}]}}`, "system", 1},
		{"unknown top-level type is system", `{"type":"mystery"}`, "system", 1},
		{"parse error", `{ not valid`, "_parse_error", 0},
		{"non-object json is parse error", `123`, "_parse_error", 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			row, _ := newCodexBuilder(t).Build(tc.raw, 0, 0)
			if row.EventType != tc.wantType {
				t.Errorf("EventType = %q, want %q", row.EventType, tc.wantType)
			}
			if row.Rendered != tc.wantRendered {
				t.Errorf("Rendered = %d, want %d", row.Rendered, tc.wantRendered)
			}
		})
	}
}

func TestBuilderCodexToolInfoAndUsage(t *testing.T) {
	// A function_call carries tool name and id.
	row, _ := newCodexBuilder(t).Build(`{"type":"response_item","payload":{"type":"function_call","name":"shell","call_id":"call-7"}}`, 0, 0)
	if row.ToolName == nil || *row.ToolName != "shell" {
		t.Errorf("ToolName = %v, want shell", row.ToolName)
	}
	if row.ToolID == nil || *row.ToolID != "call-7" {
		t.Errorf("ToolID = %v, want call-7", row.ToolID)
	}

	// token_count lines populate usage from last_token_usage.
	row, _ = newCodexBuilder(t).Build(`{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"output_tokens":5,"cached_input_tokens":2}}}}`, 0, 0)
	if row.InputTokens != 10 || row.OutputTokens != 5 || row.CacheReadTokens != 2 {
		t.Errorf("usage = %+v, want input=10 output=5 cacheRead=2", row.Usage)
	}

	// With no last_token_usage, it falls back to total_token_usage.
	row, _ = newCodexBuilder(t).Build(`{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":9}}}}`, 0, 0)
	if row.InputTokens != 9 {
		t.Errorf("fallback input tokens = %d, want 9", row.InputTokens)
	}
}

func TestBuilderCopilotUsage(t *testing.T) {
	build := func(t *testing.T, raw string) Row {
		t.Helper()
		b, err := NewBuilder(harness.MustLoad(), "copilot-cli")
		if err != nil {
			t.Fatalf("NewBuilder(copilot-cli): %v", err)
		}
		b.Now = func() string { return fixedNow }
		row, _ := b.Build(raw, 0, 0)
		return row
	}

	// Flat data envelope (Copilot CLI v1.0.59+).
	row := build(t, `{"type":"event","data":{"outputTokens":8,"inputTokens":3,"model":"gpt-x"}}`)
	if row.InputTokens != 3 || row.OutputTokens != 8 {
		t.Errorf("flat usage = %+v, want input=3 output=8", row.Usage)
	}
	if row.Model != "gpt-x" {
		t.Errorf("model = %q, want gpt-x", row.Model)
	}

	// SDK envelope with a nested event.data block.
	row = build(t, `{"event":{"data":{"inputTokens":4}}}`)
	if row.InputTokens != 4 {
		t.Errorf("envelope input tokens = %d, want 4", row.InputTokens)
	}

	// No token fields yields zero usage.
	row = build(t, `{"type":"event","data":{"note":"nothing"}}`)
	if row.InputTokens != 0 || row.OutputTokens != 0 {
		t.Errorf("empty usage = %+v, want zero", row.Usage)
	}
}
