// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package ingest

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

func classifyKiro(m map[string]any) (string, bool) {
	switch strField(m, "kind") {
	case "Prompt":
		content := listField(dictField(m, "data"), "content")
		for _, item := range content {
			im, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if im["kind"] == "text" && strings.TrimSpace(strField(im, "data")) != "" {
				return "user_prompt", true
			}
		}
		return "", false // empty prompt

	case "AssistantMessage":
		content := listField(dictField(m, "data"), "content")
		for _, item := range content {
			if im, ok := item.(map[string]any); ok && im["kind"] == "toolUse" {
				return "tool_call", true
			}
		}
		return "assistant_text", true

	case "ToolResults":
		return "tool_result", true
	}
	return "system", true
}

func previewKiro(m map[string]any, _ string) string {
	kind := strOr(m["kind"], "")
	content := getOr(dictField(m, "data"), "content", []any{})
	list, _ := content.([]any)

	switch kind {
	case "Prompt":
		var parts []string
		for _, item := range list {
			im, ok := item.(map[string]any)
			if !ok || im["kind"] != "text" {
				continue
			}
			if s, ok := im["data"].(string); ok {
				parts = append(parts, s)
			}
		}
		return truncRunes(strings.Join(parts, " "), previewMax)

	case "AssistantMessage":
		var parts []string
		for _, item := range list {
			im, ok := item.(map[string]any)
			if !ok {
				continue
			}
			switch im["kind"] {
			case "text":
				parts = append(parts, truncRunes(scalarString(getOr(im, "data", "")), previewMax))
			case "toolUse":
				name := any("")
				if dm, ok := im["data"].(map[string]any); ok {
					name = getOr(dm, "name", "")
				}
				parts = append(parts, fmt.Sprintf("[tool_use: %s]", scalarString(name)))
			}
		}
		return truncRunes(strings.Join(parts, " "), previewMax)

	case "ToolResults":
		var parts []string
		for _, item := range list {
			im, ok := item.(map[string]any)
			if !ok || im["kind"] != "toolResult" {
				continue
			}
			dm, ok := getOr(im, "data", map[string]any{}).(map[string]any)
			if !ok {
				continue
			}
			results, _ := getOr(dm, "content", []any{}).([]any)
			for _, rc := range results {
				if rm, ok := rc.(map[string]any); ok && rm["kind"] == "text" {
					parts = append(parts, truncRunes(scalarString(getOr(rm, "data", "")), previewMax))
				}
			}
		}
		return truncRunes(strings.Join(parts, " "), previewMax)
	}
	return ""
}

func toolInfoKiro(m map[string]any) (*string, *string) {
	if strField(m, "kind") != "AssistantMessage" {
		return nil, nil
	}
	for _, item := range listField(dictField(m, "data"), "content") {
		im, ok := item.(map[string]any)
		if !ok || im["kind"] != "toolUse" {
			continue
		}
		if dm, ok := getOr(im, "data", map[string]any{}).(map[string]any); ok {
			return strPtr(dm["name"]), strPtr(dm["toolUseId"])
		}
	}
	return nil, nil
}

// tsKiro reads the epoch-seconds timestamp at data.meta.timestamp.
func tsKiro(m map[string]any) string {
	data, ok := m["data"].(map[string]any)
	if !ok {
		return ""
	}
	meta, ok := data["meta"].(map[string]any)
	if !ok {
		return ""
	}
	epoch := meta["timestamp"]
	if !truthy(epoch) {
		return ""
	}
	var seconds float64
	switch x := epoch.(type) {
	case float64:
		seconds = x
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(x), 64)
		if err != nil {
			return ""
		}
		seconds = f
	default:
		return ""
	}
	if math.IsNaN(seconds) || math.IsInf(seconds, 0) {
		return ""
	}
	return time.Unix(int64(math.Floor(seconds)), 0).UTC().Format("2006-01-02 15:04:05") + ".000"
}
