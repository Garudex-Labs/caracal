// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for copyResponse: identity header strip and mid-stream revocation trailer.

package internal

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

func TestCopyResponseStripsIdentityHeader(t *testing.T) {
	store := newRevocationStore(zerolog.Nop())
	resp := &http.Response{
		StatusCode: http.StatusOK,
		Header: http.Header{
			"Content-Type":       {"application/json"},
			"X-Caracal-Identity": {"caracal-jwt-leak"},
		},
		Body: io.NopCloser(strings.NewReader(`{"ok":true}`)),
	}
	rec := httptest.NewRecorder()
	result := copyResponse(rec, resp, store, tokenRevocationIDs{SID: "sid-1"})
	if result.Bytes == 0 || result.Revoked {
		t.Fatalf("expected copied bytes without revocation, got %#v", result)
	}
	if got := rec.Header().Get("X-Caracal-Identity"); got != "" {
		t.Fatalf("X-Caracal-Identity must not surface to clients, got %q", got)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type lost in copy, got %q", got)
	}
}

func TestCopyResponseStripsServerBanners(t *testing.T) {
	store := newRevocationStore(zerolog.Nop())
	resp := &http.Response{
		StatusCode: http.StatusOK,
		Header: http.Header{
			"Content-Type":        {"application/json"},
			"Server":              {"nginx/1.27.0"},
			"X-Powered-By":        {"Express"},
			"X-Aspnet-Version":    {"4.0.30319"},
			"X-Aspnetmvc-Version": {"5.2"},
		},
		Body: io.NopCloser(strings.NewReader(`{"ok":true}`)),
	}
	rec := httptest.NewRecorder()
	copyResponse(rec, resp, store, tokenRevocationIDs{SID: "sid-1"})
	for _, banner := range []string{"Server", "X-Powered-By", "X-Aspnet-Version", "X-Aspnetmvc-Version"} {
		if got := rec.Header().Get(banner); got != "" {
			t.Fatalf("%s banner must not surface to clients, got %q", banner, got)
		}
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type lost in copy, got %q", got)
	}
}

func TestCopyResponseSanitizesRedirectLocation(t *testing.T) {
	store := newRevocationStore(zerolog.Nop())
	cases := []struct {
		name     string
		location string
		wantKept bool
	}{
		{"absolute internal", "http://10.0.0.5/internal", false},
		{"absolute loopback", "http://127.0.0.1:9000/x", false},
		{"absolute public", "https://evil.example/steal", false},
		{"protocol relative", "//attacker.example/x", false},
		{"malformed", "http://[::1", false},
		{"relative path", "/v2/resource", true},
		{"relative query", "?page=2", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp := &http.Response{
				StatusCode: http.StatusFound,
				Header:     http.Header{"Location": {tc.location}},
				Body:       io.NopCloser(strings.NewReader("")),
			}
			rec := httptest.NewRecorder()
			copyResponse(rec, resp, store, tokenRevocationIDs{SID: "sid-1"})
			got := rec.Header().Get("Location")
			if tc.wantKept && got != tc.location {
				t.Fatalf("relative Location must be preserved, got %q", got)
			}
			if !tc.wantKept && got != "" {
				t.Fatalf("absolute/malformed Location must be stripped, got %q", got)
			}
		})
	}
}

func TestCopyResponseStripsRefreshHeader(t *testing.T) {
	store := newRevocationStore(zerolog.Nop())
	resp := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Refresh": {"0; url=http://10.0.0.5/x"}},
		Body:       io.NopCloser(strings.NewReader("")),
	}
	rec := httptest.NewRecorder()
	copyResponse(rec, resp, store, tokenRevocationIDs{SID: "sid-1"})
	if got := rec.Header().Get("Refresh"); got != "" {
		t.Fatalf("Refresh directive must not surface to clients, got %q", got)
	}
}

type slowReader struct {
	closed atomic.Bool
}

func (s *slowReader) Read(p []byte) (int, error) {
	for !s.closed.Load() {
		time.Sleep(time.Millisecond)
		return 0, nil
	}
	return 0, io.EOF
}

func (s *slowReader) Close() error {
	s.closed.Store(true)
	return nil
}

type flushRecorder struct {
	*httptest.ResponseRecorder
}

func (f *flushRecorder) Flush() {
	f.ResponseRecorder.Flush()
}

func TestCopyResponseEmitsRevocationTrailer(t *testing.T) {
	store := newRevocationStore(zerolog.Nop())
	resp := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": {"text/event-stream"}},
		Body:       &slowReader{},
	}
	rec := &flushRecorder{ResponseRecorder: httptest.NewRecorder()}
	go func() {
		time.Sleep(15 * time.Millisecond)
		store.markSession("sid-stream")
	}()
	result := copyResponse(rec, resp, store, tokenRevocationIDs{SID: "sid-stream"})
	if !result.Revoked {
		t.Fatalf("expected copy result to record revocation")
	}
	if got := rec.Header().Get("Trailer"); got != "X-Caracal-Revoked" {
		t.Fatalf("expected Trailer announcement, got %q", got)
	}
	if got := rec.Header().Get("X-Caracal-Revoked"); got != "true" {
		t.Fatalf("expected X-Caracal-Revoked trailer, got %q", got)
	}
}
