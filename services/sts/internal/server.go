// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// HTTP server: wires routes, starts background goroutines, and manages lifecycle.

package internal

import (
	"context"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"time"

	sharedcrypto "github.com/garudex-labs/caracal/packages/core/go/crypto"
	sharederr "github.com/garudex-labs/caracal/packages/core/go/errors"
	"github.com/garudex-labs/caracal/packages/core/go/logging"
	coremetrics "github.com/garudex-labs/caracal/packages/core/go/metrics"
	"github.com/garudex-labs/caracal/packages/core/go/telemetry"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/rs/zerolog"
)

const (
	maxRequestBodyBytes = 64 * 1024
	jwksCacheMaxAge     = 300
)

// Server holds all runtime state for the STS.
type Server struct {
	cfg            Config
	db             DBQuerier
	redis          *RedisClient
	opa            *OPAEngine
	keys           *KeyCache
	auditBuffer    *AuditBuffer
	metrics        *STSMetrics
	stepUpThrottle *stepUpThrottle
	consumersReady chan struct{}
	log            zerolog.Logger
}

// New initialises all dependencies and returns a ready-to-run Server.
func New(ctx context.Context) (*Server, error) {
	cfg, err := loadConfig()
	if err != nil {
		return nil, fmt.Errorf("config: %w", err)
	}
	log := logging.New("sts")

	db, err := newDB(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("db: %w", err)
	}

	rdb, err := newRedis(cfg.RedisURL)
	if err != nil {
		return nil, fmt.Errorf("redis: %w", err)
	}

	streamKey, err := sharedcrypto.DecodeStreamKey(cfg.StreamsHMACKey)
	if err != nil {
		return nil, fmt.Errorf("streams hmac key: %w", err)
	}
	if cfg.IsPublished() && len(streamKey) == 0 {
		return nil, errors.New("STREAMS_HMAC_KEY is required when CARACAL_MODE=rc or CARACAL_MODE=stable")
	}
	if len(streamKey) == 0 {
		log.Warn().Msg("STREAMS_HMAC_KEY not set; stream messages will not be origin-verified")
	}
	rdb.SetStreamSigning(streamKey, cfg.IsPublished())

	kek, err := resolveKEK(cfg.ZoneKEKProvider)
	if err != nil {
		return nil, fmt.Errorf("kek: %w", err)
	}

	keys := newKeyCache(db, kek)
	opa := newOPAEngine(db, log)
	opa.SetPollInterval(time.Duration(cfg.OPAPollSeconds) * time.Second)
	metrics := &STSMetrics{}
	buf, err := newAuditBuffer(rdb, log, cfg.IsPublished(), cfg.AuditReplayDir, metrics)
	if err != nil {
		return nil, fmt.Errorf("audit: %w", err)
	}

	return &Server{
		cfg:            cfg,
		db:             db,
		redis:          rdb,
		opa:            opa,
		keys:           keys,
		auditBuffer:    buf,
		metrics:        metrics,
		stepUpThrottle: newStepUpThrottle(),
		consumersReady: make(chan struct{}),
		log:            log,
	}, nil
}

// Run starts the HTTP server and all background workers; blocks until ctx is cancelled.
func (s *Server) Run(ctx context.Context) error {
	s.auditBuffer.replayPending(ctx)
	auditCtx, stopAudit := context.WithCancel(context.Background())
	defer stopAudit()
	s.auditBuffer.start(auditCtx)
	go s.startConsumers(ctx)
	go s.opa.StartPGPolling(ctx)
	go s.opa.SeedZones(ctx)

	mux := http.NewServeMux()
	mux.HandleFunc("POST /oauth/2/token", s.handleTokenExchange)
	mux.HandleFunc("GET /.well-known/jwks.json", s.handleJWKS)
	mux.HandleFunc("GET /step-up/{id}", s.handleStepUpStatus)
	mux.HandleFunc("GET /health", handleHealth)
	mux.HandleFunc("GET /ready", s.handleReady)
	mux.HandleFunc("GET /metrics", s.handleMetrics)
	mux.HandleFunc("GET /metrics.json", s.handleMetricsJSON)
	mux.HandleFunc("POST /internal/policy/simulate", s.handlePolicySimulation)

	srv := &http.Server{
		Addr:              ":" + s.cfg.Port,
		Handler:           telemetry.HTTPHandler("caracal.sts.http", mux),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       5 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}

	errc := make(chan error, 1)
	go func() {
		s.log.Info().Str("port", s.cfg.Port).Msg("listening")
		if err := srv.ListenAndServe(); err != http.ErrServerClosed {
			errc <- err
		}
	}()

	select {
	case <-ctx.Done():
		shutCtx, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancelShutdown()
		shutErr := srv.Shutdown(shutCtx)
		stopAudit()
		auditFlushCtx, cancelAuditFlush := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancelAuditFlush()
		if err := s.auditBuffer.Close(auditFlushCtx); err != nil {
			s.log.Error().Err(err).Msg("audit buffer flush failed")
			if shutErr == nil {
				return err
			}
		}
		return shutErr
	case err := <-errc:
		return err
	}
}

// handleJWKS returns the JWKS for one zone. zone_id is mandatory: STS must never
// expose every zone's signing keys in a single document.
func (s *Server) handleJWKS(w http.ResponseWriter, r *http.Request) {
	zoneID := r.URL.Query().Get("zone_id")
	if zoneID == "" {
		writeError(w, http.StatusBadRequest, sharederr.New(sharederr.InvalidToken, "zone_id required"))
		return
	}
	secrets, err := s.db.GetZoneSigningKeySecrets(r.Context(), zoneID)
	if err != nil || len(secrets) == 0 {
		writeError(w, http.StatusNotFound, sharederr.New(sharederr.ResourceNotFound, "zone signing key not found"))
		return
	}
	entries := make([]JWKSEntry, 0, len(secrets))
	for _, secret := range secrets {
		keyBytes, err := sharedcrypto.Open(s.keys.zek, secret.Nonce, secret.Ciphertext)
		if err != nil {
			s.metrics.JWKSInvalidKeys.Add(1)
			s.log.Warn().Err(err).Str("zone", zoneID).Str("kid", secret.ID).Str("reason", "decrypt").Msg("jwks: skipped invalid signing key")
			continue
		}
		priv, err := jwt.ParseECPrivateKeyFromPEM(keyBytes)
		if err != nil {
			s.metrics.JWKSInvalidKeys.Add(1)
			s.log.Warn().Err(err).Str("zone", zoneID).Str("kid", secret.ID).Str("reason", "parse").Msg("jwks: skipped invalid signing key")
			continue
		}
		entries = append(entries, JWKSEntry{Pub: &priv.PublicKey, Kid: secret.ID})
	}
	if len(entries) == 0 {
		writeError(w, http.StatusInternalServerError, sharederr.New(sharederr.Internal, "signing key decryption failed"))
		return
	}
	data, err := BuildJWKS(entries)
	if err != nil {
		writeError(w, http.StatusInternalServerError, sharederr.New(sharederr.Internal, "jwks serialisation failed"))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", fmt.Sprintf("public, max-age=%d, must-revalidate", jwksCacheMaxAge))
	_, _ = w.Write(data)
}

func handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleStepUpStatus(w http.ResponseWriter, r *http.Request) {
	challengeID := r.PathValue("id")
	if _, err := uuid.Parse(challengeID); err != nil {
		writeError(w, http.StatusNotFound, sharederr.New(sharederr.ResourceNotFound, "challenge not found"))
		return
	}
	c, err := s.db.GetStepUpChallenge(r.Context(), challengeID)
	if err != nil {
		writeError(w, http.StatusNotFound, sharederr.New(sharederr.ResourceNotFound, "challenge not found"))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
		"id":             c.ID,
		"challenge_type": c.ChallengeType,
		"satisfied":      c.SatisfiedAt != nil,
		"consumed":       c.ConsumedAt != nil,
		"expires_at":     c.ExpiresAt.Format(time.RFC3339),
	})
}

func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.db.Ping(ctx); err != nil {
		s.log.Warn().Err(err).Msg("ready: postgres unreachable")
		writeReadyFailure(w, "postgres_unreachable")
		return
	}
	if s.redis == nil {
		s.log.Warn().Msg("ready: redis unavailable")
		writeReadyFailure(w, "redis_unavailable")
		return
	}
	if err := s.redis.Ping(ctx); err != nil {
		s.log.Warn().Err(err).Msg("ready: redis unreachable")
		writeReadyFailure(w, "redis_unreachable")
		return
	}
	if err := s.auditBuffer.Ready(); err != nil {
		s.log.Warn().Err(err).Msg("ready: audit replay unavailable")
		writeReadyFailure(w, "audit_replay_unavailable")
		return
	}
	select {
	case <-s.consumersReady:
	default:
		s.log.Warn().Msg("ready: stream consumers not ready")
		writeReadyFailure(w, "stream_consumers_not_ready")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "ready": true})
}

func writeReadyFailure(w http.ResponseWriter, reason string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusServiceUnavailable)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":     false,
		"ready":  false,
		"reason": reason,
	})
}

func (s *Server) metricsAuthorized(r *http.Request) bool {
	if s.cfg.MetricsBearer == "" {
		return true
	}
	auth := r.Header.Get("Authorization")
	expected := "Bearer " + s.cfg.MetricsBearer
	if len(auth) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(auth), []byte(expected)) == 1
}

func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	if !s.metricsAuthorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	sts := s.metrics.Snapshot()
	opa := s.opa.MetricsSnapshot()
	auditDropped := s.auditBuffer.Dropped()
	w.Header().Set("Content-Type", coremetrics.ContentType)
	_, _ = w.Write([]byte(coremetrics.Render([]coremetrics.Sample{
		{Name: "caracal_sts_graph_traversals_total", Help: "STS delegation graph traversals performed", Type: coremetrics.Counter, Value: float64(sts.GraphTraversals)},
		{Name: "caracal_sts_graph_traversal_errors_total", Help: "STS delegation graph traversal failures", Type: coremetrics.Counter, Value: float64(sts.GraphTraversalErrors)},
		{Name: "caracal_sts_audit_dropped_total", Help: "STS audit events dropped before persistence", Type: coremetrics.Counter, Value: float64(sts.AuditDropped + auditDropped)},
		{Name: "caracal_sts_audit_replay_pending", Help: "STS audit events pending replay", Type: coremetrics.Gauge, Value: float64(sts.AuditReplayPending)},
		{Name: "caracal_sts_audit_replay_replayed_total", Help: "STS audit events replayed after sink recovery", Type: coremetrics.Counter, Value: float64(sts.AuditReplayReplayed)},
		{Name: "caracal_sts_audit_sink_errors_total", Help: "STS audit sink publish errors", Type: coremetrics.Counter, Value: float64(sts.AuditSinkErrors)},
		{Name: "caracal_sts_jwks_invalid_keys_total", Help: "STS signing keys skipped because JWKS validation failed", Type: coremetrics.Counter, Value: float64(sts.JWKSInvalidKeys)},
		{Name: "caracal_sts_opa_eval_total", Help: "STS OPA policy evaluations", Type: coremetrics.Counter, Value: float64(opa.EvalTotal)},
		{Name: "caracal_sts_opa_eval_errors_total", Help: "STS OPA policy evaluation errors", Type: coremetrics.Counter, Value: float64(opa.EvalErrors)},
		{Name: "caracal_sts_opa_eval_duration_seconds_total", Help: "STS cumulative OPA policy evaluation duration", Type: coremetrics.Counter, Value: float64(opa.EvalDurationNs) / float64(time.Second)},
		{Name: "caracal_sts_opa_compile_total", Help: "STS OPA policy compilations", Type: coremetrics.Counter, Value: float64(opa.CompileTotal)},
		{Name: "caracal_sts_opa_compile_errors_total", Help: "STS OPA policy compilation errors", Type: coremetrics.Counter, Value: float64(opa.CompileErrors)},
		{Name: "caracal_sts_opa_compile_duration_seconds_total", Help: "STS cumulative OPA policy compilation duration", Type: coremetrics.Counter, Value: float64(opa.CompileDurationNs) / float64(time.Second)},
		{Name: "caracal_sts_opa_max_policy_age_seconds", Help: "STS maximum age of a loaded OPA policy bundle", Type: coremetrics.Gauge, Value: opa.MaxPolicyAgeSeconds},
		{Name: "caracal_sts_opa_poll_interval_seconds", Help: "STS OPA PostgreSQL safety poll interval", Type: coremetrics.Gauge, Value: opa.PollIntervalSeconds},
	})))
}

func (s *Server) handleMetricsJSON(w http.ResponseWriter, r *http.Request) {
	if !s.metricsAuthorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
		"sts":           s.metrics.Snapshot(),
		"opa":           s.opa.MetricsSnapshot(),
		"audit_dropped": s.auditBuffer.Dropped(),
	})
}

// resolveKEK loads the 32-byte zone encryption key. ZONE_KEK is mandatory in every
// environment: an all-zero fallback would let any database snapshot decrypt every
// zone's signing keys.
func resolveKEK(provider string) ([]byte, error) {
	switch provider {
	case "local", "":
		raw := os.Getenv("ZONE_KEK")
		if raw == "" {
			return nil, errors.New("ZONE_KEK is required")
		}
		b, err := hex.DecodeString(raw)
		if err != nil {
			return nil, fmt.Errorf("ZONE_KEK: %w", err)
		}
		if len(b) != 32 {
			return nil, fmt.Errorf("ZONE_KEK must be 32 bytes, got %d", len(b))
		}
		var allZero byte
		for _, x := range b {
			allZero |= x
		}
		if allZero == 0 {
			return nil, errors.New("ZONE_KEK must not be all zeros")
		}
		return b, nil
	default:
		return nil, fmt.Errorf("unsupported KEK provider: %s", provider)
	}
}
