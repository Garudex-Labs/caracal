// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package ingest

import (
	"fmt"
	"strings"
)

var piSkipTypes = map[string]bool{"session": true, "label": true, "session_info": true, "custom": true}

func classifyPi(m map[string]any) (string, bool) {
	lineType := strField(m, "type")

	if piSkipTypes[lineType] {
		return "", false
	}

	switch lineType {
	case "model_change", "thinking_level_change", "custom_message":
		return "system", true
	case "compaction", "branch_summary":
		return "meta", true
	case "message":
		msg := dictField(m, "message")
		switch getOr(msg, "role", "") {
		case "user":
			if !truthy(getOr(msg, "content", []any{})) {
				return "", false
			}
			return "user_prompt", true
		case "assistant":
			if list, ok := getOr(msg, "content", []any{}).([]any); ok {
				for _, b := range list {
					bm, ok := b.(map[string]any)
					if !ok {
						continue
					}
					switch strField(bm, "type") {
					case "thinking":
						return "thinking", true
					case "toolCall":
						return "tool_call", true
					case "text":
						return "assistant_text", true
					}
				}
			}
			return "assistant_text", true
		case "toolResult", "bashExecution":
			return "tool_result", true
		case "custom", "branchSummary", "compactionSummary":
			return "system", true
		}
	}
	return "system", true
}

func previewPi(m map[string]any, _ string) string {
	switch strOr(m["type"], "") {
	case "message":
		msg, ok := messageDict(m)
		if !ok {
			return ""
		}
		role := getOr(msg, "role", "")
		content := getOr(msg, "content", []any{})

		switch role {
		case "user", "assistant":
			if s, ok := content.(string); ok {
				return truncRunes(s, previewMax)
			}
			if list, ok := content.([]any); ok {
				var parts []string
				for _, b := range list {
					bm, ok := b.(map[string]any)
					if !ok {
						continue
					}
					switch strField(bm, "type") {
					case "text":
						parts = append(parts, truncRunes(strOr(bm["text"], ""), previewMax))
					case "thinking":
						parts = append(parts, truncRunes(strOr(bm["thinking"], ""), previewMax))
					case "toolCall":
						parts = append(parts, fmt.Sprintf("[tool_call: %s]", scalarString(getOr(bm, "name", ""))))
					}
				}
				return truncRunes(strings.Join(parts, " "), previewMax)
			}
		case "toolResult":
			toolName := scalarString(getOr(msg, "toolName", ""))
			if inner, ok := getOr(msg, "content", []any{}).([]any); ok {
				for _, item := range inner {
					if im, ok := item.(map[string]any); ok && strField(im, "type") == "text" {
						return truncRunes(fmt.Sprintf("[%s] %s", toolName, strOr(im["text"], "")), previewMax)
					}
				}
			}
			return truncRunes(fmt.Sprintf("[%s]", toolName), previewMax)
		case "bashExecution":
			return truncRunes(fmt.Sprintf("$ %s", scalarString(getOr(msg, "command", ""))), previewMax)
		}
		return ""

	case "model_change":
		return truncRunes(
			fmt.Sprintf("Model: %s/%s", scalarString(getOr(m, "provider", "")), scalarString(getOr(m, "modelId", ""))),
			previewMax,
		)
	case "thinking_level_change":
		return truncRunes(fmt.Sprintf("Thinking: %s", scalarString(getOr(m, "thinkingLevel", ""))), previewMax)
	case "compaction", "branch_summary":
		return truncRunes(strOr(m["summary"], ""), previewMax)
	case "custom_message":
		if s, ok := m["content"].(string); ok {
			return truncRunes(s, previewMax)
		}
	}
	return ""
}

func toolInfoPi(m map[string]any) (*string, *string) {
	if m["type"] != "message" {
		return nil, nil
	}
	msg := dictField(m, "message")
	switch getOr(msg, "role", "") {
	case "assistant":
		if list, ok := getOr(msg, "content", []any{}).([]any); ok {
			for _, b := range list {
				if bm, ok := b.(map[string]any); ok && strField(bm, "type") == "toolCall" {
					return strPtr(bm["name"]), strPtr(bm["id"])
				}
			}
		}
	case "toolResult":
		return strPtr(msg["toolName"]), strPtr(msg["toolCallId"])
	}
	return nil, nil
}
