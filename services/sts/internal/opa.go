// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// OPA policy engine: compiles per-zone policy bundles and evaluates them.

package internal

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/open-policy-agent/opa/ast"
	"github.com/open-policy-agent/opa/rego"
	"github.com/rs/zerolog"
)

const defaultPGPollInterval = 60 * time.Second

// forbiddenBuiltins names Rego built-ins that policies must not use because they
// reach the network, the host clock, or the OPA runtime — any of which would
// give tenant policy authors a side channel out of the STS process.
var forbiddenBuiltins = map[string]struct{}{
	"http.send":           {},
	"net.lookup_ip_addr":  {},
	"net.cidr_contains":   {},
	"net.cidr_intersects": {},
	"net.cidr_expand":     {},
	"opa.runtime":         {},
	"rand.intn":           {},
	"time.now_ns":         {},
}

// safeCapabilities returns the OPA capability set with forbidden built-ins removed.
func safeCapabilities() *ast.Capabilities {
	caps := ast.CapabilitiesForThisVersion()
	filtered := caps.Builtins[:0]
	for _, b := range caps.Builtins {
		if _, blocked := forbiddenBuiltins[b.Name]; blocked {
			continue
		}
		filtered = append(filtered, b)
	}
	caps.Builtins = filtered
	caps.AllowNet = []string{}
	return caps
}

// opaZoneState holds a compiled query and the manifest SHA that produced it.
type opaZoneState struct {
	query              *rego.PreparedEvalQuery
	manifestSHA        string
	policySetVersionID string
	loadedAt           time.Time
}

// OPAEngine maintains one compiled policy per zone, swapped atomically on invalidation.
type OPAEngine struct {
	mu           sync.RWMutex
	zones        map[string]*opaZoneState
	db           DBQuerier
	metrics      OPAMetrics
	log          zerolog.Logger
	pollInterval time.Duration
}

type OPAMetrics struct {
	EvalTotal     atomic.Uint64
	EvalErrors    atomic.Uint64
	EvalNanos     atomic.Uint64
	CompileTotal  atomic.Uint64
	CompileErrors atomic.Uint64
	CompileNanos  atomic.Uint64
}

type OPAMetricsSnapshot struct {
	EvalTotal           uint64  `json:"eval_total"`
	EvalErrors          uint64  `json:"eval_errors"`
	EvalDurationNs      uint64  `json:"eval_duration_ns"`
	CompileTotal        uint64  `json:"compile_total"`
	CompileErrors       uint64  `json:"compile_errors"`
	CompileDurationNs   uint64  `json:"compile_duration_ns"`
	MaxPolicyAgeSeconds float64 `json:"max_policy_age_seconds"`
	PollIntervalSeconds float64 `json:"poll_interval_seconds"`
}

func newOPAEngine(db DBQuerier, log ...zerolog.Logger) *OPAEngine {
	var l zerolog.Logger
	if len(log) > 0 {
		l = log[0]
	} else {
		l = zerolog.Nop()
	}
	return &OPAEngine{
		zones:        make(map[string]*opaZoneState),
		db:           db,
		log:          l,
		pollInterval: defaultPGPollInterval,
	}
}

// SetPollInterval overrides the default 60s PG poll cadence; values <= 0 are ignored.
// Lower this for high-risk zones where revocation latency must be tighter than the
// 60s safety net documented for the Redis pubsub fast path.
func (e *OPAEngine) SetPollInterval(d time.Duration) {
	if d <= 0 {
		return
	}
	e.pollInterval = d
}

// Evaluate evaluates the active policy for the zone in input.Principal.ZoneID.
// Callers must reject any result whose EvaluationStatus is not "complete".
func (e *OPAEngine) Evaluate(ctx context.Context, input OPAInput) (*OPAResult, error) {
	started := time.Now()
	e.metrics.EvalTotal.Add(1)
	defer func() { e.metrics.EvalNanos.Add(uint64(time.Since(started).Nanoseconds())) }()
	e.mu.RLock()
	state, ok := e.zones[input.Principal.ZoneID]
	e.mu.RUnlock()

	if !ok {
		if err := e.loadZone(ctx, input.Principal.ZoneID); err != nil {
			e.metrics.EvalErrors.Add(1)
			return nil, fmt.Errorf("load policy for zone %s: %w", input.Principal.ZoneID, err)
		}
		e.mu.RLock()
		state = e.zones[input.Principal.ZoneID]
		e.mu.RUnlock()
	}

	rs, err := state.query.Eval(ctx, rego.EvalInput(input))
	if err != nil {
		e.metrics.EvalErrors.Add(1)
		return nil, fmt.Errorf("opa eval: %w", err)
	}

	if len(rs) == 0 || len(rs[0].Bindings) == 0 {
		return &OPAResult{Decision: "deny", EvaluationStatus: "complete"}, nil
	}

	raw, err := json.Marshal(rs[0].Bindings["result"])
	if err != nil {
		e.metrics.EvalErrors.Add(1)
		return nil, fmt.Errorf("marshal opa result: %w", err)
	}
	var result OPAResult
	if err := json.Unmarshal(raw, &result); err != nil {
		e.metrics.EvalErrors.Add(1)
		return nil, fmt.Errorf("unmarshal opa result: %w", err)
	}
	return &result, nil
}

// ZoneBundleInfo identifies the policy_set version backing a zone's compiled bundle so
// callers can stamp audit events with the exact manifest used for the decision.
type ZoneBundleInfo struct {
	PolicySetVersionID string
	ManifestSHA        string
}

// BundleInfo returns the manifest SHA and policy_set version ID currently installed
// for a zone, or an empty struct when no bundle is loaded yet.
func (e *OPAEngine) BundleInfo(zoneID string) ZoneBundleInfo {
	e.mu.RLock()
	defer e.mu.RUnlock()
	state, ok := e.zones[zoneID]
	if !ok {
		return ZoneBundleInfo{}
	}
	return ZoneBundleInfo{PolicySetVersionID: state.policySetVersionID, ManifestSHA: state.manifestSHA}
}

// MetricsSnapshot returns a point-in-time copy of OPA evaluation and compilation counters.
func (e *OPAEngine) MetricsSnapshot() OPAMetricsSnapshot {
	var maxAge time.Duration
	now := time.Now()
	e.mu.RLock()
	for _, state := range e.zones {
		if state.loadedAt.IsZero() {
			continue
		}
		if age := now.Sub(state.loadedAt); age > maxAge {
			maxAge = age
		}
	}
	e.mu.RUnlock()
	return OPAMetricsSnapshot{
		EvalTotal:           e.metrics.EvalTotal.Load(),
		EvalErrors:          e.metrics.EvalErrors.Load(),
		EvalDurationNs:      e.metrics.EvalNanos.Load(),
		CompileTotal:        e.metrics.CompileTotal.Load(),
		CompileErrors:       e.metrics.CompileErrors.Load(),
		CompileDurationNs:   e.metrics.CompileNanos.Load(),
		MaxPolicyAgeSeconds: maxAge.Seconds(),
		PollIntervalSeconds: e.pollInterval.Seconds(),
	}
}

// Reload replaces the compiled policy for zoneID with the current active bundle.
func (e *OPAEngine) Reload(ctx context.Context, zoneID string) error {
	return e.loadZone(ctx, zoneID)
}

// SeedZones compiles a bundle for every zone with an active policy_set_binding so the
// engine is hot before the first token-exchange request and so PG polling has zones to
// refresh. Errors here are logged-only via the caller; STS must come up even when a
// single zone fails to compile because deny-all is installed in its place.
func (e *OPAEngine) SeedZones(ctx context.Context) {
	if e.db == nil {
		return
	}
	zones, err := e.db.ListBoundZoneIDs(ctx)
	if err != nil {
		e.log.Error().Err(err).Msg("opa seed: list bound zones")
		return
	}
	for _, z := range zones {
		if err := e.loadZone(ctx, z); err != nil {
			e.log.Error().Err(err).Str("zone", z).Msg("opa seed: load zone")
		}
	}
}

// StartPGPolling polls PostgreSQL on the configured cadence (default 60s) for policy
// changes on all known zones. This is the safety net when Redis pubsub silently drops
// invalidation messages; the engine's revocation SLA is therefore bounded by this
// interval. Tighten via SetPollInterval for high-risk zones.
func (e *OPAEngine) StartPGPolling(ctx context.Context) {
	ticker := time.NewTicker(e.pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			e.mu.RLock()
			zones := make([]string, 0, len(e.zones))
			for id := range e.zones {
				zones = append(zones, id)
			}
			e.mu.RUnlock()
			for _, zoneID := range zones {
				if err := e.loadZone(ctx, zoneID); err != nil {
					e.log.Error().Err(err).Str("zone", zoneID).Msg("opa pg poll: reload zone")
				}
			}
		case <-ctx.Done():
			return
		}
	}
}

func (e *OPAEngine) loadZone(ctx context.Context, zoneID string) error {
	binding, err := e.db.GetActivePolicySetBinding(ctx, zoneID)
	if err != nil {
		// pgx.ErrNoRows == no policy bound for this zone → install fail-closed deny-all.
		// Any other error is transient: keep the previously cached bundle so a flaky
		// database does not cause STS to self-DoS legitimate traffic.
		if errors.Is(err, pgx.ErrNoRows) {
			e.storeFallback(zoneID)
			return nil
		}
		e.mu.RLock()
		_, cached := e.zones[zoneID]
		e.mu.RUnlock()
		if cached {
			return nil
		}
		e.storeFallback(zoneID)
		return err
	}
	if binding == nil || binding.ActiveVersionID == nil {
		e.storeFallback(zoneID)
		return nil
	}

	psv, err := e.db.GetPolicySetVersion(ctx, *binding.ActiveVersionID)
	if err != nil {
		e.mu.RLock()
		_, cached := e.zones[zoneID]
		e.mu.RUnlock()
		if cached {
			return nil
		}
		e.storeFallback(zoneID)
		return err
	}

	e.mu.RLock()
	if cur, ok := e.zones[zoneID]; ok && cur.manifestSHA == psv.ManifestSHA256 {
		e.mu.RUnlock()
		return nil
	}
	e.mu.RUnlock()

	var manifest []struct {
		PolicyVersionID string `json:"policy_version_id"`
	}
	if err := json.Unmarshal(psv.ManifestJSON, &manifest); err != nil {
		return err
	}

	ids := make([]string, len(manifest))
	for i, m := range manifest {
		ids[i] = m.PolicyVersionID
	}
	versions, err := e.db.GetPolicyVersionsByIDs(ctx, ids)
	if err != nil {
		return err
	}

	modules := make([]func(*rego.Rego), 0, len(versions)+2)
	for _, v := range versions {
		modules = append(modules, rego.Module(v.ID+".rego", v.Content))
	}
	modules = append(modules, rego.Query("result = data.caracal.authz.result"))
	modules = append(modules, rego.Capabilities(safeCapabilities()))

	started := time.Now()
	e.metrics.CompileTotal.Add(1)
	pq, err := rego.New(modules...).PrepareForEval(ctx)
	e.metrics.CompileNanos.Add(uint64(time.Since(started).Nanoseconds()))
	if err != nil {
		e.metrics.CompileErrors.Add(1)
		return fmt.Errorf("compile policy bundle for zone %s: %w", zoneID, err)
	}

	e.mu.Lock()
	e.zones[zoneID] = &opaZoneState{query: &pq, manifestSHA: psv.ManifestSHA256, policySetVersionID: psv.ID, loadedAt: time.Now()}
	e.mu.Unlock()
	return nil
}

// denyAllPolicy is the deny-all fallback when no policy is active.
const denyAllPolicy = `
package caracal.authz
result := {"decision": "deny", "evaluation_status": "complete", "determining_policies": [], "diagnostics": [{"reason": "no_active_policy_set"}]}
`

func (e *OPAEngine) storeFallback(zoneID string) {
	pq, err := rego.New(
		rego.Module("fallback.rego", denyAllPolicy),
		rego.Query("result = data.caracal.authz.result"),
		rego.Capabilities(safeCapabilities()),
	).PrepareForEval(context.Background())
	if err != nil {
		return
	}
	e.mu.Lock()
	e.zones[zoneID] = &opaZoneState{query: &pq, manifestSHA: "no_active_policy_set", loadedAt: time.Now()}
	e.mu.Unlock()
}
