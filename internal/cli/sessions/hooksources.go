// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// codexSessionIDRE extracts the trailing UUID from codex rollout filenames.
var codexSessionIDRE = regexp.MustCompile(`([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})$`)

func codexSessionID(path string) string {
	stem := strings.TrimSuffix(filepath.Base(path), ".jsonl")
	if m := codexSessionIDRE.FindStringSubmatch(stem); m != nil {
		return m[1]
	}
	return stem
}

// discoverCodex scans ~/.codex/sessions recursively for rollout JSONL files.
func discoverCodex(home string, sinceHours int) ([]Source, error) {
	root := filepath.Join(homeOr(home), ".codex", "sessions")
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		return []Source{}, nil
	}
	cutoff := time.Now().Add(-time.Duration(sinceHours) * time.Hour)
	sources := []Source{}
	_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(path, ".jsonl") {
			return nil
		}
		if info.ModTime().Before(cutoff) {
			return nil
		}
		sources = append(sources, Source{
			Harness:   "codex",
			SessionID: codexSessionID(path),
			Path:      path,
		})
		return nil
	})
	return sources, nil
}

// copilotSourcesDir is where VS Code Copilot hook events are materialized:
// the hook payload is the only durable record, so the CLI writes it to a
// local JSONL source and drains that file like any other harness transcript.
func copilotSourcesDir(home string) string {
	return filepath.Join(caracalDir(home), "session_sources", "copilot")
}

// discoverCopilotVSCode lists previously materialized VS Code hook sources.
func discoverCopilotVSCode(home string, sinceHours int) ([]Source, error) {
	root := copilotSourcesDir(home)
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		return []Source{}, nil
	}
	cutoff := time.Now().Add(-time.Duration(sinceHours) * time.Hour)
	paths, _ := filepath.Glob(filepath.Join(root, "*.jsonl"))
	sources := []Source{}
	for _, path := range paths {
		if _, ok := withinWindow(path, cutoff); !ok {
			continue
		}
		stem := strings.TrimSuffix(filepath.Base(path), ".jsonl")
		sessionID, err := url.PathUnescape(stem)
		if err != nil {
			sessionID = stem
		}
		sources = append(sources, Source{
			Harness:   "copilot",
			SessionID: sessionID,
			Path:      path,
		})
	}
	return sources, nil
}

// ResolveHookEvent maps a Copilot/VS Code hook payload to its canonical
// event name when the payload does not carry one explicitly.
func ResolveHookEvent(event map[string]any) string {
	if v, ok := event["hookEventName"].(string); ok && v != "" {
		return v
	}
	if v, ok := event["hook_event_name"].(string); ok && v != "" {
		return v
	}
	has := func(keys ...string) bool {
		for _, k := range keys {
			if _, ok := event[k]; ok {
				return true
			}
		}
		return false
	}
	switch {
	case has("source", "initialPrompt", "initial_prompt"):
		return "SessionStart"
	case has("reason"):
		return "Stop"
	case has("prompt"):
		return "UserPromptSubmit"
	case has("toolResult", "tool_result", "tool_response"):
		return "PostToolUse"
	case has("toolName", "tool_name"):
		return "PreToolUse"
	}
	return "UserPromptSubmit"
}

var copilotEventTypes = map[string]string{
	"SessionStart":     "session.start",
	"UserPromptSubmit": "user.message",
	"PreToolUse":       "tool.call",
	"PostToolUse":      "tool.result",
	"Stop":             "session.end",
	"SessionEnd":       "session.end",
}

func eventStr(event map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := event[k]; ok && v != nil {
			if s, isStr := v.(string); isStr {
				return s
			}
			return fmt.Sprint(v)
		}
	}
	return ""
}

// hookEventLine converts one native hook payload into the stable Copilot
// envelope record the session parser classifies.
func hookEventLine(event map[string]any, sessionID string) string {
	hookEvent := ResolveHookEvent(event)
	body := map[string]any{"type": copilotEventTypes[hookEvent]}
	if body["type"] == nil || body["type"] == "" {
		body["type"] = "session.start"
	}
	switch hookEvent {
	case "UserPromptSubmit":
		body["content"] = eventStr(event, "prompt")
	case "PreToolUse":
		body["name"] = eventStr(event, "tool_name", "toolName")
		toolInput, ok := event["tool_input"]
		if !ok {
			toolInput = event["toolArgs"]
		}
		if s, isStr := toolInput.(string); isStr {
			var parsed any
			if json.Unmarshal([]byte(s), &parsed) == nil {
				toolInput = parsed
			} else {
				toolInput = map[string]any{"raw": s}
			}
		}
		if toolInput == nil {
			toolInput = map[string]any{}
		}
		body["input"] = toolInput
	case "PostToolUse":
		body["name"] = eventStr(event, "tool_name", "toolName")
		result, ok := event["tool_response"]
		if !ok {
			if result, ok = event["tool_result"]; !ok {
				result = event["toolResult"]
			}
		}
		if dict, isMap := result.(map[string]any); isMap {
			out := eventStr(dict, "text_result_for_llm", "textResultForLlm")
			if out == "" {
				blob, _ := json.Marshal(dict)
				out = string(blob)
			}
			body["output"] = out
		} else if result == nil {
			body["output"] = ""
		} else {
			body["output"] = fmt.Sprint(result)
		}
	case "SessionStart":
		src := eventStr(event, "source")
		if src == "" {
			src = "new"
		}
		body["source"] = src
	case "Stop", "SessionEnd":
		reason := eventStr(event, "reason", "stop_reason", "stopReason")
		if reason == "" {
			reason = "session_end"
		}
		body["reason"] = reason
	}
	blob, _ := json.Marshal(map[string]any{
		"agentId": sessionID,
		"ts":      eventStr(event, "timestamp"),
		"event":   body,
	})
	return string(blob)
}

// pythonQuote percent-encodes everything outside the unreserved set, the
// same encoding the incumbent used for source filenames.
func pythonQuote(s string) string {
	var out strings.Builder
	for _, b := range []byte(s) {
		if (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z') || (b >= '0' && b <= '9') ||
			b == '_' || b == '.' || b == '-' || b == '~' {
			out.WriteByte(b)
		} else {
			fmt.Fprintf(&out, "%%%02X", b)
		}
	}
	return out.String()
}

// MaterializeCopilotHookEvent durably appends a VS Code hook payload to its
// local session source and returns that source for draining.
func MaterializeCopilotHookEvent(home string, event map[string]any) (Source, bool) {
	sessionID := eventStr(event, "session_id", "sessionId")
	if sessionID == "" {
		return Source{}, false
	}
	dir := copilotSourcesDir(home)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return Source{}, false
	}
	path := filepath.Join(dir, pythonQuote(sessionID)+".jsonl")
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return Source{}, false
	}
	defer func() { _ = f.Close() }()
	if _, err := f.WriteString(hookEventLine(event, sessionID) + "\n"); err != nil {
		return Source{}, false
	}
	_ = f.Sync()
	return Source{Harness: "copilot", SessionID: sessionID, Path: path, CWD: eventStr(event, "cwd")}, true
}
