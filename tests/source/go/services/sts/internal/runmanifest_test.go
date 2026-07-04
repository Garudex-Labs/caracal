// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for the run manifest endpoint: authentication, enumeration resistance, and manifest shape.

package internal

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func runManifestRequest(t *testing.T, srv *Server, form url.Values) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/run/manifest", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	w := httptest.NewRecorder()
	srv.handleRunManifest(w, req)
	return w
}

func runManifestServer(t *testing.T, db *stubDB) (*Server, string) {
	t.Helper()
	hash, err := hashClientSecret("cs_good")
	if err != nil {
		t.Fatalf("hash secret: %v", err)
	}
	if db.app != nil && db.app.ClientSecretHash == nil {
		db.app.ClientSecretHash = &hash
	}
	return &Server{db: db, redis: newMemSTSRedis()}, "cs_good"
}

func TestRunManifestRequiresCredentials(t *testing.T) {
	srv, _ := runManifestServer(t, &stubDB{})
	w := runManifestRequest(t, srv, url.Values{"application_id": {"app-1"}})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestRunManifestOpaqueAuthFailures(t *testing.T) {
	manifest := []byte(`{"credentials":[{"env":"PIPERNET_TOKEN","resource":"resource://pipernet"}]}`)
	cases := []struct {
		name string
		db   *stubDB
	}{
		{"unknown application", &stubDB{appErr: errors.New("no rows"), runManifest: manifest}},
		{"nil secret hash", &stubDB{app: &Application{ID: "app-1", ZoneID: "z1"}, runManifest: manifest}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := &Server{db: tc.db, redis: newMemSTSRedis()}
			w := runManifestRequest(t, srv, url.Values{"application_id": {"app-1"}, "client_secret": {"cs_good"}})
			if w.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401", w.Code)
			}
			if !strings.Contains(w.Body.String(), "invalid application credentials") {
				t.Fatalf("want opaque credential error, got %s", w.Body.String())
			}
		})
	}
}

func TestRunManifestRejectsWrongSecret(t *testing.T) {
	db := &stubDB{app: &Application{ID: "app-1", ZoneID: "z1"}}
	srv, _ := runManifestServer(t, db)
	w := runManifestRequest(t, srv, url.Values{"application_id": {"app-1"}, "client_secret": {"cs_wrong"}})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
}

func TestRunManifestNotConfigured(t *testing.T) {
	db := &stubDB{app: &Application{ID: "app-1", ZoneID: "z1"}}
	srv, secret := runManifestServer(t, db)
	w := runManifestRequest(t, srv, url.Values{"application_id": {"app-1"}, "client_secret": {secret}})
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
	if !strings.Contains(w.Body.String(), "run manifest not configured") {
		t.Fatalf("want not-configured error, got %s", w.Body.String())
	}
}

func TestRunManifestSuccess(t *testing.T) {
	db := &stubDB{
		app: &Application{ID: "app-1", ZoneID: "z1"},
		runManifest: []byte(`{
			"ttl_seconds": 300,
			"continue_on_failure": false,
			"credentials": [
				{"env": "PIPERNET_TOKEN", "resource": "resource://pipernet"},
				{"env": "HOOLIBOX_TOKEN", "resource": "resource://hoolibox", "credential_type": "caracal_mandate", "optional": true, "on_failure": "warn"}
			]
		}`),
	}
	srv, secret := runManifestServer(t, db)
	w := runManifestRequest(t, srv, url.Values{"application_id": {"app-1"}, "client_secret": {secret}})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, w.Body.String())
	}
	var resp RunManifestResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if resp.ZoneID != "z1" || resp.ApplicationID != "app-1" {
		t.Fatalf("identity mismatch: %+v", resp)
	}
	if resp.TTLSeconds == nil || *resp.TTLSeconds != 300 {
		t.Fatalf("ttl mismatch: %+v", resp.TTLSeconds)
	}
	if len(resp.Credentials) != 2 {
		t.Fatalf("want 2 credentials, got %d", len(resp.Credentials))
	}
	if resp.Credentials[1].CredentialType != "caracal_mandate" || !resp.Credentials[1].Optional || resp.Credentials[1].OnFailure != "warn" {
		t.Fatalf("optional credential mismatch: %+v", resp.Credentials[1])
	}
}

func TestRunManifestFailsClosedWithoutRedis(t *testing.T) {
	srv := &Server{db: &stubDB{}, redis: nil}
	w := runManifestRequest(t, srv, url.Values{"application_id": {"app-1"}, "client_secret": {"cs_good"}})
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", w.Code)
	}
}
