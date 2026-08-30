// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package ingest

import (
	"fmt"
	"strings"
)

var (
	gooseThinkingBlocks = map[string]bool{"thinking": true, "redactedThinking": true}
	gooseRequestBlocks  = map[string]bool{
		"toolRequest": true, "frontendToolRequest": true, "toolConfirmationRequest": true,
	}
)

func gooseBlockTypes(m map[string]any) []string {
	content, ok := m["content"].([]any)
	if !ok {
		return nil
	}
	var types []string
	for _, b := range content {
		if bm, ok := b.(map[string]any); ok {
			types = append(types, strField(bm, "type"))
		}
	}
	return types
}

func classifyGoose(m map[string]any) (string, bool) {
	recordType := getOr(m, "type", "")
	if recordType == "session" || recordType == "session_end" {
		return "system", true
	}
	if recordType != "message" {
		return "system", true
	}

	blocks := gooseBlockTypes(m)
	if len(blocks) == 0 {
		return "", false // empty message row carries no signal
	}
	for _, block := range blocks {
		if gooseThinkingBlocks[block] {
			return "thinking", true
		}
		if gooseRequestBlocks[block] {
			return "tool_call", true
		}
		if block == "toolResponse" {
			return "tool_result", true
		}
	}
	if m["role"] == "user" {
		return "user_prompt", true
	}
	return "assistant_text", true
}

func gooseToolCallText(block map[string]any) string {
	call, _ := block["toolCall"].(map[string]any)
	value, _ := call["value"].(map[string]any)
	name := firstTruthy(value["name"], block["toolName"])
	if !truthy(name) {
		return ""
	}
	return fmt.Sprintf("[tool_use: %s]", scalarString(name))
}

func gooseToolResultText(block map[string]any) string {
	result, _ := block["toolResult"].(map[string]any)
	if errVal, present := result["error"]; present {
		return scalarString(firstTruthy(errVal, ""))
	}
	content := result["value"]
	if vm, ok := content.(map[string]any); ok {
		content = vm["content"]
	}
	if s, ok := content.(string); ok {
		return s
	}
	list, ok := content.([]any)
	if !ok {
		return ""
	}
	var parts []string
	for _, item := range list {
		if im, ok := item.(map[string]any); ok && im["type"] == "text" {
			parts = append(parts, scalarString(firstTruthy(im["text"], "")))
		}
	}
	return strings.Join(parts, " ")
}

func previewGoose(m map[string]any, _ string) string {
	switch getOr(m, "type", "") {
	case "session":
		name := firstTruthy(m["name"], firstTruthy(m["session_id"], ""))
		return truncRunes(fmt.Sprintf("[session: %s]", scalarString(name)), previewMax)
	case "session_end":
		return "[session end]"
	}
	content, ok := m["content"].([]any)
	if !ok {
		return ""
	}
	var parts []string
	for _, b := range content {
		bm, ok := b.(map[string]any)
		if !ok {
			continue
		}
		var part string
		switch blockType := strField(bm, "type"); {
		case blockType == "text":
			part = scalarString(firstTruthy(bm["text"], ""))
		case blockType == "thinking":
			part = scalarString(firstTruthy(bm["thinking"], ""))
		case blockType == "redactedThinking":
			part = "[redacted thinking]"
		case gooseRequestBlocks[blockType]:
			part = gooseToolCallText(bm)
		case blockType == "toolResponse":
			part = gooseToolResultText(bm)
		}
		if part != "" {
			parts = append(parts, part)
		}
	}
	return truncRunes(strings.Join(parts, " "), previewMax)
}

func toolInfoGoose(m map[string]any) (*string, *string) {
	content, ok := m["content"].([]any)
	if !ok {
		return nil, nil
	}
	for _, b := range content {
		bm, ok := b.(map[string]any)
		if !ok || !gooseRequestBlocks[strField(bm, "type")] {
			continue
		}
		call, _ := bm["toolCall"].(map[string]any)
		value, _ := call["value"].(map[string]any)
		name := value["name"]
		if !truthy(name) {
			name = bm["toolName"]
		}
		return strPtr(name), strPtr(bm["id"])
	}
	return nil, nil
}
