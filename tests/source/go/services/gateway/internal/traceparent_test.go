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
		corests.UpstreamDirective{AuthMode: "none"},
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
		corests.UpstreamDirective{AuthMode: "none"},
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

func TestValidTraceparent(t *testing.T) {
	t.Parallel()

	valid := []string{
		"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
		"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
		// A higher version may append fields; the leading fields still parse.
		"01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra",
	}
	for _, tp := range valid {
		if !validTraceparent(tp) {
			t.Errorf("validTraceparent(%q) = false, want true", tp)
		}
	}

	invalid := []string{
		"",
		"customer_request_42",
		"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7",      // missing flags
		"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-x", // version 00 with trailing field
		"00-00000000000000000000000000000000-00f067aa0ba902b7-01",   // zero trace-id
		"00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",   // zero parent-id
		"00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01",   // uppercase hex
		"00-4bf92f3577b34da6-00f067aa0ba902b7-01",                   // short trace-id
		"ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",   // reserved version
	}
	for _, tp := range invalid {
		if validTraceparent(tp) {
			t.Errorf("validTraceparent(%q) = true, want false", tp)
		}
	}
}

func TestTraceIDFromTraceparent(t *testing.T) {
	t.Parallel()

	got := traceIDFromTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
	if want := "4bf92f3577b34da6a3ce929d0e0e4736"; got != want {
		t.Errorf("traceIDFromTraceparent = %q, want %q", got, want)
	}
}

func TestBuildUpstreamRequestRegeneratesMalformedInboundTraceparent(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequest(http.MethodGet, "https://gateway.example.com/v1/messages", nil)
	req.Header.Set("Traceparent", "customer_request_42")

	upstreamReq, err := buildUpstreamRequest(
		req,
		mustParseURL(t, "https://api.example.com"),
		"caracal-token",
		corests.UpstreamDirective{AuthMode: "none"},
		http.NoBody,
		"customer_request_42",
	)
	if err != nil {
		t.Fatalf("buildUpstreamRequest: %v", err)
	}
	got := upstreamReq.Header.Get("Traceparent")
	if got == "customer_request_42" {
		t.Fatal("malformed inbound Traceparent was forwarded unchanged")
	}
	if !traceparentPattern.MatchString(got) {
		t.Fatalf("regenerated Traceparent %q does not match W3C format", got)
	}
}

func TestBuildUpstreamRequestPreservesFutureVersionTraceparent(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequest(http.MethodGet, "https://gateway.example.com/v1/messages", nil)
	want := "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra"
	req.Header.Set("Traceparent", want)

	upstreamReq, err := buildUpstreamRequest(
		req,
		mustParseURL(t, "https://api.example.com"),
		"caracal-token",
		corests.UpstreamDirective{AuthMode: "none"},
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
