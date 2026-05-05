// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Gateway proxy security tests: SSRF protection, header isolation, URL validation.

package internal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

func TestParseApprovedUpstreamRejectsFileScheme(t *testing.T) {
	_, err := parseApprovedUpstream("file:///etc/passwd")
	if err == nil {
		t.Error("want error for file:// scheme")
	}
}

func TestParseApprovedUpstreamRejectsDataURI(t *testing.T) {
	_, err := parseApprovedUpstream("data:text/html,<script>alert(1)</script>")
	if err == nil {
		t.Error("want error for data: URI")
	}
}

func TestParseApprovedUpstreamRejectsFTPScheme(t *testing.T) {
	_, err := parseApprovedUpstream("ftp://internal.host/resource")
	if err == nil {
		t.Error("want error for ftp:// scheme")
	}
}

func TestParseApprovedUpstreamRejectsJavascriptScheme(t *testing.T) {
	_, err := parseApprovedUpstream("javascript:alert(1)")
	if err == nil {
		t.Error("want error for javascript: scheme")
	}
}

func TestParseApprovedUpstreamRejectsEmbeddedCredentials(t *testing.T) {
	_, err := parseApprovedUpstream("https://user:pass@internal.host/api")
	if err == nil {
		t.Error("want error for upstream URL with embedded credentials")
	}
}

func TestParseApprovedUpstreamRejectsEmptyURL(t *testing.T) {
	_, err := parseApprovedUpstream("")
	if err == nil {
		t.Error("want error for empty URL")
	}
}

func TestParseApprovedUpstreamRejectsMissingHost(t *testing.T) {
	_, err := parseApprovedUpstream("https:///path-only")
	if err == nil {
		t.Error("want error for URL without a host")
	}
}

func TestParseApprovedUpstreamAcceptsHTTP(t *testing.T) {
	u, err := parseApprovedUpstream("http://backend:8080/api")
	if err != nil {
		t.Fatalf("want valid URL, got: %v", err)
	}
	if u.Scheme != "http" || u.Host != "backend:8080" {
		t.Errorf("unexpected parsed URL: %v", u)
	}
}

func TestParseApprovedUpstreamAcceptsHTTPS(t *testing.T) {
	u, err := parseApprovedUpstream("https://api.example.com/v1")
	if err != nil {
		t.Fatalf("want valid URL, got: %v", err)
	}
	if u.Scheme != "https" {
		t.Errorf("want https, got %s", u.Scheme)
	}
}

func TestParseApprovedUpstreamStripsFragment(t *testing.T) {
	u, err := parseApprovedUpstream("https://api.example.com/v1#section")
	if err != nil {
		t.Fatalf("want valid URL, got: %v", err)
	}
	if u.Fragment != "" {
		t.Errorf("want fragment stripped, got %q", u.Fragment)
	}
}

func TestJoinURLPathBothNonEmpty(t *testing.T) {
	got := joinURLPath("/base", "/resource")
	if got != "/base/resource" {
		t.Errorf("want /base/resource, got %s", got)
	}
}

func TestJoinURLPathEmptyUpstream(t *testing.T) {
	if got := joinURLPath("", "/resource"); got != "/resource" {
		t.Errorf("want /resource, got %s", got)
	}
}

func TestJoinURLPathEmptyRequest(t *testing.T) {
	if got := joinURLPath("/base", ""); got != "/base" {
		t.Errorf("want /base, got %s", got)
	}
}

func TestJoinURLQueryBothNonEmpty(t *testing.T) {
	got := joinURLQuery("k1=v1", "k2=v2")
	if got != "k1=v1&k2=v2" {
		t.Errorf("want k1=v1&k2=v2, got %s", got)
	}
}

func TestJoinURLQueryEmptyUpstream(t *testing.T) {
	if got := joinURLQuery("", "k=v"); got != "k=v" {
		t.Errorf("want k=v, got %s", got)
	}
}

func TestJoinURLQueryEmptyRequest(t *testing.T) {
	if got := joinURLQuery("k=v", ""); got != "k=v" {
		t.Errorf("want k=v, got %s", got)
	}
}

func TestProxyStripsCaracalHeadersFromUpstreamRequest(t *testing.T) {
	var capturedHeaders http.Header
	upstreamServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedHeaders = r.Header.Clone()
		w.WriteHeader(http.StatusOK)
	}))
	defer upstreamServer.Close()

	stsServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"access_token":     "upstream-token",
			"target_upstreams": map[string]string{"resource://api/v1": upstreamServer.URL},
		})
	}))
	defer stsServer.Close()

	p := newProxy(newSTSClient(stsServer.URL), zerolog.Nop())
	req := httptest.NewRequest(http.MethodGet, "/path", nil)
	req.Header.Set("Authorization", "Bearer "+validFutureJWT())
	req.Header.Set("X-Caracal-Client-ID", "zone1:app1")
	req.Header.Set("X-Caracal-Resource", "resource://api/v1")
	rr := httptest.NewRecorder()
	p.ServeHTTP(rr, req)

	if capturedHeaders.Get("X-Caracal-Client-ID") != "" {
		t.Error("X-Caracal-Client-ID must be stripped before forwarding to upstream")
	}
	if capturedHeaders.Get("X-Caracal-Resource") != "" {
		t.Error("X-Caracal-Resource must be stripped before forwarding to upstream")
	}
	if capturedHeaders.Get("Authorization") != "Bearer upstream-token" {
		t.Errorf("upstream Authorization must be replaced by STS token, got %q", capturedHeaders.Get("Authorization"))
	}
}

func TestProxySetsAuthorizationToExchangedToken(t *testing.T) {
	var capturedAuth string
	upstreamServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
	}))
	defer upstreamServer.Close()

	stsServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"access_token":     "exchanged-123",
			"target_upstreams": map[string]string{"resource://svc": upstreamServer.URL},
		})
	}))
	defer stsServer.Close()

	p := newProxy(newSTSClient(stsServer.URL), zerolog.Nop())
	req := httptest.NewRequest(http.MethodPost, "/call", strings.NewReader("body"))
	req.Header.Set("Authorization", "Bearer "+validFutureJWT())
	req.Header.Set("X-Caracal-Client-ID", "zone1:app1")
	req.Header.Set("X-Caracal-Resource", "resource://svc")
	rr := httptest.NewRecorder()
	p.ServeHTTP(rr, req)

	if capturedAuth != "Bearer exchanged-123" {
		t.Errorf("want exchanged-123, got %q", capturedAuth)
	}
}

// validFutureJWT returns a minimal unsigned JWT with exp far in the future.
func validFutureJWT() string {
	return unsignedJWT(map[string]interface{}{
		"exp": time.Now().Add(24 * time.Hour).Unix(),
		"sub": "user-1",
	})
}
