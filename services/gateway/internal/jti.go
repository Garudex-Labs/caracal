// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// JTI replay tracker: SETNX-based per-token use marker that rejects duplicate use and emits an audit event.

package internal

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/garudex-labs/caracal/packages/core/go/audit"
	"github.com/google/uuid"
	"github.com/rs/zerolog"
)

const seenJTIPrefix = "seen:jti:"

// jtiRedis is the narrow Redis surface the tracker needs: a SETNX-style first-use marker.
type jtiRedis interface {
	SetNXTTL(ctx context.Context, key, value string, ttl time.Duration) (bool, error)
}

// jtiTracker records the first use of every token's JTI and rejects subsequent
// presentations of the same JTI within the token's TTL.
type jtiTracker struct {
	redis    jtiRedis
	log      zerolog.Logger
	failOpen bool
	audit    auditEmitter
}

func newJTITracker(redis jtiRedis, log zerolog.Logger, failOpen bool, emitter auditEmitter) (*jtiTracker, error) {
	if redis == nil {
		return nil, errors.New("jti tracker requires redis")
	}
	return &jtiTracker{redis: redis, log: log, failOpen: failOpen, audit: emitter}, nil
}

// Check records the JTI as seen with TTL = time-until-exp. Returns true when the
// caller may proceed (first use or session mandate).
// Returns false on a confirmed replay of a resource mandate, after emitting a
// replay_detected audit event. Errors talking to Redis are governed by failOpen:
// when false (production default) the request is rejected so a flaky Redis cannot
// silently widen the replay window; when true the request proceeds and the error
// is logged.
//
// Session mandates are explicitly reusable because their only valid audience is
// STS exchange. Resource mandates are minted for resource execution and must not
// be re-presented; replay protection only fires for those.
func (t *jtiTracker) Check(ctx context.Context, jti string, exp time.Time, use, requestID, resource, zoneID, clientID, subjectFP string) bool {
	if jti == "" {
		return true
	}
	if use == "session" {
		return true
	}
	ttl := time.Until(exp)
	if ttl <= 0 {
		return true
	}
	created, err := t.redis.SetNXTTL(ctx, seenJTIPrefix+jti, requestID, ttl)
	if err != nil {
		t.log.Warn().Err(err).Bool("fail_open", t.failOpen).Str("jti", jti).Msg("jti tracker setnx failed")
		return t.failOpen
	}
	if created {
		return true
	}
	id, err := uuid.NewV7()
	if err != nil {
		t.log.Error().Err(err).Str("jti", jti).Msg("replay_detected audit id generation failed")
		return false
	}
	meta, _ := json.Marshal(map[string]any{
		"jti":        jti,
		"resource":   resource,
		"client_id":  clientID,
		"subject_fp": subjectFP,
		"request_id": requestID,
	})
	// The durable audit client signs the event and falls back to disk replay when the
	// stream is unreachable, so a replay anomaly record survives a Redis outage.
	if t.audit != nil {
		t.audit.Emit(buildReplayAudit(id.String(), zoneID, requestID, meta, time.Now().UTC()))
	}
	t.log.Warn().Str("jti", jti).Str("resource", resource).Str("client_id", clientID).Msg("jti replay rejected")
	return false
}

func buildReplayAudit(id, zoneID, requestID string, meta json.RawMessage, occurredAt time.Time) audit.Event {
	return audit.Event{
		ID:                      id,
		ZoneID:                  zoneID,
		EventType:               "replay_detected",
		RequestID:               requestID,
		Decision:                "deny",
		EvaluationStatus:        "anomaly",
		DeterminingPoliciesJSON: json.RawMessage(`[]`),
		DiagnosticsJSON:         json.RawMessage(`[]`),
		MetadataJSON:            meta,
		OccurredAt:              occurredAt,
	}
}

// jwtJTI extracts the jti claim from a JWT without verifying its signature. Used in
// the gateway's pre-flight pass alongside jwtExp; STS remains the trust root.
func jwtJTI(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var claims struct {
		Jti string `json:"jti"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return ""
	}
	return claims.Jti
}

// jwtUse extracts the use claim ("session" or "resource") without signature
// verification. Used to gate replay tracking; the trust root is STS validation
// when the bearer is exchanged.
func jwtUse(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var claims struct {
		Use string `json:"use"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return ""
	}
	return claims.Use
}
