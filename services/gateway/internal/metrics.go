// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Lightweight runtime metrics for gateway hot-path observability.

package internal

import "sync/atomic"

type GatewayMetrics struct {
	RequestsTotal      atomic.Uint64
	RequestsAllowed    atomic.Uint64
	RequestsDenied     atomic.Uint64
	DenialsMissingAuth atomic.Uint64
	DenialsBadBearer   atomic.Uint64
	DenialsExpiring    atomic.Uint64
	DenialsBadRouting  atomic.Uint64
	DenialsPathTrav    atomic.Uint64
	DenialsSignature   atomic.Uint64
	DenialsJTIReplay   atomic.Uint64
	DenialsRevoked     atomic.Uint64
	DenialsBinding     atomic.Uint64
	STSExchangeErrors  atomic.Uint64
	UpstreamErrors     atomic.Uint64
	BindingsLoaded     atomic.Uint64
	RevocationsActive  atomic.Uint64
}

type GatewayMetricsSnapshot struct {
	RequestsTotal      uint64 `json:"requests_total"`
	RequestsAllowed    uint64 `json:"requests_allowed"`
	RequestsDenied     uint64 `json:"requests_denied"`
	DenialsMissingAuth uint64 `json:"denials_missing_auth"`
	DenialsBadBearer   uint64 `json:"denials_bad_bearer"`
	DenialsExpiring    uint64 `json:"denials_expiring"`
	DenialsBadRouting  uint64 `json:"denials_bad_routing"`
	DenialsPathTrav    uint64 `json:"denials_path_traversal"`
	DenialsSignature   uint64 `json:"denials_signature"`
	DenialsJTIReplay   uint64 `json:"denials_jti_replay"`
	DenialsRevoked     uint64 `json:"denials_revoked"`
	DenialsBinding     uint64 `json:"denials_binding"`
	STSExchangeErrors  uint64 `json:"sts_exchange_errors"`
	UpstreamErrors     uint64 `json:"upstream_errors"`
	BindingsLoaded     uint64 `json:"bindings_loaded"`
	RevocationsActive  uint64 `json:"revocations_active"`
}

func (m *GatewayMetrics) Snapshot() GatewayMetricsSnapshot {
	return GatewayMetricsSnapshot{
		RequestsTotal:      m.RequestsTotal.Load(),
		RequestsAllowed:    m.RequestsAllowed.Load(),
		RequestsDenied:     m.RequestsDenied.Load(),
		DenialsMissingAuth: m.DenialsMissingAuth.Load(),
		DenialsBadBearer:   m.DenialsBadBearer.Load(),
		DenialsExpiring:    m.DenialsExpiring.Load(),
		DenialsBadRouting:  m.DenialsBadRouting.Load(),
		DenialsPathTrav:    m.DenialsPathTrav.Load(),
		DenialsSignature:   m.DenialsSignature.Load(),
		DenialsJTIReplay:   m.DenialsJTIReplay.Load(),
		DenialsRevoked:     m.DenialsRevoked.Load(),
		DenialsBinding:     m.DenialsBinding.Load(),
		STSExchangeErrors:  m.STSExchangeErrors.Load(),
		UpstreamErrors:     m.UpstreamErrors.Load(),
		BindingsLoaded:     m.BindingsLoaded.Load(),
		RevocationsActive:  m.RevocationsActive.Load(),
	}
}
