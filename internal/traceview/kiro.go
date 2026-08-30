// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package traceview

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"time"
)

// parseKiro expands Kiro CLI transcript rows. Lines are {version, kind, data}
// envelopes; ToolResults rows merge back into the preceding AssistantMessage
// tool-use events keyed by toolUseId.
func parseKiro(rows []Row) []*Event {
	var events []*Event
	toolUseIndex := map[string]int{}

	for _, row := range rows {
		if row.RawLine == "" {
			events = append(events, basicEvent(row))
			continue
		}
		line := loadLine(row.RawLine)
		if line == nil {
			events = append(events, basicEvent(row))
			continue
		}

		kind := getOr(line, "kind", "")
		data, ok := line.Get("data").(*Obj)
		if !ok {
			events = append(events, basicEvent(row))
			continue
		}

		// Timestamps only exist on Prompt lines (meta.timestamp, epoch
		// seconds); everything else falls back to the row timestamps.
		var jsonlTS any
		if meta, ok := data.Get("meta").(*Obj); ok && truthy(meta.Get("timestamp")) {
			jsonlTS = kiroEpochToTimestamp(meta.Get("timestamp"))
		}
		ts := pickTimestamp(jsonlTS, row.Timestamp, row.IngestedAt)

		switch kind {
		case "KiroCredits":
			// Synthetic row carrying the session's lifetime credits.
			var rowCredits any
			if row.Credits != 0 {
				rowCredits = row.Credits
			} else {
				rowCredits = data.Get("credits")
			}
			credits, creditsOK := kiroAsCredits(rowCredits)
			if truthy(rowCredits) && creditsOK {
				events = append(events, event(ts, row.Harness, "kiro_credits", fmt.Sprintf("%.4f credits", credits), 1<<30, map[string]any{
					"credits": kiroCreditsString(rowCredits),
					"model":   "Kiro Auto",
				}))
			}
		case "Prompt":
			events = kiroHandlePrompt(data, ts, row.Harness, events)
		case "AssistantMessage":
			events = kiroHandleAssistantMessage(data, ts, row.Harness, events, toolUseIndex)
		case "ToolResults":
			kiroHandleToolResults(data, events, toolUseIndex)
		default:
			events = append(events, basicEvent(row))
		}
	}
	if events == nil {
		return []*Event{}
	}
	return events
}

// kiroEpochToTimestamp converts unix epoch seconds to a timestamp string, or
// nil for values outside the representable range.
func kiroEpochToTimestamp(epoch any) any {
	var seconds float64
	switch v := epoch.(type) {
	case json.Number:
		f, err := v.Float64()
		if err != nil {
			return nil
		}
		seconds = f
	case bool:
		if v {
			seconds = 1
		}
	default:
		return nil
	}
	if !isReasonableEpoch(seconds) {
		return nil
	}
	return time.Unix(int64(math.Floor(seconds)), 0).UTC().Format("2006-01-02 15:04:05.000")
}

// isReasonableEpoch bounds epochs to timestamps a datetime can represent.
func isReasonableEpoch(seconds float64) bool {
	const maxEpoch = 253402300799 // 9999-12-31T23:59:59Z
	return !math.IsNaN(seconds) && seconds >= -62135596800 && seconds <= maxEpoch
}

// kiroAsCredits returns a credit balance as a float, or false when the
// transcript carries a non-numeric value.
func kiroAsCredits(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		return v, !math.IsNaN(v) && !math.IsInf(v, 0)
	case json.Number:
		f, err := v.Float64()
		return f, err == nil && !math.IsNaN(f) && !math.IsInf(f, 0)
	case string:
		var f float64
		if _, err := fmt.Sscanf(strings.TrimSpace(v), "%g", &f); err != nil {
			return 0, false
		}
		return f, !math.IsNaN(f) && !math.IsInf(f, 0)
	default:
		return 0, false
	}
}

// kiroCreditsString renders the raw credits value for the attribute map.
func kiroCreditsString(value any) string {
	if f, ok := value.(float64); ok {
		return floatString(f)
	}
	return scalarString(value)
}

func kiroHandlePrompt(data *Obj, ts, harness string, events []*Event) []*Event {
	var textParts []string
	for _, raw := range listField(data, "content") {
		item, ok := raw.(*Obj)
		if !ok || item.Get("kind") != "text" {
			continue
		}
		if text, ok := item.Get("data").(string); ok {
			textParts = append(textParts, text)
		}
	}
	fullText := strings.Join(textParts, "\n")
	if fullText == "" {
		return events
	}
	return append(events, event(ts, harness, "hook_userpromptsubmit", fullText, 100, map[string]any{
		"tool_input": fullText,
	}))
}

func kiroHandleAssistantMessage(data *Obj, ts, harness string, events []*Event, toolUseIndex map[string]int) []*Event {
	for _, raw := range listField(data, "content") {
		item, ok := raw.(*Obj)
		if !ok {
			continue
		}
		switch getOr(item, "kind", "") {
		case "text":
			text, _ := item.Get("data").(string)
			if strings.TrimSpace(text) == "" {
				continue // skip empty filler blocks between tool calls
			}
			events = append(events, event(ts, harness, "hook_assistant_response", text, 100, map[string]any{
				"tool_response": text,
			}))
		case "toolUse":
			itemData, ok := item.Get("data").(*Obj)
			if !ok {
				continue
			}
			toolUseID := strField(itemData, "toolUseId")
			toolName := getOr(itemData, "name", "")
			cleanInput := &Obj{}
			for _, key := range dictField(itemData, "input").Keys() {
				if !strings.HasPrefix(key, "__") { // Kiro-internal annotation keys
					cleanInput.Set(key, dictField(itemData, "input").Get(key))
				}
			}
			idx := len(events)
			events = append(events, event(ts, harness, "hook_posttooluse", scalarString(toolName), 1<<30, map[string]any{
				"tool_name":   toolName,
				"tool_input":  DumpJSON(cleanInput),
				"tool_use_id": toolUseID,
			}))
			if toolUseID != "" {
				toolUseIndex[toolUseID] = idx
			}
		}
	}
	return events
}

func kiroHandleToolResults(data *Obj, events []*Event, toolUseIndex map[string]int) {
	for _, raw := range listField(data, "content") {
		item, ok := raw.(*Obj)
		if !ok || item.Get("kind") != "toolResult" {
			continue
		}
		itemData, ok := item.Get("data").(*Obj)
		if !ok {
			continue
		}

		toolUseID := strField(itemData, "toolUseId")
		status := getOr(itemData, "status", "success")
		resultText := kiroResultText(listField(itemData, "content"))
		if status == "error" {
			if resultText != "" {
				resultText = "[error] " + resultText
			} else {
				resultText = "[error]"
			}
		}

		if idx, ok := toolUseIndex[toolUseID]; toolUseID != "" && ok {
			events[idx].Attributes["tool_response"] = resultText
			if status == "error" {
				events[idx].Attributes["tool_status"] = "error"
			}
		}
		// Orphan tool results are skipped.
	}
}

// kiroResultText extracts plain text from a tool-result content array, where
// each item is {kind: "text"|"json", data: str|{content: [{type, text}]}}.
func kiroResultText(resultContent []any) string {
	var parts []string
	for _, raw := range resultContent {
		c, ok := raw.(*Obj)
		if !ok {
			continue
		}
		switch c.Get("kind") {
		case "text":
			if text, ok := c.Get("data").(string); ok {
				parts = append(parts, text)
			}
		case "json":
			if cData, ok := c.Get("data").(*Obj); ok {
				for _, subRaw := range listField(cData, "content") {
					if sub, ok := subRaw.(*Obj); ok && sub.Get("type") == "text" {
						parts = append(parts, strField(sub, "text"))
					}
				}
			}
		}
	}
	return strings.Join(parts, "\n")
}
