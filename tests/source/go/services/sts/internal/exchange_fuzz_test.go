// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Fuzz target for token exchange HTTP handler form parsing.

package internal

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/rs/zerolog"
)

// FuzzExchangeRequestParsing feeds random form-encoded payloads into the HTTP handler.
// The handler must never panic regardless of input: it may return 4xx/5xx but not crash.
func FuzzExchangeRequestParsing(f *testing.F) {
	// Seed corpus: valid-structure forms that exercise different code paths.
	seeds := []url.Values{
		{
			"grant_type":         {"urn:ietf:params:oauth:grant-type:token-exchange"},
			"subject_token":      {"tok"},
			"subject_token_type": {"urn:ietf:params:oauth:token-type:access_token"},
			"resource":           {"resource://api"},
			"client_id":          {"zone1:app1"},
		},
		{
			"ttl_seconds": {"not-a-number"},
			"grant_type":  {"bad"},
		},
		{
			"ttl_seconds": {"-9999"},
			"resource":    {"resource://x", "resource://y"},
		},
		{},
	}
	for _, s := range seeds {
		f.Add(s.Encode())
	}

	stub := &stubDB{appErr: errors.New("auth denied")}
	s := &Server{
		db:          stub,
		redis:       newMemSTSRedis(),
		opa:         newOPAEngine(stub),
		keys:        newKeyCache(stub, testKeyring(make([]byte, 32))),
		auditBuffer: &AuditBuffer{ch: make(chan AuditEvent, auditBufCap), log: zerolog.Nop()},
		metrics:     &STSMetrics{},
	}

	f.Fuzz(func(t *testing.T, body string) {
		req := httptest.NewRequest(http.MethodPost, "/oauth/2/token",
			strings.NewReader(body))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		rr := httptest.NewRecorder()

		s.handleTokenExchange(rr, req)

		code := rr.Code
		if code < 200 || code > 599 {
			t.Errorf("response code out of valid range: %d", code)
		}
	})
}
