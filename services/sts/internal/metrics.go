// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Lightweight runtime metrics for STS hot-path observability.

package internal

import "sync/atomic"

type STSMetrics struct {
	GraphTraversals       atomic.Uint64
	GraphTraversalErrors  atomic.Uint64
	AuditDropped          atomic.Uint64
	AuditReplayPending    atomic.Uint64
	AuditReplayFiles      atomic.Uint64
	AuditReplayBytes      atomic.Uint64
	AuditReplayOldestAge  atomic.Uint64
	AuditReplayReplayed   atomic.Uint64
	AuditSinkErrors       atomic.Uint64
	JWKSInvalidKeys       atomic.Uint64
	ProviderRefreshShared atomic.Uint64
	ProviderRefreshLeased atomic.Uint64
	ProviderRefreshWaited atomic.Uint64
	ProviderRefreshErrors atomic.Uint64
	ProviderCircuitOpen   atomic.Uint64
	SecretBackendReads    atomic.Uint64
	SecretBackendErrors   atomic.Uint64
}

type STSMetricsSnapshot struct {
	GraphTraversals       uint64 `json:"graph_traversals"`
	GraphTraversalErrors  uint64 `json:"graph_traversal_errors"`
	AuditDropped          uint64 `json:"audit_dropped"`
	AuditReplayPending    uint64 `json:"audit_replay_pending"`
	AuditReplayFiles      uint64 `json:"audit_replay_files"`
	AuditReplayBytes      uint64 `json:"audit_replay_bytes"`
	AuditReplayOldestAge  uint64 `json:"audit_replay_oldest_age_seconds"`
	AuditReplayReplayed   uint64 `json:"audit_replay_replayed"`
	AuditSinkErrors       uint64 `json:"audit_sink_errors"`
	JWKSInvalidKeys       uint64 `json:"jwks_invalid_keys"`
	ProviderRefreshShared uint64 `json:"provider_refresh_shared"`
	ProviderRefreshLeased uint64 `json:"provider_refresh_leased"`
	ProviderRefreshWaited uint64 `json:"provider_refresh_waited"`
	ProviderRefreshErrors uint64 `json:"provider_refresh_errors"`
	ProviderCircuitOpen   uint64 `json:"provider_circuit_open"`
	SecretBackendReads    uint64 `json:"secret_backend_reads"`
	SecretBackendErrors   uint64 `json:"secret_backend_errors"`
}

func (m *STSMetrics) Snapshot() STSMetricsSnapshot {
	return STSMetricsSnapshot{
		GraphTraversals:       m.GraphTraversals.Load(),
		GraphTraversalErrors:  m.GraphTraversalErrors.Load(),
		AuditDropped:          m.AuditDropped.Load(),
		AuditReplayPending:    m.AuditReplayPending.Load(),
		AuditReplayFiles:      m.AuditReplayFiles.Load(),
		AuditReplayBytes:      m.AuditReplayBytes.Load(),
		AuditReplayOldestAge:  m.AuditReplayOldestAge.Load(),
		AuditReplayReplayed:   m.AuditReplayReplayed.Load(),
		AuditSinkErrors:       m.AuditSinkErrors.Load(),
		JWKSInvalidKeys:       m.JWKSInvalidKeys.Load(),
		ProviderRefreshShared: m.ProviderRefreshShared.Load(),
		ProviderRefreshLeased: m.ProviderRefreshLeased.Load(),
		ProviderRefreshWaited: m.ProviderRefreshWaited.Load(),
		ProviderRefreshErrors: m.ProviderRefreshErrors.Load(),
		ProviderCircuitOpen:   m.ProviderCircuitOpen.Load(),
		SecretBackendReads:    m.SecretBackendReads.Load(),
		SecretBackendErrors:   m.SecretBackendErrors.Load(),
	}
}
