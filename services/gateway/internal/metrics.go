// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Lightweight runtime metrics for gateway hot-path observability.

package internal

import "sync/atomic"

type GatewayMetrics struct {
	RequestsTotal                atomic.Uint64
	RequestsAllowed              atomic.Uint64
	RequestsDenied               atomic.Uint64
	DenialsMissingAuth           atomic.Uint64
	DenialsBadBearer             atomic.Uint64
	DenialsExpiring              atomic.Uint64
	DenialsBadRouting            atomic.Uint64
	DenialsPathTrav              atomic.Uint64
	DenialsSignature             atomic.Uint64
	DenialsJTIReplay             atomic.Uint64
	DenialsRevoked               atomic.Uint64
	DenialsRevocationStale       atomic.Uint64
	STSExchangeErrors            atomic.Uint64
	STSExchangeLatencyMs         atomic.Uint64
	STSCircuitOpen               atomic.Uint64
	STSCircuitOpened             atomic.Uint64
	STSCircuitFastFail           atomic.Uint64
	UpstreamErrors               atomic.Uint64
	AuditReplayFiles             atomic.Uint64
	AuditReplayBytes             atomic.Uint64
	AuditReplayOldestAge         atomic.Uint64
	AuditDropped                 atomic.Uint64
	AuditSinkErrors              atomic.Uint64
	AuditQueueDepth              atomic.Uint64
	AuditQueueCap                atomic.Uint64
	AuditPersisted               atomic.Uint64
	AuditDrained                 atomic.Uint64
	RevocationsActive            atomic.Uint64
	RevocationSnapshotAgeSeconds atomic.Uint64
	RevocationSnapshotFresh      atomic.Uint64
	RevocationMessages           atomic.Uint64
	RevocationPendingReplayed    atomic.Uint64
	RevocationDeadLetters        atomic.Uint64
	RevocationInvalidSignatures  atomic.Uint64
	RevocationReloads            atomic.Uint64
	RevocationReloadErrors       atomic.Uint64
	RevocationPropagationSeconds atomic.Uint64
}

type GatewayMetricsSnapshot struct {
	RequestsTotal                uint64 `json:"requests_total"`
	RequestsAllowed              uint64 `json:"requests_allowed"`
	RequestsDenied               uint64 `json:"requests_denied"`
	DenialsMissingAuth           uint64 `json:"denials_missing_auth"`
	DenialsBadBearer             uint64 `json:"denials_bad_bearer"`
	DenialsExpiring              uint64 `json:"denials_expiring"`
	DenialsBadRouting            uint64 `json:"denials_bad_routing"`
	DenialsPathTrav              uint64 `json:"denials_path_traversal"`
	DenialsSignature             uint64 `json:"denials_signature"`
	DenialsJTIReplay             uint64 `json:"denials_jti_replay"`
	DenialsRevoked               uint64 `json:"denials_revoked"`
	DenialsRevocationStale       uint64 `json:"denials_revocation_stale"`
	STSExchangeErrors            uint64 `json:"sts_exchange_errors"`
	STSExchangeLatencyMs         uint64 `json:"sts_exchange_latency_ms"`
	STSCircuitOpen               uint64 `json:"sts_circuit_open"`
	STSCircuitOpened             uint64 `json:"sts_circuit_opened"`
	STSCircuitFastFail           uint64 `json:"sts_circuit_fast_fail"`
	UpstreamErrors               uint64 `json:"upstream_errors"`
	AuditReplayFiles             uint64 `json:"audit_replay_files"`
	AuditReplayBytes             uint64 `json:"audit_replay_bytes"`
	AuditReplayOldestAge         uint64 `json:"audit_replay_oldest_age_seconds"`
	AuditDropped                 uint64 `json:"audit_dropped"`
	AuditSinkErrors              uint64 `json:"audit_sink_errors"`
	AuditQueueDepth              uint64 `json:"audit_queue_depth"`
	AuditQueueCap                uint64 `json:"audit_queue_cap"`
	AuditPersisted               uint64 `json:"audit_persisted"`
	AuditDrained                 uint64 `json:"audit_drained"`
	RevocationsActive            uint64 `json:"revocations_active"`
	RevocationSnapshotAgeSeconds uint64 `json:"revocation_snapshot_age_seconds"`
	RevocationSnapshotFresh      uint64 `json:"revocation_snapshot_fresh"`
	RevocationMessages           uint64 `json:"revocation_messages"`
	RevocationPendingReplayed    uint64 `json:"revocation_pending_replayed"`
	RevocationDeadLetters        uint64 `json:"revocation_dead_letters"`
	RevocationInvalidSignatures  uint64 `json:"revocation_invalid_signatures"`
	RevocationReloads            uint64 `json:"revocation_reloads"`
	RevocationReloadErrors       uint64 `json:"revocation_reload_errors"`
	RevocationPropagationSeconds uint64 `json:"revocation_propagation_seconds"`
}

func (m *GatewayMetrics) Snapshot() GatewayMetricsSnapshot {
	return GatewayMetricsSnapshot{
		RequestsTotal:                m.RequestsTotal.Load(),
		RequestsAllowed:              m.RequestsAllowed.Load(),
		RequestsDenied:               m.RequestsDenied.Load(),
		DenialsMissingAuth:           m.DenialsMissingAuth.Load(),
		DenialsBadBearer:             m.DenialsBadBearer.Load(),
		DenialsExpiring:              m.DenialsExpiring.Load(),
		DenialsBadRouting:            m.DenialsBadRouting.Load(),
		DenialsPathTrav:              m.DenialsPathTrav.Load(),
		DenialsSignature:             m.DenialsSignature.Load(),
		DenialsJTIReplay:             m.DenialsJTIReplay.Load(),
		DenialsRevoked:               m.DenialsRevoked.Load(),
		DenialsRevocationStale:       m.DenialsRevocationStale.Load(),
		STSExchangeErrors:            m.STSExchangeErrors.Load(),
		STSExchangeLatencyMs:         m.STSExchangeLatencyMs.Load(),
		STSCircuitOpen:               m.STSCircuitOpen.Load(),
		STSCircuitOpened:             m.STSCircuitOpened.Load(),
		STSCircuitFastFail:           m.STSCircuitFastFail.Load(),
		UpstreamErrors:               m.UpstreamErrors.Load(),
		AuditReplayFiles:             m.AuditReplayFiles.Load(),
		AuditReplayBytes:             m.AuditReplayBytes.Load(),
		AuditReplayOldestAge:         m.AuditReplayOldestAge.Load(),
		AuditDropped:                 m.AuditDropped.Load(),
		AuditSinkErrors:              m.AuditSinkErrors.Load(),
		AuditQueueDepth:              m.AuditQueueDepth.Load(),
		AuditQueueCap:                m.AuditQueueCap.Load(),
		AuditPersisted:               m.AuditPersisted.Load(),
		AuditDrained:                 m.AuditDrained.Load(),
		RevocationsActive:            m.RevocationsActive.Load(),
		RevocationSnapshotAgeSeconds: m.RevocationSnapshotAgeSeconds.Load(),
		RevocationSnapshotFresh:      m.RevocationSnapshotFresh.Load(),
		RevocationMessages:           m.RevocationMessages.Load(),
		RevocationPendingReplayed:    m.RevocationPendingReplayed.Load(),
		RevocationDeadLetters:        m.RevocationDeadLetters.Load(),
		RevocationInvalidSignatures:  m.RevocationInvalidSignatures.Load(),
		RevocationReloads:            m.RevocationReloads.Load(),
		RevocationReloadErrors:       m.RevocationReloadErrors.Load(),
		RevocationPropagationSeconds: m.RevocationPropagationSeconds.Load(),
	}
}
