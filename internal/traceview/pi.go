// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package traceview

import (
	"fmt"
	"strings"
)

// parsePi expands Pi session rows. Entries carry a top-level type with
// message.role structure; tool calls use type "toolCall" blocks and results
// arrive as role "toolResult" messages that merge back by toolCallId.
func parsePi(rows []Row) []*Event {
	var events []*Event
	toolCallIndex := map[string]int{}

	for _, row := range rows {
		if row.RawLine == "" {
			events = append(events, basicEvent(row))
			continue
		}
		parsed := loadLine(row.RawLine)
		if parsed == nil {
			events = append(events, basicEvent(row))
			continue
		}

		ts := pickTimestamp(parsed.Get("timestamp"), row.Timestamp, row.IngestedAt)
		switch getOr(parsed, "type", "") {
		case "message":
			events = piHandleMessage(parsed, ts, row.Harness, events, toolCallIndex)
		case "model_change":
			events = append(events, event(ts, row.Harness, "hook_sessionstart",
				fmt.Sprintf("Model: %s/%s", scalarString(getOr(parsed, "provider", "")), scalarString(getOr(parsed, "modelId", ""))), 1<<30,
				map[string]any{
					"provider": getOr(parsed, "provider", ""),
					"model":    getOr(parsed, "modelId", ""),
				}))
		case "thinking_level_change":
			events = append(events, event(ts, row.Harness, "hook_sessionstart",
				fmt.Sprintf("Thinking level: %s", scalarString(getOr(parsed, "thinkingLevel", ""))), 1<<30,
				map[string]any{"thinking_level": getOr(parsed, "thinkingLevel", "")}))
		case "compaction", "branch_summary":
			summary := strField(parsed, "summary")
			events = append(events, event(ts, row.Harness, "hook_assistant_response", summary, 100, map[string]any{
				"tool_response": summary,
			}))
		case "custom_message":
			content := getOr(parsed, "content", "")
			text := piContentText(content)
			events = append(events, event(ts, row.Harness, "hook_assistant_response", text, 100, map[string]any{
				"tool_response": text,
			}))
		}
	}
	if events == nil {
		return []*Event{}
	}
	return events
}

// piContentText flattens message content to display text.
func piContentText(content any) string {
	if blocks, ok := content.([]any); ok {
		var parts []string
		for _, raw := range blocks {
			if b, ok := raw.(*Obj); ok && b.Get("type") == "text" {
				parts = append(parts, scalarString(getOr(b, "text", "")))
			}
		}
		return strings.Join(parts, "\n")
	}
	return scalarString(content)
}

func piHandleMessage(parsed *Obj, ts, harness string, events []*Event, toolCallIndex map[string]int) []*Event {
	msg := dictField(parsed, "message")
	switch msg.Get("role") {
	case "user":
		return piHandleUser(msg, ts, harness, events)
	case "assistant":
		return piHandleAssistant(msg, ts, harness, events, toolCallIndex)
	case "toolResult":
		return piHandleToolResult(msg, ts, harness, events, toolCallIndex)
	case "bashExecution":
		return piHandleBash(msg, ts, harness, events)
	}
	return events
}

func piHandleUser(msg *Obj, ts, harness string, events []*Event) []*Event {
	var text string
	switch content := getOr(msg, "content", []any{}).(type) {
	case string:
		text = content
	case []any:
		var parts []string
		for _, raw := range content {
			if b, ok := raw.(*Obj); ok && b.Get("type") == "text" {
				parts = append(parts, strField(b, "text"))
			}
		}
		text = strings.Join(parts, "\n")
	default:
		text = scalarString(content)
	}

	if strings.TrimSpace(text) == "" {
		return events
	}
	return append(events, event(ts, harness, "hook_userpromptsubmit", text, 100, map[string]any{
		"tool_input": text,
	}))
}

func piHandleAssistant(msg *Obj, ts, harness string, events []*Event, toolCallIndex map[string]int) []*Event {
	content, ok := msg.Get("content").([]any)
	if !ok {
		return events
	}

	usage := dictField(msg, "usage")
	tokenAttrs := map[string]any{}
	if usage.Len() > 0 {
		if truthy(usage.Get("input")) {
			tokenAttrs["input_tokens"] = scalarString(usage.Get("input"))
		}
		if truthy(usage.Get("output")) {
			tokenAttrs["output_tokens"] = scalarString(usage.Get("output"))
		}
		if truthy(usage.Get("cacheRead")) {
			tokenAttrs["cache_read_tokens"] = scalarString(usage.Get("cacheRead"))
		}
		if truthy(usage.Get("cacheWrite")) {
			tokenAttrs["cache_creation_tokens"] = scalarString(usage.Get("cacheWrite"))
		}
		if truthy(msg.Get("model")) {
			tokenAttrs["model"] = msg.Get("model")
		}
		if truthy(msg.Get("provider")) {
			tokenAttrs["provider"] = msg.Get("provider")
		}
		if truthy(msg.Get("stopReason")) {
			tokenAttrs["stop_reason"] = msg.Get("stopReason")
		}
		cost := dictField(usage, "cost")
		if cost.Len() > 0 && truthy(cost.Get("total")) {
			tokenAttrs["cost_usd"] = scalarString(cost.Get("total"))
		}
	}

	for _, raw := range content {
		block, ok := raw.(*Obj)
		if !ok {
			continue
		}
		switch getOr(block, "type", "") {
		case "thinking":
			thinkingText := stripANSI(strField(block, "thinking"))
			events = append(events, event(ts, harness, "hook_assistant_thinking", thinkingText, 100, map[string]any{
				"tool_response": thinkingText,
			}))
		case "text":
			responseText := strField(block, "text")
			attrs := map[string]any{"tool_response": responseText}
			if len(tokenAttrs) > 0 {
				for k, v := range tokenAttrs {
					attrs[k] = v
				}
				tokenAttrs = map[string]any{} // consumed
			}
			events = append(events, event(ts, harness, "hook_assistant_response", responseText, 100, attrs))
		case "toolCall":
			toolCallID := strField(block, "id")
			toolName := getOr(block, "name", "")
			toolInput := getOr(block, "arguments", &Obj{})
			idx := len(events)
			events = append(events, event(ts, harness, "hook_posttooluse", scalarString(toolName), 1<<30, map[string]any{
				"tool_name":   toolName,
				"tool_input":  DumpJSON(toolInput),
				"tool_use_id": toolCallID,
			}))
			if toolCallID != "" {
				toolCallIndex[toolCallID] = idx
			}
		}
	}

	// Usage not consumed by a text block (tool-only turn) surfaces standalone.
	if len(tokenAttrs) > 0 {
		events = append(events, event(ts, harness, "hook_token_usage", "", 100, tokenAttrs))
	}
	return events
}

func piHandleToolResult(msg *Obj, ts, harness string, events []*Event, toolCallIndex map[string]int) []*Event {
	toolCallID := strField(msg, "toolCallId")
	toolName := getOr(msg, "toolName", "")
	isError := truthy(getOr(msg, "isError", false))

	var resultText string
	switch content := getOr(msg, "content", []any{}).(type) {
	case []any:
		var parts []string
		for _, raw := range content {
			if c, ok := raw.(*Obj); ok && c.Get("type") == "text" {
				parts = append(parts, strField(c, "text"))
			}
		}
		resultText = strings.Join(parts, "\n")
	case string:
		resultText = content
	default:
		resultText = scalarString(content)
	}

	if idx, ok := toolCallIndex[toolCallID]; toolCallID != "" && ok {
		events[idx].Attributes["tool_response"] = resultText
		if isError {
			events[idx].Attributes["is_error"] = "true"
		}
		return events
	}
	attributes := map[string]any{
		"tool_name":     toolName,
		"tool_response": resultText,
		"tool_use_id":   toolCallID,
	}
	if isError {
		attributes["is_error"] = "true"
	}
	return append(events, event(ts, harness, "hook_posttooluse", scalarString(toolName), 1<<30, attributes))
}

func piHandleBash(msg *Obj, ts, harness string, events []*Event) []*Event {
	attributes := map[string]any{
		"tool_name":     "bash",
		"tool_input":    getOr(msg, "command", ""),
		"tool_response": getOr(msg, "output", ""),
	}
	if exitCode := msg.Get("exitCode"); exitCode != nil {
		attributes["exit_code"] = scalarString(exitCode)
	}
	return append(events, event(ts, harness, "hook_posttooluse", "bash", 1<<30, attributes))
}
