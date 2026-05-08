// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Gateway HTTP server: TLS-aware listener, request-id middleware, graceful shutdown.

package internal

import (
	"context"
	"crypto/tls"
	"errors"
	"net/http"
	"time"

	"github.com/garudex-labs/caracal/shared/logging"
	"github.com/rs/zerolog"
)

// shutdownGrace bounds in-flight requests during graceful shutdown.
const shutdownGrace = 25 * time.Second

// requestIDKey is the context key under which the per-request ID is stored.
type requestIDKey struct{}

// Server owns the HTTP listener and its dependencies.
type Server struct {
	cfg     Config
	log     zerolog.Logger
	sts     *stsClient
	guard   *upstreamGuard
	tracker *jtiTracker
}

// New constructs a Server from environment configuration.
func New(_ context.Context) (*Server, error) {
	cfg := loadConfig()
	log := logging.New("gateway")
	var tracker *jtiTracker
	if cfg.RedisURL != "" {
		rdb, err := newRedis(cfg.RedisURL)
		if err != nil {
			return nil, err
		}
		tracker = newJTITracker(rdb, log)
	} else {
		log.Warn().Msg("REDIS_URL unset; jti replay detection disabled")
	}
	return &Server{
		cfg:     cfg,
		log:     log,
		sts:     newSTSClient(cfg.STSURL, cfg.STSTimeout),
		guard:   newUpstreamGuard(cfg.UpstreamHostAllowlist, cfg.AllowPrivateUpstreams),
		tracker: tracker,
	}, nil
}

// Run starts the HTTP(S) listener and blocks until ctx is cancelled.
func (s *Server) Run(ctx context.Context) error {
	p := newProxy(s.sts, s.guard, s.log, s.cfg.MaxRequestBytes, s.cfg.UpstreamTimeout, s.cfg.ResourceClientBindings, s.tracker)

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("/ready", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.Handle("/", p)

	handler := requestIDMiddleware(mux)

	srv := &http.Server{
		Addr:              ":" + s.cfg.Port,
		Handler:           handler,
		ReadHeaderTimeout: s.cfg.ReadHeaderTimeout,
		ReadTimeout:       s.cfg.ReadTimeout,
		WriteTimeout:      s.cfg.WriteTimeout,
		IdleTimeout:       s.cfg.IdleTimeout,
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
