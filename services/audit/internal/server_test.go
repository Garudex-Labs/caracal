// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Audit service HTTP probe and metrics tests.

package internal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
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
	if body["ready"] != false || body["reason"] != "redis_unreachable" {
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
	s.pelOldestAge.Store(30)
	s.dlqSize.Store(3)
	s.dlqOldestAge.Store(60)

	w := httptest.NewRecorder()
	s.handleMetrics(w, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["consumer_lag"] != float64(7) || body["dlq_size"] != float64(3) || body["dlq_oldest_age_secs"] != float64(60) {
		t.Fatalf("missing backlog metrics: %#v", body)
	}
}
