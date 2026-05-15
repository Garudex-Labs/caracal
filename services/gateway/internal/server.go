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

	sharedcrypto "github.com/garudex-labs/caracal/core/crypto"
	"github.com/garudex-labs/caracal/core/logging"
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
	revocations *revocationStore
	metrics     *GatewayMetrics
}

// New constructs a Server from environment configuration.
func New(ctx context.Context) (*Server, error) {
	cfg := loadConfig()
	log := logging.New("gateway")
	var tracker *jtiTracker
	var rdb *RedisClient
	if cfg.RedisURL != "" {
		var err error
		rdb, err = newRedis(cfg.RedisURL)
		if err != nil {
			return nil, err
		}
		streamKey, err := sharedcrypto.DecodeStreamKey(cfg.StreamsHMACKey)
		if err != nil {
			return nil, fmt.Errorf("streams hmac key: %w", err)
		}
		if len(streamKey) == 0 {
			log.Warn().Msg("STREAMS_HMAC_KEY not set; revocation stream messages will not be origin-verified")
		}
		rdb.SetStreamSigning(streamKey, cfg.Mode == "runtime")
		tracker = newJTITracker(rdb, log, cfg.JTIFailOpen)
	} else {
		log.Warn().Msg("REDIS_URL unset; jti replay detection and revocation propagation disabled")
	}
	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}
	bindings := newBindingStore(pool, log)
	if err := bindings.Reload(ctx); err != nil {
		return nil, err
	}
	return &Server{
		cfg:         cfg,
		log:         log,
		sts:         newSTSClient(cfg.STSURL, cfg.STSTimeout),
		jwks:        newJWKSCache(cfg.STSURL, cfg.STSTimeout, log),
		guard:       newUpstreamGuard(cfg.UpstreamHostAllowlist, cfg.AllowPrivateUpstreams),
		tracker:     tracker,
		bindings:    bindings,
		redis:       rdb,
		revocations: newRevocationStore(log),
		metrics:     &GatewayMetrics{},
	}, nil
}

// Run starts the HTTP(S) listener and blocks until ctx is cancelled.
func (s *Server) Run(ctx context.Context) error {
	go s.bindings.StartPolling(ctx)
	if err := startRevocationConsumer(ctx, s.redis, s.revocations, s.log); err != nil {
		return err
	}
	p := newProxy(s.sts, s.jwks, s.guard, s.log, s.cfg.MaxRequestBytes, s.cfg.UpstreamTimeout, s.bindings, s.tracker, s.revocations, s.metrics)

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("/ready", s.handleReady)
	mux.HandleFunc("/metrics", s.handleMetrics)
	mux.Handle("/", p)

	handler := requestIDMiddleware(mux)

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
		http.Error(w, "bindings unavailable", http.StatusServiceUnavailable)
		return
	}
	if err := s.bindings.Reload(ctx); err != nil {
		http.Error(w, "postgres unreachable: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	if s.redis != nil {
		if err := s.redis.Ping(ctx); err != nil {
			http.Error(w, "redis unreachable: "+err.Error(), http.StatusServiceUnavailable)
			return
		}
	}
	if s.sts == nil {
		http.Error(w, "sts unavailable", http.StatusServiceUnavailable)
		return
	}
	if err := s.sts.Health(ctx); err != nil {
		http.Error(w, "sts unreachable: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleMetrics(w http.ResponseWriter, _ *http.Request) {
	if s.bindings != nil {
		s.metrics.BindingsLoaded.Store(uint64(s.bindings.Size()))
	}
	if s.revocations != nil {
		s.metrics.RevocationsActive.Store(uint64(s.revocations.Size()))
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(s.metrics.Snapshot()) //nolint:errcheck
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

// requestIDFromContext returns the request ID stored by requestIDMiddleware, or a fresh UUID
// as a defensive fallback when middleware did not run (e.g. direct handler tests).
func requestIDFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(requestIDKey{}).(string); ok && v != "" {
		return v
	}
	return newRequestID()
}
