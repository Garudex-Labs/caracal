// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package traceview turns stored session rows into the normalized event
// stream the frontend trace viewer renders. One parser per transcript
// format, dispatched strictly through the harness registry so unknown
// harnesses fail loudly instead of falling through to a wrong parser.
package traceview

import (
	"fmt"

	"github.com/garudex-labs/caracal/internal/harness"
)

// Row is one stored session_events row, as the read path sees it.
type Row struct {
	Harness        string  `json:"harness"`
	EventType      string  `json:"event_type"`
	Timestamp      string  `json:"timestamp"`
	IngestedAt     string  `json:"ingested_at"`
	UUID           *string `json:"uuid"`
	ParentUUID     *string `json:"parent_uuid"`
	ToolName       *string `json:"tool_name"`
	ToolID         *string `json:"tool_id"`
	ContentPreview string  `json:"content_preview"`
	ContentLength  int64   `json:"content_length"`
	RawLine        string  `json:"raw_line"`
	Credits        float64 `json:"credits"`
}

// Event is one frontend trace event.
type Event struct {
	Timestamp   string         `json:"timestamp"`
	EventName   string         `json:"event_name"`
	Body        string         `json:"body"`
	Attributes  map[string]any `json:"attributes"`
	ServiceName string         `json:"service_name"`
}

// parseFn expands stored rows into frontend events.
type parseFn func(rows []Row) []*Event

// parsers maps a session parser id to its implementation.
var parsers = map[string]parseFn{
	"claude-code": parseClaudeCode,
	"codex":       parseCodex,
	"copilot-cli": parseCopilotCLI,
	"cursor":      parseCursor,
	"goose":       parseGoose,
	"kiro":        parseKiro,
	"opencode":    parseOpenCode,
	"pi":          parsePi,
	"antigravity": parseAntigravity,
}

// Parse expands stored rows into normalized frontend events, dispatching on
// the first row's harness through the registry. Unknown harnesses and
// unimplemented parsers are errors.
func Parse(registry *harness.Registry, rows []Row) ([]*Event, error) {
	if len(rows) == 0 {
		return []*Event{}, nil
	}
	parserID, err := registry.SessionParserID(rows[0].Harness)
	if err != nil {
		return nil, err
	}
	if parserID == "" {
		return []*Event{}, nil
	}
	parser, ok := parsers[parserID]
	if !ok {
		return nil, fmt.Errorf("traceview: no parser registered for %q", parserID)
	}
	return parser(rows), nil
}

// basicEvent builds a minimal event from stored columns when raw_line is
// unusable.
func basicEvent(row Row) *Event {
	attributes := map[string]any{
		"tool_name":      orEmpty(row.ToolName),
		"tool_id":        orEmpty(row.ToolID),
		"uuid":           orEmpty(row.UUID),
		"parent_uuid":    orEmpty(row.ParentUUID),
		"content_length": fmt.Sprintf("%d", row.ContentLength),
	}
	if row.Credits != 0 {
		attributes["credits"] = floatString(row.Credits)
	}
	return &Event{
		Timestamp:   row.Timestamp,
		EventName:   row.EventType,
		Body:        row.ContentPreview,
		Attributes:  attributes,
		ServiceName: row.Harness,
	}
}

func orEmpty(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// event is the common constructor used across parsers.
func event(ts, harness, name, body string, bodyLimit int, attributes map[string]any) *Event {
	return &Event{
		Timestamp:   ts,
		EventName:   name,
		Body:        truncChars(body, bodyLimit),
		Attributes:  attributes,
		ServiceName: harness,
	}
}
