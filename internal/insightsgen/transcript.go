// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"

	"github.com/garudex-labs/caracal/internal/clickhouse"
)

const (
	maxTranscriptChars = 30000
	summaryChunkChars  = 25000
	maxPromptChars     = 500
	maxAssistantChars  = 300
	maxToolInputChars  = 200
	maxToolOutputChars = 200
)

const chunkSummaryPrompt = `Summarize this portion of a session transcript. Focus on:
1. What the user asked for
2. What the assistant did, including tools used and files modified
3. Any friction or issues
4. The outcome

Keep it concise. Preserve specific file names, error messages, and user feedback.

Respond with only this JSON shape:
{"summary": "3 to 5 sentence summary"}

TRANSCRIPT CHUNK:
`

// buildSessionTranscript renders a session's stored events as a readable
// transcript; oversized transcripts are chunk-summarized instead of
// truncated.
func (e *Engine) buildSessionTranscript(ctx context.Context, sessionID string) string {
	rows, err := e.CH.QueryJSON(ctx, `
		SELECT line_offset, event_type, tool_name, raw_line
		FROM session_events FINAL
		WHERE session_id = {sid:String}
		ORDER BY line_offset ASC
		FORMAT JSON`, clickhouse.Settings{"param_sid": sessionID})
	if err != nil {
		slog.Warn("transcript read failed", "session_id", sessionID, "error", err)
		return ""
	}
	if len(rows) == 0 {
		return ""
	}
	transcript := formatTranscriptRows(rows)
	if len(transcript) <= maxTranscriptChars {
		return transcript
	}
	return e.summarizeTranscript(ctx, sessionID, transcript)
}

func formatTranscriptRows(rows []map[string]any) string {
	lines := []string{}
	for _, row := range rows {
		raw := chString(row, "raw_line")
		if raw == "" {
			continue
		}
		var parsed map[string]any
		if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
			continue
		}
		line := formatTranscriptEvent(chString(row, "event_type"), chString(row, "tool_name"), parsed)
		if line == "" {
			continue
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

func (e *Engine) summarizeTranscript(ctx context.Context, sessionID, transcript string) string {
	modelOverride := e.Config.String(ctx, "insights.model_facets", "")
	summaries := []string{}
	for i := 0; i < len(transcript); i += summaryChunkChars {
		chunk := transcript[i:min(i+summaryChunkChars, len(transcript))]
		result := e.callModel(ctx, chunkSummaryPrompt+chunk, modelOverride, 700)
		summary := strings.TrimSpace(str(result["summary"]))
		if summary == "" {
			summary = chunk[:min(2000, len(chunk))]
		}
		summaries = append(summaries, summary)
	}
	return strings.Join([]string{
		fmt.Sprintf("Session: %s", truncateRunes(sessionID, 8)),
		"[Long session summarized]",
		"",
		strings.Join(summaries, "\n\n[Next chunk]\n\n"),
	}, "\n")
}

func formatTranscriptEvent(eventType, toolName string, parsed map[string]any) string {
	switch eventType {
	case "user_prompt":
		if text := transcriptText(parsed); text != "" {
			return "[User]: " + truncateRunes(text, maxPromptChars)
		}
	case "assistant_text":
		if text := transcriptText(parsed); text != "" {
			return "[Assistant]: " + truncateRunes(text, maxAssistantChars)
		}
	case "tool_call":
		name := toolName
		if name == "" {
			name = transcriptToolName(parsed)
		}
		if name == "" {
			name = "unknown"
		}
		return fmt.Sprintf("[Tool: %s] %s", name, truncateRunes(transcriptToolInput(parsed), maxToolInputChars))
	case "tool_result":
		name := toolName
		if name == "" {
			name = "unknown"
		}
		isError, _ := parsed["is_error"].(bool)
		if !isError {
			isError, _ = parsed["isError"].(bool)
		}
		if isError {
			content := transcriptToolResult(parsed)
			return fmt.Sprintf("[Tool Result: %s] ERROR: %s", name, truncateRunes(content, maxToolOutputChars))
		}
		// Successful tool output stays out of the transcript to keep it
		// focused on intent and friction.
		return ""
	}
	return ""
}

func messageOf(parsed map[string]any) map[string]any {
	if msg := asMap(parsed["message"]); msg != nil {
		return msg
	}
	return parsed
}

func transcriptText(parsed map[string]any) string {
	return contentText(messageOf(parsed)["content"])
}

func transcriptToolName(parsed map[string]any) string {
	if name := str(parsed["name"]); name != "" {
		return name
	}
	msg := asMap(parsed["message"])
	if msg == nil {
		return ""
	}
	for _, b := range asList(msg["content"]) {
		block := asMap(b)
		if block == nil {
			continue
		}
		if t := str(block["type"]); t == "tool_use" || t == "toolCall" {
			return str(block["name"])
		}
	}
	return ""
}

func toolInputSummary(input any) (string, bool) {
	inp, ok := input.(map[string]any)
	if !ok {
		return "", false
	}
	if cmd, ok := inp["command"].(string); ok {
		return cmd, true
	}
	if p := str(inp["file_path"]); p != "" {
		return "file: " + p, true
	}
	if p := str(inp["path"]); p != "" {
		return "file: " + p, true
	}
	blob, err := json.Marshal(inp)
	if err != nil {
		return "", true
	}
	return truncateRunes(string(blob), maxToolInputChars), true
}

func transcriptToolInput(parsed map[string]any) string {
	if input, present := parsed["input"]; present {
		if summary, ok := toolInputSummary(input); ok {
			return summary
		}
		return truncateRunes(fmt.Sprint(input), maxToolInputChars)
	}
	msg := messageOf(parsed)
	for _, b := range asList(msg["content"]) {
		block := asMap(b)
		if block == nil {
			continue
		}
		if t := str(block["type"]); t != "tool_use" && t != "toolCall" {
			continue
		}
		input := block["input"]
		if input == nil {
			input = block["arguments"]
		}
		if inp, ok := input.(map[string]any); ok {
			if cmd, ok := inp["command"].(string); ok {
				return cmd
			}
			if p := str(inp["path"]); p != "" {
				return "file: " + p
			}
			blob, err := json.Marshal(inp)
			if err == nil {
				return truncateRunes(string(blob), maxToolInputChars)
			}
		}
	}
	return ""
}

func transcriptToolResult(parsed map[string]any) string {
	content := parsed["content"]
	if s, ok := content.(string); ok {
		return s
	}
	if blocks, ok := content.([]any); ok {
		parts := []string{}
		for _, b := range blocks {
			if block := asMap(b); block != nil && str(block["type"]) == "text" {
				parts = append(parts, str(block["text"]))
			} else if s, ok := b.(string); ok {
				parts = append(parts, s)
			}
		}
		return strings.Join(parts, " ")
	}
	return truncateRunes(fmt.Sprint(content), 200)
}
