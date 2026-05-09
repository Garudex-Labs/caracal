// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for the gateway's revocation cache and sid extraction.

package internal

import (
	"encoding/base64"
	"io"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

func TestRevocationStoreMarkAndExpire(t *testing.T) {
	store := newRevocationStore(zerolog.New(io.Discard))
	if store.IsRevoked("sid1") {
		t.Fatalf("fresh store should not report sid1 revoked")
	}
	store.mark("sid1")
	if !store.IsRevoked("sid1") {
		t.Fatalf("sid1 should be revoked after mark")
	}
	store.mu.Lock()
	store.entries["sid1"] = time.Now().Add(-time.Second)
	store.mu.Unlock()
	if store.IsRevoked("sid1") {
		t.Fatalf("expired entry should not report revoked")
	}
	store.prune()
	store.mu.RLock()
	_, present := store.entries["sid1"]
	store.mu.RUnlock()
	if present {
		t.Fatalf("prune should drop expired entries")
	}
}

func TestRevocationStoreNilSafe(t *testing.T) {
	var store *revocationStore
	if store.IsRevoked("sid") {
		t.Fatalf("nil store must report not revoked")
	}
}

func TestJWTSIDPrefersSidClaim(t *testing.T) {
	payload := `{"sid":"sess-123","agent_session_id":"agent-xyz"}`
	tok := "header." + base64.RawURLEncoding.EncodeToString([]byte(payload)) + ".sig"
	if got := jwtSID(tok); got != "sess-123" {
		t.Fatalf("want sess-123, got %q", got)
	}
}

func TestJWTSIDFallsBackToAgentSession(t *testing.T) {
	payload := `{"agent_session_id":"agent-xyz"}`
	tok := "header." + base64.RawURLEncoding.EncodeToString([]byte(payload)) + ".sig"
	if got := jwtSID(tok); got != "agent-xyz" {
		t.Fatalf("want agent-xyz, got %q", got)
	}
}

func TestJWTSIDMalformed(t *testing.T) {
	if got := jwtSID("notajwt"); got != "" {
		t.Fatalf("malformed token should return empty sid, got %q", got)
	}
}
