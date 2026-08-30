// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package traceview

import (
	"testing"

	"github.com/garudex-labs/caracal/internal/harness"
)

// eventNames extracts the ordered event-name sequence for assertions.
func eventNames(events []*Event) []string {
	names := make([]string, len(events))
	for i, e := range events {
		names[i] = e.EventName
	}
	return names
}

func namesEqual(got []string, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

func TestParseEmptyAndUnknownHarness(t *testing.T) {
	reg := harness.MustLoad()

	got, err := Parse(reg, nil)
	if err != nil {
		t.Fatalf("Parse(nil): %v", err)
	}
	if len(got) != 0 {
		t.Errorf("Parse(nil) = %d events, want 0", len(got))
	}

	if _, err := Parse(reg, []Row{{Harness: "does-not-exist"}}); err == nil {
		t.Error("Parse with unknown harness should error")
	}
}

// TestBasicEventFallbackAllHarnesses drives every parser through the
// unparseable-line fallback: empty, malformed, and non-object JSON all
// collapse to basicEvent, and non-zero credits render through floatString.
func TestBasicEventFallbackAllHarnesses(t *testing.T) {
	reg := harness.MustLoad()
	harnesses := []string{
		"claude-code", "codex", "copilot-cli", "cursor",
		"goose", "kiro", "opencode", "pi", "antigravity",
	}
	for _, h := range harnesses {
		t.Run(h, func(t *testing.T) {
			rows := []Row{
				{Harness: h, EventType: "evt", ContentPreview: "body-a", Credits: 1.5, RawLine: ""},
				{Harness: h, EventType: "evt", ContentPreview: "body-b", RawLine: "{ not valid json"},
				{Harness: h, EventType: "evt", ContentPreview: "body-c", RawLine: "123"},
			}
			got, err := Parse(reg, rows)
			if err != nil {
				t.Fatalf("Parse: %v", err)
			}
			if len(got) != 3 {
				t.Fatalf("event count = %d, want 3", len(got))
			}
			for i, e := range got {
				if e.EventName != "evt" {
					t.Errorf("event[%d].EventName = %q, want evt", i, e.EventName)
				}
				if e.ServiceName != h {
					t.Errorf("event[%d].ServiceName = %q, want %q", i, e.ServiceName, h)
				}
			}
			if got[0].Body != "body-a" {
				t.Errorf("basicEvent body = %q, want body-a", got[0].Body)
			}
			if credits, ok := got[0].Attributes["credits"]; !ok || credits != "1.5" {
				t.Errorf("credits attribute = %v (present=%v), want 1.5", credits, ok)
			}
			// Zero-credit rows omit the attribute entirely.
			if _, ok := got[1].Attributes["credits"]; ok {
				t.Error("zero-credit row should not carry a credits attribute")
			}
		})
	}
}

func codexRows(raws ...string) []Row {
	rows := make([]Row, len(raws))
	for i, raw := range raws {
		rows[i] = Row{Harness: "codex", EventType: "stored", RawLine: raw, Timestamp: "2026-01-01 00:00:00.000", IngestedAt: "2026-01-01 00:00:01.000"}
	}
	return rows
}

func TestParseCodexBranches(t *testing.T) {
	tests := []struct {
		name string
		raws []string
		want []string
	}{
		{"user message", []string{`{"type":"event_msg","payload":{"type":"user_message","message":"hi"}}`}, []string{"hook_userpromptsubmit"}},
		{"agent message", []string{`{"type":"event_msg","payload":{"type":"agent_message","message":"ok"}}`}, []string{"hook_assistant_response"}},
		{"token count last usage", []string{`{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"output_tokens":5,"cached_input_tokens":2}},"rate_limits":{"model":"gpt-5"}}}`}, []string{"hook_token_usage"}},
		{"token count total fallback", []string{`{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":7}}}}`}, []string{"hook_token_usage"}},
		{"event_msg unknown payload", []string{`{"type":"event_msg","payload":{"type":"task_started"}}`}, []string{"system"}},
		{"event_msg without object payload", []string{`{"type":"event_msg","payload":"nope"}`}, []string{}},
		{"function call", []string{`{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"ls","call_id":"c1"}}`}, []string{"hook_pretooluse"}},
		{"function call output", []string{`{"type":"response_item","payload":{"type":"function_call_output","name":"shell","output":"files","call_id":"c1"}}`}, []string{"hook_posttooluse"}},
		{"role user is context", []string{`{"type":"response_item","payload":{"role":"user","content":[]}}`}, []string{"system"}},
		{"assistant text", []string{`{"type":"response_item","payload":{"role":"assistant","content":[{"type":"output_text","text":"answer"}]}}`}, []string{"hook_assistant_response"}},
		{"assistant tool call", []string{`{"type":"response_item","payload":{"role":"assistant","content":[{"type":"function_call","name":"grep","arguments":{"q":"x"},"call_id":"c2"}]}}`}, []string{"tool_call"}},
		{"assistant nested tool result", []string{`{"type":"response_item","payload":{"role":"assistant","content":[{"type":"function_call_output","name":"grep","output":"hits"}]}}`}, []string{"tool_result"}},
		{"developer role", []string{`{"type":"response_item","payload":{"role":"developer"}}`}, []string{"system"}},
		{"unknown role", []string{`{"type":"response_item","payload":{"role":"sysadmin"}}`}, []string{"system"}},
		{"response_item empty payload", []string{`{"type":"response_item","payload":{}}`}, []string{"system"}},
		{"response_item non-object payload", []string{`{"type":"response_item","payload":123}`}, []string{}},
		{"session meta", []string{`{"type":"session_meta"}`}, []string{"system"}},
		{"turn context", []string{`{"type":"turn_context"}`}, []string{"system"}},
		{"unknown line type", []string{`{"type":"mystery"}`}, []string{"system"}},
		{"empty line type", []string{`{}`}, []string{"system"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := parseCodex(codexRows(tc.raws...))
			if !namesEqual(eventNames(got), tc.want) {
				t.Errorf("event names = %v, want %v", eventNames(got), tc.want)
			}
		})
	}
}

func TestParseCodexSpecificAttributes(t *testing.T) {
	got := parseCodex(codexRows(`{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"output_tokens":5,"cached_input_tokens":2}},"rate_limits":{"model":"gpt-5"}}}`))
	if len(got) != 1 {
		t.Fatalf("got %d events, want 1", len(got))
	}
	attrs := got[0].Attributes
	for k, want := range map[string]string{"input_tokens": "10", "output_tokens": "5", "cache_read_tokens": "2"} {
		if attrs[k] != want {
			t.Errorf("attr %s = %v, want %s", k, attrs[k], want)
		}
	}
	if attrs["model"] != "gpt-5" {
		t.Errorf("model = %v, want gpt-5", attrs["model"])
	}

	// The default token usage (no rate limits) leaves the model empty.
	got = parseCodex(codexRows(`{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":7}}}}`))
	if got[0].Attributes["output_tokens"] != "0" {
		t.Errorf("missing output token should default to 0, got %v", got[0].Attributes["output_tokens"])
	}
	if got[0].Attributes["model"] != "" {
		t.Errorf("model without rate limits = %v, want empty", got[0].Attributes["model"])
	}
}

func gooseRows(raws ...string) []Row {
	rows := make([]Row, len(raws))
	for i, raw := range raws {
		rows[i] = Row{Harness: "goose", EventType: "stored", RawLine: raw, Timestamp: "2026-01-01 00:00:00.000", IngestedAt: "2026-01-01 00:00:01.000"}
	}
	return rows
}

func TestParseGooseBranches(t *testing.T) {
	tests := []struct {
		name string
		raws []string
		want []string
	}{
		{"session with name", []string{`{"type":"session","name":"My Session","working_dir":"/w","session_type":"cli","provider":"anthropic","model":"claude","goose_mode":"auto","parent_session_id":"p1"}`}, []string{"hook_sessionstart"}},
		{"session falls back to id", []string{`{"type":"session","session_id":"s2"}`}, []string{"hook_sessionstart"}},
		{"session end", []string{`{"type":"session_end","usage":{"inputTokens":10,"outputTokens":5,"totalTokens":15,"cost":0.02}}`}, []string{"hook_stop"}},
		{"user text", []string{`{"type":"message","role":"user","content":[{"type":"text","text":"hello"}]}`}, []string{"hook_userpromptsubmit"}},
		{"assistant text with usage", []string{`{"type":"message","role":"assistant","metadata":{"usage":{"inputTokens":3,"outputTokens":4,"cacheReadTokens":1,"cacheWriteTokens":2,"cost":0.01},"inference":{"resolvedModel":"claude-3"}},"content":[{"type":"text","text":"reply"}]}`}, []string{"hook_assistant_response"}},
		{"assistant thinking", []string{`{"type":"message","role":"assistant","content":[{"type":"thinking","thinking":"hmm"}]}`}, []string{"hook_assistant_thinking"}},
		{"redacted thinking", []string{`{"type":"message","role":"assistant","content":[{"type":"redactedThinking"}]}`}, []string{"hook_assistant_thinking"}},
		{"tool request success", []string{`{"type":"message","role":"assistant","content":[{"type":"toolRequest","id":"t1","toolCall":{"status":"success","value":{"name":"shell","arguments":{"cmd":"ls"}}}}]}`}, []string{"hook_posttooluse"}},
		{"tool request error", []string{`{"type":"message","role":"assistant","content":[{"type":"toolRequest","id":"t2","toolCall":{"status":"error","error":"boom"}}]}`}, []string{"hook_posttooluse"}},
		{"tool confirmation", []string{`{"type":"message","role":"assistant","content":[{"type":"toolConfirmationRequest","toolName":"write","arguments":{"path":"x"}}]}`}, []string{"hook_pretooluse"}},
		{"error message", []string{`{"type":"message","role":"assistant","content":[{"type":"error","message":"failure"}]}`}, []string{"hook_error"}},
		{"error msg fallback", []string{`{"type":"message","role":"assistant","content":[{"type":"error","msg":"alt"}]}`}, []string{"hook_error"}},
		{"orphan tool response", []string{`{"type":"message","role":"user","content":[{"type":"toolResponse","id":"zzz","toolResult":{"value":"raw text"}}]}`}, []string{"hook_posttooluse"}},
		{"orphan tool response with error status", []string{`{"type":"message","role":"user","content":[{"type":"toolResponse","id":"e1","toolResult":{"status":"error","error":"failed"}}]}`}, []string{"hook_posttooluse"}},
		{"orphan tool response with non-object result", []string{`{"type":"message","role":"user","content":[{"type":"toolResponse","id":"e2","toolResult":"notobj"}]}`}, []string{"hook_posttooluse"}},
		{"tool-only turn reports usage", []string{`{"type":"message","role":"assistant","metadata":{"usage":{"inputTokens":9}},"content":[{"type":"toolRequest","id":"t9","toolCall":{"value":{"name":"n"}}}]}`}, []string{"hook_posttooluse", "hook_token_usage"}},
		{"message content not a list", []string{`{"type":"message","content":"notarray"}`}, []string{}},
		{"unknown type falls to basic event", []string{`{"type":"weird"}`}, []string{"stored"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := parseGoose(gooseRows(tc.raws...))
			if !namesEqual(eventNames(got), tc.want) {
				t.Errorf("event names = %v, want %v", eventNames(got), tc.want)
			}
		})
	}
}

// TestParseGooseToolResponseMerge checks that a tool response with a matching
// request id folds into the request event instead of emitting a new one.
func TestParseGooseToolResponseMerge(t *testing.T) {
	rows := gooseRows(
		`{"type":"message","role":"assistant","content":[{"type":"toolRequest","id":"t3","toolCall":{"value":{"name":"shell","arguments":{"cmd":"ls"}}}}]}`,
		`{"type":"message","role":"user","content":[{"type":"toolResponse","id":"t3","toolResult":{"value":{"content":[{"type":"text","text":"done"}],"isError":false}}}]}`,
	)
	got := parseGoose(rows)
	if len(got) != 1 {
		t.Fatalf("merge produced %d events, want 1", len(got))
	}
	if resp := got[0].Attributes["tool_response"]; resp != "done" {
		t.Errorf("merged tool_response = %v, want done", resp)
	}
}
