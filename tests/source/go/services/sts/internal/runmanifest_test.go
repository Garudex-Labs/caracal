// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for the run manifest endpoint: workload authentication, enumeration resistance, and binding shape.

package internal

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/rs/zerolog"
)

func runManifestRequest(t *testing.T, srv *Server, form url.Values) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/run/manifest", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	srv.handleRunManifest(w, req)
	return w
}

func runWorkloadServer(t *testing.T, db *stubDB) (*Server, string) {
	t.Helper()
	hash, err := hashClientSecret("ws_good")
	if err != nil {
		t.Fatalf("hash secret: %v", err)
	}
	if db.workload != nil && db.workload.SecretHash == "" {
		db.workload.SecretHash = hash
	}
	srv := &Server{
		db:          db,
		redis:       newMemSTSRedis(),
		auditBuffer: &AuditBuffer{ch: make(chan AuditEvent, 100)},
		log:         zerolog.Nop(),
	}
	return srv, "ws_good"
}

func drainRunAudit(t *testing.T, srv *Server) *AuditEvent {
	t.Helper()
	select {
	case event := <-srv.auditBuffer.ch:
		return &event
	default:
		return nil
	}
}

func TestRunManifestRequiresCredentials(t *testing.T) {
	srv, _ := runWorkloadServer(t, &stubDB{})
	w := runManifestRequest(t, srv, url.Values{"workload_id": {"wl-1"}})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestRunManifestRequiresBodyOnlyFormEncoding(t *testing.T) {
	cases := []struct {
		name        string
		target      string
		contentType string
		body        string
		wantStatus  int
	}{
		{"query rejected", "/v1/run/manifest?workload_id=wl-1", "application/x-www-form-urlencoded", "secret=ws_good", http.StatusBadRequest},
		{"wrong content type", "/v1/run/manifest", "application/json", `{}`, http.StatusUnsupportedMediaType},
		{"duplicate workload", "/v1/run/manifest", "application/x-www-form-urlencoded", "workload_id=wl-1&workload_id=wl-2&secret=ws_good", http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, tc.target, strings.NewReader(tc.body))
			req.Header.Set("Content-Type", tc.contentType)
			w := httptest.NewRecorder()
			(&Server{}).handleRunManifest(w, req)
			if w.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d", w.Code, tc.wantStatus)
			}
		})
	}
}

func TestRunManifestOpaqueAuthFailures(t *testing.T) {
	bindings := []byte(`[{"env":"PIPERNET_TOKEN","resource":"resource://pipernet"}]`)
	cases := []struct {
		name string
		db   *stubDB
	}{
		{"unknown workload", &stubDB{workloadErr: errors.New("no rows")}},
		{"empty secret hash", &stubDB{workload: &Workload{ID: "wl-1", ZoneID: "z1", Bindings: bindings}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := &Server{
				db:          tc.db,
				redis:       newMemSTSRedis(),
				auditBuffer: &AuditBuffer{ch: make(chan AuditEvent, 100)},
				log:         zerolog.Nop(),
			}
			w := runManifestRequest(t, srv, url.Values{"workload_id": {"wl-1"}, "secret": {"ws_good"}})
			if w.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401", w.Code)
			}
			if !strings.Contains(w.Body.String(), "invalid workload credentials") {
				t.Fatalf("want opaque credential error, got %s", w.Body.String())
			}
			if event := drainRunAudit(t, srv); event != nil {
				t.Fatalf("unknown workloads cannot be zone attributed, got audit event %+v", event)
			}
		})
	}
}

func TestRunManifestRejectsWrongSecret(t *testing.T) {
	db := &stubDB{workload: &Workload{ID: "wl-1", ZoneID: "z1", Name: "Anton"}}
	srv, _ := runWorkloadServer(t, db)
	w := runManifestRequest(t, srv, url.Values{"workload_id": {"wl-1"}, "secret": {"ws_wrong"}})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
	event := drainRunAudit(t, srv)
	if event == nil {
		t.Fatal("want a workload_auth_failed audit event")
	}
	if event.EventType != "run_launch" || event.Decision != "deny" || event.EvaluationStatus != "workload_auth_failed" {
		t.Fatalf("audit event mismatch: %+v", event)
	}
	if event.ZoneID != "z1" {
		t.Fatalf("zone = %s, want z1", event.ZoneID)
	}
	var meta map[string]any
	if err := json.Unmarshal(event.MetadataJSON, &meta); err != nil {
		t.Fatalf("decode meta: %v", err)
	}
	if meta["workload_id"] != "wl-1" || meta["workload_name"] != "Anton" {
		t.Fatalf("meta mismatch: %+v", meta)
	}
}

func TestRunManifestNoBindings(t *testing.T) {
	db := &stubDB{workload: &Workload{ID: "wl-1", ZoneID: "z1"}}
	srv, secret := runWorkloadServer(t, db)
	w := runManifestRequest(t, srv, url.Values{"workload_id": {"wl-1"}, "secret": {secret}})
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
	if !strings.Contains(w.Body.String(), "no credential bindings configured") {
		t.Fatalf("want no-bindings error, got %s", w.Body.String())
	}
}

func TestRunManifestSuccess(t *testing.T) {
	db := &stubDB{
		workload: &Workload{
			ID:     "wl-1",
			ZoneID: "z1",
			Name:   "Anton",
			Bindings: []byte(`[
				{"env": "PIPERNET_TOKEN", "resource": "resource://pipernet", "scopes": ["pipernet:read"]},
				{"env": "HOOLIBOX_TOKEN", "resource": "resource://hoolibox", "optional": true, "on_failure": "warn"}
			]`),
		},
	}
	srv, secret := runWorkloadServer(t, db)
	w := runManifestRequest(t, srv, url.Values{"workload_id": {"wl-1"}, "secret": {secret}})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body.String())
	}
	var resp RunManifestResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.ZoneID != "z1" || resp.WorkloadID != "wl-1" {
		t.Fatalf("identity mismatch: %+v", resp)
	}
	if len(resp.Bindings) != 2 {
		t.Fatalf("want 2 bindings, got %d", len(resp.Bindings))
	}
	if resp.Bindings[0].Scopes[0] != "pipernet:read" {
		t.Fatalf("scopes mismatch: %+v", resp.Bindings[0])
	}
	if !resp.Bindings[1].Optional || resp.Bindings[1].OnFailure != "warn" {
		t.Fatalf("optional binding mismatch: %+v", resp.Bindings[1])
	}
	event := drainRunAudit(t, srv)
	if event == nil {
		t.Fatal("want a run_launch audit event")
	}
	if event.EventType != "run_launch" || event.Decision != "allow" || event.EvaluationStatus != "complete" || event.ZoneID != "z1" {
		t.Fatalf("audit event mismatch: %+v", event)
	}
	var meta map[string]any
	if err := json.Unmarshal(event.MetadataJSON, &meta); err != nil {
		t.Fatalf("decode meta: %v", err)
	}
	if meta["binding_count"] != float64(2) || meta["workload_name"] != "Anton" {
		t.Fatalf("meta mismatch: %+v", meta)
	}
}

func TestRunManifestLaunchCorrelation(t *testing.T) {
	db := &stubDB{
		workload: &Workload{
			ID:       "wl-1",
			ZoneID:   "z1",
			Name:     "Anton",
			Bindings: []byte(`[{"env": "PIPERNET_TOKEN", "resource": "resource://pipernet"}]`),
		},
	}
	srv, secret := runWorkloadServer(t, db)
	form := url.Values{"workload_id": {"wl-1"}, "secret": {secret}}

	req := httptest.NewRequest(http.MethodPost, "/v1/run/manifest", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("X-Caracal-Launch-Id", "0190a1b2-0000-7000-8000-000000000001")
	w := httptest.NewRecorder()
	srv.handleRunManifest(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body.String())
	}
	event := drainRunAudit(t, srv)
	if event == nil {
		t.Fatal("want a run_launch audit event")
	}
	var meta map[string]any
	if err := json.Unmarshal(event.MetadataJSON, &meta); err != nil {
		t.Fatalf("decode meta: %v", err)
	}
	if meta["launch_id"] != "0190a1b2-0000-7000-8000-000000000001" {
		t.Fatalf("launch id missing from meta: %+v", meta)
	}

	req = httptest.NewRequest(http.MethodPost, "/v1/run/manifest", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("X-Caracal-Launch-Id", "not-a-uuid")
	w = httptest.NewRecorder()
	srv.handleRunManifest(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body.String())
	}
	event = drainRunAudit(t, srv)
	if event == nil {
		t.Fatal("want a run_launch audit event")
	}
	meta = nil
	if err := json.Unmarshal(event.MetadataJSON, &meta); err != nil {
		t.Fatalf("decode meta: %v", err)
	}
	if _, present := meta["launch_id"]; present {
		t.Fatalf("malformed launch id must be dropped, got %+v", meta)
	}
}

func TestRunManifestFailsClosedWithoutRedis(t *testing.T) {
	srv := &Server{db: &stubDB{}, redis: nil}
	w := runManifestRequest(t, srv, url.Values{"workload_id": {"wl-1"}, "secret": {"ws_good"}})
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", w.Code)
	}
}
