// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Lightweight runtime metrics for STS hot-path observability.

package internal

import "sync/atomic"

type STSMetrics struct {
	GraphTraversals      atomic.Uint64
	GraphTraversalErrors atomic.Uint64
	AuditDropped         atomic.Uint64
	AuditReplayPending   atomic.Uint64
	AuditReplayReplayed  atomic.Uint64
	AuditSinkErrors      atomic.Uint64
	JWKSInvalidKeys      atomic.Uint64
}

type STSMetricsSnapshot struct {
	GraphTraversals      uint64 `json:"graph_traversals"`
	GraphTraversalErrors uint64 `json:"graph_traversal_errors"`
	AuditDropped         uint64 `json:"audit_dropped"`
	AuditReplayPending   uint64 `json:"audit_replay_pending"`
	AuditReplayReplayed  uint64 `json:"audit_replay_replayed"`
	AuditSinkErrors      uint64 `json:"audit_sink_errors"`
	JWKSInvalidKeys      uint64 `json:"jwks_invalid_keys"`
}

func (m *STSMetrics) Snapshot() STSMetricsSnapshot {
	return STSMetricsSnapshot{
		GraphTraversals:      m.GraphTraversals.Load(),
		GraphTraversalErrors: m.GraphTraversalErrors.Load(),
		AuditDropped:         m.AuditDropped.Load(),
		AuditReplayPending:   m.AuditReplayPending.Load(),
		AuditReplayReplayed:  m.AuditReplayReplayed.Load(),
		AuditSinkErrors:      m.AuditSinkErrors.Load(),
		JWKSInvalidKeys:      m.JWKSInvalidKeys.Load(),
	}
}
