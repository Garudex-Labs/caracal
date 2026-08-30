// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package traceview

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
)

// Antigravity transcript lines carry {step_index, source, type, status,
// created_at, content, tool_calls}. Tool results come as separate rows whose
// type is the tool name and whose step_index follows the calling response.
var (
	antigravityUserTypes      = map[string]bool{"USER_INPUT": true}
	antigravityAssistantTypes = map[string]bool{"PLANNER_RESPONSE": true}
	antigravitySystemTypes    = map[string]bool{"CONVERSATION_HISTORY": true, "SYSTEM_PROMPT": true}
	antigravityUserRequestRE  = regexp.MustCompile(`(?s)<USER_REQUEST>\s*(.*?)\s*</USER_REQUEST>`)
)

// antigravityUserText strips the XML wrapper injected around user prompts.
func antigravityUserText(content string) string {
	if m := antigravityUserRequestRE.FindStringSubmatch(content); m != nil {
		return strings.TrimSpace(m[1])
	}
	return strings.TrimSpace(content)
}

// parseAntigravity expands Antigravity transcript rows into frontend events.
func parseAntigravity(rows []Row) []*Event {
	var events []*Event
	// Maps step_index of a PLANNER_RESPONSE with tool calls to its event
	// index, so results attach back to the call.
	toolStepIndex := map[int64]int{}

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

		lineType := strField(line, "type")
		source := strField(line, "source")
		status := strField(line, "status")
		content := strField(line, "content")
		toolCalls := listField(line, "tool_calls")
		stepIndex := antigravityStepIndex(line.Get("step_index"))
		ts := pickTimestamp(line.Get("created_at"), row.Timestamp, row.IngestedAt)

		switch {
		// Skip system/history lines.
		case antigravitySystemTypes[lineType] || source == "SYSTEM":
			continue

		case antigravityUserTypes[lineType] && (source == "USER_EXPLICIT" || source == "USER_IMPLICIT"):
			text := ""
			if content != "" {
				text = antigravityUserText(content)
			}
			if text != "" {
				events = append(events, event(ts, row.Harness, "hook_userpromptsubmit", text, 120, map[string]any{
					"tool_input": text,
				}))
			}

		// Model response with tool calls.
		case antigravityAssistantTypes[lineType] && len(toolCalls) > 0:
			for _, raw := range toolCalls {
				tc, ok := raw.(*Obj)
				if !ok {
					continue
				}
				toolName := getOr(tc, "name", "")
				args := getOr(tc, "args", &Obj{})
				var toolInput string
				if obj, ok := args.(*Obj); ok {
					toolInput = DumpJSON(obj)
				} else {
					toolInput = scalarString(args)
				}
				idx := len(events)
				events = append(events, event(ts, row.Harness, "hook_posttooluse", scalarString(toolName), 1<<30, map[string]any{
					"tool_name":  toolName,
					"tool_input": toolInput,
				}))
				toolStepIndex[stepIndex] = idx
			}

		// Model text response (no tool calls).
		case antigravityAssistantTypes[lineType] && content != "" && len(toolCalls) == 0:
			events = append(events, event(ts, row.Harness, "hook_assistant_response", content, 120, map[string]any{
				"tool_response": content,
			}))

		// Tool result: type is the tool name, step_index follows the call.
		case source == "MODEL" && !antigravityAssistantTypes[lineType] && content != "":
			parentIdx, found := antigravityParentIndex(toolStepIndex, stepIndex)
			if found && parentIdx < len(events) {
				events[parentIdx].Attributes["tool_response"] = truncChars(content, 500)
				if status == "ERROR" {
					events[parentIdx].Attributes["tool_status"] = "error"
				}
			} else {
				events = append(events, event(ts, row.Harness, "hook_posttooluse", lineType, 1<<30, map[string]any{
					"tool_name":     lineType,
					"tool_response": truncChars(content, 500),
				}))
			}

		default:
			events = append(events, basicEvent(row))
		}
	}
	if events == nil {
		return []*Event{}
	}
	return events
}

// antigravityStepIndex returns an integer step index, or -1 for anything a
// transcript may carry that is not an integer literal.
func antigravityStepIndex(value any) int64 {
	n, ok := value.(json.Number)
	if !ok {
		return -1
	}
	i, err := strconv.ParseInt(n.String(), 10, 64)
	if err != nil {
		return -1
	}
	return i
}

// antigravityParentIndex resolves the calling event for a tool result: the
// call one step back is preferred, falling back two steps, and an index of
// zero on the first probe defers to the fallback.
func antigravityParentIndex(toolStepIndex map[int64]int, stepIndex int64) (int, bool) {
	if idx, ok := toolStepIndex[stepIndex-1]; ok && idx != 0 {
		return idx, true
	}
	idx, ok := toolStepIndex[stepIndex-2]
	return idx, ok
}
