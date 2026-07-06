// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Proxy denial-path tests: bearer limits, zone claims, verification failures, and upstream errors.

package internal

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	sharederr "github.com/garudex-labs/caracal/packages/core/go/errors"
	corests "github.com/garudex-labs/caracal/packages/core/go/sts"
	"github.com/rs/zerolog"
)

type denyVerifier struct{ err error }

func (v denyVerifier) Verify(context.Context, string, string) error {
	return v.err
}

type denyTracker struct{}

func (denyTracker) Check(context.Context, string, time.Time, string, string, string, string, string, string) bool {
	return false
}

func proxyHeaders(token string) http.Header {
	h := http.Header{}
	h.Set("Authorization", "Bearer "+token)
	h.Set("X-Caracal-Resource", "r")
	return h
}

func makeJWTWithoutZone(t *testing.T, offset time.Duration) string {
	t.Helper()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))
	payload, _ := json.Marshal(struct {
		Exp int64 `json:"exp"`
	}{Exp: time.Now().Add(offset).Unix()})
	return header + "." + base64.RawURLEncoding.EncodeToString(payload) + ".sig"
}

func makeJWTWithoutClient(t *testing.T, offset time.Duration) string {
	t.Helper()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))
	payload, _ := json.Marshal(struct {
		Exp    int64  `json:"exp"`
		ZoneID string `json:"zone_id"`
	}{Exp: time.Now().Add(offset).Unix(), ZoneID: "z"})
	return header + "." + base64.RawURLEncoding.EncodeToString(payload) + ".sig"
}

func TestProxyOversizedBearerRejected(t *testing.T) {
	sts := newFakeSTS(t, "http://127.0.0.1:1", nil)
	defer sts.Close()
	p := newProxyForTest(t, sts)

	resp := doProxiedRequest(t, p, http.MethodGet, "/x", nil, proxyHeaders(strings.Repeat("a", maxBearerBytes+1)))
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if p.metrics.Snapshot().DenialsBadBearer != 1 {
		t.Fatalf("bad bearer denials = %d", p.metrics.Snapshot().DenialsBadBearer)
	}
}

func TestProxyMissingZoneClaimRejected(t *testing.T) {
	sts := newFakeSTS(t, "http://127.0.0.1:1", nil)
	defer sts.Close()
	p := newProxyForTest(t, sts)

	resp := doProxiedRequest(t, p, http.MethodGet, "/x", nil, proxyHeaders(makeJWTWithoutZone(t, time.Hour)))
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if p.metrics.Snapshot().DenialsBadRouting != 1 {
		t.Fatalf("bad routing denials = %d", p.metrics.Snapshot().DenialsBadRouting)
	}
}

func TestProxyMissingClientClaimRejected(t *testing.T) {
	sts := newFakeSTS(t, "http://127.0.0.1:1", nil)
	defer sts.Close()
	p := newProxyForTest(t, sts)

	resp := doProxiedRequest(t, p, http.MethodGet, "/x", nil, proxyHeaders(makeJWTWithoutClient(t, time.Hour)))
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if p.metrics.Snapshot().DenialsBadRouting != 1 {
		t.Fatalf("bad routing denials = %d", p.metrics.Snapshot().DenialsBadRouting)
	}
}

func TestProxySignatureFailureRejected(t *testing.T) {
	sts := newFakeSTS(t, "http://127.0.0.1:1", nil)
	defer sts.Close()
	stsClient := newSTSClient(sts.URL, time.Second, nil)
	p := newProxy(stsClient, denyVerifier{err: errors.New("bad signature")}, newUpstreamGuard(nil), zerolog.Nop(), 1<<20, time.Second, allowTracker{}, allowRevocations{}, &GatewayMetrics{}, nil)

	resp := doProxiedRequest(t, p, http.MethodGet, "/x", nil, proxyHeaders(makeJWT(t, time.Hour)))
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if p.metrics.Snapshot().DenialsSignature != 1 {
		t.Fatalf("signature denials = %d", p.metrics.Snapshot().DenialsSignature)
	}
}

func TestProxyJTIReplayRejected(t *testing.T) {
	sts := newFakeSTS(t, "http://127.0.0.1:1", nil)
	defer sts.Close()
	stsClient := newSTSClient(sts.URL, time.Second, nil)
	p := newProxy(stsClient, allowVerifier{}, newUpstreamGuard(nil), zerolog.Nop(), 1<<20, time.Second, denyTracker{}, allowRevocations{}, &GatewayMetrics{}, nil)

	resp := doProxiedRequest(t, p, http.MethodGet, "/x", nil, proxyHeaders(makeJWT(t, time.Hour)))
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if p.metrics.Snapshot().DenialsJTIReplay != 1 {
		t.Fatalf("jti replay denials = %d", p.metrics.Snapshot().DenialsJTIReplay)
	}
}

func TestProxyOpenCircuitFastFails(t *testing.T) {
	sts := newFakeSTS(t, "http://127.0.0.1:1", nil)
	defer sts.Close()
	p := newProxyForTest(t, sts)
	p.stsOpenUntil = time.Now().Add(time.Minute)

	resp := doProxiedRequest(t, p, http.MethodGet, "/x", nil, proxyHeaders(makeJWT(t, time.Hour)))
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if p.metrics.Snapshot().STSCircuitFastFail != 1 {
		t.Fatalf("circuit fast fails = %d", p.metrics.Snapshot().STSCircuitFastFail)
	}
}

func newFakeSTSWithDirective(t *testing.T, directive corests.UpstreamDirective) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(stsResponseFixture{
			AccessToken: "sts-issued-token",
			ExpiresIn:   300,
			Upstreams:   map[string]corests.UpstreamDirective{r.Form.Get("resource"): directive},
		})
	}))
}

func TestProxyRejectsDisallowedProviderHost(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	sts := newFakeSTSWithDirective(t, corests.UpstreamDirective{
		URL:               upstream.URL,
		AuthMode:          "provider_oauth",
		ProviderToken:     "provider-token",
		AllowedTokenHosts: []string{"api.pipernet.example"},
	})
	defer sts.Close()
	rec := &recordAudit{}
	stsClient := newSTSClient(sts.URL, time.Second, nil)
	p := newProxy(stsClient, allowVerifier{}, newUpstreamGuard(nil), zerolog.Nop(), 1<<20, time.Second, allowTracker{}, allowRevocations{}, &GatewayMetrics{}, rec)

	resp := doProxiedRequest(t, p, http.MethodGet, "/x", nil, proxyHeaders(makeJWT(t, time.Hour)))
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if len(rec.events) != 1 {
		t.Fatalf("audit events = %d", len(rec.events))
	}
	if p.metrics.Snapshot().UpstreamErrors != 1 {
		t.Fatalf("upstream errors = %d", p.metrics.Snapshot().UpstreamErrors)
	}
}

func TestProxyUpstreamTransportErrorAudited(t *testing.T) {
	sts := newFakeSTS(t, "http://127.0.0.1:1", nil)
	defer sts.Close()
	rec := &recordAudit{}
	stsClient := newSTSClient(sts.URL, time.Second, nil)
	p := newProxy(stsClient, allowVerifier{}, newUpstreamGuard(nil), zerolog.Nop(), 1<<20, time.Second, allowTracker{}, allowRevocations{}, &GatewayMetrics{}, rec)

	resp := doProxiedRequest(t, p, http.MethodGet, "/r", nil, proxyHeaders(makeJWT(t, time.Hour)))
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if len(rec.events) != 1 {
		t.Fatalf("audit events = %d", len(rec.events))
	}
	if p.metrics.Snapshot().UpstreamErrors != 1 {
		t.Fatalf("upstream errors = %d", p.metrics.Snapshot().UpstreamErrors)
	}
}

func TestClassifyUpstreamErrorMapsTransportFailures(t *testing.T) {
	for _, tc := range []struct {
		err    error
		status int
		code   sharederr.Code
	}{
		{err: context.DeadlineExceeded, status: http.StatusGatewayTimeout, code: sharederr.Internal},
		{err: context.Canceled, status: 499, code: sharederr.Internal},
		{err: &http.MaxBytesError{Limit: 1}, status: http.StatusRequestEntityTooLarge, code: sharederr.PayloadTooLarge},
		{err: errors.New("connection refused"), status: http.StatusBadGateway, code: sharederr.Internal},
	} {
		status, code, msg := classifyUpstreamError(tc.err)
		if status != tc.status || code != tc.code || msg == "" {
			t.Fatalf("classify(%v) = %d %s %q", tc.err, status, code, msg)
		}
	}
}

func TestNewProxyPanicsWithoutRequiredDependencies(t *testing.T) {
	expectPanic := func(name string, fn func()) {
		defer func() {
			if recover() == nil {
				t.Fatalf("%s: expected panic", name)
			}
		}()
		fn()
	}
	guard := newUpstreamGuard(nil)
	expectPanic("nil jwks", func() {
		newProxy(nil, nil, guard, zerolog.Nop(), 1, time.Second, allowTracker{}, allowRevocations{}, nil, nil)
	})
	expectPanic("nil tracker", func() {
		newProxy(nil, allowVerifier{}, guard, zerolog.Nop(), 1, time.Second, nil, allowRevocations{}, nil, nil)
	})
	expectPanic("nil revocations", func() {
		newProxy(nil, allowVerifier{}, guard, zerolog.Nop(), 1, time.Second, allowTracker{}, nil, nil, nil)
	})
}

// plainWriter hides the recorder's Flush method so copyResponse takes the
// unbuffered path.
type plainWriter struct {
	http.ResponseWriter
}

func TestCopyResponseWithoutFlusherCopiesBody(t *testing.T) {
	rec := httptest.NewRecorder()
	resp := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/plain"}},
		Body:       io.NopCloser(strings.NewReader("hello")),
	}
	result := copyResponse(plainWriter{rec}, resp, allowRevocations{}, tokenRevocationIDs{})
	if result.Bytes != 5 || result.Revoked {
		t.Fatalf("copy result = %+v", result)
	}
	if rec.Body.String() != "hello" {
		t.Fatalf("body = %q", rec.Body.String())
	}
}

func TestJWTZoneIDRejectsMalformedTokens(t *testing.T) {
	valid := base64.RawURLEncoding.EncodeToString([]byte(`{"zone_id":"z"}`))
	for name, token := range map[string]string{
		"wrong parts":  "abc",
		"bad base64":   "h.!!!.s",
		"bad json":     "h." + base64.RawURLEncoding.EncodeToString([]byte("{")) + ".s",
		"invalid zone": "h." + base64.RawURLEncoding.EncodeToString([]byte(`{"zone_id":"z one!"}`)) + ".s",
	} {
		if got := jwtZoneID(token); got != "" {
			t.Fatalf("%s: zone = %q", name, got)
		}
	}
	if got := jwtZoneID("h." + valid + ".s"); got != "z" {
		t.Fatalf("valid zone = %q", got)
	}
}

func TestJWTExpRejectsMalformedTokens(t *testing.T) {
	for name, token := range map[string]string{
		"wrong parts": "abc",
		"bad base64":  "h.!!!.s",
		"bad json":    "h." + base64.RawURLEncoding.EncodeToString([]byte("{")) + ".s",
		"missing exp": "h." + base64.RawURLEncoding.EncodeToString([]byte(`{}`)) + ".s",
	} {
		if _, ok := jwtExp(token); ok {
			t.Fatalf("%s: expected rejection", name)
		}
	}
}
