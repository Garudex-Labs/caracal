// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package traceview

import "strings"

// claudeMetaTypes are transcript bookkeeping lines that carry no trace value.
var claudeMetaTypes = map[string]bool{
	"agent-setting":         true,
	"debug":                 true,
	"file-history-snapshot": true,
	"last-prompt":           true,
	"meta":                  true,
	"mode":                  true,
	"permission-mode":       true,
	"pr-link":               true,
	"queue-operation":       true,
	"worktree-state":        true,
}

// parseClaudeCode expands Claude Code transcript rows into frontend events.
// tool_result blocks merge back into the preceding tool_use event keyed by
// tool_use_id rather than emitting a separate event.
func parseClaudeCode(rows []Row) []*Event {
	var events []*Event
	toolUseIndex := map[string]int{}

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

		msgType := strField(line, "type")
		if claudeMetaTypes[msgType] {
			continue
		}
		ts := pickTimestamp(line.Get("timestamp"), row.Timestamp, row.IngestedAt)

		switch msgType {
		case "user":
			events = claudeHandleUser(line, ts, row.Harness, events, toolUseIndex)
		case "assistant":
			events = claudeHandleAssistant(line, ts, row.Harness, events, toolUseIndex)
		case "system":
			systemText := strField(line, "content")
			events = append(events, event(ts, row.Harness, "hook_sessionstart", systemText, 100, map[string]any{}))
		case "attachment":
			attachment := dictField(line, "attachment")
			attachName := strField(attachment, "name")
			events = append(events, event(ts, row.Harness, "attachment", attachName, 100, map[string]any{
				"attachment_type": getOr(attachment, "type", ""),
				"attachment_name": attachName,
			}))
		default:
			events = append(events, basicEvent(row))
		}
	}
	if events == nil {
		return []*Event{}
	}
	return events
}

// claudeHandleUser emits the prompt event and merges tool results back into
// their originating tool_use events.
func claudeHandleUser(line *Obj, ts, harness string, events []*Event, toolUseIndex map[string]int) []*Event {
	content := getOr(dictField(line, "message"), "content", []any{})

	if text, ok := content.(string); ok {
		return append(events, event(ts, harness, "hook_userpromptsubmit", text, 100, map[string]any{
			"tool_input": text,
		}))
	}
	blocks, ok := content.([]any)
	if !ok {
		return events
	}

	var textParts []string
	var resultBlocks []*Obj
	for _, raw := range blocks {
		block, ok := raw.(*Obj)
		if !ok {
			continue
		}
		switch block.Get("type") {
		case "text":
			textParts = append(textParts, strField(block, "text"))
		case "tool_result":
			resultBlocks = append(resultBlocks, block)
		}
	}

	if len(textParts) > 0 {
		fullText := strings.Join(textParts, "\n")
		events = append(events, event(ts, harness, "hook_userpromptsubmit", fullText, 100, map[string]any{
			"tool_input": fullText,
		}))
	}

	for _, block := range resultBlocks {
		toolUseID := strField(block, "tool_use_id")
		resultText := claudeResultText(getOr(block, "content", ""))
		if idx, ok := toolUseIndex[toolUseID]; toolUseID != "" && ok {
			events[idx].Attributes["tool_response"] = resultText
		}
		// Orphan tool results are skipped.
	}
	return events
}

// claudeResultText flattens a tool_result content payload to display text.
func claudeResultText(content any) string {
	switch v := content.(type) {
	case string:
		return v
	case []any:
		var parts []string
		for _, raw := range v {
			if c, ok := raw.(*Obj); ok && c.Get("type") == "text" {
				parts = append(parts, strField(c, "text"))
			}
		}
		return strings.Join(parts, "\n")
	default:
		return scalarString(v)
	}
}

// claudeHandleAssistant expands thinking, text, and tool_use blocks. Token
// usage attaches to the first text block, or a standalone token_usage event
// on tool-only turns.
func claudeHandleAssistant(line *Obj, ts, harness string, events []*Event, toolUseIndex map[string]int) []*Event {
	message := dictField(line, "message")
	content := message.Get("content")

	usage := dictField(message, "usage")
	tokenAttrs := map[string]any{}
	if usage.Len() > 0 {
		if truthy(usage.Get("input_tokens")) {
			tokenAttrs["input_tokens"] = scalarString(usage.Get("input_tokens"))
		}
		if truthy(usage.Get("output_tokens")) {
			tokenAttrs["output_tokens"] = scalarString(usage.Get("output_tokens"))
		}
		if truthy(usage.Get("cache_read_input_tokens")) {
			tokenAttrs["cache_read_tokens"] = scalarString(usage.Get("cache_read_input_tokens"))
		}
		if truthy(usage.Get("cache_creation_input_tokens")) {
			tokenAttrs["cache_creation_tokens"] = scalarString(usage.Get("cache_creation_input_tokens"))
		}
		if truthy(message.Get("model")) {
			tokenAttrs["model"] = message.Get("model")
		}
		if truthy(message.Get("stop_reason")) {
			tokenAttrs["stop_reason"] = message.Get("stop_reason")
		}
	}

	blocks, ok := content.([]any)
	if !ok {
		return events
	}

	for _, raw := range blocks {
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
				tokenAttrs = map[string]any{} // consumed by the first text block
			}
			events = append(events, event(ts, harness, "hook_assistant_response", responseText, 100, attrs))

		case "tool_use":
			toolUseID := strField(block, "id")
			toolName := getOr(block, "name", "")
			toolInput := getOr(block, "input", &Obj{})
			idx := len(events)
			events = append(events, event(ts, harness, "hook_posttooluse", scalarString(toolName), 10000, map[string]any{
				"tool_name":   toolName,
				"tool_input":  DumpJSON(toolInput),
				"tool_use_id": toolUseID,
			}))
			if toolUseID != "" {
				toolUseIndex[toolUseID] = idx
			}
		}
	}

	// A tool-only turn still reports usage; surface it standalone.
	if len(tokenAttrs) > 0 {
		events = append(events, event(ts, harness, "hook_token_usage", "", 100, tokenAttrs))
	}
	return events
}

// parseOpenCode handles OpenCode's mirrored transcripts, which share the
// Claude Code line format.
func parseOpenCode(rows []Row) []*Event {
	return parseClaudeCode(rows)
}

// parseCursor handles Cursor transcripts: the content structure matches
// Claude Code, but the top-level discriminator is role and user text carries
// XML wrapper tags that are stripped for display.
func parseCursor(rows []Row) []*Event {
	var events []*Event
	toolUseIndex := map[string]int{}

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
		switch line.Get("role") {
		case "user":
			cursorCleanUserContent(line)
			events = claudeHandleUser(line, ts, row.Harness, events, toolUseIndex)
		case "assistant":
			events = claudeHandleAssistant(line, ts, row.Harness, events, toolUseIndex)
		default:
			events = append(events, basicEvent(row))
		}
	}
	if events == nil {
		return []*Event{}
	}
	return events
}

// cursorCleanUserContent strips Cursor XML tags from user text blocks.
func cursorCleanUserContent(line *Obj) {
	content, ok := dictField(line, "message").Get("content").([]any)
	if !ok {
		return
	}
	for _, raw := range content {
		if block, ok := raw.(*Obj); ok && block.Get("type") == "text" {
			block.Set("text", stripCursorXMLTags(strField(block, "text")))
		}
	}
}
