// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package traceview

import "strings"

const (
	gooseMaxBody     = 120
	gooseMaxResponse = 2000
)

// parseGoose expands mirrored Goose session rows. Sessions live in SQLite,
// so the CLI adapter projects them onto an append-only JSONL mirror of
// session / message / session_end records.
func parseGoose(rows []Row) []*Event {
	var events []*Event
	toolIndex := map[string]int{}

	for _, row := range rows {
		if row.RawLine == "" {
			events = append(events, basicEvent(row))
			continue
		}
		line := loadLine(row.RawLine)
		if line == nil {
			events = append(events, basicEvent(row))
			continue
		}

		ts := pickTimestamp(line.Get("timestamp"), row.Timestamp, row.IngestedAt)
		switch getOr(line, "type", "") {
		case "session":
			events = append(events, gooseSessionEvent(line, ts, row.Harness))
		case "session_end":
			events = append(events, gooseSessionEndEvent(line, ts, row.Harness))
		case "message":
			events = gooseHandleMessage(line, ts, row.Harness, events, toolIndex)
		default:
			events = append(events, basicEvent(row))
		}
	}
	if events == nil {
		return []*Event{}
	}
	return events
}

// orBlank renders a value as a string, treating falsy values as "".
func orBlank(value any) string {
	if !truthy(value) {
		return ""
	}
	return scalarString(value)
}

func gooseSessionEvent(line *Obj, ts, harness string) *Event {
	attributes := map[string]any{}
	for _, key := range []string{"working_dir", "session_type", "provider", "model", "goose_mode"} {
		if truthy(line.Get(key)) {
			attributes[key] = orBlank(line.Get(key))
		}
	}
	if truthy(line.Get("parent_session_id")) {
		attributes["parent_session_id"] = scalarString(line.Get("parent_session_id"))
	}
	body := orBlank(line.Get("name"))
	if body == "" {
		body = orBlank(line.Get("session_id"))
	}
	return event(ts, harness, "hook_sessionstart", body, gooseMaxBody, attributes)
}

func gooseSessionEndEvent(line *Obj, ts, harness string) *Event {
	usage, _ := line.Get("usage").(*Obj)
	attributes := map[string]any{}
	for _, pair := range [][2]string{
		{"inputTokens", "input_tokens"},
		{"outputTokens", "output_tokens"},
		{"totalTokens", "total_tokens"},
		{"cost", "cost"},
	} {
		if truthy(usage.Get(pair[0])) {
			attributes[pair[1]] = scalarString(usage.Get(pair[0]))
		}
	}
	return event(ts, harness, "hook_stop", "", gooseMaxBody, attributes)
}

func gooseHandleMessage(line *Obj, ts, harness string, events []*Event, toolIndex map[string]int) []*Event {
	content, ok := line.Get("content").([]any)
	if !ok {
		return events
	}
	role := orBlank(line.Get("role"))
	tokenAttrs := gooseTokenAttributes(line.Get("metadata"))

	for _, raw := range content {
		block, ok := raw.(*Obj)
		if !ok {
			continue
		}
		switch getOr(block, "type", "") {
		case "text":
			text := stripANSI(orBlank(block.Get("text")))
			if strings.TrimSpace(text) == "" {
				continue
			}
			if role == "user" {
				events = append(events, event(ts, harness, "hook_userpromptsubmit", text, gooseMaxBody, map[string]any{
					"tool_input": text,
				}))
			} else {
				attributes := map[string]any{"tool_response": truncChars(text, gooseMaxResponse)}
				for k, v := range tokenAttrs {
					attributes[k] = v
				}
				tokenAttrs = map[string]any{} // consumed by the first assistant text block
				events = append(events, event(ts, harness, "hook_assistant_response", text, gooseMaxBody, attributes))
			}

		case "thinking":
			thinking := stripANSI(orBlank(block.Get("thinking")))
			if strings.TrimSpace(thinking) != "" {
				events = append(events, event(ts, harness, "hook_assistant_thinking", thinking, gooseMaxBody, map[string]any{
					"tool_response": truncChars(thinking, gooseMaxResponse),
				}))
			}

		case "redactedThinking":
			events = append(events, event(ts, harness, "hook_assistant_thinking", "[redacted]", gooseMaxBody, map[string]any{}))

		case "toolRequest", "frontendToolRequest":
			toolID := orBlank(block.Get("id"))
			name, arguments, toolErr := gooseToolCall(block.Get("toolCall"))
			attributes := map[string]any{"tool_name": name, "tool_input": DumpJSON(arguments), "tool_use_id": toolID}
			if toolErr != "" {
				attributes["tool_status"] = "error"
				attributes["tool_response"] = truncChars(toolErr, gooseMaxResponse)
			}
			if toolID != "" {
				toolIndex[toolID] = len(events)
			}
			events = append(events, event(ts, harness, "hook_posttooluse", name, gooseMaxBody, attributes))

		case "toolResponse":
			events = gooseMergeToolResponse(block, ts, harness, events, toolIndex)

		case "toolConfirmationRequest":
			toolName := orBlank(block.Get("toolName"))
			arguments := block.Get("arguments")
			if !truthy(arguments) {
				arguments = &Obj{}
			}
			events = append(events, event(ts, harness, "hook_pretooluse", toolName, gooseMaxBody, map[string]any{
				"tool_name":  toolName,
				"tool_input": DumpJSON(arguments),
			}))

		case "error":
			message := orBlank(block.Get("message"))
			if message == "" {
				message = orBlank(block.Get("msg"))
			}
			events = append(events, event(ts, harness, "hook_error", message, gooseMaxBody, map[string]any{
				"tool_response": truncChars(message, gooseMaxResponse),
			}))
		}
	}

	// A tool-only assistant turn still reports usage; surface it standalone.
	if len(tokenAttrs) > 0 {
		events = append(events, event(ts, harness, "hook_token_usage", "", gooseMaxBody, tokenAttrs))
	}
	return events
}

// gooseTokenAttributes extracts per-message token counts and the resolved
// model from message metadata.
func gooseTokenAttributes(metadata any) map[string]any {
	meta, ok := metadata.(*Obj)
	if !ok {
		return map[string]any{}
	}
	attributes := map[string]any{}
	if usage, ok := meta.Get("usage").(*Obj); ok {
		for _, pair := range [][2]string{
			{"inputTokens", "input_tokens"},
			{"outputTokens", "output_tokens"},
			{"cacheReadTokens", "cache_read_tokens"},
			{"cacheWriteTokens", "cache_creation_tokens"},
			{"cost", "cost"},
		} {
			if truthy(usage.Get(pair[0])) {
				attributes[pair[1]] = scalarString(usage.Get(pair[0]))
			}
		}
	}
	if inference, ok := meta.Get("inference").(*Obj); ok {
		model := inference.Get("resolvedModel")
		if !truthy(model) {
			model = inference.Get("requestedModel")
		}
		if truthy(model) {
			attributes["model"] = scalarString(model)
		}
	}
	return attributes
}

// gooseToolCall returns (name, arguments, error) from a toolCall envelope.
func gooseToolCall(toolCall any) (string, any, string) {
	tc, ok := toolCall.(*Obj)
	if !ok {
		return "", &Obj{}, ""
	}
	if tc.Get("status") == "error" || tc.Has("error") {
		return "", &Obj{}, orBlank(tc.Get("error"))
	}
	value, ok := tc.Get("value").(*Obj)
	if !ok {
		return "", &Obj{}, ""
	}
	arguments := value.Get("arguments")
	if _, ok := arguments.(*Obj); !ok {
		arguments = &Obj{}
	}
	return orBlank(value.Get("name")), arguments, ""
}

// gooseMergeToolResponse attaches a tool result to its request, or emits it
// standalone when orphaned.
func gooseMergeToolResponse(block *Obj, ts, harness string, events []*Event, toolIndex map[string]int) []*Event {
	toolID := orBlank(block.Get("id"))
	text, failed := gooseToolResultText(block.Get("toolResult"))
	if toolID != "" {
		if idx, ok := toolIndex[toolID]; ok && idx < len(events) {
			events[idx].Attributes["tool_response"] = truncChars(text, gooseMaxResponse)
			if failed {
				events[idx].Attributes["tool_status"] = "error"
			}
			return events
		}
	}
	attributes := map[string]any{"tool_use_id": toolID, "tool_response": truncChars(text, gooseMaxResponse)}
	if failed {
		attributes["tool_status"] = "error"
	}
	return append(events, event(ts, harness, "hook_posttooluse", text, gooseMaxBody, attributes))
}

// gooseToolResultText returns (text, failed) for a toolResult envelope,
// handling both the CallToolResult shape (value.content + value.isError) and
// the legacy shape where value is the content list.
func gooseToolResultText(toolResult any) (string, bool) {
	tr, ok := toolResult.(*Obj)
	if !ok {
		return "", false
	}
	if tr.Get("status") == "error" || tr.Has("error") {
		return orBlank(tr.Get("error")), true
	}
	if value, ok := tr.Get("value").(*Obj); ok {
		return gooseContentText(value.Get("content")), truthy(value.Get("isError"))
	}
	return gooseContentText(tr.Get("value")), false
}

func gooseContentText(content any) string {
	switch v := content.(type) {
	case string:
		return v
	case []any:
		var parts []string
		for _, raw := range v {
			if item, ok := raw.(*Obj); ok && item.Get("type") == "text" {
				if part := orBlank(item.Get("text")); part != "" {
					parts = append(parts, part)
				}
			}
		}
		return strings.Join(parts, "\n")
	default:
		return ""
	}
}
