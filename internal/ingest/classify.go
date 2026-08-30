// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package ingest classifies raw harness transcript lines into session-event
// rows for ClickHouse.
//
// Classification behavior is pinned by the golden fixtures in
// contracts/session-goldens: every service that ingests transcripts must
// produce identical rows for the same input, so any change here must be
// reflected in re-recorded fixtures. Malformed blocks inside a line degrade
// that block only, never the whole preview.
package ingest

import (
	"fmt"

	"github.com/garudex-labs/caracal/internal/harness"
)

// classifier bundles the per-format line functions, keyed by the registry's
// session_parser id.
type classifier struct {
	// classify returns the event type, or ok=false to skip the line.
	classify func(m map[string]any) (eventType string, ok bool)
	// preview returns a display string, at most previewMax runes.
	preview func(m map[string]any, eventType string) string
	// toolInfo returns the tool name and id, nil when absent.
	toolInfo func(m map[string]any) (name, id *string)
	// timestamp returns a ClickHouse timestamp string, "" when the line has none.
	timestamp func(m map[string]any) string
}

var classifiers = map[string]classifier{
	"claude-code": {classifyClaudeCode, previewClaudeCode, toolInfoClaudeCode, tsISOField("timestamp")},
	"codex":       {classifyCodex, previewCodex, toolInfoCodex, tsISOField("timestamp")},
	"copilot-cli": {classifyCopilotCLI, previewCopilotCLI, toolInfoCopilotCLI, tsCopilotCLI},
	"kiro":        {classifyKiro, previewKiro, toolInfoKiro, tsKiro},
	"cursor":      {classifyCursor, previewCursor, toolInfoClaudeCode, tsNone},
	"goose":       {classifyGoose, previewGoose, toolInfoGoose, tsISOField("timestamp")},
	"opencode":    {classifyClaudeCode, previewClaudeCode, toolInfoClaudeCode, tsISOField("timestamp")},
	"pi":          {classifyPi, previewPi, toolInfoPi, tsISOField("timestamp")},
	"antigravity": {classifyAntigravity, previewAntigravity, toolInfoAntigravity, tsISOField("created_at")},
}

// classifierFor resolves the classifier for a harness via the shared registry.
// Unknown harnesses or harnesses without a session parser are errors: ingest
// must never guess a format.
func classifierFor(reg *harness.Registry, harnessName string) (classifier, error) {
	parserID, err := reg.SessionParserID(harnessName)
	if err != nil {
		return classifier{}, err
	}
	c, ok := classifiers[parserID]
	if !ok {
		return classifier{}, fmt.Errorf("no classifier implemented for session parser %q", parserID)
	}
	return c, nil
}

// tsISOField builds the common timestamp extractor over one ISO-8601 field.
func tsISOField(key string) func(map[string]any) string {
	return func(m map[string]any) string {
		return isoToClickHouse(m[key])
	}
}

// tsNone is for formats without embedded timestamps (Cursor): the caller
// falls back to ingestion time.
func tsNone(map[string]any) string { return "" }
