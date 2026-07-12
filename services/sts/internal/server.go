// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// HTTP server: wires routes, starts background goroutines, and manages lifecycle.

package internal

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	sharedcrypto "github.com/garudex-labs/caracal/packages/core/go/crypto"
	sharederr "github.com/garudex-labs/caracal/packages/core/go/errors"
	"github.com/garudex-labs/caracal/packages/core/go/logging"
	coremetrics "github.com/garudex-labs/caracal/packages/core/go/metrics"
	"github.com/garudex-labs/caracal/packages/core/go/secretstore"
	"github.com/garudex-labs/caracal/packages/core/go/telemetry"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
	"golang.org/x/sync/singleflight"
)

const (
	maxRequestBodyBytes = 64 * 1024
	jwksCacheMaxAge     = 300

	stepUpMaxWaitSeconds  = 25
	stepUpReasonMaxLength = 500
	stepUpSweepInterval   = time.Hour
	stepUpRetention       = 24 * time.Hour
)

// Server holds all runtime state for the STS.
type Server struct {
	cfg                Config
	db                 DBQuerier
	redis              stsRedis
	opa                *OPAEngine
	keys               *KeyCache
	secrets            secretstore.Backend
	auditBuffer        *AuditBuffer
	metrics            *STSMetrics
	refreshGroup       singleflight.Group
	providerTokenMu    sync.RWMutex
	providerTokenCache map[string]providerServiceTokenCacheEntry
	subjectKeys        *subjectKeyCache
	consumersReady     chan struct{}
	log                zerolog.Logger
}

type stsRedis interface {
	Ping(context.Context) error
	EvictionPolicy(context.Context) (string, error)
	SetNXTTL(context.Context, string, string, time.Duration) (bool, error)
	SetTTL(context.Context, string, any, time.Duration) error
	Get(context.Context, string) (string, error)
	Del(context.Context, string) error
	DelIfValue(context.Context, string, string) error
	ExpireIfValue(context.Context, string, string, time.Duration) (bool, error)
	Exists(context.Context, string) (bool, error)
	IncrWithExpiry(context.Context, string, time.Duration) (int64, error)
	EnsureGroup(context.Context, string, string) error
	XReadGroup(context.Context, string, string, string, int64) ([]redis.XMessage, error)
	XAutoClaim(context.Context, string, string, string, string, time.Duration, int64) ([]redis.XMessage, string, error)
	VerifyStream(string, map[string]any) bool
	XAck(context.Context, string, string, string) error
	SignedXAdd(context.Context, string, map[string]any) error
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

	keyring, err := secretstore.LoadKeyring()
	if err != nil {
		return nil, fmt.Errorf("kek: %w", err)
	}

	metrics := &STSMetrics{}
	secrets, err := newSecretBackend(cfg.SecretBackend, db, keyring, metrics)
	if err != nil {
		return nil, fmt.Errorf("secret backend: %w", err)
	}

	keys := newKeyCache(db, keyring)
	opa := newOPAEngine(db, log)
	if err := verifyDecisionContract(); err != nil {
		return nil, fmt.Errorf("decision contract: %w", err)
	}
	opa.SetPollInterval(time.Duration(cfg.OPAPollSeconds) * time.Second)
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
		secrets:        secrets,
		auditBuffer:    buf,
		metrics:        metrics,
		subjectKeys:    newSubjectKeyCache(cfg.PrivateEgressHosts),
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
	go s.startStepUpSweeper(ctx)

	mux := http.NewServeMux()
	mux.HandleFunc("POST /oauth/2/token", s.handleTokenExchange)
	mux.HandleFunc("POST /v1/run/manifest", s.handleRunManifest)
	mux.HandleFunc("POST /v1/run/credential", s.handleRunCredential)
	mux.HandleFunc("GET /.well-known/jwks.json", s.handleJWKS)
	mux.HandleFunc("GET /step-up/{id}", s.handleStepUpStatus)
	mux.HandleFunc("POST /step-up/{id}/decision", s.handleStepUpDecision)
	mux.HandleFunc("GET /health", handleHealth)
	mux.HandleFunc("GET /ready", s.handleReady)
	mux.HandleFunc("GET /metrics", s.handleMetrics)
	mux.HandleFunc("GET /metrics.json", s.handleMetricsJSON)
	mux.HandleFunc("POST /internal/policy/simulate", s.handlePolicySimulation)
	mux.HandleFunc("GET /internal/policy/status/{zoneID}", s.handlePolicyStatus)
	mux.HandleFunc("POST /internal/zones/{zoneID}/signing-key/rotate", s.handleRotateZoneSigningKey)

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
		keyBytes, err := s.keys.keyring.Open(secret.Envelope, secretstore.AADZoneSigningKey)
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
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", fmt.Sprintf("public, max-age=%d, must-revalidate", jwksCacheMaxAge))
	_, _ = w.Write(data)
}

func handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
}

// handleStepUpStatus reports the lifecycle state of a challenge and nothing else. The
// challenge id is an unguessable capability held by the party that received the 401,
// and the body discloses no approver identity, no request metadata, and no bindings,
// so polling it leaks nothing worth authenticating. An optional wait parameter
// long-polls until the state leaves pending or the window closes, replacing tight
// client-side polling loops.
func (s *Server) handleStepUpStatus(w http.ResponseWriter, r *http.Request) {
	challengeID := r.PathValue("id")
	if _, err := uuid.Parse(challengeID); err != nil {
		writeError(w, http.StatusNotFound, sharederr.New(sharederr.ResourceNotFound, "challenge not found"))
		return
	}
	wait := time.Duration(0)
	if raw := r.URL.Query().Get("wait"); raw != "" {
		seconds, err := strconv.Atoi(raw)
		if err != nil || seconds < 0 {
			writeError(w, http.StatusBadRequest, sharederr.New(sharederr.InvalidToken, "invalid wait"))
			return
		}
		if seconds > stepUpMaxWaitSeconds {
			seconds = stepUpMaxWaitSeconds
		}
		wait = time.Duration(seconds) * time.Second
	}
	if wait > 0 {
		// The server-wide write timeout is shorter than the poll window, so the
		// deadline is extended for exactly this response.
		rc := http.NewResponseController(w)
		_ = rc.SetWriteDeadline(time.Now().Add(wait + 5*time.Second))
	}
	deadline := time.Now().Add(wait)
	for {
		c, err := s.db.GetStepUpChallenge(r.Context(), challengeID)
		if err != nil {
			writeError(w, http.StatusNotFound, sharederr.New(sharederr.ResourceNotFound, "challenge not found"))
			return
		}
		now, err := s.db.CurrentTime(r.Context())
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, sharederr.New(sharederr.STSUnavailable, "trusted time unavailable"))
			return
		}
		state := challengeLifecycleState(c, now)
		if state != ChallengeStatePending || !time.Now().Before(deadline) {
			writeStepUpState(w, c, state)
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-time.After(time.Second):
		}
	}
}

func writeStepUpState(w http.ResponseWriter, c *StepUpChallengePG, state string) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
		"id":         c.ID,
		"state":      state,
		"expires_at": c.ExpiresAt.Format(time.RFC3339),
	})
}

// handleStepUpDecision records an approver's decision on a pending hold from the
// subject plane: the approver is an authenticated end user of the requesting
// application, presenting the session mandate that application minted for them.
// Caracal never learns who the application's users are beyond this mandate; the
// application owns the approval surface and relays only the challenge id and binding.
// The guards, in order: the mandate must verify for the challenge's zone and belong to
// a user, its session must be live and minted by the very application the hold binds,
// the hold must admit subject decisions, the approver's session may not share a
// delegation lineage with the session that raised the hold, and the echoed binding
// must match the hold exactly. The decision record applies the tier's privacy mode.
func (s *Server) handleStepUpDecision(w http.ResponseWriter, r *http.Request) {
	challengeID := r.PathValue("id")
	if _, err := uuid.Parse(challengeID); err != nil {
		writeError(w, http.StatusNotFound, sharederr.New(sharederr.ResourceNotFound, "challenge not found"))
		return
	}
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || token == "" {
		w.Header().Set("WWW-Authenticate", `Bearer realm="caracal-sts"`)
		writeError(w, http.StatusUnauthorized, sharederr.New(sharederr.InvalidToken, "session mandate required"))
		return
	}
	var body struct {
		Decision string `json:"decision"`
		Binding  string `json:"binding"`
		Reason   string `json:"reason"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, sharederr.New(sharederr.InvalidToken, "malformed request body"))
		return
	}
	if body.Decision != "approved" && body.Decision != "rejected" {
		writeError(w, http.StatusBadRequest, sharederr.New(sharederr.InvalidToken, "decision must be approved or rejected"))
		return
	}
	if len(body.Reason) > stepUpReasonMaxLength {
		writeError(w, http.StatusBadRequest, sharederr.New(sharederr.InvalidToken, "reason too long"))
		return
	}
	c, err := s.db.GetStepUpChallenge(r.Context(), challengeID)
	if err != nil || c.ChallengeType != humanApprovalChallengeType {
		writeError(w, http.StatusNotFound, sharederr.New(sharederr.ResourceNotFound, "challenge not found"))
		return
	}
	claims, err := s.validateSubjectToken(r.Context(), token, c.ZoneID)
	if err != nil {
		writeError(w, http.StatusUnauthorized, sharederr.New(sharederr.InvalidToken, "invalid session mandate"))
		return
	}
	if claimString(claims, "sub_type") != SubTypeUser {
		writeError(w, http.StatusForbidden, sharederr.New(sharederr.AccessDenied, "approver must be a user session"))
		return
	}
	if c.ApplicationID == "" {
		writeError(w, http.StatusForbidden, sharederr.New(sharederr.AccessDenied, "challenge does not admit subject decisions"))
		return
	}
	approverAuthorityRecordID, serr := s.validateAuthorityRecord(r.Context(), c.ZoneID, c.ApplicationID, "", claims)
	if serr != nil {
		writeError(w, http.StatusForbidden, serr)
		return
	}
	if c.ApproverClass != ApproverClassSubject && c.ApproverClass != ApproverClassAny {
		writeError(w, http.StatusForbidden, sharederr.New(sharederr.AccessDenied, "this approval requires an operator decision"))
		return
	}
	related, err := s.db.AuthorityRecordsRelated(r.Context(), c.ZoneID, approverAuthorityRecordID, c.AuthorityRecordID)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, sharederr.New(sharederr.STSUnavailable, "authority record lineage unavailable"))
		return
	}
	if related {
		writeError(w, http.StatusForbidden, sharederr.New(sharederr.AccessDenied, "an approver cannot decide a hold raised by its own authority record lineage"))
		return
	}
	if body.Binding != hex.EncodeToString(c.ResourceSetHash) {
		writeError(w, http.StatusConflict, sharederr.New(sharederr.AccessDenied, "binding does not match this challenge"))
		return
	}
	decideErr := s.db.DecideStepUpChallenge(r.Context(), DecideStepUpParams{
		ID:                        c.ID,
		ZoneID:                    c.ZoneID,
		Approve:                   body.Decision == "approved",
		ApproverSubjectID:         approverRecordID(c.PrivacyMode, c.ZoneID, claimString(claims, "sub")),
		ApproverAuthorityRecordID: approverAuthorityRecordID,
		Reason:                    body.Reason,
	})
	if decideErr != nil {
		writeError(w, http.StatusConflict, sharederr.New(sharederr.AccessDenied, "challenge is not pending"))
		return
	}
	if auditErr := s.emitStepUpAudit(c.ID, c.ZoneID, "step_up_decided", body.Decision,
		mergeAuditMeta(stepUpAuditMeta(c), map[string]any{
			"approver_plane":      "subject",
			"approver_session_id": approverAuthorityRecordID,
		})); auditErr != nil {
		writeError(w, http.StatusInternalServerError, auditErr)
		return
	}
	updated, err := s.db.GetStepUpChallenge(r.Context(), c.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, sharederr.New(sharederr.Internal, "challenge reload failed"))
		return
	}
	now, err := s.db.CurrentTime(r.Context())
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, sharederr.New(sharederr.STSUnavailable, "trusted time unavailable"))
		return
	}
	writeStepUpState(w, updated, challengeLifecycleState(updated, now))
}

// approverRecordID applies a hold's privacy mode to the approver identity the decision
// record retains. identified stores the subject verbatim; pseudonymous stores a stable
// zone-scoped pseudonym so decisions by one approver correlate without naming anyone;
// anonymous stores only a redaction marker. Every mode retains the approver's authority
// record id separately as the forensic and revocation anchor.
func approverRecordID(privacyMode, zoneID, sub string) string {
	switch privacyMode {
	case PrivacyAnonymous:
		return "subject:redacted"
	case PrivacyPseudonymous:
		sum := sha256.Sum256([]byte(zoneID + "\x00" + sub))
		return "subject:pseudonym:" + hex.EncodeToString(sum[:8])
	default:
		return "subject:" + sub
	}
}

// startStepUpSweeper deletes challenge rows whose lifecycle ended more than the
// retention window ago. The audit stream is the durable record; the table only needs
// terminal rows long enough for operators to inspect recent decisions.
func (s *Server) startStepUpSweeper(ctx context.Context) {
	ticker := time.NewTicker(stepUpSweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			now, err := s.db.CurrentTime(ctx)
			if err != nil {
				s.log.Warn().Err(err).Msg("step-up sweep: trusted time unavailable")
				continue
			}
			deleted, err := s.db.DeleteExpiredStepUpChallenges(ctx, now.Add(-stepUpRetention))
			if err != nil {
				s.log.Warn().Err(err).Msg("step-up sweep failed")
				continue
			}
			if deleted > 0 {
				s.log.Info().Int64("deleted", deleted).Msg("step-up sweep purged terminal challenges")
			}
		}
	}
}

func (s *Server) handleRotateZoneSigningKey(w http.ResponseWriter, r *http.Request) {
	if !s.adminAuthorized(w, r) {
		return
	}
	zoneID := r.PathValue("zoneID")
	if zoneID == "" {
		writeError(w, http.StatusBadRequest, sharederr.New(sharederr.ZoneInvalid, "zone_id required"))
		return
	}
	secret, err := s.keys.RotateZoneSigningKey(r.Context(), zoneID)
	if err != nil {
		s.log.Error().Err(err).Str("zone", zoneID).Msg("signing key rotation failed")
		writeError(w, http.StatusInternalServerError, sharederr.New(sharederr.Internal, "signing key rotation failed"))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"rotated": true,
		"zone_id": zoneID,
		"kid":     secret.ID,
	})
}

func (s *Server) adminAuthorized(w http.ResponseWriter, r *http.Request) bool {
	if s.cfg.AdminToken == "" {
		http.NotFound(w, r)
		return false
	}
	auth := r.Header.Get("Authorization")
	expected := "Bearer " + s.cfg.AdminToken
	if len(auth) != len(expected) || subtle.ConstantTimeCompare([]byte(auth), []byte(expected)) != 1 {
		w.Header().Set("WWW-Authenticate", `Bearer realm="caracal-sts"`)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return false
	}
	return true
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
	if s.auditBuffer.Dropped() > 0 {
		s.log.Error().Uint64("dropped", s.auditBuffer.Dropped()).Msg("ready: audit evidence lost")
		writeReadyFailure(w, "audit_evidence_lost")
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
		return !s.cfg.IsPublished()
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
	s.auditBuffer.RefreshReplayStats(time.Now())
	sts := s.metrics.Snapshot()
	opa := s.opa.MetricsSnapshot()
	w.Header().Set("Content-Type", coremetrics.ContentType)
	_, _ = w.Write([]byte(coremetrics.Render([]coremetrics.Sample{
		{Name: "caracal_sts_graph_traversals_total", Help: "STS delegation graph traversals performed", Type: coremetrics.Counter, Value: float64(sts.GraphTraversals)},
		{Name: "caracal_sts_graph_traversal_errors_total", Help: "STS delegation graph traversal failures", Type: coremetrics.Counter, Value: float64(sts.GraphTraversalErrors)},
		{Name: "caracal_sts_audit_dropped_total", Help: "STS audit events irrecoverably lost", Type: coremetrics.Counter, Value: float64(s.auditBuffer.Dropped())},
		{Name: "caracal_sts_audit_replay_pending", Help: "STS audit events pending replay", Type: coremetrics.Gauge, Value: float64(sts.AuditReplayPending)},
		{Name: "caracal_sts_audit_replay_files", Help: "STS audit replay files waiting on disk", Type: coremetrics.Gauge, Value: float64(sts.AuditReplayFiles)},
		{Name: "caracal_sts_audit_replay_bytes", Help: "STS audit replay bytes waiting on disk", Type: coremetrics.Gauge, Value: float64(sts.AuditReplayBytes)},
		{Name: "caracal_sts_audit_replay_oldest_age_seconds", Help: "Age of the oldest STS audit replay file on disk", Type: coremetrics.Gauge, Value: float64(sts.AuditReplayOldestAge)},
		{Name: "caracal_sts_audit_replay_replayed_total", Help: "STS audit events replayed after sink recovery", Type: coremetrics.Counter, Value: float64(sts.AuditReplayReplayed)},
		{Name: "caracal_sts_audit_sink_errors_total", Help: "STS audit sink publish errors", Type: coremetrics.Counter, Value: float64(sts.AuditSinkErrors)},
		{Name: "caracal_sts_jwks_invalid_keys_total", Help: "STS signing keys skipped because JWKS validation failed", Type: coremetrics.Counter, Value: float64(sts.JWKSInvalidKeys)},
		{Name: "caracal_sts_secret_backend_reads_total", Help: "Secret backend reads attempted by the data plane", Type: coremetrics.Counter, Value: float64(sts.SecretBackendReads)},
		{Name: "caracal_sts_secret_backend_errors_total", Help: "Secret backend reads that failed", Type: coremetrics.Counter, Value: float64(sts.SecretBackendErrors)},
		{Name: "caracal_sts_provider_refresh_shared_total", Help: "STS provider credential refresh calls served by a shared in-process result", Type: coremetrics.Counter, Value: float64(sts.ProviderRefreshShared)},
		{Name: "caracal_sts_provider_refresh_leased_total", Help: "STS provider credential refresh calls that acquired the distributed refresh lease", Type: coremetrics.Counter, Value: float64(sts.ProviderRefreshLeased)},
		{Name: "caracal_sts_provider_refresh_waited_total", Help: "STS provider credential refresh calls that waited for a distributed peer result", Type: coremetrics.Counter, Value: float64(sts.ProviderRefreshWaited)},
		{Name: "caracal_sts_provider_refresh_errors_total", Help: "STS provider credential refresh distributed coordination errors", Type: coremetrics.Counter, Value: float64(sts.ProviderRefreshErrors)},
		{Name: "caracal_sts_provider_circuit_open_total", Help: "STS provider refresh attempts rejected because the provider circuit was open", Type: coremetrics.Counter, Value: float64(sts.ProviderCircuitOpen)},
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
	s.auditBuffer.RefreshReplayStats(time.Now())
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
		"sts":           s.metrics.Snapshot(),
		"opa":           s.opa.MetricsSnapshot(),
		"audit_dropped": s.auditBuffer.Dropped(),
	})
}
