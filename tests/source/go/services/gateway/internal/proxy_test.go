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

	"github.com/garudex-labs/caracal/packages/core/go/audit"
	sharederr "github.com/garudex-labs/caracal/packages/core/go/errors"
	corests "github.com/garudex-labs/caracal/packages/core/go/sts"
	"github.com/rs/zerolog"
)

type allowVerifier struct{}

func (allowVerifier) Verify(context.Context, string, string) error {
	return nil
}

type allowTracker struct{}

func (allowTracker) Check(context.Context, string, time.Time, string, string, string, string, string, string) bool {
	return true
}

type allowRevocations struct{}

func (allowRevocations) IsRevoked(string) bool {
	return false
}

func (allowRevocations) IsAgentRevoked(string) bool {
	return false
}

func (allowRevocations) IsDelegationRevoked(string) bool {
	return false
}

type revokedDelegation struct {
	allowRevocations
}

func (revokedDelegation) IsDelegationRevoked(edgeID string) bool {
	return edgeID == "edge-revoked"
}

type revokedRoot struct {
	allowRevocations
}

func (revokedRoot) IsRevoked(sid string) bool {
	return sid == "root-revoked"
}

type streamingRootRevoked struct {
	allowRevocations
	revoked *atomic.Bool
}

func (s streamingRootRevoked) IsRevoked(sid string) bool {
	return sid == "root-stream" && s.revoked.Load()
}

type revokingChunkReader struct {
	chunks  []string
	index   int
	revoked *atomic.Bool
}

func (r *revokingChunkReader) Read(p []byte) (int, error) {
	if r.index >= len(r.chunks) {
		return 0, io.EOF
	}
	n := copy(p, r.chunks[r.index])
	r.index++
	if r.index == 1 {
		r.revoked.Store(true)
	}
	return n, nil
}

func (*revokingChunkReader) Close() error {
	return nil
}

type testFlusher struct{}

func (testFlusher) Flush() {}

type recordAudit struct {
	events []audit.Event
}

func (r *recordAudit) Emit(event audit.Event) {
	r.events = append(r.events, event)
}

func TestSTSCircuitOpensAfterRepeatedUnavailableErrors(t *testing.T) {
	metrics := &GatewayMetrics{}
	p := &proxy{metrics: metrics}
	out := exchangeOutcome{
		Status:    http.StatusBadGateway,
		ClientErr: sharederr.New(sharederr.STSUnavailable, "sts unavailable"),
	}

	for i := 0; i < stsCircuitFailureLimit; i++ {
		p.recordSTSFailure(out)
	}

	if !p.stsCircuitOpen() {
		t.Fatal("expected STS circuit to open")
	}
	snap := metrics.Snapshot()
	if snap.STSCircuitOpened != 1 || snap.STSCircuitOpen != 1 {
		t.Fatalf("unexpected circuit metrics: %+v", snap)
	}
	p.recordSTSSuccess()
	if p.stsCircuitOpen() {
		t.Fatal("expected STS circuit to close after success")
	}
}

// makeJWT builds an unsigned-but-shaped token whose exp is offset seconds in the future.
func makeJWT(t *testing.T, offset time.Duration) string {
	t.Helper()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))
	payload, _ := json.Marshal(struct {
		Exp    int64  `json:"exp"`
		ZoneID string `json:"zone_id"`
	}{Exp: time.Now().Add(offset).Unix(), ZoneID: "z"})
	body := base64.RawURLEncoding.EncodeToString(payload)
	return header + "." + body + ".sig"
}

func makeJWTWithDelegation(t *testing.T, offset time.Duration, edgeID string) string {
	t.Helper()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))
	payload, _ := json.Marshal(struct {
		Exp              int64  `json:"exp"`
		ZoneID           string `json:"zone_id"`
		DelegationEdgeID string `json:"delegation_edge_id"`
	}{Exp: time.Now().Add(offset).Unix(), ZoneID: "z", DelegationEdgeID: edgeID})
	body := base64.RawURLEncoding.EncodeToString(payload)
	return header + "." + body + ".sig"
}

func makeJWTWithRoot(t *testing.T, offset time.Duration, rootSID string) string {
	t.Helper()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))
	payload, _ := json.Marshal(struct {
		Exp     int64  `json:"exp"`
		ZoneID  string `json:"zone_id"`
		RootSID string `json:"root_sid"`
	}{Exp: time.Now().Add(offset).Unix(), ZoneID: "z", RootSID: rootSID})
	body := base64.RawURLEncoding.EncodeToString(payload)
	return header + "." + body + ".sig"
}

type stsResponseFixture struct {
	AccessToken string                               `json:"access_token"`
	ExpiresIn   int                                  `json:"expires_in"`
	Upstreams   map[string]corests.UpstreamDirective `json:"upstreams"`
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
			AccessToken: "sts-issued-token",
			ExpiresIn:   300,
			Upstreams:   map[string]corests.UpstreamDirective{resource: {URL: upstream, AuthMode: "caracal_jwt"}},
		})
	}))
}

func newProxyForTest(_ *testing.T, sts *httptest.Server) *proxy {
	stsClient := newSTSClient(sts.URL, 2*time.Second, nil)
	guard := newUpstreamGuard(nil)
	return newProxy(stsClient, allowVerifier{}, guard, zerolog.New(io.Discard), 1<<20, 5*time.Second, testBindings(), allowTracker{}, allowRevocations{}, &GatewayMetrics{}, nil)
}

func newProxyForTestWithRevocations(_ *testing.T, sts *httptest.Server, revocations revocationChecker) *proxy {
	stsClient := newSTSClient(sts.URL, 2*time.Second, nil)
	guard := newUpstreamGuard(nil)
	return newProxy(stsClient, allowVerifier{}, guard, zerolog.New(io.Discard), 1<<20, 5*time.Second, testBindings(), allowTracker{}, revocations, &GatewayMetrics{}, nil)
}

// testBindings returns a bindingStore preloaded with the resource identifiers used
// across proxy tests. The empty pool is safe because tests never trigger Reload.
func testBindings() *bindingStore {
	s := &bindingStore{log: zerolog.Nop(), pollInterval: defaultBindingPollInterval}
	m := map[string]binding{
		bindingKey("z", "r"):  {ZoneID: "z", ApplicationID: "a"},
		bindingKey("z", "r1"): {ZoneID: "z", ApplicationID: "a"},
	}
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
	p := newProxyForTest(t, sts)

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
	p := newProxyForTest(t, sts)

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
	p := newProxyForTest(t, sts)

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
	p := newProxyForTest(t, sts)

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
	p := newProxyForTest(t, sts)

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

func TestProxyRejectsRevokedDelegationEdge(t *testing.T) {
	var calls int32
	sts := newFakeSTS(t, "http://127.0.0.1:1", &calls)
	defer sts.Close()
	p := newProxyForTestWithRevocations(t, sts, revokedDelegation{})

	tok := makeJWTWithDelegation(t, time.Hour, "edge-revoked")
	resp := doProxiedRequest(t, p, "GET", "/x", nil, http.Header{
		"Authorization":      {"Bearer " + tok},
		"X-Caracal-Resource": {"r1"},
	})
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected revoked delegation to return 401, got %d", resp.StatusCode)
	}
	if atomic.LoadInt32(&calls) != 0 {
		t.Fatalf("revoked delegation must not reach STS")
	}
}

func TestProxyRejectsRevokedRootSession(t *testing.T) {
	var calls int32
	sts := newFakeSTS(t, "http://127.0.0.1:1", &calls)
	defer sts.Close()
	p := newProxyForTestWithRevocations(t, sts, revokedRoot{})

	tok := makeJWTWithRoot(t, time.Hour, "root-revoked")
	resp := doProxiedRequest(t, p, "GET", "/x", nil, http.Header{
		"Authorization":      {"Bearer " + tok},
		"X-Caracal-Resource": {"r1"},
	})
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected revoked root session to return 401, got %d", resp.StatusCode)
	}
	if atomic.LoadInt32(&calls) != 0 {
		t.Fatalf("revoked root session must not reach STS")
	}
}

func TestProxySSRFBlocksMetadata(t *testing.T) {
	// Cloud metadata / link-local is always blocked, even though the upstream is
	// operator-provisioned, because it is never a legitimate provider and is the
	// crown-jewel SSRF target under DNS rebinding.
	sts := newFakeSTS(t, "http://169.254.169.254/latest/meta-data/", nil)
	defer sts.Close()

	p := newProxyForTest(t, sts)

	tok := makeJWT(t, time.Hour)
	hdr := http.Header{
		"Authorization":      {"Bearer " + tok},
		"X-Caracal-Resource": {"r1"},
	}
	resp := doProxiedRequest(t, p, "GET", "/x", nil, hdr)
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("metadata upstream should be rejected as 502, got %d", resp.StatusCode)
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
	p := newProxyForTest(t, sts)

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

func TestProxyNoneAuthModeForwardsNoCredential(t *testing.T) {
	var seen *http.Request
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Clone(context.Background())
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		resource := r.Form.Get("resource")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(stsResponseFixture{
			AccessToken: "sts-issued-token",
			ExpiresIn:   300,
			Upstreams: map[string]corests.UpstreamDirective{
				resource: {URL: upstream.URL, AuthMode: "none", ProviderID: "provider-none"},
			},
		})
	}))
	defer sts.Close()
	p := newProxyForTest(t, sts)

	tok := makeJWT(t, time.Hour)
	resp := doProxiedRequest(t, p, "GET", "/none", nil, http.Header{
		"Authorization":      {"Bearer " + tok},
		"X-Caracal-Resource": {"r1"},
		"X-Caracal-Identity": {"caller-identity"},
	})
	if resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected 204, got %d: %s", resp.StatusCode, body)
	}
	if seen == nil {
		t.Fatal("upstream never received request")
	}
	for _, header := range []string{"Authorization", "X-Caracal-Identity"} {
		if got := seen.Header.Get(header); got != "" {
			t.Fatalf("%s leaked upstream: %q", header, got)
		}
	}
}

func TestProxyProviderAPIKeyDoesNotLeakInboundAuthorizationOrIdentity(t *testing.T) {
	var seen *http.Request
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Clone(context.Background())
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		resource := r.Form.Get("resource")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(stsResponseFixture{
			AccessToken: "caracal-identity-token",
			ExpiresIn:   300,
			Upstreams: map[string]corests.UpstreamDirective{resource: {
				URL:           upstream.URL,
				AuthMode:      "provider_apikey",
				AuthHeader:    "X-Api-Key",
				ProviderToken: "provider-secret",
			}},
		})
	}))
	defer sts.Close()
	p := newProxyForTest(t, sts)

	tok := makeJWT(t, time.Hour)
	hdr := http.Header{
		"Authorization":      {"Bearer " + tok},
		"X-Api-Key":          {"caller-supplied"},
		"X-Caracal-Resource": {"r1"},
	}
	resp := doProxiedRequest(t, p, "GET", "/x", nil, hdr)
	if resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected 204, got %d: %s", resp.StatusCode, body)
	}
	if seen == nil {
		t.Fatal("upstream never received request")
	}
	if got := seen.Header.Get("Authorization"); got != "" {
		t.Fatalf("inbound Authorization leaked upstream: %q", got)
	}
	if got := seen.Header.Get("X-Api-Key"); got != "provider-secret" {
		t.Fatalf("provider API key header = %q", got)
	}
	if got := seen.Header.Get("X-Caracal-Identity"); got != "" {
		t.Fatalf("Caracal identity leaked upstream by default: %q", got)
	}
}

func TestProxyProviderAPIKeySupportsAuthorizationAndSchemes(t *testing.T) {
	cases := []struct {
		name        string
		authHeader  string
		authScheme  string
		inbound     http.Header
		wantHeader  string
		wantValue   string
		wantMissing string
	}{
		{
			name:       "authorization bearer",
			authHeader: "Authorization",
			authScheme: "Bearer",
			inbound: http.Header{
				"Authorization": {"Bearer caller-token"},
			},
			wantHeader: "Authorization",
			wantValue:  "Bearer provider-secret",
		},
		{
			name:       "custom vendor scheme",
			authHeader: "X-Vendor-Key",
			authScheme: "Token",
			inbound: http.Header{
				"Authorization": {"Bearer caller-token"},
				"X-Vendor-Key":  {"caller-supplied"},
			},
			wantHeader:  "X-Vendor-Key",
			wantValue:   "Token provider-secret",
			wantMissing: "Authorization",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var seen *http.Request
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				seen = r.Clone(context.Background())
				w.WriteHeader(http.StatusNoContent)
			}))
			defer upstream.Close()

			sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_ = r.ParseForm()
				resource := r.Form.Get("resource")
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(stsResponseFixture{
					AccessToken: "caracal-identity-token",
					ExpiresIn:   300,
					Upstreams: map[string]corests.UpstreamDirective{resource: {
						URL:           upstream.URL,
						AuthMode:      "provider_apikey",
						AuthHeader:    tc.authHeader,
						AuthScheme:    tc.authScheme,
						ProviderToken: "provider-secret",
					}},
				})
			}))
			defer sts.Close()
			p := newProxyForTest(t, sts)

			hdr := tc.inbound.Clone()
			hdr.Set("Authorization", "Bearer "+makeJWT(t, time.Hour))
			if tc.authHeader != "Authorization" && tc.inbound.Get(tc.authHeader) != "" {
				hdr.Set(tc.authHeader, tc.inbound.Get(tc.authHeader))
			}
			hdr.Set("X-Caracal-Resource", "r1")
			resp := doProxiedRequest(t, p, "GET", "/x", nil, hdr)
			if resp.StatusCode != http.StatusNoContent {
				body, _ := io.ReadAll(resp.Body)
				t.Fatalf("expected 204, got %d: %s", resp.StatusCode, body)
			}
			if seen == nil {
				t.Fatal("upstream never received request")
			}
			if got := seen.Header.Get(tc.wantHeader); got != tc.wantValue {
				t.Fatalf("%s = %q", tc.wantHeader, got)
			}
			if tc.wantMissing != "" && seen.Header.Get(tc.wantMissing) != "" {
				t.Fatalf("%s leaked upstream: %q", tc.wantMissing, seen.Header.Get(tc.wantMissing))
			}
		})
	}
}

func TestProxyProviderAPIKeySupportsQueryParameterPlacement(t *testing.T) {
	var seen *http.Request
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Clone(context.Background())
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		resource := r.Form.Get("resource")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(stsResponseFixture{
			AccessToken: "caracal-identity-token",
			ExpiresIn:   300,
			Upstreams: map[string]corests.UpstreamDirective{resource: {
				URL:            upstream.URL + "?key=upstream-default&lang=en",
				AuthMode:       "provider_apikey",
				AuthLocation:   "query",
				QueryParamName: "key",
				ProviderToken:  "provider-secret",
			}},
		})
	}))
	defer sts.Close()
	p := newProxyForTest(t, sts)

	resp := doProxiedRequest(t, p, "GET", "/x?key=caller-supplied&q=search", nil, http.Header{
		"Authorization":      {"Bearer " + makeJWT(t, time.Hour)},
		"X-Caracal-Resource": {"r1"},
	})
	if resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected 204, got %d: %s", resp.StatusCode, body)
	}
	if seen == nil {
		t.Fatal("upstream never received request")
	}
	if got := seen.URL.Query().Get("key"); got != "provider-secret" {
		t.Fatalf("provider API key query parameter = %q", got)
	}
	if got := seen.URL.Query().Get("lang"); got != "en" {
		t.Fatalf("upstream query parameter lost: %q", got)
	}
	if got := seen.URL.Query().Get("q"); got != "search" {
		t.Fatalf("caller query parameter lost: %q", got)
	}
	if got := seen.Header.Get("Authorization"); got != "" {
		t.Fatalf("inbound Authorization leaked upstream: %q", got)
	}
}

func TestProxyProviderBearerTokenSupportsHeadersSchemesAndIdentity(t *testing.T) {
	cases := []struct {
		name            string
		authHeader      string
		authScheme      string
		forwardIdentity bool
		inbound         http.Header
		wantHeader      string
		wantValue       string
		wantIdentity    string
		wantMissing     string
	}{
		{
			name:       "authorization bearer",
			authScheme: "Bearer",
			inbound: http.Header{
				"Authorization": {"Bearer caller-token"},
			},
			wantHeader: "Authorization",
			wantValue:  "Bearer provider-token",
		},
		{
			name:            "custom trusted upstream",
			authHeader:      "X-Provider-Authorization",
			authScheme:      "Token",
			forwardIdentity: true,
			inbound: http.Header{
				"Authorization":            {"Bearer caller-token"},
				"X-Provider-Authorization": {"caller-supplied"},
			},
			wantHeader:   "X-Provider-Authorization",
			wantValue:    "Token provider-token",
			wantIdentity: "caracal-identity-token",
			wantMissing:  "Authorization",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var seen *http.Request
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				seen = r.Clone(context.Background())
				w.WriteHeader(http.StatusNoContent)
			}))
			defer upstream.Close()

			sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_ = r.ParseForm()
				resource := r.Form.Get("resource")
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(stsResponseFixture{
					AccessToken: "caracal-identity-token",
					ExpiresIn:   300,
					Upstreams: map[string]corests.UpstreamDirective{resource: {
						URL:                    upstream.URL,
						AuthMode:               "provider_oauth",
						AuthHeader:             tc.authHeader,
						AuthScheme:             tc.authScheme,
						ProviderToken:          "provider-token",
						ForwardCaracalIdentity: tc.forwardIdentity,
					}},
				})
			}))
			defer sts.Close()
			p := newProxyForTest(t, sts)

			hdr := tc.inbound.Clone()
			hdr.Set("Authorization", "Bearer "+makeJWT(t, time.Hour))
			if tc.authHeader != "" && tc.authHeader != "Authorization" && tc.inbound.Get(tc.authHeader) != "" {
				hdr.Set(tc.authHeader, tc.inbound.Get(tc.authHeader))
			}
			hdr.Set("X-Caracal-Resource", "r1")
			resp := doProxiedRequest(t, p, "GET", "/x", nil, hdr)
			if resp.StatusCode != http.StatusNoContent {
				body, _ := io.ReadAll(resp.Body)
				t.Fatalf("expected 204, got %d: %s", resp.StatusCode, body)
			}
			if seen == nil {
				t.Fatal("upstream never received request")
			}
			if got := seen.Header.Get(tc.wantHeader); got != tc.wantValue {
				t.Fatalf("%s = %q", tc.wantHeader, got)
			}
			if got := seen.Header.Get("X-Caracal-Identity"); got != tc.wantIdentity {
				t.Fatalf("X-Caracal-Identity = %q", got)
			}
			if tc.wantMissing != "" && seen.Header.Get(tc.wantMissing) != "" {
				t.Fatalf("%s leaked upstream: %q", tc.wantMissing, seen.Header.Get(tc.wantMissing))
			}
		})
	}
}

func TestProxyProviderBearerTokenRejectsNonAllowlistedUpstreamHost(t *testing.T) {
	var calls int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		resource := r.Form.Get("resource")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(stsResponseFixture{
			AccessToken: "caracal-identity-token",
			ExpiresIn:   300,
			Upstreams: map[string]corests.UpstreamDirective{resource: {
				URL:               upstream.URL,
				AuthMode:          "provider_oauth",
				AuthScheme:        "Bearer",
				AllowedTokenHosts: []string{"api.hooli.example"},
				ProviderToken:     "provider-token",
			}},
		})
	}))
	defer sts.Close()
	p := newProxyForTest(t, sts)

	resp := doProxiedRequest(t, p, "GET", "/x", nil, http.Header{
		"Authorization":      {"Bearer " + makeJWT(t, time.Hour)},
		"X-Caracal-Resource": {"r1"},
	})
	if resp.StatusCode != http.StatusBadGateway {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected 502, got %d: %s", resp.StatusCode, body)
	}
	if atomic.LoadInt32(&calls) != 0 {
		t.Fatal("provider token was sent to a non-allowlisted upstream")
	}
}

// TestProxyDoesNotFollowUpstreamRedirect proves the gateway never follows a 3xx from an
// upstream. A redirect target is a host the SSRF guard, egress allowlist, and
// credential-host checks never vetted, and Go preserves custom headers across a redirect,
// so following one would exfiltrate the injected provider credential and the Caracal
// identity. The 3xx must be surfaced to the caller unfollowed and the redirect target must
// never be dialed.
func TestProxyDoesNotFollowUpstreamRedirect(t *testing.T) {
	var sinkHits int32
	var sinkAuthHeader, sinkIdentity string
	sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&sinkHits, 1)
		sinkAuthHeader = r.Header.Get("X-Api-Key")
		sinkIdentity = r.Header.Get("X-Caracal-Identity")
		w.WriteHeader(http.StatusOK)
	}))
	defer sink.Close()

	var upstreamHits int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&upstreamHits, 1)
		w.Header().Set("Location", sink.URL+"/stolen")
		w.WriteHeader(http.StatusFound)
	}))
	defer upstream.Close()

	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		resource := r.Form.Get("resource")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(stsResponseFixture{
			AccessToken: "caracal-identity-token",
			ExpiresIn:   300,
			Upstreams: map[string]corests.UpstreamDirective{resource: {
				URL:                    upstream.URL,
				AuthMode:               "provider_apikey",
				AuthHeader:             "X-Api-Key",
				ProviderToken:          "provider-secret",
				ForwardCaracalIdentity: true,
			}},
		})
	}))
	defer sts.Close()
	p := newProxyForTest(t, sts)

	resp := doProxiedRequest(t, p, "GET", "/x", nil, http.Header{
		"Authorization":      {"Bearer " + makeJWT(t, time.Hour)},
		"X-Caracal-Resource": {"r1"},
	})
	if resp.StatusCode != http.StatusFound {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected the upstream 302 surfaced unfollowed, got %d: %s", resp.StatusCode, body)
	}
	if atomic.LoadInt32(&upstreamHits) != 1 {
		t.Fatalf("upstream should be dialed exactly once, got %d", atomic.LoadInt32(&upstreamHits))
	}
	if hits := atomic.LoadInt32(&sinkHits); hits != 0 {
		t.Fatalf("redirect target was dialed %d time(s); redirect was followed", hits)
	}
	if sinkAuthHeader != "" || sinkIdentity != "" {
		t.Fatalf("credential leaked to redirect target: api-key=%q identity=%q", sinkAuthHeader, sinkIdentity)
	}
	// The absolute upstream Location is stripped on fan-out: an untrusted upstream must not
	// disclose an internal target or steer the agent client off the gateway's enforced path.
	if got := resp.Header.Get("Location"); got != "" {
		t.Fatalf("absolute upstream Location must be stripped, got %q", got)
	}
}

func TestProxySignedExchangeBrokersProviderCredentialWithoutIdentityLeak(t *testing.T) {
	var seen *http.Request
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Clone(context.Background())
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	key := []byte("12345678901234567890123456789012")
	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse form: %v", err)
		}
		if r.Form.Get("client_secret") != "" || r.Form.Get("client_assertion") != "" {
			t.Fatalf("gateway exchange must not use public client credentials")
		}
		if r.Form.Get("subject_token") == "" {
			t.Fatal("gateway exchange must present the session mandate")
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
		_ = json.NewEncoder(w).Encode(stsResponseFixture{
			AccessToken: "caracal-identity-token",
			ExpiresIn:   300,
			Upstreams: map[string]corests.UpstreamDirective{resource: {
				URL:           upstream.URL,
				AuthMode:      "provider_apikey",
				AuthHeader:    "X-Api-Key",
				ProviderToken: "brokered-provider-secret",
			}},
		})
	}))
	defer sts.Close()

	stsClient := newSTSClient(sts.URL, 2*time.Second, key)
	guard := newUpstreamGuard(nil)
	p := newProxy(stsClient, allowVerifier{}, guard, zerolog.New(io.Discard), 1<<20, 5*time.Second, testBindings(), allowTracker{}, allowRevocations{}, &GatewayMetrics{}, nil)
	resp := doProxiedRequest(t, p, "GET", "/x", nil, http.Header{
		"Authorization":      {"Bearer " + makeJWT(t, time.Hour)},
		"X-Api-Key":          {"caller-supplied"},
		"X-Caracal-Resource": {"r1"},
	})
	if resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected 204, got %d: %s", resp.StatusCode, body)
	}
	if seen == nil {
		t.Fatal("upstream never received request")
	}
	if got := seen.Header.Get("X-Api-Key"); got != "brokered-provider-secret" {
		t.Fatalf("provider API key header = %q", got)
	}
	if got := seen.Header.Get("X-Caracal-Identity"); got != "" {
		t.Fatalf("Caracal identity leaked upstream by default: %q", got)
	}
}

func TestProxyProviderAPIKeyForwardsIdentityWhenOptedIn(t *testing.T) {
	var seen *http.Request
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Clone(context.Background())
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		resource := r.Form.Get("resource")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(stsResponseFixture{
			AccessToken: "caracal-identity-token",
			ExpiresIn:   300,
			Upstreams: map[string]corests.UpstreamDirective{resource: {
				URL:                    upstream.URL,
				AuthMode:               "provider_apikey",
				AuthHeader:             "X-Api-Key",
				ProviderToken:          "provider-secret",
				ForwardCaracalIdentity: true,
			}},
		})
	}))
	defer sts.Close()
	p := newProxyForTest(t, sts)

	tok := makeJWT(t, time.Hour)
	resp := doProxiedRequest(t, p, "GET", "/x", nil, http.Header{
		"Authorization":      {"Bearer " + tok},
		"X-Caracal-Resource": {"r1"},
	})
	if resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected 204, got %d: %s", resp.StatusCode, body)
	}
	if seen == nil {
		t.Fatal("upstream never received request")
	}
	if got := seen.Header.Get("X-Caracal-Identity"); got != "caracal-identity-token" {
		t.Fatalf("Caracal identity header = %q", got)
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
	p := newProxyForTest(t, sts)

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
	p := newProxyForTest(t, sts)

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
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(stsResponseFixture{
			AccessToken: "tok",
			Upstreams:   map[string]corests.UpstreamDirective{"r1": {URL: upstream.URL + "/base?fixed=upstream&shared=upstream", AuthMode: "caracal_jwt"}},
		})
	}))
	defer sts.Close()

	p := newProxyForTest(t, sts)
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

	stsClient := newSTSClient(sts.URL, 2*time.Second, nil)
	guard := newUpstreamGuard(nil)
	p := newProxy(stsClient, allowVerifier{}, guard, zerolog.New(io.Discard), 16, 2*time.Second, testBindings(), allowTracker{}, allowRevocations{}, &GatewayMetrics{}, nil)

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

	p := newProxyForTest(t, sts)
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

func TestProxyEmitsCredentialFreeActionAudit(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "ApiKey provider-secret" {
			t.Fatalf("upstream Authorization = %q", got)
		}
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusCreated)
	}))
	defer upstream.Close()

	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		resource := r.Form.Get("resource")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(stsResponseFixture{
			AccessToken: "sts-issued-token",
			Upstreams: map[string]corests.UpstreamDirective{resource: {
				URL:           upstream.URL,
				AuthMode:      "provider_apikey",
				AuthScheme:    "ApiKey",
				ProviderToken: "provider-secret",
				ProviderID:    "provider-1",
				GrantID:       "grant-1",
			}},
		})
	}))
	defer sts.Close()

	rec := &recordAudit{}
	p := newProxyForTest(t, sts)
	p.audit = rec

	tok := makeJWT(t, time.Hour)
	hdr := http.Header{
		"Authorization":      {"Bearer " + tok},
		"X-Caracal-Resource": {"r1"},
	}
	resp := doProxiedRequest(t, p, "POST", "/x", strings.NewReader("sensitive-body"), hdr)
	if resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("expected 201, got %d: %s", resp.StatusCode, body)
	}
	if len(rec.events) != 1 {
		t.Fatalf("audit events = %d, want 1", len(rec.events))
	}
	event := rec.events[0]
	if event.EventType != gatewayResourceRequestEvent {
		t.Fatalf("event type = %q", event.EventType)
	}
	if event.ZoneID != "z" || event.RequestID == "" || event.Decision != "allow" || event.EvaluationStatus != "executed" {
		t.Fatalf("unexpected event envelope: %+v", event)
	}
	var meta map[string]any
	if err := json.Unmarshal(event.MetadataJSON, &meta); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"application_id", "resource", "subject_fingerprint", "method", "upstream_host", "auth_mode", "provider_id", "grant_id", "gateway_status", "upstream_status", "latency_ms"} {
		if _, ok := meta[want]; !ok {
			t.Fatalf("missing audit metadata %q in %#v", want, meta)
		}
	}
	if meta["provider_id"] != "provider-1" || meta["grant_id"] != "grant-1" {
		t.Fatalf("provider trace metadata = %#v", meta)
	}
	rawMeta := string(event.MetadataJSON)
	for _, secret := range []string{"sts-issued-token", "provider-secret", "Bearer", "sensitive-body", tok} {
		if strings.Contains(rawMeta, secret) {
			t.Fatalf("audit metadata leaked %q: %s", secret, rawMeta)
		}
	}
}

func TestProxyAuditsUpstreamTransportFailure(t *testing.T) {
	sts := newFakeSTS(t, "http://127.0.0.1:1", nil)
	defer sts.Close()
	rec := &recordAudit{}
	p := newProxyForTest(t, sts)
	p.audit = rec

	tok := makeJWT(t, time.Hour)
	hdr := http.Header{
		"Authorization":      {"Bearer " + tok},
		"X-Caracal-Resource": {"r1"},
	}
	resp := doProxiedRequest(t, p, "GET", "/x", nil, hdr)
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d", resp.StatusCode)
	}
	if len(rec.events) != 1 {
		t.Fatalf("audit events = %d, want 1", len(rec.events))
	}
	event := rec.events[0]
	if event.EvaluationStatus != "upstream_error" {
		t.Fatalf("status = %q", event.EvaluationStatus)
	}
	var meta map[string]any
	if err := json.Unmarshal(event.MetadataJSON, &meta); err != nil {
		t.Fatal(err)
	}
	if meta["error_kind"] != "transport_error" {
		t.Fatalf("metadata = %#v", meta)
	}
}

func TestProxySTSUnavailableMappedSafely(t *testing.T) {
	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("temporary outage"))
	}))
	defer sts.Close()

	p := newProxyForTest(t, sts)
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
	p := newProxyForTest(t, sts)

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
		t.Fatal("first SSE chunk not received within 2s: flushing broken")
	}
}

func TestStreamCopyStopsOnRootRevocationDuringExecution(t *testing.T) {
	revoked := &atomic.Bool{}
	src := &revokingChunkReader{
		chunks:  []string{"first\n", "second\n"},
		revoked: revoked,
	}
	var out strings.Builder
	n, hit := streamCopy(&out, src, testFlusher{}, streamingRootRevoked{revoked: revoked}, tokenRevocationIDs{RootSID: "root-stream"})
	if !hit {
		t.Fatal("expected stream to stop after root revocation")
	}
	if n != int64(len("first\n")) || out.String() != "first\n" {
		t.Fatalf("stream should only include pre-revocation bytes, n=%d body=%q", n, out.String())
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
	c := newSTSClient("http://127.0.0.1:1", 100*time.Millisecond, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	outcome := c.Exchange(ctx, "tok", binding{}, "r", "GET", "/x", "rid")
	if outcome.InternalErr == nil {
		t.Fatal("expected transport error")
	}
	if outcome.ClientErr == nil {
		t.Fatal("expected sanitised CaracalError")
	}
	if outcome.Status < 500 {
		t.Errorf("transport failure should map to 5xx, got %d", outcome.Status)
	}
	if strings.Contains(outcome.ClientErr.Description, "127.0.0.1") {
		t.Errorf("internal address leaked: %s", outcome.ClientErr.Description)
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
