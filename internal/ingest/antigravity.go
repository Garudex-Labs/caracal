// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package ingest

import (
	"fmt"
	"regexp"
	"strings"
)

var (
	antigravitySkipTypes = map[string]bool{"CONVERSATION_HISTORY": true, "SYSTEM_PROMPT": true}
	reAntigravityRequest = regexp.MustCompile(`(?s)<USER_REQUEST>\s*(.*?)\s*</USER_REQUEST>`)
)

func classifyAntigravity(m map[string]any) (string, bool) {
	source := strField(m, "source")
	lineType := strField(m, "type")

	switch {
	case antigravitySkipTypes[lineType]:
		return "", false
	case source == "USER_EXPLICIT" && lineType == "USER_INPUT":
		return "user_prompt", true
	case source == "MODEL" && lineType == "PLANNER_RESPONSE":
		if truthy(getOr(m, "tool_calls", []any{})) {
			return "tool_call", true
		}
		return "assistant_text", true
	case source == "MODEL" && lineType != "PLANNER_RESPONSE" && lineType != "USER_INPUT":
		return "tool_result", true
	case source == "SYSTEM":
		return "system", true
	}
	return "", false
}

func previewAntigravity(m map[string]any, eventType string) string {
	content, ok := m["content"].(string)
	if !ok || content == "" {
		return ""
	}

	switch eventType {
	case "user_prompt":
		if g := reAntigravityRequest.FindStringSubmatch(content); g != nil {
			return truncRunes(strings.TrimSpace(g[1]), previewMax)
		}
		return truncRunes(content, previewMax)

	case "assistant_text":
		return truncRunes(content, previewMax)

	case "tool_call":
		toolCalls := getOr(m, "tool_calls", []any{})
		if truthy(toolCalls) {
			list, ok := toolCalls.([]any)
			if !ok {
				return ""
			}
			var names []string
			for _, tc := range list {
				if tm, ok := tc.(map[string]any); ok {
					names = append(names, scalarString(getOr(tm, "name", "")))
				}
			}
			return truncRunes(
				fmt.Sprintf("%s [tools: %s]", truncRunes(content, 200), strings.Join(names, ", ")),
				previewMax,
			)
		}
		return truncRunes(content, previewMax)

	case "tool_result":
		return truncRunes(
			fmt.Sprintf("[%s] %s", scalarString(getOr(m, "type", "")), truncRunes(content, 200)),
			previewMax,
		)
	}
	return ""
}

func toolInfoAntigravity(m map[string]any) (*string, *string) {
	if list, ok := m["tool_calls"].([]any); ok && len(list) > 0 {
		if tm, ok := list[0].(map[string]any); ok {
			return strPtr(tm["name"]), nil
		}
	}
	source := strField(m, "source")
	lineType := strField(m, "type")
	if source == "MODEL" && lineType != "PLANNER_RESPONSE" && lineType != "USER_INPUT" {
		lower := strings.ToLower(lineType)
		return &lower, nil
	}
	return nil, nil
}
