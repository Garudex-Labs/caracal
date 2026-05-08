// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// JTI replay tracker: SETNX-based per-token use marker that emits audit events on duplicate use.

package internal

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog"
)

const (
	seenJTIPrefix = "seen:jti:"
	auditStream   = "caracal.audit.events"
)

// jtiTracker records the first use of every token's JTI and emits a replay_detected
// audit event when the same JTI is presented a second time within the token's TTL.
// A nil tracker is a no-op so deployments without REDIS_URL still serve traffic.
type jtiTracker struct {
	redis *RedisClient
	log   zerolog.Logger
}

func newJTITracker(redis *RedisClient, log zerolog.Logger) *jtiTracker {
	if redis == nil {
		return nil
	}
	return &jtiTracker{redis: redis, log: log}
}

// Observe records the JTI as seen with TTL = time-until-exp. When SETNX fails because
// the key already exists, the use is treated as a replay: an audit event is XAdded to
// the standard audit stream and the gateway continues serving (signature/expiry
// remain the primary access controls). Errors talking to Redis are logged but never
// block the request.
func (t *jtiTracker) Observe(ctx context.Context, jti string, exp time.Time, requestID, resource, clientID, subjectFP string) {
	if t == nil || jti == "" {
		return
	}
	ttl := time.Until(exp)
	if ttl <= 0 {
		return
	}
	created, err := t.redis.SetNXTTL(ctx, seenJTIPrefix+jti, requestID, ttl)
	if err != nil {
		t.log.Warn().Err(err).Str("jti", jti).Msg("jti tracker setnx failed")
		return
	}
	if created {
		return
	}
	id, _ := uuid.NewV7()
	meta, _ := json.Marshal(map[string]interface{}{
		"jti":        jti,
		"resource":   resource,
		"client_id":  clientID,
		"subject_fp": subjectFP,
		"request_id": requestID,
	})
	values := map[string]interface{}{
		"id": id.String(),
		"data": string(mustMarshal(map[string]interface{}{
			"id":                id.String(),
			"event_type":        "replay_detected",
			"request_id":        requestID,
			"decision":          "warn",
			"evaluation_status": "anomaly",
			"metadata_json":     json.RawMessage(meta),
			"occurred_at":       time.Now().UTC().Format(time.RFC3339Nano),
		})),
	}
	if err := t.redis.XAdd(ctx, auditStream, values); err != nil {
		t.log.Error().Err(err).Str("jti", jti).Msg("replay_detected audit emit failed")
		return
	}
	t.log.Warn().Str("jti", jti).Str("resource", resource).Str("client_id", clientID).Msg("jti replay detected")
}

func mustMarshal(v interface{}) []byte {
	b, _ := json.Marshal(v)
	return b
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
