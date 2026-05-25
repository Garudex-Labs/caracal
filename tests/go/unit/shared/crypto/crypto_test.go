// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared crypto unit tests for envelope encryption and signing key generation.

package crypto

import "testing"

func TestSealOpenRoundTrip(t *testing.T) {
	key := make([]byte, 32)
	ciphertext, nonce, err := Seal(key, []byte("secret payload"))
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	plaintext, err := Open(key, nonce, ciphertext)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if string(plaintext) != "secret payload" {
		t.Fatalf("want original payload, got %q", plaintext)
	}
}

func TestOpenRejectsWrongKey(t *testing.T) {
	key := make([]byte, 32)
	ciphertext, nonce, err := Seal(key, []byte("secret payload"))
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	wrongKey := make([]byte, 32)
	wrongKey[0] = 1
	if _, err := Open(wrongKey, nonce, ciphertext); err == nil {
		t.Fatal("expected wrong key to fail authentication")
	}
}

func TestGenerateP256Key(t *testing.T) {
	key, err := GenerateP256Key()
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	if key.Curve == nil || key.X == nil || key.Y == nil || key.D == nil {
		t.Fatalf("generated key is incomplete: %#v", key)
	}
}

func TestCanonicalizeStreamSkipsNilValues(t *testing.T) {
	got := string(CanonicalizeStream("s", map[string]any{
		"action":   "transfer",
		"metadata": nil,
	}))
	want := "s\naction=transfer\n"
	if got != want {
		t.Fatalf("nil value not skipped:\ngot:  %q\nwant: %q", got, want)
	}
}

func TestCanonicalizeStreamSkipsSigField(t *testing.T) {
	got := string(CanonicalizeStream("s", map[string]any{
		"action": "transfer",
		"_sig":   "deadbeef",
	}))
	want := "s\naction=transfer\n"
	if got != want {
		t.Fatalf("_sig field not excluded:\ngot:  %q\nwant: %q", got, want)
	}
}

func TestCanonicalizeStreamDeterministicOrder(t *testing.T) {
	values := map[string]any{"z": "1", "a": "2", "m": "3"}
	want := "s\na=2\nm=3\nz=1\n"
	// Run multiple times to catch map-ordering flakiness.
	for i := 0; i < 50; i++ {
		if got := string(CanonicalizeStream("s", values)); got != want {
			t.Fatalf("iteration %d: key order unstable:\ngot:  %q\nwant: %q", i, got, want)
		}
	}
}

func TestSignVerifyRoundTrip(t *testing.T) {
	key := []byte("00112233445566778899aabbccddeeff")
	values := map[string]any{"action": "transfer", "amount": "100"}
	sig := SignStream(key, "s", values)
	if sig == "" {
		t.Fatal("SignStream returned empty signature")
	}
	values[StreamSigField] = sig
	if !VerifyStream(key, "s", values) {
		t.Fatal("VerifyStream rejected its own signature")
	}
}

func TestSignVerifyWithNilField(t *testing.T) {
	key := []byte("00112233445566778899aabbccddeeff")
	values := map[string]any{"action": "transfer", "metadata": nil}
	sig := SignStream(key, "s", values)
	values[StreamSigField] = sig
	if !VerifyStream(key, "s", values) {
		t.Fatal("VerifyStream rejected signature for payload with nil field")
	}
}

