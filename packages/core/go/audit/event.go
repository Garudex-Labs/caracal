// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Canonical Caracal audit event payload published on caracal.audit.events.

package audit

import (
	"encoding/json"
	"strings"
	"time"
)

// Event is the wire-format audit record produced by STS and consumed by the
// audit service. JSON tags define the on-the-wire contract; do not rename.
type Event struct {
	ID                      string          `json:"id"`
	ZoneID                  string          `json:"zone_id"`
	EventType               string          `json:"event_type"`
	RequestID               string          `json:"request_id"`
	Decision                string          `json:"decision"`
	PolicySetID             string          `json:"policy_set_id,omitempty"`
	PolicySetVersionID      string          `json:"policy_set_version_id,omitempty"`
	ManifestSHA             string          `json:"manifest_sha,omitempty"`
	EvaluationStatus        string          `json:"evaluation_status"`
	DeterminingPoliciesJSON json.RawMessage `json:"determining_policies_json"`
	DiagnosticsJSON         json.RawMessage `json:"diagnostics_json"`
	MetadataJSON            json.RawMessage `json:"metadata_json,omitempty"`
	OccurredAt              time.Time       `json:"occurred_at"`
}

// IsDeny returns true for any case-insensitive variant of "deny".
func (e Event) IsDeny() bool {
	return strings.EqualFold(e.Decision, "deny")
}
