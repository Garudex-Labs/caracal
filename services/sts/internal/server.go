// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// HTTP server: wires routes, starts background goroutines, and manages lifecycle.

package internal

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"time"

	sharedcrypto "github.com/garudex-labs/caracal/shared/crypto"
	sharederr "github.com/garudex-labs/caracal/shared/errors"
	"github.com/garudex-labs/caracal/shared/logging"
	"github.com/golang-jwt/jwt/v5"
	"github.com/rs/zerolog"
)

const (
	maxRequestBodyBytes = 64 * 1024
	jwksCacheMaxAge     = 300
)

// Server holds all runtime state for the STS.
type Server struct {
	cfg         Config
	db          DBQuerier
	redis       *RedisClient
	opa         *OPAEngine
	keys        *KeyCache
	auditBuffer *AuditBuffer
	metrics     *STSMetrics
	log         zerolog.Logger
}

// New initialises all dependencies and returns a ready-to-run Server.
func New(ctx context.Context) (*Server, error) {
	cfg := loadConfig()
	log := logging.New("sts")

	db, err := newDB(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("db: %w", err)
	}

	rdb, err := newRedis(cfg.RedisURL)
	if err != nil {
		return nil, fmt.Errorf("redis: %w", err)
	}

	kek, err := resolveKEK(cfg.ZoneKEKProvider, cfg.IsProduction())
	if err != nil {
		return nil, fmt.Errorf("kek: %w", err)
	}

	keys := newKeyCache(db, kek)
	opa := newOPAEngine(db, log)
	buf := newAuditBuffer(rdb, log)

	return &Server{
		cfg:         cfg,
		db:          db,
		redis:       rdb,
		opa:         opa,
		keys:        keys,
		auditBuffer: buf,
		metrics:     &STSMetrics{},
		log:         log,
	}, nil
}

// Run starts the HTTP server and all background workers; blocks until ctx is cancelled.
func (s *Server) Run(ctx context.Context) error {
	s.auditBuffer.start(ctx)
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

	srv := &http.Server{
		Addr:         ":" + s.cfg.Port,
		Handler:      mux,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  60 * time.Second,
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
		shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return srv.Shutdown(shutCtx)
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
			continue
		}
		priv, err := jwt.ParseECPrivateKeyFromPEM(keyBytes)
		if err != nil {
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
	if err := s.db.Ping(r.Context()); err != nil {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleMetrics(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
		"sts":           s.metrics.Snapshot(),
		"opa":           s.opa.MetricsSnapshot(),
		"audit_dropped": s.auditBuffer.Dropped(),
	})
}

// resolveKEK loads the 32-byte zone encryption key. In production-like environments
// (CARACAL_ENV=production|prod|staging) ZONE_KEK is mandatory; the dev-only zero key
// is rejected to prevent silent issuance with predictable signing-key encryption.
func resolveKEK(provider string, production bool) ([]byte, error) {
	switch provider {
	case "local", "":
		raw := os.Getenv("ZONE_KEK")
		if raw == "" {
			if production {
				return nil, errors.New("ZONE_KEK is required in production")
			}
			return make([]byte, 32), nil
		}
		b, err := hex.DecodeString(raw)
		if err != nil {
			return nil, fmt.Errorf("ZONE_KEK: %w", err)
		}
		if len(b) != 32 {
			return nil, fmt.Errorf("ZONE_KEK must be 32 bytes, got %d", len(b))
		}
		return b, nil
	default:
		return nil, fmt.Errorf("unsupported KEK provider: %s", provider)
	}
}
