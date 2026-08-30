// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package ingest

import (
	"regexp"
	"strings"
)

var (
	reCursorTimestamp      = regexp.MustCompile(`(?s)<timestamp>.*?</timestamp>\s*`)
	reCursorUserQuery      = regexp.MustCompile(`</?user_query>\s*`)
	reCursorSystemReminder = regexp.MustCompile(`</?system_reminder>\s*`)
	reCursorAttachedFiles  = regexp.MustCompile(`</?attached_files>\s*`)
)

// stripCursorXMLTags removes Cursor's XML wrapper tags from user prompts.
func stripCursorXMLTags(text string) string {
	text = reCursorTimestamp.ReplaceAllString(text, "")
	text = reCursorUserQuery.ReplaceAllString(text, "")
	text = reCursorSystemReminder.ReplaceAllString(text, "")
	text = reCursorAttachedFiles.ReplaceAllString(text, "")
	return strings.TrimSpace(text)
}

func classifyCursor(m map[string]any) (string, bool) {
	role := strField(m, "role")

	switch role {
	case "user":
		content := getOr(dictField(m, "message"), "content", []any{})
		if !truthy(content) {
			return "", false
		}
		if list, ok := content.([]any); ok {
			for _, b := range list {
				if bm, ok := b.(map[string]any); ok && strField(bm, "type") == "tool_result" {
					return "tool_result", true
				}
			}
		}
		return "user_prompt", true

	case "assistant":
		content := getOr(dictField(m, "message"), "content", []any{})
		if list, ok := content.([]any); ok && len(list) > 0 {
			for _, b := range list {
				bm, ok := b.(map[string]any)
				if !ok {
					continue
				}
				switch strField(bm, "type") {
				case "thinking":
					return "thinking", true
				case "tool_use":
					return "tool_call", true
				case "text":
					return "assistant_text", true
				}
			}
		}
		return "assistant_text", true

	case "":
		return "", false
	}
	return "system", true
}

func previewCursor(m map[string]any, eventType string) string {
	msg, ok := messageDict(m)
	if !ok {
		return ""
	}
	content := getOr(msg, "content", []any{})
	// Raw string content is always stripped; text blocks only for user prompts.
	if s, ok := content.(string); ok {
		return truncRunes(stripCursorXMLTags(s), previewMax)
	}
	var transform func(string) string
	if eventType == "user_prompt" {
		transform = stripCursorXMLTags
	}
	return previewContentBlocks(content, transform)
}
