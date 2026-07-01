// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for request-id and traceparent propagation invariants.

package internal

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"testing"

	corests "github.com/garudex-labs/caracal/packages/core/go/sts"
)

var traceparentPattern = regexp.MustCompile(`^00-[0-9a-f]{32}-[0-9a-f]{16}-01$`)

func TestNewTraceparent(t *testing.T) {
	t.Parallel()

	a := newTraceparent()
	b := newTraceparent()
	if a == b {
		t.Error("traceparents collided")
	}
	for _, got := range []string{a, b} {
		if !traceparentPattern.MatchString(got) {
			t.Fatalf("traceparent %q does not match W3C format", got)
		}
	}
}

func TestRequestIDMiddlewarePreservesOpaqueIDs(t *testing.T) {
	t.Parallel()

	want := "customer_request_42"
	var captured string
	h := requestIDMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured = requestIDFromContext(r.Context())
	}))
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("X-Request-Id", want)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if captured != want {
		t.Errorf("got %q, want %q", captured, want)
	}
	if w.Header().Get("X-Request-Id") != want {
		t.Errorf("response X-Request-Id = %q, want %q", w.Header().Get("X-Request-Id"), want)
	}
}

func TestBuildUpstreamRequestGeneratesValidTraceparentForOpaqueRequestID(t *testing.T) {
	t.Parallel()

	upstreamReq, err := buildUpstreamRequest(
		httptest.NewRequest(http.MethodPost, "https://gateway.example.com/v1/messages?foo=bar", nil),
		mustParseURL(t, "https://api.example.com/base"),
		"caracal-token",
		corests.UpstreamDirective{},
		http.NoBody,
		"customer_request_42",
	)
	if err != nil {
		t.Fatalf("buildUpstreamRequest: %v", err)
	}
	got := upstreamReq.Header.Get("Traceparent")
	if !traceparentPattern.MatchString(got) {
		t.Fatalf("Traceparent %q does not match W3C format", got)
	}
	if upstreamReq.Header.Get("X-Request-Id") != "customer_request_42" {
		t.Fatalf("X-Request-Id = %q, want opaque request id preserved", upstreamReq.Header.Get("X-Request-Id"))
	}
}

func TestBuildUpstreamRequestPreservesInboundTraceparent(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequest(http.MethodGet, "https://gateway.example.com/v1/messages", nil)
	want := "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
	req.Header.Set("Traceparent", want)

	upstreamReq, err := buildUpstreamRequest(
		req,
		mustParseURL(t, "https://api.example.com"),
		"caracal-token",
		corests.UpstreamDirective{},
		http.NoBody,
		"customer_request_42",
	)
	if err != nil {
		t.Fatalf("buildUpstreamRequest: %v", err)
	}
	if got := upstreamReq.Header.Get("Traceparent"); got != want {
		t.Fatalf("Traceparent = %q, want %q", got, want)
	}
}

func mustParseURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse url %q: %v", raw, err)
	}
	return u
}
