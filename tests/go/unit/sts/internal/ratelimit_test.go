// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Rate limit and cryptographic helper unit tests.

package internal

import (
	"context"
	"testing"
)

func TestCheckRateLimitFailsClosedWhenRedisUnavailable(t *testing.T) {
	s := &Server{db: &stubDB{}, redis: nil}
	if err := s.checkRateLimit(context.Background(), "z1", "res-1", "app-1"); err == nil {
		t.Error("rate limit must fail closed when redis is unavailable")
	}
}

func TestSealOpenZEKRoundTrip(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	plaintext := []byte("super-secret-refresh-token")

	packed, err := sealZEK(key, plaintext)
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	if len(packed) == 0 {
		t.Fatal("packed must not be empty")
	}

	recovered, err := openZEK(key, packed)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if string(recovered) != string(plaintext) {
		t.Errorf("want %q, got %q", plaintext, recovered)
	}
}

func TestSealZEKProducesDifferentOutputEachTime(t *testing.T) {
	key := make([]byte, 32)
	plaintext := []byte("same plaintext")

	ct1, err := sealZEK(key, plaintext)
	if err != nil {
		t.Fatal(err)
	}
	ct2, err := sealZEK(key, plaintext)
	if err != nil {
		t.Fatal(err)
	}
	if string(ct1) == string(ct2) {
		t.Error("sealed output must differ between calls (random nonce)")
	}
}

func TestOpenZEKRejectsTruncatedCiphertext(t *testing.T) {
	key := make([]byte, 32)
	_, err := openZEK(key, []byte("short"))
	if err == nil {
		t.Error("want error for ciphertext shorter than nonce")
	}
}

func TestOpenZEKRejectsWrongKey(t *testing.T) {
	key := make([]byte, 32)
	plaintext := []byte("data")
	packed, err := sealZEK(key, plaintext)
	if err != nil {
		t.Fatal(err)
	}

	wrongKey := make([]byte, 32)
	wrongKey[0] = 0xFF
	_, err = openZEK(wrongKey, packed)
	if err == nil {
		t.Error("want error when decrypting with wrong key")
	}
}

func TestSealZEKRejectsInvalidKeyLength(t *testing.T) {
	_, err := sealZEK([]byte("short-key"), []byte("data"))
	if err == nil {
		t.Error("want error for invalid key length")
	}
}
