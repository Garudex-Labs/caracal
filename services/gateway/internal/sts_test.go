// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for STS exchange outcomes.

package internal

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSTSExchangeReturnsOutcomeForTransportError(t *testing.T) {
	c := newSTSClient("http://127.0.0.1:1", 100*time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	outcome := c.Exchange(ctx, "tok", binding{ZoneID: "z", ApplicationID: "a"}, "r", "rid")
	if outcome == nil {
		t.Fatal("expected exchange outcome")
	}
	if outcome.InternalError == nil {
		t.Fatal("expected transport error")
	}
	if outcome.BusinessError == nil {
		t.Fatal("expected sanitised CaracalError")
	}
	if outcome.StatusCode < 500 {
		t.Fatalf("transport failure should map to 5xx, got %d", outcome.StatusCode)
	}
	if strings.Contains(outcome.BusinessError.Description, "127.0.0.1") {
		t.Fatalf("internal address leaked: %s", outcome.BusinessError.Description)
	}
	if outcome.Result != nil {
		t.Fatal("result must be nil on transport error")
	}
}

func TestSTSExchangeReturnsOutcomeResultOnSuccess(t *testing.T) {
	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"sts-token","expires_in":300,"upstreams":{"r1":{"url":"https://api.example.com","auth_mode":"caracal_jwt"}}}`))
	}))
	defer sts.Close()

	c := newSTSClient(sts.URL, 200*time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	outcome := c.Exchange(ctx, "tok", binding{ZoneID: "z", ApplicationID: "a"}, "r1", "rid")
	if outcome == nil {
		t.Fatal("expected exchange outcome")
	}
	if outcome.BusinessError != nil || outcome.InternalError != nil {
		t.Fatalf("unexpected errors: business=%v internal=%v", outcome.BusinessError, outcome.InternalError)
	}
	if outcome.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want %d", outcome.StatusCode, http.StatusOK)
	}
	if outcome.Result == nil {
		t.Fatal("expected result")
	}
	if outcome.Result.AccessToken != "sts-token" {
		t.Fatalf("access token = %q", outcome.Result.AccessToken)
	}
	if outcome.Result.Upstream.URL != "https://api.example.com" {
		t.Fatalf("upstream url = %q", outcome.Result.Upstream.URL)
	}
}
