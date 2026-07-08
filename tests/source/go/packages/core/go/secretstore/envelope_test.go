// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for CSS1 envelope sealing, opening, and KEK loading.

package secretstore

import (
	"bytes"
	"encoding/hex"
	"strings"
	"testing"
)

func testKEK() []byte {
	kek, err := hex.DecodeString("8f3d9a712c45e6b0d18f2a4c6e9b3d57a1c4f8020e6a9c3d5b7f1a2c4e6d8b90")
	if err != nil {
		panic(err)
	}
	return kek
}

func TestSealOpenRoundTrip(t *testing.T) {
	kek := testKEK()
	plaintext := []byte("super-secret-provider-credential")
	envelope, err := Seal(kek, plaintext, "caracal/test/roundtrip")
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	if len(envelope) < minEnvelopeLen() {
		t.Fatalf("envelope shorter than minimum: %d", len(envelope))
	}
	if !bytes.HasPrefix(envelope, []byte("CSS1")) {
		t.Fatal("envelope must start with CSS1 magic")
	}
	recovered, err := Open(kek, envelope, "caracal/test/roundtrip")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if !bytes.Equal(recovered, plaintext) {
		t.Errorf("want %q, got %q", plaintext, recovered)
	}
}

func TestSealProducesUniqueEnvelopes(t *testing.T) {
	kek := testKEK()
	first, err := Seal(kek, []byte("same plaintext"), "aad")
	if err != nil {
		t.Fatal(err)
	}
	second, err := Seal(kek, []byte("same plaintext"), "aad")
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(first, second) {
		t.Error("envelopes must differ between calls (random DEK and nonces)")
	}
}

func TestOpenRejectsWrongAAD(t *testing.T) {
	kek := testKEK()
	envelope, err := Seal(kek, []byte("data"), "zones/z1/providers/p1/secretConfig")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Open(kek, envelope, "zones/z1/providers/p2/secretConfig"); err == nil {
		t.Error("want error when opening under a different AAD")
	}
}

func TestOpenRejectsWrongKEK(t *testing.T) {
	kek := testKEK()
	envelope, err := Seal(kek, []byte("data"), "aad")
	if err != nil {
		t.Fatal(err)
	}
	wrong := testKEK()
	wrong[0] ^= 0xFF
	_, err = Open(wrong, envelope, "aad")
	if err == nil || !strings.Contains(err.Error(), "different KEK") {
		t.Errorf("want KEK mismatch error, got %v", err)
	}
}

func TestOpenRejectsTamperedValue(t *testing.T) {
	kek := testKEK()
	envelope, err := Seal(kek, []byte("data"), "aad")
	if err != nil {
		t.Fatal(err)
	}
	envelope[len(envelope)-1] ^= 0x01
	if _, err := Open(kek, envelope, "aad"); err == nil {
		t.Error("want error for tampered value ciphertext")
	}
}

func TestOpenRejectsTamperedDataKey(t *testing.T) {
	kek := testKEK()
	envelope, err := Seal(kek, []byte("data"), "aad")
	if err != nil {
		t.Fatal(err)
	}
	envelope[len(magic)+kekIDBytes+nonceBytes] ^= 0x01
	_, err = Open(kek, envelope, "aad")
	if err == nil || !strings.Contains(err.Error(), "data key") {
		t.Errorf("want data key rejection, got %v", err)
	}
}

func TestOpenRejectsTruncatedEnvelope(t *testing.T) {
	if _, err := Open(testKEK(), []byte("CSS1short"), "aad"); err == nil {
		t.Error("want error for truncated envelope")
	}
}

func TestOpenRejectsUnknownMagic(t *testing.T) {
	kek := testKEK()
	envelope, err := Seal(kek, []byte("data"), "aad")
	if err != nil {
		t.Fatal(err)
	}
	envelope[0] = 'X'
	_, err = Open(kek, envelope, "aad")
	if err == nil || !strings.Contains(err.Error(), "unknown format") {
		t.Errorf("want unknown format error, got %v", err)
	}
}

func TestSealRejectsInvalidKEKLength(t *testing.T) {
	if _, err := Seal([]byte("short"), []byte("data"), "aad"); err == nil {
		t.Error("want error for invalid KEK length")
	}
	if _, err := Open([]byte("short"), []byte("data"), "aad"); err == nil {
		t.Error("want error for invalid KEK length on open")
	}
}

func TestKEKIDIsDeterministicPrefix(t *testing.T) {
	kek := testKEK()
	id := KEKID(kek)
	if len(id) != kekIDBytes {
		t.Fatalf("want %d byte kek id, got %d", kekIDBytes, len(id))
	}
	if !bytes.Equal(id, KEKID(kek)) {
		t.Error("kek id must be deterministic")
	}
	envelope, err := Seal(kek, []byte("data"), "aad")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(envelope[len(magic):len(magic)+kekIDBytes], id) {
		t.Error("envelope must embed the kek id after the magic")
	}
}

// TestGoldenVectorFromTypeScript decrypts an envelope sealed by the TypeScript
// implementation, proving byte-level CSS1 compatibility across language runtimes.
func TestGoldenVectorFromTypeScript(t *testing.T) {
	envelope, err := hex.DecodeString(
		"435353318547798a706fba7297f14e4710dbb70cafae5284625e843ff8421f7c39a9163935" +
			"21998fb02c28cb8ed66bd59c3ee433fdb69dbe116f295b047f469dda4e0b18458de702ee43" +
			"0005bce2eb80fa7179ebc2f1703b332eb089df95e40689a592b90f696c8a10b80922d81251" +
			"5ec4db3ff067ccb578a016521c9e815538")
	if err != nil {
		t.Fatal(err)
	}
	recovered, err := Open(testKEK(), envelope, "caracal/test/golden")
	if err != nil {
		t.Fatalf("open golden vector: %v", err)
	}
	if string(recovered) != "cross-language golden secret" {
		t.Errorf("unexpected golden plaintext: %q", recovered)
	}
}

func TestLoadKeyring(t *testing.T) {
	strong := "8f3d9a712c45e6b0d18f2a4c6e9b3d57a1c4f8020e6a9c3d5b7f1a2c4e6d8b90"
	cases := []struct {
		name    string
		value   string
		wantErr string
	}{
		{"missing", "", "SECRET_STORE_KEK is required"},
		{"not hex", "zz", "SECRET_STORE_KEK"},
		{"wrong length", "8f3d9a71", "32 bytes"},
		{"all zeros", strings.Repeat("00", 32), "all zeros"},
		{"repeated byte", strings.Repeat("aa", 32), "repeat the same byte"},
		{"ascending", "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "sequential"},
		{"descending", "1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100", "sequential"},
		{"alternating", strings.Repeat("aa55", 16), "repeating byte pattern"},
		{"strong", strong, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("SECRET_STORE_KEK", tc.value)
			t.Setenv("SECRET_STORE_KEK_PREVIOUS", "")
			ring, err := LoadKeyring()
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("want success, got %v", err)
				}
				if len(ring.keys) != 1 || len(ring.keys[0]) != keyBytes {
					t.Fatalf("want one %d byte key, got %d keys", keyBytes, len(ring.keys))
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("want error containing %q, got %v", tc.wantErr, err)
			}
		})
	}
}

func TestLoadKeyringValidatesPreviousKey(t *testing.T) {
	t.Setenv("SECRET_STORE_KEK", "8f3d9a712c45e6b0d18f2a4c6e9b3d57a1c4f8020e6a9c3d5b7f1a2c4e6d8b90")
	t.Setenv("SECRET_STORE_KEK_PREVIOUS", strings.Repeat("aa", 32))
	if _, err := LoadKeyring(); err == nil || !strings.Contains(err.Error(), "SECRET_STORE_KEK_PREVIOUS") {
		t.Errorf("weak previous key must be rejected with its own name, got %v", err)
	}
	t.Setenv("SECRET_STORE_KEK_PREVIOUS", "d1c4f8020e6a9c3d5b7f1a2c4e6d8b908f3d9a712c45e6b0d18f2a4c6e9b3d57")
	ring, err := LoadKeyring()
	if err != nil {
		t.Fatal(err)
	}
	if len(ring.keys) != 2 {
		t.Fatalf("want current and previous key, got %d", len(ring.keys))
	}
}

func TestKeyringRotationRouting(t *testing.T) {
	current := testKEK()
	previous := make([]byte, keyBytes)
	for i := range previous {
		previous[i] = byte(255 - i*7)
	}
	oldRing, err := NewKeyring(previous)
	if err != nil {
		t.Fatal(err)
	}
	envelope, err := oldRing.Seal([]byte("rotate me"), "caracal/test/rotation")
	if err != nil {
		t.Fatal(err)
	}
	rotated, err := NewKeyring(current, previous)
	if err != nil {
		t.Fatal(err)
	}
	value, err := rotated.Open(envelope, "caracal/test/rotation")
	if err != nil || string(value) != "rotate me" {
		t.Fatalf("previous-key envelope must open through the keyring: %q %v", value, err)
	}
	resealed, err := rotated.Seal([]byte("rotate me"), "caracal/test/rotation")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Open(previous, resealed, "caracal/test/rotation"); err == nil {
		t.Error("seal must always use the current key")
	}
	currentOnly, err := NewKeyring(current)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := currentOnly.Open(envelope, "caracal/test/rotation"); err == nil || !strings.Contains(err.Error(), "different KEK") {
		t.Errorf("unknown kekId must be rejected, got %v", err)
	}
}
