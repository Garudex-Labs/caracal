// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package ingest

import (
	"fmt"
	"strings"
)

func classifyCodex(m map[string]any) (string, bool) {
	switch strField(m, "type") {
	case "event_msg":
		switch strField(dictField(m, "payload"), "type") {
		case "user_message":
			return "user_prompt", true
		case "agent_message":
			return "assistant_text", true
		case "token_count":
			return "meta", true
		}
		return "system", true

	case "response_item":
		payload := dictField(m, "payload")
		content := getOr(payload, "content", []any{})

		switch payload["type"] {
		case "function_call":
			return "tool_call", true
		case "function_call_output":
			return "tool_result", true
		}

		switch getOr(payload, "role", "") {
		case "user":
			return "system", true
		case "assistant":
			if list, ok := content.([]any); ok {
				for _, b := range list {
					bm, ok := b.(map[string]any)
					if !ok {
						continue
					}
					switch strField(bm, "type") {
					case "function_call":
						return "tool_call", true
					case "function_call_output":
						return "tool_result", true
					}
				}
			}
			return "assistant_text", true
		case "developer":
			return "system", true
		}
		if list, ok := content.([]any); ok {
			for _, b := range list {
				if bm, ok := b.(map[string]any); ok && strField(bm, "type") == "function_call_output" {
					return "tool_result", true
				}
			}
		}
		return "system", true
	}
	return "system", true
}

func previewCodex(m map[string]any, _ string) string {
	switch strOr(m["type"], "") {
	case "event_msg":
		payload, ok := payloadDict(m)
		if !ok {
			return ""
		}
		switch payload["type"] {
		case "user_message", "agent_message":
			return truncRunes(scalarString(getOr(payload, "message", "")), previewMax)
		}
		return ""

	case "response_item":
		payload, ok := payloadDict(m)
		if !ok {
			return ""
		}
		list, ok := getOr(payload, "content", []any{}).([]any)
		if !ok {
			return ""
		}
		var parts []string
		for _, b := range list {
			bm, ok := b.(map[string]any)
			if !ok {
				continue
			}
			switch strField(bm, "type") {
			case "input_text", "output_text":
				parts = append(parts, truncRunes(strOr(bm["text"], ""), previewMax))
			case "function_call":
				parts = append(parts, fmt.Sprintf("[tool_call: %s]", scalarString(getOr(bm, "name", ""))))
			case "function_call_output":
				parts = append(parts, truncRunes(scalarString(getOr(bm, "output", "")), previewMax))
			}
		}
		return truncRunes(strings.Join(parts, " "), previewMax)
	}
	return ""
}

// payloadDict resolves the payload envelope: an absent payload reads as an
// empty dict, while a present non-dict aborts the preview entirely.
func payloadDict(m map[string]any) (map[string]any, bool) {
	v, present := m["payload"]
	if !present {
		return map[string]any{}, true
	}
	d, ok := v.(map[string]any)
	return d, ok
}

func toolInfoCodex(m map[string]any) (*string, *string) {
	if m["type"] != "response_item" {
		return nil, nil
	}
	payload := dictField(m, "payload")
	if payload["type"] == "function_call" {
		return strPtr(payload["name"]), strPtr(payload["call_id"])
	}
	if list, ok := getOr(payload, "content", []any{}).([]any); ok {
		for _, b := range list {
			if bm, ok := b.(map[string]any); ok && bm["type"] == "function_call" {
				return strPtr(bm["name"]), strPtr(bm["call_id"])
			}
		}
	}
	return nil, nil
}
