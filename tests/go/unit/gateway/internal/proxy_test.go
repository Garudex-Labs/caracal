// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Gateway proxy unit tests: bearer extraction, missing token, end-to-end exchange.

package internal

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

func TestExtractBearer(t *testing.T) {
	cases := []struct {
		header string
		want   string
	}{
		{"Bearer token123", "token123"},
		{"bearer token123", ""},
		{"Basic abc123", ""},
		{"", ""},
		{"Bearer ", ""},
	}
	for _, tc := range cases {
		got := extractBearer(tc.header)
		if got != tc.want {
			t.Errorf("extractBearer(%q) = %q, want %q", tc.header, got, tc.want)
		}
	}
}

func TestProxyMissingBearer(t *testing.T) {
	p := newProxy(newSTSClient("http://localhost:19999"), zerolog.Nop())
	req := httptest.NewRequest(http.MethodPost, "/tool", nil)
	rr := httptest.NewRecorder()
	p.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("want 401, got %d", rr.Code)
	}
}

func TestProxyMissingResourceHeader(t *testing.T) {
	p := newProxy(newSTSClient("http://localhost:19999"), zerolog.Nop())
	req := httptest.NewRequest(http.MethodPost, "/tool", nil)
	req.Header.Set("Authorization", "Bearer subject-token")
	req.Header.Set("X-Caracal-Client-ID", "zone1:app1")
	rr := httptest.NewRecorder()
	p.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", rr.Code)
	}
}

func TestProxyMissingClientIDHeader(t *testing.T) {
	p := newProxy(newSTSClient("http://localhost:19999"), zerolog.Nop())
	req := httptest.NewRequest(http.MethodPost, "/tool", nil)
	req.Header.Set("Authorization", "Bearer subject-token")
	req.Header.Set("X-Caracal-Resource", "resource://api/v1")
	rr := httptest.NewRecorder()
	p.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Errorf("want 400, got %d", rr.Code)
	}
}

func TestProxyRejectsExpiringSubjectTokenBeforeSTS(t *testing.T) {
	var stsCalls int64
	stsServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		atomic.AddInt64(&stsCalls, 1)
		response.WriteHeader(http.StatusInternalServerError)
	}))
	defer stsServer.Close()

	proxyServer := newProxy(newSTSClient(stsServer.URL), zerolog.Nop())
	req := httptest.NewRequest(http.MethodPost, "/tool", nil)
	req.Header.Set("Authorization", "Bearer "+unsignedJWT(map[string]interface{}{"exp": time.Now().Add(10 * time.Second).Unix()}))
	req.Header.Set("X-Caracal-Client-ID", "zone1:app1")
	req.Header.Set("X-Caracal-Resource", "resource://api/v1")
	recorder := httptest.NewRecorder()

	proxyServer.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusUnauthorized {
		t.Errorf("want 401, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if atomic.LoadInt64(&stsCalls) != 0 {
		t.Errorf("want no STS calls for expiring token, got %d", stsCalls)
	}
	if !strings.Contains(recorder.Body.String(), "credential_expired") {
		t.Errorf("want credential_expired error, got %s", recorder.Body.String())
	}
}

func TestProxyPerformsFreshSTSExchangePerConcurrentRequest(t *testing.T) {
	const requests = 25
	var stsCalls int64
	upstreamServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if !strings.HasPrefix(request.Header.Get("Authorization"), "Bearer resource-token-") {
			response.WriteHeader(http.StatusUnauthorized)
			return
		}
		response.WriteHeader(http.StatusNoContent)
	}))
	defer upstreamServer.Close()

	stsServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		call := atomic.AddInt64(&stsCalls, 1)
		response.Header().Set("Content-Type", "application/json")
		json.NewEncoder(response).Encode(map[string]interface{}{
			"access_token": fmt.Sprintf("resource-token-%d", call),
			"token_type":   "Bearer",
			"expires_in":   900,
			"target_upstreams": map[string]string{
				"resource://api/v1": upstreamServer.URL,
			},
		})
	}))
	defer stsServer.Close()

	proxyServer := newProxy(newSTSClient(stsServer.URL), zerolog.Nop())
	var waitGroup sync.WaitGroup
	errors := make(chan string, requests)
	for index := 0; index < requests; index++ {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			req := httptest.NewRequest(http.MethodPost, "/tool", nil)
			req.Header.Set("Authorization", "Bearer subject-token")
			req.Header.Set("X-Caracal-Client-ID", "zone1:app1")
			req.Header.Set("X-Caracal-Resource", "resource://api/v1")
			recorder := httptest.NewRecorder()
			proxyServer.ServeHTTP(recorder, req)
			if recorder.Code != http.StatusNoContent {
				errors <- fmt.Sprintf("want 204, got %d: %s", recorder.Code, recorder.Body.String())
			}
		}()
	}
	waitGroup.Wait()
	close(errors)

	for message := range errors {
		t.Error(message)
	}
	if got := atomic.LoadInt64(&stsCalls); got != requests {
		t.Errorf("want %d STS exchanges, got %d", requests, got)
	}
}

func TestProxyEndToEnd(t *testing.T) {
	// Mock upstream MCP that requires the resource-scoped token
	upstreamServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer resource-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"result": "ok"})
	}))
	defer upstreamServer.Close()

	// Mock STS that returns a resource-scoped token
	stsServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"access_token": "resource-token",
			"token_type":   "Bearer",
			"expires_in":   900,
			"target_upstreams": map[string]string{
				"resource://api/v1": upstreamServer.URL,
			},
		})
	}))
	defer stsServer.Close()

	p := newProxy(newSTSClient(stsServer.URL), zerolog.Nop())
	req := httptest.NewRequest(http.MethodPost, "/tool", nil)
	req.Header.Set("Authorization", "Bearer subject-token")
	req.Header.Set("X-Caracal-Client-ID", "zone1:app1")
	req.Header.Set("X-Caracal-Resource", "resource://api/v1")
	req.Header.Set("X-Caracal-Upstream", "http://example.invalid")

	rr := httptest.NewRecorder()
	p.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Errorf("want 200, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestProxyUsesApprovedUpstreamPathAndQuery(t *testing.T) {
	upstreamServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/mcp/tool" {
			t.Errorf("want upstream path /mcp/tool, got %s", r.URL.Path)
		}
		if r.URL.RawQuery != "approved=true&request=1" {
			t.Errorf("want merged query, got %s", r.URL.RawQuery)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstreamServer.Close()

	stsServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Request-Id") != "req-123" {
			t.Errorf("want request id propagated, got %s", r.Header.Get("X-Request-Id"))
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"access_token": "resource-token",
			"token_type":   "Bearer",
			"expires_in":   900,
			"target_upstreams": map[string]string{
				"resource://api/v1": upstreamServer.URL + "/mcp?approved=true",
			},
		})
	}))
	defer stsServer.Close()

	p := newProxy(newSTSClient(stsServer.URL+"/"), zerolog.Nop())
	req := httptest.NewRequest(http.MethodPost, "/tool?request=1", nil)
	req.Header.Set("Authorization", "Bearer subject-token")
	req.Header.Set("X-Caracal-Client-ID", "zone1:app1")
	req.Header.Set("X-Caracal-Resource", "resource://api/v1")
	req.Header.Set("X-Request-Id", "req-123")

	rr := httptest.NewRecorder()
	p.ServeHTTP(rr, req)
	if rr.Code != http.StatusNoContent {
		t.Errorf("want 204, got %d: %s", rr.Code, rr.Body.String())
	}
}

func TestProxyRetriesUpstreamUnauthorized(t *testing.T) {
	callCount := 0
	upstreamServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer resource-token-2" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstreamServer.Close()

	stsServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		token := "resource-token"
		if callCount == 2 {
			token = "resource-token-2"
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"access_token": token,
			"token_type":   "Bearer",
			"expires_in":   900,
			"target_upstreams": map[string]string{
				"resource://api/v1": upstreamServer.URL,
			},
		})
	}))
	defer stsServer.Close()

	p := newProxy(newSTSClient(stsServer.URL), zerolog.Nop())
	req := httptest.NewRequest(http.MethodPost, "/tool", nil)
	req.Header.Set("Authorization", "Bearer subject-token")
	req.Header.Set("X-Caracal-Client-ID", "zone1:app1")
	req.Header.Set("X-Caracal-Resource", "resource://api/v1")

	rr := httptest.NewRecorder()
	p.ServeHTTP(rr, req)
	if rr.Code != http.StatusNoContent {
		t.Errorf("want 204 after retry, got %d: %s", rr.Code, rr.Body.String())
	}
	if callCount != 2 {
		t.Errorf("want 2 STS calls, got %d", callCount)
	}
}

func TestProxyDoesNotRetryNonReplayableBody(t *testing.T) {
	callCount := 0
	upstreamServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer upstreamServer.Close()

	stsServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"access_token": "resource-token",
			"token_type":   "Bearer",
			"expires_in":   900,
			"target_upstreams": map[string]string{
				"resource://api/v1": upstreamServer.URL,
			},
		})
	}))
	defer stsServer.Close()

	p := newProxy(newSTSClient(stsServer.URL), zerolog.Nop())
	req := httptest.NewRequest(http.MethodPost, "/tool", ioReadCloser{Reader: strings.NewReader("payload")})
	req.GetBody = nil
	req.Header.Set("Authorization", "Bearer subject-token")
	req.Header.Set("X-Caracal-Client-ID", "zone1:app1")
	req.Header.Set("X-Caracal-Resource", "resource://api/v1")

	rr := httptest.NewRecorder()
	p.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("want upstream 401, got %d: %s", rr.Code, rr.Body.String())
	}
	if callCount != 1 {
		t.Errorf("want 1 STS call, got %d", callCount)
	}
}

func TestProxySTSFailure(t *testing.T) {
	// STS returns an error
	stsServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(map[string]string{"error": "access_denied"})
	}))
	defer stsServer.Close()

	p := newProxy(newSTSClient(stsServer.URL), zerolog.Nop())
	req := httptest.NewRequest(http.MethodPost, "/tool", nil)
	req.Header.Set("Authorization", "Bearer subject-token")
	req.Header.Set("X-Caracal-Client-ID", "zone1:app1")
	req.Header.Set("X-Caracal-Resource", "resource://api/v1")

	rr := httptest.NewRecorder()
	p.ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Errorf("want 403 from STS passthrough, got %d", rr.Code)
	}
}

func TestProxyMalformedSTSError(t *testing.T) {
	stsServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("temporary outage"))
	}))
	defer stsServer.Close()

	p := newProxy(newSTSClient(stsServer.URL), zerolog.Nop())
	req := httptest.NewRequest(http.MethodPost, "/tool", nil)
	req.Header.Set("Authorization", "Bearer subject-token")
	req.Header.Set("X-Caracal-Client-ID", "zone1:app1")
	req.Header.Set("X-Caracal-Resource", "resource://api/v1")

	rr := httptest.NewRecorder()
	p.ServeHTTP(rr, req)
	if rr.Code != http.StatusServiceUnavailable {
		t.Errorf("want 503, got %d", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), "sts_unavailable") {
		t.Errorf("want sts_unavailable error, got %s", rr.Body.String())
	}
}

func TestParseApprovedUpstreamRejectsUserInfo(t *testing.T) {
	if _, err := parseApprovedUpstream("https://user:pass@example.com"); err == nil {
		t.Error("expected upstream with user info to be rejected")
	}
}

func TestJoinURLPathPreservesRootAndNestedPaths(t *testing.T) {
	cases := []struct {
		upstreamPath string
		requestPath  string
		want         string
	}{
		{"", "", "/"},
		{"/", "/tool", "/tool"},
		{"/mcp", "/", "/mcp"},
		{"/mcp/", "/tool", "/mcp/tool"},
		{"/mcp/base", "tool", "/mcp/base/tool"},
	}
	for _, testCase := range cases {
		if got := joinURLPath(testCase.upstreamPath, testCase.requestPath); got != testCase.want {
			t.Errorf("joinURLPath(%q, %q) = %q, want %q", testCase.upstreamPath, testCase.requestPath, got, testCase.want)
		}
	}
}

func unsignedJWT(claims map[string]interface{}) string {
	header, _ := json.Marshal(map[string]interface{}{"alg": "none", "typ": "JWT"})
	payload, _ := json.Marshal(claims)
	return base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(payload) + "."
}

type ioReadCloser struct {
	*strings.Reader
}

func (r ioReadCloser) Close() error { return nil }
