// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Gateway HTTP server: TLS-aware listener, request-id middleware, graceful shutdown.

package internal

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/garudex-labs/caracal/packages/core/go/audit"
	sharedcrypto "github.com/garudex-labs/caracal/packages/core/go/crypto"
	"github.com/garudex-labs/caracal/packages/core/go/logging"
	coremetrics "github.com/garudex-labs/caracal/packages/core/go/metrics"
	"github.com/garudex-labs/caracal/packages/core/go/telemetry"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"
)

// shutdownGrace bounds in-flight requests during graceful shutdown.
const shutdownGrace = 25 * time.Second

// requestIDKey is the context key under which the per-request ID is stored.
type requestIDKey struct{}

// Server owns the HTTP listener and its dependencies.
type Server struct {
	cfg         Config
	log         zerolog.Logger
	sts         *stsClient
	jwks        *jwksCache
	guard       *upstreamGuard
	tracker     *jtiTracker
	bindings    *bindingStore
	redis       *RedisClient
	audit       *audit.Client
	revocations *revocationStore
	metrics     *GatewayMetrics
	pool        *pgxpool.Pool
}

// New constructs a Server from environment configuration.
func New(ctx context.Context) (*Server, error) {
	cfg, err := loadConfig()
	if err != nil {
		return nil, fmt.Errorf("config: %w", err)
	}
	log := logging.New("gateway")
	rdb, err := newRedis(cfg.RedisURL)
	if err != nil {
		return nil, err
	}
	streamKey, err := sharedcrypto.DecodeStreamKey(cfg.StreamsHMACKey)
	if err != nil {
		return nil, fmt.Errorf("streams hmac key: %w", err)
	}
	rdb.SetStreamSigning(streamKey, cfg.Mode != "dev")
	tracker, err := newJTITracker(rdb, log, cfg.JTIFailOpen, cfg.AuditHMACKey)
	if err != nil {
		return nil, err
	}
	pool, err := newPool(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}
	bindings := newBindingStore(pool, log)
	if err := bindings.Reload(ctx); err != nil {
		return nil, err
	}
	revocations := newRevocationStore(log)
	if err := reloadRevocationSnapshot(ctx, pool, revocations); err != nil {
		return nil, fmt.Errorf("revocation snapshot: %w", err)
	}
	auditClient, err := audit.NewClient(rdb, audit.ClientConfig{
		AuditHMACKey: cfg.AuditHMACKey,
		ReplayDir:    cfg.AuditReplayDir,
		Logger:       log,
		Production:   cfg.Mode != "dev",
	})
	if err != nil {
		return nil, err
	}
	return &Server{
		cfg:         cfg,
		log:         log,
		sts:         newSTSClient(cfg.STSURL, cfg.STSTimeout, cfg.STSExchangeHMACKey),
		jwks:        newJWKSCache(cfg.STSURL, cfg.STSTimeout, log),
		guard:       newUpstreamGuard(cfg.UpstreamHostAllowlist, cfg.AllowPrivateUpstreams),
		tracker:     tracker,
		bindings:    bindings,
		redis:       rdb,
		audit:       auditClient,
		revocations: revocations,
		metrics:     &GatewayMetrics{},
		pool:        pool,
	}, nil
}

// Run starts the HTTP(S) listener and blocks until ctx is cancelled.
func (s *Server) Run(ctx context.Context) error {
	go s.bindings.StartPolling(ctx)
	s.audit.ReplayPending(ctx)
	auditCtx, stopAudit := context.WithCancel(context.Background())
	defer stopAudit()
	s.audit.Start(auditCtx)
	if err := startRevocationConsumer(ctx, s.redis, s.revocations, s.log); err != nil {
		return err
	}
	startRevocationSnapshotPolling(ctx, s.bindings.pool, s.revocations, s.log)
	p := newProxy(s.sts, s.jwks, s.guard, s.log, s.cfg.MaxRequestBytes, s.cfg.UpstreamTimeout, s.bindings, s.tracker, s.revocations, s.metrics, s.audit)

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("/ready", s.handleReady)
	mux.HandleFunc("/metrics", s.handleMetrics)
	mux.HandleFunc("/metrics.json", s.handleMetricsJSON)
	mux.Handle("/", p)

	handler := telemetry.HTTPHandler("caracal.gateway.http", requestIDMiddleware(mux))

	srv := &http.Server{
		Addr:              ":" + s.cfg.Port,
		Handler:           handler,
		ReadHeaderTimeout: s.cfg.ReadHeaderTimeout,
		ReadTimeout:       s.cfg.ReadTimeout,
		WriteTimeout:      s.cfg.WriteTimeout,
		IdleTimeout:       s.cfg.IdleTimeout,
		MaxHeaderBytes:    16 << 10,
		ErrorLog:          nil,
	}
	if s.cfg.TLSEnabled() {
		srv.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	}

	errc := make(chan error, 1)
	go func() {
		s.log.Info().
			Str("port", s.cfg.Port).
			Bool("tls", s.cfg.TLSEnabled()).
			Msg("gateway listening")
		var err error
		if s.cfg.TLSEnabled() {
			err = srv.ListenAndServeTLS(s.cfg.TLSCertFile, s.cfg.TLSKeyFile)
		} else {
			err = srv.ListenAndServe()
		}
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			errc <- err
		}
		close(errc)
	}()

	select {
	case <-ctx.Done():
		s.log.Info().Msg("gateway shutting down")
		shutCtx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
		defer cancel()
		if err := srv.Shutdown(shutCtx); err != nil {
			s.log.Error().Err(err).Msg("graceful shutdown failed; forcing close")
			_ = srv.Close()
			return err
		}
		stopAudit()
		auditFlushCtx, cancelAuditFlush := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancelAuditFlush()
		if err := s.audit.Close(auditFlushCtx); err != nil {
			s.log.Error().Err(err).Msg("audit client flush failed")
			return err
		}
		return nil
	case err, ok := <-errc:
		if !ok {
			return nil
		}
		return err
	}
}

func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if s.bindings == nil {
		s.log.Warn().Msg("ready: bindings unavailable")
		writeReadyFailure(w, "bindings_unavailable")
		return
	}
	if err := s.bindings.Reload(ctx); err != nil {
		s.log.Warn().Err(err).Msg("ready: postgres unreachable")
		writeReadyFailure(w, "postgres_unreachable")
		return
	}
	if err := s.redis.Ping(ctx); err != nil {
		s.log.Warn().Err(err).Msg("ready: redis unreachable")
		writeReadyFailure(w, "redis_unreachable")
		return
	}
	if err := s.audit.Ready(); err != nil {
		s.log.Warn().Err(err).Msg("ready: audit replay unavailable")
		writeReadyFailure(w, "audit_replay_unavailable")
		return
	}
	if s.sts == nil {
		s.log.Warn().Msg("ready: sts unavailable")
		writeReadyFailure(w, "sts_unavailable")
		return
	}
	if err := s.sts.Health(ctx); err != nil {
		s.log.Warn().Err(err).Msg("ready: sts unreachable")
		writeReadyFailure(w, "sts_unreachable")
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

func (s *Server) handleMetrics(w http.ResponseWriter, _ *http.Request) {
	s.refreshMetricGauges()
	snap := s.metrics.Snapshot()
	samples := []coremetrics.Sample{
		{Name: "caracal_gateway_requests_total", Help: "Gateway requests received", Type: coremetrics.Counter, Value: float64(snap.RequestsTotal)},
		{Name: "caracal_gateway_requests_allowed_total", Help: "Gateway requests allowed upstream", Type: coremetrics.Counter, Value: float64(snap.RequestsAllowed)},
		{Name: "caracal_gateway_requests_denied_total", Help: "Gateway requests denied before upstream dispatch", Type: coremetrics.Counter, Value: float64(snap.RequestsDenied)},
		{Name: "caracal_gateway_denials_missing_auth_total", Help: "Gateway denials caused by missing bearer credentials", Type: coremetrics.Counter, Value: float64(snap.DenialsMissingAuth)},
		{Name: "caracal_gateway_denials_bad_bearer_total", Help: "Gateway denials caused by malformed bearer credentials", Type: coremetrics.Counter, Value: float64(snap.DenialsBadBearer)},
		{Name: "caracal_gateway_denials_expiring_total", Help: "Gateway denials caused by nearly expired mandates", Type: coremetrics.Counter, Value: float64(snap.DenialsExpiring)},
		{Name: "caracal_gateway_denials_bad_routing_total", Help: "Gateway denials caused by invalid route targets", Type: coremetrics.Counter, Value: float64(snap.DenialsBadRouting)},
		{Name: "caracal_gateway_denials_path_traversal_total", Help: "Gateway denials caused by unsafe upstream paths", Type: coremetrics.Counter, Value: float64(snap.DenialsPathTrav)},
		{Name: "caracal_gateway_denials_signature_total", Help: "Gateway denials caused by invalid JWT signatures", Type: coremetrics.Counter, Value: float64(snap.DenialsSignature)},
		{Name: "caracal_gateway_denials_jti_replay_total", Help: "Gateway denials caused by replayed token identifiers", Type: coremetrics.Counter, Value: float64(snap.DenialsJTIReplay)},
		{Name: "caracal_gateway_denials_revoked_total", Help: "Gateway denials caused by revoked sessions or delegations", Type: coremetrics.Counter, Value: float64(snap.DenialsRevoked)},
		{Name: "caracal_gateway_denials_binding_total", Help: "Gateway denials caused by missing Gateway bindings", Type: coremetrics.Counter, Value: float64(snap.DenialsBinding)},
		{Name: "caracal_gateway_sts_exchange_errors_total", Help: "Gateway STS token exchange failures", Type: coremetrics.Counter, Value: float64(snap.STSExchangeErrors)},
		{Name: "caracal_gateway_upstream_errors_total", Help: "Gateway upstream request failures", Type: coremetrics.Counter, Value: float64(snap.UpstreamErrors)},
		{Name: "caracal_gateway_bindings_loaded", Help: "Gateway resource bindings loaded in memory", Type: coremetrics.Gauge, Value: float64(snap.BindingsLoaded)},
		{Name: "caracal_gateway_revocations_active", Help: "Gateway revocation anchors loaded in memory", Type: coremetrics.Gauge, Value: float64(snap.RevocationsActive)},
	}
	if s.pool != nil {
		stat := s.pool.Stat()
		total := stat.MaxConns()
		var ratio float64
		if total > 0 {
			ratio = float64(stat.AcquiredConns()) / float64(total)
		}
		samples = append(samples,
			coremetrics.Sample{Name: "caracal_db_pool_in_use_ratio", Help: "Fraction of the Postgres pool currently in use", Type: coremetrics.Gauge, Value: ratio},
			coremetrics.Sample{Name: "caracal_db_pool_max_conns", Help: "Configured maximum Postgres pool size", Type: coremetrics.Gauge, Value: float64(total)},
			coremetrics.Sample{Name: "caracal_db_pool_acquired_conns", Help: "Postgres pool connections currently checked out", Type: coremetrics.Gauge, Value: float64(stat.AcquiredConns())},
		)
	}
	w.Header().Set("Content-Type", coremetrics.ContentType)
	_, _ = w.Write([]byte(coremetrics.Render(samples)))
}

func (s *Server) handleMetricsJSON(w http.ResponseWriter, _ *http.Request) {
	s.refreshMetricGauges()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(s.metrics.Snapshot()) //nolint:errcheck
}

func (s *Server) refreshMetricGauges() {
	if s.bindings != nil {
		s.metrics.BindingsLoaded.Store(uint64(s.bindings.Size()))
	}
	if s.revocations != nil {
		s.metrics.RevocationsActive.Store(uint64(s.revocations.Size()))
	}
}

// requestIDMiddleware ensures every request has a server-assigned UUID in its context
// and echoes it back to the caller. Client-supplied X-Request-Id is preserved only when
// it satisfies validRequestID; otherwise it is replaced.
func requestIDMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-Id")
		if !validRequestID(id) {
			id = newRequestID()
		}
		ctx := context.WithValue(r.Context(), requestIDKey{}, id)
		w.Header().Set("X-Request-Id", id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// requestIDFromContext returns the request ID stored by requestIDMiddleware, or
// creates a fresh UUID when direct handler tests invoke handlers without middleware.
func requestIDFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(requestIDKey{}).(string); ok && v != "" {
		return v
	}
	return newRequestID()
}
