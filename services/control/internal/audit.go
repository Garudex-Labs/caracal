// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Audit emit sink for the control surface: every invoke decision is logged to caracal.audit.events as a control.invoke event.

package internal

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"time"

	"github.com/garudex-labs/caracal/core/audit"
	"github.com/garudex-labs/caracal/core/config"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
)

type AuditEvent struct {
	At        time.Time `json:"at"`
	ZoneID    string    `json:"zone_id,omitempty"`
	ClientID  string    `json:"client_id,omitempty"`
	Subject   string    `json:"subject"`
	JTI       string    `json:"jti"`
	Command   string    `json:"command"`
	Sub       string    `json:"subcommand,omitempty"`
	Decision  string    `json:"decision"`
	Reason    string    `json:"reason,omitempty"`
	RequestID string    `json:"request_id,omitempty"`
}

type EventSink interface {
	Emit(ev AuditEvent)
}

type logSink struct{ log zerolog.Logger }

func (s *logSink) Emit(ev AuditEvent) {
	b, _ := json.Marshal(ev)
	s.log.Info().RawJSON("event", b).Str("stream", "caracal.audit.events").Str("type", "control.invoke").Msg("audit")
}

type redisSink struct {
	client *redis.Client
	key    []byte
	log    zerolog.Logger
}

func NewEventSink(ctx context.Context, log zerolog.Logger) (EventSink, error) {
	config.ResolveFileSecrets("CONTROL_REDIS_URL", "AUDIT_HMAC_KEY")
	url := os.Getenv("CONTROL_REDIS_URL")
	if url == "" {
		if config.Mode() == "runtime" {
			return nil, errors.New("CONTROL_REDIS_URL is required for control audit when CARACAL_MODE=runtime")
		}
		log.Warn().Msg("control audit sink: log-only")
		return &logSink{log: log}, nil
	}
	key, err := auditKey(config.Mode() == "runtime")
	if err != nil {
		return nil, err
	}
	opt, err := redis.ParseURL(url)
	if err != nil {
		return nil, err
	}
	client := redis.NewClient(opt)
	if err := client.Ping(ctx).Err(); err != nil {
		return nil, err
	}
	return &redisSink{client: client, key: key, log: log}, nil
}

func auditKey(required bool) ([]byte, error) {
	raw := os.Getenv("AUDIT_HMAC_KEY")
	if raw == "" {
		if required {
			return nil, errors.New("AUDIT_HMAC_KEY is required when CARACAL_MODE=runtime")
		}
		return nil, nil
	}
	key, err := hex.DecodeString(raw)
	if err != nil || len(key) < 32 {
		return nil, errors.New("AUDIT_HMAC_KEY must be hex-encoded with at least 32 bytes")
	}
	return key, nil
}

func (s *redisSink) Emit(ev AuditEvent) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	values := buildControlAudit(ev, s.key)
	if err := s.client.XAdd(ctx, &redis.XAddArgs{Stream: audit.DefaultStream, Values: values}).Err(); err != nil {
		s.log.Error().Err(err).Str("request_id", ev.RequestID).Msg("control audit emit failed")
	}
}

func buildControlAudit(ev AuditEvent, key []byte) map[string]any {
	id := ev.RequestID
	if id == "" {
		id = newRequestID()
	}
	zoneID := ev.ZoneID
	if zoneID == "" {
		zoneID = "unknown"
	}
	metadata, _ := json.Marshal(map[string]any{
		"subject":    ev.Subject,
		"jti":        ev.JTI,
		"client_id":  ev.ClientID,
		"command":    ev.Command,
		"subcommand": ev.Sub,
		"reason":     ev.Reason,
	})
	event := audit.Event{
		ID:                      id,
		ZoneID:                  zoneID,
		EventType:               "control.invoke",
		RequestID:               ev.RequestID,
		Decision:                ev.Decision,
		EvaluationStatus:        "complete",
		DeterminingPoliciesJSON: json.RawMessage(`[]`),
		DiagnosticsJSON:         json.RawMessage(`[]`),
		MetadataJSON:            metadata,
		OccurredAt:              ev.At,
	}
	if event.OccurredAt.IsZero() {
		event.OccurredAt = time.Now().UTC()
	}
	data, _ := json.Marshal(event)
	values := map[string]any{"id": id, "data": string(data)}
	if len(key) > 0 {
		mac := hmac.New(sha256.New, key)
		mac.Write(data)
		values["sig"] = hex.EncodeToString(mac.Sum(nil))
	}
	return values
}

func NewLogEventSink(log zerolog.Logger) EventSink {
	return &logSink{log: log}
}
