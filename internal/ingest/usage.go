// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package ingest

// Usage carries per-line token counts and the model that produced them.
type Usage struct {
	InputTokens      int    `json:"input_tokens"`
	OutputTokens     int    `json:"output_tokens"`
	CacheReadTokens  int    `json:"cache_read_tokens"`
	CacheWriteTokens int    `json:"cache_write_tokens"`
	Model            string `json:"model"`
}

// Usage and uuid extraction dispatch by harness name (not parser id), with
// the claude-code format as the fallback for unknown harnesses.

func usageClaudeCode(m map[string]any) Usage {
	msg := dictField(m, "message")
	usage := dictField(msg, "usage")
	return Usage{
		InputTokens:      intOf(usage["input_tokens"]),
		OutputTokens:     intOf(usage["output_tokens"]),
		CacheReadTokens:  intOf(usage["cache_read_input_tokens"]),
		CacheWriteTokens: intOf(usage["cache_creation_input_tokens"]),
		Model:            scalarString(firstTruthy(msg["model"], firstTruthy(m["model"], ""))),
	}
}

func usagePi(m map[string]any) Usage {
	msg := dictField(m, "message")
	usage := dictField(msg, "usage")
	return Usage{
		InputTokens:      intOf(usage["input"]),
		OutputTokens:     intOf(usage["output"]),
		CacheReadTokens:  intOf(usage["cacheRead"]),
		CacheWriteTokens: intOf(usage["cacheWrite"]),
		Model:            scalarString(firstTruthy(msg["model"], "")),
	}
}

func usageAntigravity(map[string]any) Usage { return Usage{} }

func usageGoose(m map[string]any) Usage {
	metadata := dictField(m, "metadata")
	usage := dictField(metadata, "usage")
	inference := dictField(metadata, "inference")
	return Usage{
		InputTokens:      intOf(usage["inputTokens"]),
		OutputTokens:     intOf(usage["outputTokens"]),
		CacheReadTokens:  intOf(usage["cacheReadTokens"]),
		CacheWriteTokens: intOf(usage["cacheWriteTokens"]),
		Model:            scalarString(firstTruthy(inference["resolvedModel"], firstTruthy(inference["requestedModel"], ""))),
	}
}

func usageCodex(m map[string]any) Usage {
	info := dictField(dictField(m, "payload"), "info")
	usageVal := firstTruthy(info["last_token_usage"], info["total_token_usage"])
	usage, _ := usageVal.(map[string]any)
	return Usage{
		InputTokens:     intOf(usage["input_tokens"]),
		OutputTokens:    intOf(usage["output_tokens"]),
		CacheReadTokens: intOf(usage["cached_input_tokens"]),
	}
}

func usageCopilotCLI(m map[string]any) Usage {
	// Flat format first (Copilot CLI v1.0.59+), then the SDK envelope.
	if data, ok := m["data"].(map[string]any); ok && (truthy(data["outputTokens"]) || truthy(data["inputTokens"])) {
		return copilotUsageFrom(data)
	}
	if event, ok := m["event"].(map[string]any); ok {
		if edata, ok := event["data"].(map[string]any); ok && (truthy(edata["outputTokens"]) || truthy(edata["inputTokens"])) {
			return copilotUsageFrom(edata)
		}
	}
	return Usage{}
}

func copilotUsageFrom(data map[string]any) Usage {
	return Usage{
		InputTokens:      intOf(data["inputTokens"]),
		OutputTokens:     intOf(data["outputTokens"]),
		CacheReadTokens:  intOf(data["cacheReadTokens"]),
		CacheWriteTokens: intOf(data["cacheWriteTokens"]),
		Model:            scalarString(firstTruthy(data["model"], "")),
	}
}

var usageExtractors = map[string]func(map[string]any) Usage{
	"claude-code": usageClaudeCode,
	"codex":       usageCodex,
	"kiro":        usageClaudeCode,
	"cursor":      usageClaudeCode,
	"goose":       usageGoose,
	"pi":          usagePi,
	"copilot-cli": usageCopilotCLI,
	"copilot":     usageCopilotCLI,
	"opencode":    usageClaudeCode,
	"antigravity": usageAntigravity,
}

// extractUsage dispatches by harness, falling back to the Claude Code format.
func extractUsage(harnessName string, m map[string]any) Usage {
	if fn, ok := usageExtractors[harnessName]; ok {
		return fn(m)
	}
	return usageClaudeCode(m)
}

func uuidDefault(m map[string]any) (*string, *string) {
	return strPtr(m["uuid"]), strPtr(m["parentUuid"])
}

func uuidPi(m map[string]any) (*string, *string) {
	return strPtr(m["id"]), strPtr(m["parentId"])
}

func uuidAntigravity(m map[string]any) (*string, *string) {
	if step, present := m["step_index"]; present && step != nil {
		s := scalarString(step)
		return &s, nil
	}
	return nil, nil
}

func uuidGoose(m map[string]any) (*string, *string) {
	return strPtr(firstTruthy(m["message_id"], m["session_id"])), strPtr(m["parent_session_id"])
}

var uuidExtractors = map[string]func(map[string]any) (*string, *string){
	"claude-code": uuidDefault,
	"kiro":        uuidDefault,
	"cursor":      uuidDefault,
	"goose":       uuidGoose,
	"opencode":    uuidDefault,
	"pi":          uuidPi,
	"antigravity": uuidAntigravity,
}

// extractUUID dispatches by harness, falling back to uuid/parentUuid fields.
func extractUUID(harnessName string, m map[string]any) (*string, *string) {
	if fn, ok := uuidExtractors[harnessName]; ok {
		return fn(m)
	}
	return uuidDefault(m)
}
