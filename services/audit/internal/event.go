// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// OCSF v1.7.0 Authorization Activity mapping for Caracal audit events.

package internal

import (
	"encoding/json"

	"github.com/garudex-labs/caracal/core/audit"
)

// AuditEvent is the wire payload emitted by STS to caracal.audit.events.
// Aliased from the canonical definition in core/audit so STS and the audit
// service share a single source of truth.
type AuditEvent = audit.Event

// OCSFEvent is the OCSF v1.7.0 Authorization Activity (class_uid 6003) shape for Parquet.
// Forensic fields beyond the OCSF base set ride alongside to preserve archive fidelity.
type OCSFEvent struct {
	ClassUID           int32  `parquet:"class_uid"`
	TypeUID            int32  `parquet:"type_uid"`
	SeverityID         int32  `parquet:"severity_id"`
	ActivityID         int32  `parquet:"activity_id"`
	Time               int64  `parquet:"time"`
	ZoneID             string `parquet:"zone_id"`
	RequestID          string `parquet:"request_id"`
	PolicySetVersionID string `parquet:"policy_set_version_id"`
	Decision           string `parquet:"decision"`
	MetadataVersion    string `parquet:"metadata_version"`
	ProductName        string `parquet:"product_name"`

	EventID             string `parquet:"event_id"`
	EventType           string `parquet:"event_type"`
	PolicySetID         string `parquet:"policy_set_id"`
	ManifestSHA         string `parquet:"manifest_sha"`
	EvaluationStatus    string `parquet:"evaluation_status"`
	DeterminingPolicies string `parquet:"determining_policies_json"`
	Diagnostics         string `parquet:"diagnostics_json"`
	Metadata            string `parquet:"metadata_json"`
	ContentSHA256       string `parquet:"content_sha256"`
	ChainHMAC           string `parquet:"chain_hmac"`
	ChainSeq            int64  `parquet:"chain_seq"`
}

func toOCSF(e AuditEvent, contentSHA, chainHMAC string, chainSeq int64) OCSFEvent {
	severityID := int32(1)
	activityID := int32(1)
	if e.IsDeny() {
		severityID = 2
		activityID = 2
	}
	return OCSFEvent{
		ClassUID:           6003,
		TypeUID:            600301,
		SeverityID:         severityID,
		ActivityID:         activityID,
		Time:               e.OccurredAt.UnixMilli(),
		ZoneID:             e.ZoneID,
		RequestID:          e.RequestID,
		PolicySetVersionID: e.PolicySetVersionID,
		Decision:           e.Decision,
		MetadataVersion:    "1.7.0",
		ProductName:        "caracal",

		EventID:             e.ID,
		EventType:           e.EventType,
		PolicySetID:         e.PolicySetID,
		ManifestSHA:         e.ManifestSHA,
		EvaluationStatus:    e.EvaluationStatus,
		DeterminingPolicies: rawString(e.DeterminingPoliciesJSON),
		Diagnostics:         rawString(e.DiagnosticsJSON),
		Metadata:            rawString(e.MetadataJSON),
		ContentSHA256:       contentSHA,
		ChainHMAC:           chainHMAC,
		ChainSeq:            chainSeq,
	}
}

func rawString(r json.RawMessage) string {
	if len(r) == 0 {
		return ""
	}
	return string(r)
}
