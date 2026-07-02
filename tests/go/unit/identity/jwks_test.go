// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// JWKS cache tests for fetch, TTL caching, and cache reset behavior.

package identity_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/garudex-labs/caracal/packages/identity/go"
)

func TestGetJWKSFetchesFromWellKnownEndpoint(t *testing.T) {
	identity.ResetJWKSCache()
	var gotPath string
	var gotZone string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotZone = r.URL.Query().Get("zone_id")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []any{}})
	}))
	defer server.Close()

	_, err := identity.GetJWKS(server.URL, "zone1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotPath != "/.well-known/jwks.json" {
		t.Fatalf("expected /.well-known/jwks.json, got %q", gotPath)
	}
	if gotZone != "zone1" {
		t.Fatalf("expected zone_id=zone1, got %q", gotZone)
	}
}

func TestGetJWKSRequiresZone(t *testing.T) {
	identity.ResetJWKSCache()
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
	}))
	defer server.Close()

	if _, err := identity.GetJWKS(server.URL, ""); err == nil {
		t.Fatal("expected error for missing zone_id")
	}
	if calls != 0 {
		t.Fatalf("expected no fetch without zone_id, got %d", calls)
	}
}

func TestGetJWKSCachesPerZone(t *testing.T) {
	identity.ResetJWKSCache()
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []any{}})
	}))
	defer server.Close()

	if _, err := identity.GetJWKS(server.URL, "zone1"); err != nil {
		t.Fatalf("zone1 fetch failed: %v", err)
	}
	if _, err := identity.GetJWKS(server.URL, "zone2"); err != nil {
		t.Fatalf("zone2 fetch failed: %v", err)
	}

	if calls != 2 {
		t.Fatalf("expected separate fetches per zone, got %d", calls)
	}
}

func TestGetJWKSCachesResultAndSkipsRefetch(t *testing.T) {
	identity.ResetJWKSCache()
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []any{}})
	}))
	defer server.Close()

	if _, err := identity.GetJWKS(server.URL, "zone1"); err != nil {
		t.Fatalf("first fetch failed: %v", err)
	}
	if _, err := identity.GetJWKS(server.URL, "zone1"); err != nil {
		t.Fatalf("second fetch failed: %v", err)
	}

	if calls != 1 {
		t.Fatalf("expected 1 fetch, got %d", calls)
	}
}

func TestResetJWKSCacheForcesRefetch(t *testing.T) {
	identity.ResetJWKSCache()
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []any{}})
	}))
	defer server.Close()

	if _, err := identity.GetJWKS(server.URL, "zone1"); err != nil {
		t.Fatalf("first fetch failed: %v", err)
	}
	identity.ResetJWKSCache()
	if _, err := identity.GetJWKS(server.URL, "zone1"); err != nil {
		t.Fatalf("second fetch failed: %v", err)
	}

	if calls != 2 {
		t.Fatalf("expected 2 fetches after reset, got %d", calls)
	}
}

func TestGetJWKSContextHonorsDeadline(t *testing.T) {
	identity.ResetJWKSCache()
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
	}))
	defer server.Close()
	defer close(release)

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := identity.GetJWKSContext(ctx, server.URL, "zone1")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected deadline exceeded, got %v", err)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("fetch ignored the context deadline, took %v", elapsed)
	}
}

func TestGetJWKSRejectsNonOKStatus(t *testing.T) {
	identity.ResetJWKSCache()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()

	_, err := identity.GetJWKS(server.URL, "zone1")
	if err == nil {
		t.Fatal("expected error for 503 response")
	}
}

func TestGetJWKSRejectsInvalidJSON(t *testing.T) {
	identity.ResetJWKSCache()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("{not valid json"))
	}))
	defer server.Close()

	_, err := identity.GetJWKS(server.URL, "zone1")
	if err == nil {
		t.Fatal("expected error for malformed JSON response")
	}
}
