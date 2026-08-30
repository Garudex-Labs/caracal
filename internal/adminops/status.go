// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package adminops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/garudex-labs/caracal/internal/httpapi"
)

// System status aggregation: the authoritative operational health model.
//
// Every dependency the API can meaningfully verify is probed concurrently
// with a hard per-check timeout, so one hung dependency can never take the
// status endpoint down with it. Results carry an explicit four-state model:
//
//   - healthy  - the check succeeded within budget
//   - degraded - reachable but impaired (slow, backlogged, misconfigured)
//   - critical - unavailable and required for core functionality
//   - unknown  - the check could not run; never presented as healthy
//
// Failure details are reduced to error type names - never connection
// strings, tokens, or driver error bodies.

// checkTimeout is the hard budget for any single dependency probe.
const checkTimeout = 2500 * time.Millisecond

// statusCacheTTL is how long an aggregate result is served before re-probing.
const statusCacheTTL = 5 * time.Second

// slowThresholdMS marks a healthy dependency answering slower than this
// as degraded.
const slowThresholdMS = 1000

// processStart anchors the uptime figure on the status document.
var processStart = time.Now()

var statusOrder = map[string]int{"healthy": 0, "unknown": 1, "degraded": 2, "critical": 3}

// statusFloat renders with a decimal point even when integral ("5.0").
type statusFloat float64

func (f statusFloat) MarshalJSON() ([]byte, error) {
	s := strconv.FormatFloat(float64(f), 'f', -1, 64)
	if !strings.ContainsAny(s, ".eE") {
		s += ".0"
	}
	return []byte(s), nil
}

// roundMS rounds a millisecond latency to one decimal, ties to even.
func roundMS(d time.Duration) statusFloat {
	ms := float64(d) / float64(time.Millisecond)
	return statusFloat(math.RoundToEven(ms*10) / 10)
}

func nowStatusISO() string {
	t := time.Now().UTC()
	if t.Nanosecond() == 0 {
		return t.Format("2006-01-02T15:04:05+00:00")
	}
	return t.Format("2006-01-02T15:04:05.000000+00:00")
}

type componentStatus struct {
	ID        string         `json:"id"`
	Name      string         `json:"name"`
	Purpose   string         `json:"purpose"`
	Status    string         `json:"status"`
	LatencyMS *statusFloat   `json:"latency_ms"`
	Detail    *string        `json:"detail"`
	Metrics   map[string]any `json:"metrics"`
	CheckedAt string         `json:"checked_at"`
}

type statusDocument struct {
	Overall            string            `json:"overall"`
	CheckedAt          string            `json:"checked_at"`
	CacheTTLSeconds    statusFloat       `json:"cache_ttl_seconds"`
	Version            string            `json:"version"`
	UptimeSeconds      int64             `json:"uptime_seconds"`
	DegradedComponents []string          `json:"degraded_components"`
	FailingComponents  []string          `json:"failing_components"`
	Components         []componentStatus `json:"components"`
}

type probeMeta struct {
	id, name, purpose string
	// failureStatus is the state reported when the probe cannot run.
	failureStatus string
}

var probeMetas = []probeMeta{
	{"database", "PostgreSQL", "Registry data: users, organizations, projects, agents, components", "critical"},
	{"identity", "Identity service", "Sign-in, sessions, and JWT signing keys (Better Auth)", "critical"},
	{"clickhouse", "ClickHouse", "Session events, telemetry, audit and security event storage", "degraded"},
	{"redis", "Redis", "Background job queue, settings cache, token revocation, live updates", "critical"},
	{"runtime_config", "Runtime configuration", "Deployment settings this instance boots with", "unknown"},
}

// probeError carries a stable failure name for the status detail line.
type probeError struct{ name string }

func (e probeError) Error() string { return e.name }

// safeErrorDetail reduces a probe failure to its error type name so driver
// messages carrying hosts or credentials never reach the wire.
func safeErrorDetail(err error) string {
	var named probeError
	if errors.As(err, &named) {
		return named.name + " during health probe"
	}
	name := strings.TrimPrefix(fmt.Sprintf("%T", err), "*")
	return name + " during health probe"
}

func strPtr(s string) *string { return &s }

func (h *Handler) probeDatabase(ctx context.Context, meta probeMeta) (componentStatus, error) {
	started := time.Now()
	var one int
	if err := h.DB.QueryRow(ctx, "SELECT 1").Scan(&one); err != nil {
		return componentStatus{}, err
	}
	latency := roundMS(time.Since(started))
	var userCount int64
	if err := h.DB.QueryRow(ctx, "SELECT count(*) FROM users").Scan(&userCount); err != nil {
		return componentStatus{}, err
	}
	c := componentStatus{
		ID: meta.id, Name: meta.name, Purpose: meta.purpose,
		Status:    "healthy",
		LatencyMS: &latency,
		Metrics:   map[string]any{"users": userCount},
	}
	if float64(latency) > slowThresholdMS {
		c.Status = "degraded"
		c.Detail = strPtr("Responding slowly")
	}
	return c, nil
}

func (h *Handler) probeIdentity(ctx context.Context, meta probeMeta) (componentStatus, error) {
	client := h.HTTP
	if client == nil {
		client = &http.Client{Timeout: checkTimeout}
	}
	started := time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.JWKSURL, nil)
	if err != nil {
		return componentStatus{}, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return componentStatus{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 400 {
		return componentStatus{}, probeError{"HTTPStatusError"}
	}
	var doc struct {
		Keys []json.RawMessage `json:"keys"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		return componentStatus{}, err
	}
	latency := roundMS(time.Since(started))
	if len(doc.Keys) == 0 {
		return componentStatus{
			ID: meta.id, Name: meta.name, Purpose: meta.purpose,
			Status:    "critical",
			LatencyMS: &latency,
			Detail:    strPtr("JWKS reachable but publishes no signing keys; token verification will fail"),
			Metrics:   map[string]any{"jwks_keys": 0},
		}, nil
	}
	c := componentStatus{
		ID: meta.id, Name: meta.name, Purpose: meta.purpose,
		Status:    "healthy",
		LatencyMS: &latency,
		Metrics:   map[string]any{"jwks_keys": len(doc.Keys)},
	}
	if float64(latency) > slowThresholdMS {
		c.Status = "degraded"
		c.Detail = strPtr("Responding slowly")
	}
	return c, nil
}

func (h *Handler) probeClickhouse(ctx context.Context, meta probeMeta) (componentStatus, error) {
	started := time.Now()
	err := h.CH.Exec(ctx, "SELECT 1", nil)
	latency := roundMS(time.Since(started))
	if err != nil {
		if ctx.Err() != nil {
			return componentStatus{}, ctx.Err()
		}
		return componentStatus{
			ID: meta.id, Name: meta.name, Purpose: meta.purpose,
			Status:    "degraded",
			LatencyMS: &latency,
			Detail:    strPtr("Unreachable; traces, telemetry, and audit queries are unavailable"),
			Metrics:   map[string]any{},
		}, nil
	}
	c := componentStatus{
		ID: meta.id, Name: meta.name, Purpose: meta.purpose,
		Status:    "healthy",
		LatencyMS: &latency,
		Metrics:   map[string]any{},
	}
	if float64(latency) > slowThresholdMS {
		c.Status = "degraded"
		c.Detail = strPtr("Responding slowly")
	}
	return c, nil
}

func (h *Handler) probeRedis(ctx context.Context, meta probeMeta) (componentStatus, error) {
	started := time.Now()
	err := h.Redis.Ping(ctx).Err()
	latency := roundMS(time.Since(started))
	if err != nil {
		if ctx.Err() != nil {
			return componentStatus{}, ctx.Err()
		}
		return componentStatus{
			ID: meta.id, Name: meta.name, Purpose: meta.purpose,
			Status:    "critical",
			LatencyMS: &latency,
			Detail:    strPtr("Unreachable; authentication fails closed and background jobs stop"),
			Metrics:   map[string]any{},
		}, nil
	}
	c := componentStatus{
		ID: meta.id, Name: meta.name, Purpose: meta.purpose,
		Status:    "healthy",
		LatencyMS: &latency,
		Metrics:   map[string]any{},
	}
	if float64(latency) > slowThresholdMS {
		c.Status = "degraded"
		c.Detail = strPtr("Responding slowly")
	}
	return c, nil
}

// probeWorkerQueue was retired with the standalone worker: background jobs
// (insight generation and its schedulers) now run in the server process, so
// their liveness is covered by the server responding at all.

func (h *Handler) probeRuntimeConfig(ctx context.Context, meta probeMeta) (componentStatus, error) {
	issues := []string{}
	if h.RawSecret == "change-me-to-a-random-string" {
		issues = append(issues, "SECRET_KEY is using default value")
	}
	if h.AuthInternalSecret == "" {
		issues = append(issues, "AUTH_INTERNAL_SECRET is not set (required for the identity-service bridge)")
	}
	frontendURL := strings.TrimSpace(h.Settings.String(ctx, "deployment.frontend_url", "http://localhost:8000"))
	if frontendURL == "" {
		issues = append(issues, "deployment.frontend_url is empty")
	} else if !h.Development && isLoopbackURL(frontendURL) {
		issues = append(issues, "deployment.frontend_url uses a loopback host outside development")
	}
	if len(issues) > 0 {
		return componentStatus{
			ID: meta.id, Name: meta.name, Purpose: meta.purpose,
			Status:  "degraded",
			Detail:  strPtr(fmt.Sprintf("%d configuration issue(s) need attention", len(issues))),
			Metrics: map[string]any{"issues": issues},
		}, nil
	}
	return componentStatus{
		ID: meta.id, Name: meta.name, Purpose: meta.purpose,
		Status:  "healthy",
		Metrics: map[string]any{},
	}, nil
}

func isLoopbackURL(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil {
		return false
	}
	host := parsed.Hostname()
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

type probeFunc func(context.Context, probeMeta) (componentStatus, error)

func (h *Handler) probes() []probeFunc {
	return []probeFunc{
		h.probeDatabase,
		h.probeIdentity,
		h.probeClickhouse,
		h.probeRedis,
		h.probeRuntimeConfig,
	}
}

// runCheck applies the probe budget and folds timeouts and failures into
// the four-state model; a probe error never escapes as a 500.
func runCheck(ctx context.Context, probe probeFunc, meta probeMeta) componentStatus {
	probeCtx, cancel := context.WithTimeout(ctx, checkTimeout)
	defer cancel()
	started := time.Now()
	result, err := probe(probeCtx, meta)
	if err == nil {
		result.CheckedAt = nowStatusISO()
		return result
	}
	latency := roundMS(time.Since(started))
	if errors.Is(err, context.DeadlineExceeded) {
		status := meta.failureStatus
		if status == "unknown" {
			status = "degraded"
		}
		return componentStatus{
			ID: meta.id, Name: meta.name, Purpose: meta.purpose,
			Status:    status,
			LatencyMS: &latency,
			Detail:    strPtr(fmt.Sprintf("Health probe timed out after %gs", checkTimeout.Seconds())),
			Metrics:   map[string]any{},
			CheckedAt: nowStatusISO(),
		}
	}
	return componentStatus{
		ID: meta.id, Name: meta.name, Purpose: meta.purpose,
		Status:    meta.failureStatus,
		LatencyMS: &latency,
		Detail:    strPtr(safeErrorDetail(err)),
		Metrics:   map[string]any{},
		CheckedAt: nowStatusISO(),
	}
}

// overallStatus folds component states into the aggregate: any critical
// component is critical, and an unknown component is never presented as a
// healthy system.
func overallStatus(components []componentStatus) string {
	worst := 0
	for _, c := range components {
		rank, ok := statusOrder[c.Status]
		if !ok {
			rank = 1
		}
		if rank > worst {
			worst = rank
		}
	}
	switch {
	case worst >= statusOrder["critical"]:
		return "critical"
	case worst >= statusOrder["unknown"]:
		return "degraded"
	default:
		return "healthy"
	}
}

func buildStatusDocument(components []componentStatus, version string) *statusDocument {
	degraded := []string{}
	failing := []string{}
	for _, c := range components {
		switch c.Status {
		case "degraded", "unknown":
			degraded = append(degraded, c.ID)
		case "critical":
			failing = append(failing, c.ID)
		}
	}
	return &statusDocument{
		Overall:            overallStatus(components),
		CheckedAt:          nowStatusISO(),
		CacheTTLSeconds:    statusFloat(statusCacheTTL.Seconds()),
		Version:            version,
		UptimeSeconds:      int64(time.Since(processStart).Seconds()),
		DegradedComponents: degraded,
		FailingComponents:  failing,
		Components:         components,
	}
}

// systemStatus serves the aggregated status document for the status page
// and CLI.
func (h *Handler) systemStatus(w http.ResponseWriter, r *http.Request) {
	force, ok := statusBoolParam(w, r.URL.Query(), "force")
	if !ok {
		return
	}
	h.statusMu.Lock()
	defer h.statusMu.Unlock()
	if !force && h.statusDoc != nil && time.Since(h.statusAt) < statusCacheTTL {
		httpapi.WriteJSON(w, http.StatusOK, h.statusDoc)
		return
	}

	probes := h.probes()
	components := make([]componentStatus, len(probes))
	done := make(chan struct{})
	for i, probe := range probes {
		go func(i int, probe probeFunc, meta probeMeta) {
			components[i] = runCheck(r.Context(), probe, meta)
			done <- struct{}{}
		}(i, probe, probeMetas[i])
	}
	for range probes {
		<-done
	}

	h.statusDoc = buildStatusDocument(components, h.Version)
	h.statusAt = time.Now()
	httpapi.WriteJSON(w, http.StatusOK, h.statusDoc)
}

// statusBoolParam parses an optional boolean query parameter, answering the
// validation contract on garbage input.
func statusBoolParam(w http.ResponseWriter, q url.Values, name string) (value, ok bool) {
	raw := q.Get(name)
	if raw == "" && !q.Has(name) {
		return false, true
	}
	switch strings.ToLower(raw) {
	case "true", "yes", "on", "1", "t", "y":
		return true, true
	case "false", "no", "off", "0", "f", "n":
		return false, true
	}
	httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, []map[string]any{{
		"type": "bool_parsing", "loc": []string{"query", name},
		"msg": "Input should be a valid boolean, unable to interpret input", "input": raw,
	}})
	return false, false
}
