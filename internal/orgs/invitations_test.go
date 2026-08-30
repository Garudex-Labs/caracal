// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package orgs

import (
	"strings"
	"testing"
	"time"

	"github.com/garudex-labs/caracal/internal/fernet"
)

func TestInvitationState(t *testing.T) {
	now := time.Now().UTC()
	past := now.Add(-time.Hour)
	future := now.Add(time.Hour)
	cases := []struct {
		name string
		inv  Invitation
		want string
	}{
		{"pending", Invitation{ExpiresAt: future}, "pending"},
		{"expired", Invitation{ExpiresAt: past}, "expired"},
		{"revoked", Invitation{ExpiresAt: future, RevokedAt: &past}, "revoked"},
		{"accepted", Invitation{ExpiresAt: future, AcceptedAt: &past}, "accepted"},
		// Acceptance is terminal: it outranks both revocation and expiry.
		{"accepted outranks revoked", Invitation{ExpiresAt: past, AcceptedAt: &past, RevokedAt: &past}, "accepted"},
		{"revoked outranks expired", Invitation{ExpiresAt: past, RevokedAt: &past}, "revoked"},
	}
	for _, tc := range cases {
		if got := tc.inv.State(now); got != tc.want {
			t.Errorf("%s: State() = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestInvitationTokensAreOpaqueAndHashed(t *testing.T) {
	a, err := newInvitationToken()
	if err != nil {
		t.Fatal(err)
	}
	b, err := newInvitationToken()
	if err != nil {
		t.Fatal(err)
	}
	if a == b {
		t.Fatal("two generated tokens collided")
	}
	if len(a) < 32 {
		t.Fatalf("token %q too short", a)
	}
	h := invitationTokenHash(a)
	if len(h) != 64 || strings.Contains(h, a) {
		t.Fatalf("hash %q must be a hex digest unrelated to the token", h)
	}
	if invitationTokenHash(a) != h {
		t.Fatal("hash must be deterministic")
	}
}

func TestInvitationURLOnlyForPending(t *testing.T) {
	h := &Handler{Settings: fakeSetting{}, SecretKey: fernet.DeriveKey("test-secret")}
	enc, err := h.encryptInvitationToken("tok-123")
	if err != nil {
		t.Fatal(err)
	}
	past := time.Now().UTC().Add(-time.Hour)
	pending := &Invitation{Email: "a@x.dev", Role: "member", TokenEncrypted: &enc, ExpiresAt: time.Now().UTC().Add(time.Hour)}
	got := h.wireInvitation(pending, "acme", "Acme", nil, true)
	if got.URL == nil || !strings.Contains(*got.URL, "/onboarding/organization?invite=tok-123") {
		t.Fatalf("pending invitation URL = %v", got.URL)
	}
	// Consumed or dead invitations never re-expose their link.
	for _, inv := range []*Invitation{
		{Email: "a@x.dev", TokenEncrypted: &enc, ExpiresAt: past},
		{Email: "a@x.dev", TokenEncrypted: &enc, ExpiresAt: time.Now().UTC().Add(time.Hour), RevokedAt: &past},
		{Email: "a@x.dev", TokenEncrypted: &enc, ExpiresAt: time.Now().UTC().Add(time.Hour), AcceptedAt: &past},
	} {
		if wired := h.wireInvitation(inv, "acme", "Acme", nil, true); wired.URL != nil {
			t.Errorf("state %s still exposes a URL", wired.State)
		}
	}
	// The addressee listing never carries the link at all.
	if wired := h.wireInvitation(pending, "acme", "Acme", nil, false); wired.URL != nil {
		t.Error("withURL=false must suppress the link")
	}
}
