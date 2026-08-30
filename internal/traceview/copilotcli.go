// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package traceview

import (
	"fmt"
	"strings"
)

// copilotSkipTypes are streaming deltas that duplicate the final message.
var copilotSkipTypes = map[string]bool{"assistant.message_delta": true}

// copilotSanitize strips trailing NULs and replaces U+2028/U+2029 before
// JSON parsing.
func copilotSanitize(raw string) string {
	raw = strings.TrimRight(raw, "\x00")
	raw = strings.ReplaceAll(raw, "\u2028", "\\n")
	raw = strings.ReplaceAll(raw, "\u2029", "\\n")
	return raw
}

// parseCopilotCLI expands Copilot CLI transcript rows. Lines arrive as an
// envelope {agentId, ts, event:{type, ...}} with a flat fallback shape.
func parseCopilotCLI(rows []Row) []*Event {
	var events []*Event
	toolCallIndex := map[string]int{}

	for _, row := range rows {
		if row.RawLine == "" {
			events = append(events, basicEvent(row))
			continue
		}
		parsed := loadLine(copilotSanitize(row.RawLine))
		if parsed == nil {
			events = append(events, basicEvent(row))
			continue
		}

		var (
			eventType string
			data      *Obj
			ts        string
			eventID   string
			parentID  string
		)
		if envelope, ok := parsed.Get("event").(*Obj); ok {
			eventType = strField(envelope, "type")
			data = &Obj{}
			for _, key := range envelope.Keys() {
				if key != "type" {
					data.Set(key, envelope.Get(key))
				}
			}
			ts = pickTimestamp(parsed.Get("ts"), row.Timestamp, row.IngestedAt)
			eventID = strField(parsed, "agentId")
		} else {
			eventType = strField(parsed, "type")
			if d, ok := parsed.Get("data").(*Obj); ok {
				data = d
			} else {
				data = &Obj{}
			}
			ts = pickTimestamp(parsed.Get("timestamp"), row.Timestamp, row.IngestedAt)
			eventID = strField(parsed, "id")
			parentID = strField(parsed, "parentId")
		}

		if eventType == "" {
			events = append(events, basicEvent(row))
			continue
		}
		if copilotSkipTypes[eventType] {
			continue
		}

		switch eventType {
		case "user.message":
			text := copilotContentText(getOr(data, "content", ""))
			events = append(events, event(ts, row.Harness, "hook_userpromptsubmit", text, 100, map[string]any{
				"tool_input": text,
			}))
		case "assistant.message":
			events = copilotHandleAssistant(data, ts, row.Harness, events)
		case "tool.call":
			events = copilotHandleToolCall(data, ts, row.Harness, events, toolCallIndex, eventID)
		case "tool.result", "tool.execution_complete":
			events = copilotHandleToolResult(data, ts, row.Harness, events, toolCallIndex, parentID)
		case "agent.thinking":
			content := getOr(data, "content", getOr(data, "thinking", ""))
			text := scalarString(content)
			events = append(events, event(ts, row.Harness, "hook_assistant_thinking", text, 100, map[string]any{
				"tool_response": text,
			}))
		case "session.start":
			events = copilotHandleSessionStart(data, ts, row.Harness, events)
		case "session.end":
			reason := getOr(data, "reason", "")
			body := "session end"
			if truthy(reason) {
				body = fmt.Sprintf("session end (%s)", scalarString(reason))
			}
			events = append(events, event(ts, row.Harness, "hook_sessionend", body, 1<<30, map[string]any{
				"reason": reason,
			}))
		default:
			events = append(events, event(ts, row.Harness, "copilot_cli_"+strings.ReplaceAll(eventType, ".", "_"), eventType, 1<<30, map[string]any{}))
		}
	}
	if events == nil {
		return []*Event{}
	}
	return events
}

// copilotContentText flattens a message content payload to display text.
func copilotContentText(content any) string {
	if obj, ok := content.(*Obj); ok {
		content = getOr(obj, "text", "")
	}
	return scalarString(content)
}

func copilotHandleAssistant(data *Obj, ts, harness string, events []*Event) []*Event {
	text := copilotContentText(getOr(data, "content", ""))
	attrs := map[string]any{"tool_response": text}
	if model := getOr(data, "model", ""); truthy(model) {
		attrs["model"] = model
	}
	if usage, ok := data.Get("usage").(*Obj); ok && truthy(usage) {
		if truthy(usage.Get("input_tokens")) {
			attrs["input_tokens"] = scalarString(usage.Get("input_tokens"))
		}
		if truthy(usage.Get("output_tokens")) {
			attrs["output_tokens"] = scalarString(usage.Get("output_tokens"))
		}
	}
	return append(events, event(ts, harness, "hook_assistant_response", text, 100, attrs))
}

func copilotHandleToolCall(data *Obj, ts, harness string, events []*Event, toolCallIndex map[string]int, eventID string) []*Event {
	toolName := getOr(data, "name", getOr(data, "toolName", ""))
	toolInput := getOr(data, "input", getOr(data, "args", &Obj{}))

	var toolInputStr string
	if obj, ok := toolInput.(*Obj); ok {
		toolInputStr = DumpJSON(obj)
	} else {
		toolInputStr = scalarString(toolInput)
	}

	idx := len(events)
	events = append(events, event(ts, harness, "hook_pretooluse", scalarString(toolName), 1<<30, map[string]any{
		"tool_name":   toolName,
		"tool_input":  toolInputStr,
		"tool_use_id": eventID,
	}))
	if eventID != "" {
		toolCallIndex[eventID] = idx
	}
	return events
}

func copilotHandleToolResult(data *Obj, ts, harness string, events []*Event, toolCallIndex map[string]int, parentID string) []*Event {
	result := getOr(data, "output", getOr(data, "result", ""))

	var resultText any
	switch v := result.(type) {
	case *Obj:
		resultText = getOr(v, "textResultForLlm", getOr(v, "text", DumpJSON(v)))
	case []any:
		parts := make([]string, len(v))
		for i, item := range v {
			parts[i] = scalarString(item)
		}
		resultText = strings.Join(parts, "\n")
	default:
		resultText = scalarString(v)
	}

	if idx, ok := toolCallIndex[parentID]; parentID != "" && ok {
		events[idx].Attributes["tool_response"] = resultText
		return events
	}
	toolName := getOr(data, "name", getOr(data, "toolName", ""))
	body := scalarString(toolName)
	if !truthy(toolName) {
		body = "tool_result"
	}
	return append(events, event(ts, harness, "hook_toolresult", body, 1<<30, map[string]any{
		"tool_name":     toolName,
		"tool_response": resultText,
		"tool_use_id":   parentID,
	}))
}

func copilotHandleSessionStart(data *Obj, ts, harness string, events []*Event) []*Event {
	var cwd any = ""
	if context, ok := data.Get("context").(*Obj); ok {
		cwd = getOr(context, "cwd", "")
	}
	body := "session start"
	if truthy(cwd) {
		body = fmt.Sprintf("session start (cwd: %s)", scalarString(cwd))
	}
	return append(events, event(ts, harness, "hook_sessionstart", body, 100, map[string]any{
		"session_id": getOr(data, "sessionId", ""),
		"cwd":        cwd,
	}))
}
