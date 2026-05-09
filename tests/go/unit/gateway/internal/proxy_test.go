// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// End-to-end proxy handler tests with fake STS and upstream.

package internal

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

// makeJWT builds an unsigned-but-shaped token whose exp is offset seconds in the future.
func makeJWT(t *testing.T, offset time.Duration) string {
	t.Helper()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))
	payload, _ := json.Marshal(struct {
		Exp int64 `json:"exp"`
	}{Exp: time.Now().Add(offset).Unix()})
	body := base64.RawURLEncoding.EncodeToString(payload)
	return header + "." + body + ".sig"
}

type stsResponseFixture struct {
	AccessToken     string            `json:"access_token"`
	ExpiresIn       int               `json:"expires_in"`
	TargetUpstreams map[string]string `json:"target_upstreams"`
}

func newFakeSTS(t *testing.T, upstream string, calls *int32) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls != nil {
			atomic.AddInt32(calls, 1)
		}
		_ = r.ParseForm()
		resource := r.Form.Get("resource")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(stsResponseFixture{
			AccessToken:     "sts-issued-token",
			ExpiresIn:       300,
			TargetUpstreams: map[string]string{resource: upstream},
		})
	}))
}

func newProxyForTest(_ *testing.T, sts *httptest.Server, allowPrivate bool) *proxy {
	stsClient := newSTSClient(sts.URL, 2*time.Second)
	guard := newUpstreamGuard(nil, allowPrivate)
	return newProxy(stsClient, guard, zerolog.New(io.Discard), 1<<20, 5*time.Second, testBindings(), nil)
}

// testBindings returns a bindingStore preloaded with the resource identifiers used
// across proxy tests. The empty pool is safe because tests never trigger Reload.
func testBindings() *bindingStore {
	s := &bindingStore{log: zerolog.Nop(), pollInterval: defaultBindingPollInterval}
	m := map[string]string{"r": "z:a", "r1": "z:a"}
	s.cache.Store(&m)
	return s
}

func doProxiedRequest(t *testing.T, p *proxy, method, target string, body io.Reader, hdr http.Header) *http.Response {
	t.Helper()
	r := httptest.NewRequest(method, target, body)
	for k, vs := range hdr {
		for _, v := range vs {
			r.Header.Add(k, v)
		}
	}
	r.RemoteAddr = "203.0.113.7:54321"
	w := httptest.NewRecorder()
	p.ServeHTTP(w, r)
	return w.Result()
}

func TestExtractBearer(t *testing.T) {
	cases := map[string]string{
		"Bearer abc":  "abc",
		"bearer abc":  "abc",
		"Basic xyz":   "",
		"":            "",
		"Bearer ":     "",
		"Bearer  abc": "abc",
	}
	for input, want := range cases {
		if got := extractBearer(input); got != want {
			t.Errorf("extractBearer(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestProxyMissingBearerReturns401(t *testing.T) {
	sts := newFakeSTS(t, "http://127.0.0.1:1", nil)
	defer sts.Close()
	p := newProxyForTest(t, sts, true)

	resp := doProxiedRequest(t, p, "GET", "/x", nil, nil)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if resp.Header.Get("X-Request-Id") == "" {
		t.Error("missing X-Request-Id in error response")
	}
}

func TestProxyMalformedBearerRejectedWithoutSTSCall(t *testing.T) {
	var calls int32
	sts := newFakeSTS(t, "http://127.0.0.1:1", &calls)
	defer sts.Close()
	p := newProxyForTest(t, sts, true)

	hdr := http.Header{
		"Authorization":      {"Bearer not.a.jwt.4parts"},
		"X-Caracal-Resource": {"r"},
	}
	resp := doProxiedRequest(t, p, "GET", "/x", nil, hdr)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("malformed bearer should 401, got %d", resp.StatusCode)
	}
	if atomic.LoadInt32(&calls) != 0 {
		t.Errorf("malformed bearer must not reach STS, got %d calls", calls)
	}
}

func TestProxyExpiringBearerPreflightRejected(t *testing.T) {
	var calls int32
	sts := newFakeSTS(t, "http://127.0.0.1:1", &calls)
	defer sts.Close()
	p := newProxyForTest(t, sts, true)

	tok := makeJWT(t, 5*time.Second)
	hdr := http.Header{
		"Authorization":      {"Bearer " + tok},
		"X-Caracal-Resource": {"r1"},
	}
	resp := doProxiedRequest(t, p, "GET", "/x", nil, hdr)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected preflight 401, got %d", resp.StatusCode)
	}
	if atomic.LoadInt32(&calls) != 0 {
		t.Errorf("preflight failure must not reach STS")
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "credential_expired") {
		t.Errorf("expected credential_expired error code, got %s", body)
	}
}

func TestProxyMissingRoutingHeaders(t *testing.T) {
	sts := newFakeSTS(t, "http://127.0.0.1:1", nil)
	defer sts.Close()
	p := newProxyForTest(t, sts, true)

	tok := makeJWT(t, time.Hour)
	cases := []http.Header{
		{"Authorization": {"Bearer " + tok}},
		{"Authorization": {"Bearer " + tok}, "X-Caracal-Resource": {"r"}, "X-Caracal-Client-ID": {"a"}},
	}
	for i, hdr := range cases {
		resp := doProxiedRequest(t, p, "GET", "/x", nil, hdr)
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("case %d: expected 400, got %d", i, resp.StatusCode)
		}
	}
}

func TestProxyPathTraversalBlocked(t *testing.T) {
	sts := newFakeSTS(t, "http://127.0.0.1:1", nil)
	defer sts.Close()
	p := newProxyForTest(t, sts, true)

	tok := makeJWT(t, time.Hour)
	hdr := http.Header{
		"Authorization":      {"Bearer " + tok},
		"X-Caracal-Resource": {"r1"},
	}
	resp := doProxiedRequest(t, p, "GET", "/v1/../admin", nil, hdr)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("path traversal should 400, got %d", resp.StatusCode)
	}
}

func TestProxySSRFBlocksLoopback(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	sts := newFakeSTS(t, upstream.URL, nil)
	defer sts.Close()

	p := newProxyForTest(t, sts, false) // disallow private upstreams

	tok := makeJWT(t, time.Hour)
	hdr := http.Header{
		"Authorization":      {"Bearer " + tok},
		"X-Caracal-Resource": {"r1"},
	}
	resp := doProxiedRequest(t, p, "GET", "/x", nil, hdr)
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("loopback upstream should be rejected as 502, got %d", resp.StatusCode)
	}
}

func TestProxyHappyPathForwardsAndStripsHeaders(t *testing.T) {
	var seen *http.Request
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Clone(context.Background())
		w.Header().Set("X-Upstream-Sent", "yes")
		_, _ = io.WriteString(w, "ok")
	}))
	defer upstream.Close()

	sts := newFakeSTS(t, upstream.URL, nil)
	defer sts.Close()
	p := newProxyForTest(t, sts, true)

	tok := makeJWT(t, time.Hour)
	hdr := http.Header{
		"Authorization":       {"Bearer " + tok},
		"X-Caracal-Resource":  {"r1"},
		"X-Caracal-Upstream":  {"shouldnt-leak"},
		"Connection":          {"X-Hop-Custom"},
		"X-Hop-Custom":        {"drop"},
		"Proxy-Authorization": {"Bearer leak"},
		"X-Keep":              {"value"},
	}
	resp := doProxiedRequest(t, p, "POST", "/api/v1", strings.NewReader("payload"), hdr)
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, body)
	}
	if seen == nil {
		t.Fatal("upstream never received request")
	}
	if got := seen.Header.Get("Authorization"); got != "Bearer sts-issued-token" {
		t.Errorf("Authorization not replaced; got %q", got)
	}
	for _, drop := range []string{"X-Caracal-Client-ID", "X-Caracal-Resource", "X-Caracal-Upstream", "Connection", "X-Hop-Custom", "Proxy-Authorization"} {
		if seen.Header.Get(drop) != "" {
			t.Errorf("%s should be stripped, got %q", drop, seen.Header.Get(drop))
		}
	}
	if seen.Header.Get("X-Keep") != "value" {
		t.Error("regular header lost")
	}
	if seen.Header.Get("X-Forwarded-For") != "203.0.113.7" {
		t.Errorf("X-Forwarded-For wrong: %q", seen.Header.Get("X-Forwarded-For"))
	}
	if seen.Header.Get("X-Forwarded-Proto") == "" {
		t.Error("X-Forwarded-Proto missing")
	}
	if seen.Header.Get("X-Request-Id") == "" {
		t.Error("X-Request-Id not propagated to upstream")
	}
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "ok" {
		t.Errorf("body = %q", body)
	}
}

func TestProxySTSExchangedExactlyOncePerRequest(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer upstream.Close()

	var stsCalls int32
	sts := newFakeSTS(t, upstream.URL, &stsCalls)
	defer sts.Close()
	p := newProxyForTest(t, sts, true)

	tok := makeJWT(t, time.Hour)
	hdr := http.Header{
		"Authorization":      {"Bearer " + tok},
		"X-Caracal-Resource": {"r1"},
	}
	resp := doProxiedRequest(t, p, "GET", "/x", nil, hdr)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("upstream 401 should be surfaced, got %d", resp.StatusCode)
	}
	if got := atomic.LoadInt32(&stsCalls); got != 1 {
		t.Errorf("expected exactly 1 STS call (no retry), got %d", got)
	}
}

func TestProxyConcurrentRequestsEachExchange(t *testing.T) {
	const requests = 25
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	var stsCalls int32
	sts := newFakeSTS(t, upstream.URL, &stsCalls)
	defer sts.Close()
	p := newProxyForTest(t, sts, true)

	tok := makeJWT(t, time.Hour)
	done := make(chan int, requests)
	for i := 0; i < requests; i++ {
		go func() {
			hdr := http.Header{
				"Authorization":      {"Bearer " + tok},
				"X-Caracal-Resource": {"r"},
			}
			resp := doProxiedRequest(t, p, "GET", "/x", nil, hdr)
			done <- resp.StatusCode
		}()
	}
	for i := 0; i < requests; i++ {
		if got := <-done; got != http.StatusNoContent {
			t.Errorf("req %d: status %d", i, got)
		}
	}
	if got := atomic.LoadInt32(&stsCalls); got != int32(requests) {
		t.Errorf("expected %d STS calls (one per request), got %d", requests, got)
	}
}

func TestProxyPathAndQueryComposition(t *testing.T) {
	var seenURL string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenURL = r.URL.Path + "?" + r.URL.RawQuery
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(stsResponseFixture{
			AccessToken:     "tok",
			TargetUpstreams: map[string]string{"r1": upstream.URL + "/base?fixed=upstream&shared=upstream"},
		})
	}))
	defer sts.Close()

	p := newProxyForTest(t, sts, true)
	tok := makeJWT(t, time.Hour)
	hdr := http.Header{
		"Authorization":      {"Bearer " + tok},
		"X-Caracal-Resource": {"r1"},
	}
	resp := doProxiedRequest(t, p, "GET", "/v1/items?shared=client&extra=1", nil, hdr)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if !strings.HasPrefix(seenURL, "/base/v1/items?") {
		t.Errorf("path not joined; got %q", seenURL)
	}
	if !strings.Contains(seenURL, "fixed=upstream") || !strings.Contains(seenURL, "extra=1") {
		t.Errorf("query not merged; got %q", seenURL)
	}
	if !strings.Contains(seenURL, "shared=upstream") || strings.Contains(seenURL, "shared=client") {
		t.Errorf("upstream should win on conflict; got %q", seenURL)
	}
}

func TestProxyBodySizeLimitEnforced(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	sts := newFakeSTS(t, upstream.URL, nil)
	defer sts.Close()

	stsClient := newSTSClient(sts.URL, 2*time.Second)
	guard := newUpstreamGuard(nil, true)
	p := newProxy(stsClient, guard, zerolog.New(io.Discard), 16, 2*time.Second, testBindings(), nil)

	tok := makeJWT(t, time.Hour)
	hdr := http.Header{
		"Authorization":      {"Bearer " + tok},
		"X-Caracal-Resource": {"r1"},
	}
	resp := doProxiedRequest(t, p, "POST", "/x", strings.NewReader(strings.Repeat("a", 1024)), hdr)
	if resp.StatusCode == http.StatusOK {
		t.Errorf("oversized body should not pass; got 200")
	}
}

func TestProxySTSDeniedSurfacesError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"access_denied","error_description":"policy denied"}`))
	}))
	defer sts.Close()

	p := newProxyForTest(t, sts, true)
	tok := makeJWT(t, time.Hour)
	hdr := http.Header{
		"Authorization":      {"Bearer " + tok},
		"X-Caracal-Resource": {"r1"},
	}
	resp := doProxiedRequest(t, p, "GET", "/x", nil, hdr)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "access_denied") {
		t.Errorf("error code not propagated: %s", body)
	}
}

func TestProxySTSUnavailableMappedSafely(t *testing.T) {
	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("temporary outage"))
	}))
	defer sts.Close()

	p := newProxyForTest(t, sts, true)
	tok := makeJWT(t, time.Hour)
	hdr := http.Header{
		"Authorization":      {"Bearer " + tok},
		"X-Caracal-Resource": {"r1"},
	}
	resp := doProxiedRequest(t, p, "GET", "/x", nil, hdr)
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("got %d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "sts_unavailable") {
		t.Errorf("expected sts_unavailable, got %s", body)
	}
}

func TestProxySSEStreamsAndFlushes(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher := w.(http.Flusher)
		for i := 0; i < 3; i++ {
			fmt.Fprintf(w, "data: %d\n\n", i)
			flusher.Flush()
			time.Sleep(10 * time.Millisecond)
		}
	}))
	defer upstream.Close()
	sts := newFakeSTS(t, upstream.URL, nil)
	defer sts.Close()
	p := newProxyForTest(t, sts, true)

	server := httptest.NewServer(p)
	defer server.Close()

	tok := makeJWT(t, time.Hour)
	req, _ := http.NewRequest("GET", server.URL+"/sse", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("X-Caracal-Resource", "r1")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	gotChunk := make(chan struct{}, 1)
	go func() {
		buf := make([]byte, 64)
		n, _ := resp.Body.Read(buf)
		if n > 0 {
			gotChunk <- struct{}{}
		}
	}()
	select {
	case <-gotChunk:
	case <-time.After(2 * time.Second):
		t.Fatal("first SSE chunk not received within 2s — flushing broken")
	}
}

func TestRequestIDMiddlewareReplacesInvalidIDs(t *testing.T) {
	var captured string
	h := requestIDMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured = requestIDFromContext(r.Context())
	}))
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("X-Request-Id", "bad\x00id")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if captured == "bad\x00id" {
		t.Error("invalid id passed through")
	}
	if !validRequestID(captured) {
		t.Errorf("captured id invalid: %q", captured)
	}
	if w.Header().Get("X-Request-Id") != captured {
		t.Error("response header not echoed")
	}
}

func TestRequestIDMiddlewarePreservesValidIDs(t *testing.T) {
	want := "550e8400-e29b-41d4-a716-446655440000"
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
}

func TestSTSClientTransportFailureSanitised(t *testing.T) {
	c := newSTSClient("http://127.0.0.1:1", 100*time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	_, status, cerr, internalErr := c.Exchange(ctx, "tok", "app", "r", "rid")
	if internalErr == nil {
		t.Fatal("expected transport error")
	}
	if cerr == nil {
		t.Fatal("expected sanitised CaracalError")
	}
	if status < 500 {
		t.Errorf("transport failure should map to 5xx, got %d", status)
	}
	if strings.Contains(cerr.Description, "127.0.0.1") {
		t.Errorf("internal address leaked: %s", cerr.Description)
	}
}

func TestJoinURLPathHelpers(t *testing.T) {
	cases := []struct {
		upstream, request, want string
	}{
		{"", "", "/"},
		{"/", "/tool", "/tool"},
		{"/mcp", "/", "/mcp"},
		{"/mcp/", "/tool", "/mcp/tool"},
		{"/mcp/base", "tool", "/mcp/base/tool"},
	}
	for _, tc := range cases {
		if got := joinURLPath(tc.upstream, tc.request); got != tc.want {
			t.Errorf("joinURLPath(%q,%q)=%q want %q", tc.upstream, tc.request, got, tc.want)
		}
	}
}
