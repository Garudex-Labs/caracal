// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package traceview

import (
	"encoding/json"
	"strings"
)

// parseCodex expands Codex CLI transcript rows: event_msg lines carry chat
// payloads, response_item lines carry typed role content.
func parseCodex(rows []Row) []*Event {
	var events []*Event

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
		lineType := getOr(parsed, "type", "")

		switch lineType {
		case "event_msg":
			events = codexHandleEventMsg(parsed, ts, row.Harness, events)
		case "response_item":
			events = codexHandleResponseItem(parsed, ts, row.Harness, events)
		case "session_meta", "turn_context":
			events = append(events, event(ts, row.Harness, "system", scalarString(lineType), 1<<30, map[string]any{}))
		default:
			body := scalarString(lineType)
			if !truthy(lineType) {
				body = "unknown"
			}
			events = append(events, event(ts, row.Harness, "system", body, 1<<30, map[string]any{}))
		}
	}
	if events == nil {
		return []*Event{}
	}
	return events
}

func codexHandleEventMsg(parsed *Obj, ts, harness string, events []*Event) []*Event {
	payload, ok := parsed.Get("payload").(*Obj)
	if !ok {
		return events
	}
	payloadType := getOr(payload, "type", "")

	switch payloadType {
	case "user_message":
		message := scalarString(getOr(payload, "message", ""))
		return append(events, event(ts, harness, "hook_userpromptsubmit", message, 200, map[string]any{
			"tool_input": message,
		}))
	case "agent_message":
		message := scalarString(getOr(payload, "message", ""))
		return append(events, event(ts, harness, "hook_assistant_response", message, 200, map[string]any{
			"tool_response": message,
		}))
	case "token_count":
		info := dictField(payload, "info")
		usage := dictField(info, "last_token_usage")
		if usage.Len() == 0 {
			usage = dictField(info, "total_token_usage")
		}
		var model any = ""
		if rateLimits, ok := payload.Get("rate_limits").(*Obj); ok {
			model = getOr(rateLimits, "model", "")
		}
		return append(events, event(ts, harness, "hook_token_usage", "token_count", 1<<30, map[string]any{
			"input_tokens":      scalarString(getOr(usage, "input_tokens", json.Number("0"))),
			"output_tokens":     scalarString(getOr(usage, "output_tokens", json.Number("0"))),
			"cache_read_tokens": scalarString(getOr(usage, "cached_input_tokens", json.Number("0"))),
			"model":             model,
		}))
	default:
		return append(events, event(ts, harness, "system", scalarString(payloadType), 1<<30, map[string]any{}))
	}
}

func codexHandleResponseItem(parsed *Obj, ts, harness string, events []*Event) []*Event {
	payload, ok := parsed.Get("payload").(*Obj)
	if !ok {
		return events
	}
	role := getOr(payload, "role", "")
	content := listField(payload, "content")
	payloadType := getOr(payload, "type", "")

	switch payloadType {
	case "function_call":
		return append(events, event(ts, harness, "hook_pretooluse", scalarString(getOr(payload, "name", "")), 1<<30, map[string]any{
			"tool_name":   getOr(payload, "name", ""),
			"tool_input":  getOr(payload, "arguments", ""),
			"tool_use_id": getOr(payload, "call_id", ""),
		}))
	case "function_call_output":
		return append(events, event(ts, harness, "hook_posttooluse", scalarString(getOr(payload, "name", "tool_result")), 1<<30, map[string]any{
			"tool_name":     getOr(payload, "name", ""),
			"tool_response": truncChars(scalarString(getOr(payload, "output", "")), 500),
			"tool_use_id":   getOr(payload, "call_id", ""),
			"success":       "true",
		}))
	}

	switch role {
	case "user":
		// Injected context (AGENTS.md, permissions) - system, not real user input.
		return append(events, event(ts, harness, "system", "context", 1<<30, map[string]any{}))
	case "assistant":
		var textParts []string
		var toolCalls []*Obj
		for _, raw := range content {
			block, ok := raw.(*Obj)
			if !ok {
				continue
			}
			switch getOr(block, "type", "") {
			case "output_text":
				textParts = append(textParts, strField(block, "text"))
			case "function_call":
				toolCalls = append(toolCalls, block)
			case "function_call_output":
				events = append(events, event(ts, harness, "tool_result", scalarString(getOr(block, "name", "tool_result")), 1<<30, map[string]any{
					"tool_name":     getOr(block, "name", ""),
					"tool_response": truncChars(scalarString(getOr(block, "output", "")), 500),
				}))
			}
		}
		for _, tc := range toolCalls {
			events = append(events, event(ts, harness, "tool_call", scalarString(getOr(tc, "name", "")), 1<<30, map[string]any{
				"tool_name":   getOr(tc, "name", ""),
				"tool_input":  DumpJSON(getOr(tc, "arguments", &Obj{})),
				"tool_use_id": getOr(tc, "call_id", ""),
			}))
		}
		if len(textParts) > 0 && len(toolCalls) == 0 {
			full := strings.Join(textParts, " ")
			events = append(events, event(ts, harness, "hook_assistant_response", full, 200, map[string]any{
				"tool_response": full,
			}))
		}
		return events
	case "developer":
		return append(events, event(ts, harness, "system", "developer instructions", 1<<30, map[string]any{}))
	default:
		body := scalarString(role)
		if !truthy(role) {
			body = "response_item"
		}
		return append(events, event(ts, harness, "system", body, 1<<30, map[string]any{}))
	}
}
