// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package livewire serves the GraphQL endpoint: live subscriptions over
// WebSocket (graphql-transport-ws) bridged from Redis pub/sub, and the
// health query over HTTP POST.
package livewire

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"
)

// Subscriber delivers raw payloads published on a channel until stop is
// called. Implementations must close the returned channel on stop.
type Subscriber interface {
	Subscribe(ctx context.Context, channel string) (<-chan []byte, func())
}

// wsMessage is the graphql-transport-ws envelope.
type wsMessage struct {
	ID      string          `json:"id,omitempty"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// subscribePayload is the client's subscribe operation.
type subscribePayload struct {
	Query         string         `json:"query"`
	OperationName string         `json:"operationName"`
	Variables     map[string]any `json:"variables"`
}

// operation is a parsed subscription or query request.
type operation struct {
	Field     string // "sessionUpdated", "reviewUpdated", or "health"
	SessionID string // sessionUpdated filter
	ListingID string // reviewUpdated filter
	ProjectID string // server-validated subscription boundary
}

var inlineArg = regexp.MustCompile(`(?:sessionId|listingId)\s*:\s*"([^"]*)"`)

// parseOperation resolves the requested root field and its filter argument
// from the query text and variables. The schema exposes exactly three
// fields, so full GraphQL parsing is unnecessary.
func parseOperation(p subscribePayload) (operation, bool) {
	q := p.Query
	op := operation{}
	switch {
	case strings.Contains(q, "sessionUpdated"):
		op.Field = "sessionUpdated"
	case strings.Contains(q, "reviewUpdated"):
		op.Field = "reviewUpdated"
	case strings.Contains(q, "health"):
		op.Field = "health"
	default:
		return op, false
	}
	pick := func(names ...string) string {
		for _, n := range names {
			if v, ok := p.Variables[n].(string); ok && v != "" {
				return v
			}
		}
		if m := inlineArg.FindStringSubmatch(q); m != nil {
			return m[1]
		}
		return ""
	}
	if op.Field == "sessionUpdated" {
		op.SessionID = pick("sessionId", "session_id")
	}
	if op.Field == "reviewUpdated" {
		op.ListingID = pick("listingId", "listing_id")
	}
	return op, true
}

// channelFor mirrors the subscription resolvers' channel selection.
func channelFor(op operation) string {
	if op.Field == "sessionUpdated" {
		if op.SessionID != "" {
			return "sessions:" + op.ProjectID + ":" + op.SessionID + ":updated"
		}
		return "sessions:" + op.ProjectID + ":updated"
	}
	return "reviews:" + op.ProjectID + ":updated"
}

// nextPayload renders one published event as the subscription's next
// message data, or nil when the event is filtered out.
func nextPayload(op operation, raw []byte) []byte {
	var event map[string]any
	if err := json.Unmarshal(raw, &event); err != nil {
		return nil
	}
	str := func(k string) string {
		s, _ := event[k].(string)
		return s
	}
	switch op.Field {
	case "sessionUpdated":
		sid := str("session_id")
		if op.SessionID != "" && sid != op.SessionID {
			return nil
		}
		out, _ := json.Marshal(map[string]any{
			"data": map[string]any{
				"sessionUpdated": map[string]string{
					"sessionId": sid,
					"eventName": str("event_name"),
				},
			},
		})
		return out
	case "reviewUpdated":
		lid := str("listing_id")
		if op.ListingID != "" && lid != op.ListingID {
			return nil
		}
		out, _ := json.Marshal(map[string]any{
			"data": map[string]any{
				"reviewUpdated": map[string]string{
					"listingId": lid,
					"action":    str("action"),
				},
			},
		})
		return out
	}
	return nil
}
