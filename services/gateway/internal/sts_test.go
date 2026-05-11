// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Gateway STS client tests for readiness health checks.

package internal

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestSTSClientHealthAcceptsHealthySTS(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			t.Fatalf("unexpected path %q", r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	client := newSTSClient(srv.URL, time.Second)
	if err := client.Health(context.Background()); err != nil {
		t.Fatalf("expected healthy STS, got %v", err)
	}
}

func TestSTSClientHealthRejectsUnhealthySTS(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	client := newSTSClient(srv.URL, time.Second)
	if err := client.Health(context.Background()); err == nil {
		t.Fatal("expected unhealthy STS to fail readiness")
	}
}
