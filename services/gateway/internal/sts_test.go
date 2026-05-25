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

	corests "github.com/garudex-labs/caracal/packages/core/go/sts"
)

func TestSTSClientHealthAcceptsHealthySTS(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			t.Fatalf("unexpected path %q", r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	client := newSTSClient(srv.URL, time.Second, nil)
	if err := client.Health(context.Background()); err != nil {
		t.Fatalf("expected healthy STS, got %v", err)
	}
}

func TestSTSClientHealthRejectsUnhealthySTS(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	client := newSTSClient(srv.URL, time.Second, nil)
	if err := client.Health(context.Background()); err == nil {
		t.Fatal("expected unhealthy STS to fail readiness")
	}
}

func TestSTSClientSignsGatewayExchange(t *testing.T) {
	key := []byte("12345678901234567890123456789012")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/oauth/2/token" {
			t.Fatalf("unexpected path %q", r.URL.Path)
		}
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse form: %v", err)
		}
		if err := corests.VerifyGatewayExchange(
			key,
			time.Now().UTC(),
			time.Minute,
			r.Header.Get(corests.GatewayTimestampHeader),
			r.Header.Get(corests.GatewayRequestHeader),
			r.Header.Get(corests.GatewaySignatureHeader),
			r.Method,
			r.URL.EscapedPath(),
			[]byte(r.PostForm.Encode()),
		); err != nil {
			t.Fatalf("gateway exchange signature invalid: %v", err)
		}
		resource := r.Form.Get("resource")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"tok","token_type":"Bearer","expires_in":60,"issued_token_type":"urn:ietf:params:oauth:token-type:access_token","upstreams":{"` + resource + `":{"url":"https://upstream.example","auth_mode":"caracal_jwt"}}}`))
	}))
	defer srv.Close()

	client := newSTSClient(srv.URL, time.Second, key)
	out := client.Exchange(context.Background(), "subject", binding{ZoneID: "zone", ApplicationID: "app"}, "resource://api", "req-123")
	if out.ClientErr != nil || out.Result == nil {
		t.Fatalf("expected signed exchange success, got %#v", out)
	}
}
