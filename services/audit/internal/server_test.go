// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Audit service HTTP probe, metrics, and search endpoint tests.

package internal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func TestRedisIDAgeSeconds(t *testing.T) {
	now := time.UnixMilli(1_000_000)
	if got := redisIDAgeSeconds("990000-0", now); got != 10 {
		t.Fatalf("age = %d, want 10", got)
	}
	if got := redisIDAgeSeconds("bad", now); got != 0 {
		t.Fatalf("bad id age = %d, want 0", got)
	}
}

func TestReadyFailureReturnsReason(t *testing.T) {
	w := httptest.NewRecorder()
	writeReadyFailure(w, "redis_unreachable")
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", w.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["ok"] != false || body["ready"] != false || body["reason"] != "redis_unreachable" {
		t.Fatalf("unexpected body: %#v", body)
	}
}

func TestMetricsExposeAuditBacklogFields(t *testing.T) {
	s := &Server{
		consumer:     &Consumer{},
		sweeper:      &TamperSweeper{},
		retention:    &Retention{},
		exporterLead: &Leader{},
		retentLead:   &Leader{},
	}
	s.consumerLag.Store(7)
	s.exportBacklog.Store(2)
	s.pelOldestAge.Store(30)
	s.dlqSize.Store(3)
	s.dlqOldestAge.Store(60)
	s.cfg.MetricsBearer = "secret"

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	req.Header.Set("Authorization", "Bearer secret")
	s.handleMetrics(w, req)
	body := w.Body.String()
	if w.Header().Get("Content-Type") != "text/plain; version=0.0.4; charset=utf-8" {
		t.Fatalf("content-type = %q", w.Header().Get("Content-Type"))
	}
	for _, want := range []string{
		"caracal_audit_consumer_lag 7",
		"caracal_audit_export_backlog_hours 2",
		"caracal_audit_dlq_size 3",
		"caracal_audit_dlq_oldest_age_seconds 60",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("missing %q in metrics:\n%s", want, body)
		}
	}
}

func TestMetricsJSONPreservesCompatibilityFields(t *testing.T) {
	s := &Server{
		consumer:     &Consumer{},
		sweeper:      &TamperSweeper{},
		retention:    &Retention{},
		exporterLead: &Leader{},
		retentLead:   &Leader{},
	}
	s.consumerLag.Store(7)
	s.exportBacklog.Store(2)
	s.dlqSize.Store(3)
	s.dlqOldestAge.Store(60)
	s.cfg.MetricsBearer = "secret"

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/metrics.json", nil)
	req.Header.Set("Authorization", "Bearer secret")
	s.handleMetricsJSON(w, req)
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["consumer_lag"] != float64(7) || body["export_backlog_hours"] != float64(2) || body["dlq_size"] != float64(3) || body["dlq_oldest_age_secs"] != float64(60) {
		t.Fatalf("missing backlog metrics: %#v", body)
	}
}

func searchServer(adminToken string) *Server {
	s := &Server{
		consumer:     &Consumer{},
		sweeper:      &TamperSweeper{},
		retention:    &Retention{},
		exporterLead: &Leader{},
		retentLead:   &Leader{},
	}
	s.cfg.AdminToken = adminToken
	return s
}

func TestSearchDisabledWithoutAdminToken(t *testing.T) {
	s := searchServer("")
	w := httptest.NewRecorder()
	s.handleSearch(w, httptest.NewRequest(http.MethodGet, "/api/audit/search?zone_id=z1", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
}

func TestSearchRejectsWrongBearer(t *testing.T) {
	s := searchServer("correct-token")
	req := httptest.NewRequest(http.MethodGet, "/api/audit/search?zone_id=z1", nil)
	req.Header.Set("Authorization", "Bearer wrong-token")
	w := httptest.NewRecorder()
	s.handleSearch(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
	if w.Header().Get("WWW-Authenticate") == "" {
		t.Fatal("missing WWW-Authenticate header")
	}
}

func TestSearchRejectsMissingZoneID(t *testing.T) {
	s := searchServer("tok")
	req := httptest.NewRequest(http.MethodGet, "/api/audit/search", nil)
	req.Header.Set("Authorization", "Bearer tok")
	w := httptest.NewRecorder()
	s.handleSearch(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestDLQReplayDisabledWithoutAdminToken(t *testing.T) {
	s := searchServer("")
	w := httptest.NewRecorder()
	s.handleDLQReplay(w, httptest.NewRequest(http.MethodPost, "/api/audit/dlq/replay", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
}

func TestDLQReplayFieldsRestoresAuditMessage(t *testing.T) {
	fields, ok := dlqReplayFields(map[string]any{
		"reason":   "transient_exceeded_max_deliveries:connection refused",
		"src_data": `{"id":"event-1","zone_id":"zone-1"}`,
		"src_sig":  "abc123",
	})
	if !ok {
		t.Fatal("expected replayable DLQ entry")
	}
	if fields["data"] != `{"id":"event-1","zone_id":"zone-1"}` || fields["sig"] != "abc123" {
		t.Fatalf("unexpected fields: %#v", fields)
	}
}

func TestDLQReplayFieldsSkipsMalformedEntry(t *testing.T) {
	if _, ok := dlqReplayFields(map[string]any{"reason": "missing_data_field"}); ok {
		t.Fatal("malformed DLQ entry must not be replayable")
	}
	if _, ok := dlqReplayFields(map[string]any{
		"reason":   "hmac_verify_failed",
		"src_data": `{"id":"event-1","zone_id":"zone-1"}`,
	}); ok {
		t.Fatal("HMAC failure must stay in DLQ for forensic review")
	}
}

func TestDLQEntryFromMessageSummarizesReplayableEvent(t *testing.T) {
	msg := redis.XMessage{
		ID: "1760000000000-0",
		Values: map[string]any{
			"reason":      "transient_exceeded_max_deliveries:connection refused",
			"src_id":      "1759999999000-0",
			"received_at": "1760000000000",
			"src_sig":     "abc123",
			"src_data":    `{"id":"event-1","zone_id":"zone-1","event_type":"token_exchange","request_id":"req-1","decision":"allow","evaluation_status":"complete","determining_policies_json":[],"diagnostics_json":[],"occurred_at":"2026-01-01T00:00:00Z"}`,
		},
	}

	entry := dlqEntryFromMessage(msg, time.UnixMilli(1760000005000), true)
	if !entry.Replayable {
		t.Fatal("expected replayable DLQ entry")
	}
	if entry.EventID != "event-1" || entry.ZoneID != "zone-1" || entry.RequestID != "req-1" {
		t.Fatalf("unexpected event summary: %#v", entry)
	}
	if entry.SourceEvent == nil || entry.Fields["src_sig"] != "abc123" {
		t.Fatalf("expected detail fields and source event: %#v", entry)
	}
	if entry.ReceivedAt == "" || entry.AgeSeconds != 5 {
		t.Fatalf("unexpected timing fields: %#v", entry)
	}
}

func TestMetricsFailClosedWithoutBearerInPublishedMode(t *testing.T) {
	s := &Server{}
	s.cfg.Mode = "stable"
	w := httptest.NewRecorder()
	s.handleMetrics(w, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("published audit metrics without bearer must be 401, got %d", w.Code)
	}
	w = httptest.NewRecorder()
	s.handleMetricsJSON(w, httptest.NewRequest(http.MethodGet, "/metrics.json", nil))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("published audit metrics.json without bearer must be 401, got %d", w.Code)
	}
}
