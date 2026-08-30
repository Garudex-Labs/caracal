// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package ingest

import (
	"fmt"
	"strings"
)

var claudeMetaTypes = map[string]bool{
	"summary": true, "completion_start": true, "tool_use_result": true, "tool_use_delta": true,
}

var claudeAttachmentTypes = map[string]string{
	"file":              "attachment_file",
	"url":               "attachment_url",
	"image":             "attachment_image",
	"directory":         "attachment_dir",
	"project_knowledge": "attachment_knowledge",
}

func classifyClaudeCode(m map[string]any) (string, bool) {
	lineType := strField(m, "type")

	if claudeMetaTypes[lineType] {
		return "meta", true
	}

	switch lineType {
	case "system":
		return "system", true

	case "user":
		content := getOr(dictField(m, "message"), "content", []any{})
		if !truthy(content) {
			return "", false // empty continuation signal
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

	case "attachment":
		attachmentType := ""
		if am, ok := m["attachment"].(map[string]any); ok {
			attachmentType = strField(am, "type")
		}
		if et, ok := claudeAttachmentTypes[attachmentType]; ok {
			return et, true
		}
		return "system", true
	}

	// Unknown type -- store as system so nothing is silently dropped.
	return "system", true
}

func previewClaudeCode(m map[string]any, eventType string) string {
	switch strField(m, "type") {
	case "user", "assistant":
		msg, ok := messageDict(m)
		if !ok {
			return ""
		}
		return previewContentBlocks(getOr(msg, "content", []any{}), nil)
	case "attachment":
		am, ok := m["attachment"].(map[string]any)
		if !ok {
			if _, present := m["attachment"]; present {
				return "" // a present non-dict attachment yields no preview
			}
			am = map[string]any{}
		}
		name := firstTruthy(am["name"], getOr(am, "type", ""))
		return truncRunes(fmt.Sprintf("[attachment: %s]", scalarString(name)), previewMax)
	case "system":
		return truncRunes(strOr(m["content"], ""), previewMax)
	}
	return ""
}

// messageDict resolves the message envelope: an absent message reads as an
// empty dict, while a present non-dict aborts the preview entirely.
func messageDict(m map[string]any) (map[string]any, bool) {
	v, present := m["message"]
	if !present {
		return map[string]any{}, true
	}
	d, ok := v.(map[string]any)
	return d, ok
}

// previewContentBlocks renders a Claude-style content value (string or block
// list). textTransform, when set, is applied to text blocks and raw strings
// (Cursor XML stripping).
func previewContentBlocks(content any, textTransform func(string) string) string {
	if s, ok := content.(string); ok {
		if textTransform != nil {
			s = textTransform(s)
		}
		return truncRunes(s, previewMax)
	}
	list, ok := content.([]any)
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
		case "text":
			text := strOr(bm["text"], "")
			if textTransform != nil {
				text = textTransform(text)
			}
			parts = append(parts, truncRunes(text, previewMax))
		case "thinking":
			parts = append(parts, truncRunes(strOr(bm["thinking"], ""), previewMax))
		case "tool_use":
			parts = append(parts, fmt.Sprintf("[tool_use: %s]", scalarString(getOr(bm, "name", ""))))
		case "tool_result":
			switch inner := bm["content"].(type) {
			case []any:
				for _, item := range inner {
					if im, ok := item.(map[string]any); ok && strField(im, "type") == "text" {
						parts = append(parts, truncRunes(strOr(im["text"], ""), previewMax))
					}
				}
			case string:
				parts = append(parts, truncRunes(inner, previewMax))
			}
		}
	}
	return truncRunes(strings.Join(parts, " "), previewMax)
}

func toolInfoClaudeCode(m map[string]any) (*string, *string) {
	content, ok := getOr(dictField(m, "message"), "content", []any{}).([]any)
	if !ok {
		return nil, nil
	}
	for _, b := range content {
		if bm, ok := b.(map[string]any); ok && strField(bm, "type") == "tool_use" {
			return strPtr(bm["name"]), strPtr(bm["id"])
		}
	}
	return nil, nil
}
