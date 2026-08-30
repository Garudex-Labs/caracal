// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package ingest

import (
	"fmt"
)

func classifyCopilotCLI(m map[string]any) (string, bool) {
	var eventType string
	if em, ok := m["event"].(map[string]any); ok {
		eventType = strField(em, "type")
	} else {
		eventType = strField(m, "type")
	}
	if eventType == "" {
		return "", false
	}

	switch eventType {
	case "user.message":
		return "user_prompt", true
	case "assistant.message":
		return "assistant_text", true
	case "assistant.message_delta":
		return "", false
	case "tool.call":
		return "tool_call", true
	case "tool.result", "tool.execution_complete":
		return "tool_result", true
	case "agent.thinking":
		return "thinking", true
	case "assistant.usage":
		return "usage", true
	}
	return "system", true
}

// copilotEventData resolves the two Copilot CLI shapes: the SDK envelope
// ({"event": {"type": ..., ...fields}}) and the flat v1.0.59+ format
// ({"type": ..., "data": {...}}). ok=false aborts the preview (flat form
// with a non-dict data field).
func copilotEventData(m map[string]any) (etype string, data map[string]any, ok bool) {
	if em, isDict := m["event"].(map[string]any); isDict {
		data = make(map[string]any, len(em))
		for k, v := range em {
			if k != "type" {
				data[k] = v
			}
		}
		return strOr(em["type"], ""), data, true
	}
	dv, present := m["data"]
	if !present {
		return strOr(m["type"], ""), map[string]any{}, true
	}
	data, isDict := dv.(map[string]any)
	if !isDict {
		return "", nil, false
	}
	return strOr(m["type"], ""), data, true
}

func previewCopilotCLI(m map[string]any, _ string) string {
	etype, data, ok := copilotEventData(m)
	if !ok {
		return ""
	}

	switch etype {
	case "user.message", "assistant.message":
		content := getOr(data, "content", "")
		if cd, ok := content.(map[string]any); ok {
			content = getOr(cd, "text", "")
		}
		return truncRunes(scalarString(content), previewMax)

	case "tool.call":
		name := getOr(data, "name", getOr(data, "toolName", ""))
		return truncRunes(fmt.Sprintf("[tool_call: %s]", scalarString(name)), previewMax)

	case "tool.result", "tool.execution_complete":
		output := getOr(data, "output", getOr(data, "result", ""))
		if od, ok := output.(map[string]any); ok {
			output = getOr(od, "textResultForLlm", getOr(od, "text", ""))
		}
		return truncRunes(scalarString(output), previewMax)

	case "agent.thinking":
		return truncRunes(scalarString(getOr(data, "content", getOr(data, "thinking", ""))), previewMax)

	case "session.start":
		cwd := any("")
		if cm, ok := getOr(data, "context", map[string]any{}).(map[string]any); ok {
			cwd = getOr(cm, "cwd", "")
		}
		if truthy(cwd) {
			return truncRunes(fmt.Sprintf("session start (cwd: %s)", scalarString(cwd)), previewMax)
		}
		return "session start"
	}
	return ""
}

func toolInfoCopilotCLI(m map[string]any) (*string, *string) {
	if em, ok := m["event"].(map[string]any); ok {
		if getOr(em, "type", "") != "tool.call" {
			return nil, nil
		}
		return strPtr(getOr(em, "name", em["toolName"])), strPtr(m["agentId"])
	}
	if getOr(m, "type", "") != "tool.call" {
		return nil, nil
	}
	if data, ok := m["data"].(map[string]any); ok {
		return strPtr(getOr(data, "name", data["toolName"])), strPtr(m["id"])
	}
	return nil, nil
}

// tsCopilotCLI reads ts at the top level or inside the event envelope.
func tsCopilotCLI(m map[string]any) string {
	raw := m["ts"]
	if !truthy(raw) {
		if em, ok := m["event"].(map[string]any); ok {
			raw = em["ts"]
		}
	}
	return isoToClickHouse(raw)
}
