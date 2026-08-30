// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package fernet

import "testing"

func TestRoundTrip(t *testing.T) {
	key := DeriveKey("interop-test-key")
	tok, err := Encrypt(key, []byte("round-trip"))
	if err != nil {
		t.Fatal(err)
	}
	pt, err := Decrypt(key, tok)
	if err != nil {
		t.Fatal(err)
	}
	if string(pt) != "round-trip" {
		t.Fatalf("got %q", pt)
	}
}

// The fixture token was produced by the cryptography library's Fernet with
// the same derived key; decrypting it pins wire-format compatibility.
func TestDecryptExternalToken(t *testing.T) {
	key := DeriveKey("interop-test-key")
	const token = "gAAAAABqko4MbB8ZAEMUD9g6QLUYP6ccNi4QV85-y8hH21g0knnnLT4VyiP0uqbkbHhLzDXG5Ds1YEWrjC9vpNm9cAnNFk0bpQ=="
	pt, err := Decrypt(key, token)
	if err != nil {
		t.Fatal(err)
	}
	if string(pt) != "py-to-go-secret" {
		t.Fatalf("got %q", pt)
	}
}

func TestDecryptRejectsTampering(t *testing.T) {
	key := DeriveKey("interop-test-key")
	tok, err := Encrypt(key, []byte("x"))
	if err != nil {
		t.Fatal(err)
	}
	broken := []byte(tok)
	broken[len(broken)-5] ^= 'A'
	if _, err := Decrypt(key, string(broken)); err == nil {
		t.Fatal("tampered token accepted")
	}
	if _, err := Decrypt(DeriveKey("other-key"), tok); err == nil {
		t.Fatal("wrong key accepted")
	}
}
