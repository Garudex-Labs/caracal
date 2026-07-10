// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Property tests for envelope encryption and stream-signature invariants.

package property

import (
	"crypto/rand"
	"fmt"
	"testing"
	"testing/quick"

	"github.com/garudex-labs/caracal/packages/core/go/crypto"
	"github.com/garudex-labs/caracal/packages/core/go/secretstore"
)

const propertyAAD = "caracal/tests/property"

func newKey(t *testing.T) []byte {
	t.Helper()
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatalf("rand key: %v", err)
	}
	return key
}

func TestSealOpenRoundTrip(t *testing.T) {
	key := newKey(t)
	roundTrip := func(plaintext []byte) bool {
		envelope, err := secretstore.Seal(key, plaintext, propertyAAD)
		if err != nil {
			return false
		}
		got, err := secretstore.Open(key, envelope, propertyAAD)
		if err != nil {
			return false
		}
		if len(plaintext) == 0 {
			return len(got) == 0
		}
		return string(got) == string(plaintext)
	}
	if err := quick.Check(roundTrip, &quick.Config{MaxCount: 500}); err != nil {
		t.Errorf("seal/open round trip failed: %v", err)
	}
}

func TestOpenRejectsTamperedCiphertext(t *testing.T) {
	key := newKey(t)
	tamperFails := func(plaintext []byte, index uint16) bool {
		envelope, err := secretstore.Seal(key, plaintext, propertyAAD)
		if err != nil {
			return false
		}
		envelope[int(index)%len(envelope)] ^= 0xFF
		_, err = secretstore.Open(key, envelope, propertyAAD)
		return err != nil
	}
	if err := quick.Check(tamperFails, &quick.Config{MaxCount: 500}); err != nil {
		t.Errorf("tampered envelope was accepted: %v", err)
	}
}

func TestOpenRejectsWrongKey(t *testing.T) {
	key := newKey(t)
	other := newKey(t)
	wrongKeyFails := func(plaintext []byte) bool {
		envelope, err := secretstore.Seal(key, plaintext, propertyAAD)
		if err != nil {
			return false
		}
		_, err = secretstore.Open(other, envelope, propertyAAD)
		return err != nil
	}
	if err := quick.Check(wrongKeyFails, &quick.Config{MaxCount: 300}); err != nil {
		t.Errorf("wrong key decrypted envelope: %v", err)
	}
}

func TestOpenRejectsWrongAAD(t *testing.T) {
	key := newKey(t)
	wrongAADFails := func(plaintext []byte) bool {
		envelope, err := secretstore.Seal(key, plaintext, propertyAAD)
		if err != nil {
			return false
		}
		_, err = secretstore.Open(key, envelope, propertyAAD+"/other")
		return err != nil
	}
	if err := quick.Check(wrongAADFails, &quick.Config{MaxCount: 300}); err != nil {
		t.Errorf("wrong AAD decrypted envelope: %v", err)
	}
}

func TestSignVerifyRoundTrip(t *testing.T) {
	key := newKey(t)
	roundTrip := func(stream string, a int, b string, c bool) bool {
		values := map[string]any{"a": a, "b": b, "c": c}
		sig := crypto.SignStream(key, stream, values)
		if sig == "" {
			return false
		}
		values[crypto.StreamSigField] = sig
		return crypto.VerifyStream(key, stream, values)
	}
	if err := quick.Check(roundTrip, &quick.Config{MaxCount: 500}); err != nil {
		t.Errorf("sign/verify round trip failed: %v", err)
	}
}

func TestVerifyRejectsTamperedValue(t *testing.T) {
	key := newKey(t)
	tamperFails := func(stream string, a int) bool {
		values := map[string]any{"a": a}
		values[crypto.StreamSigField] = crypto.SignStream(key, stream, values)
		values["a"] = a + 1
		return !crypto.VerifyStream(key, stream, values)
	}
	if err := quick.Check(tamperFails, &quick.Config{MaxCount: 500}); err != nil {
		t.Errorf("tampered stream value verified: %v", err)
	}
}

func TestCanonicalizeIsOrderIndependent(t *testing.T) {
	stable := func(stream string, x int, y string) bool {
		first := crypto.CanonicalizeStream(stream, map[string]any{"x": x, "y": y})
		second := crypto.CanonicalizeStream(stream, map[string]any{"y": y, "x": x})
		return string(first) == string(second)
	}
	if err := quick.Check(stable, &quick.Config{MaxCount: 500}); err != nil {
		t.Errorf("canonicalization is order dependent: %v", err)
	}
}

func TestCanonicalizeExcludesSigField(t *testing.T) {
	stream := "caracal.audit.events"
	withSig := crypto.CanonicalizeStream(stream, map[string]any{"k": "v", crypto.StreamSigField: "deadbeef"})
	withoutSig := crypto.CanonicalizeStream(stream, map[string]any{"k": "v"})
	if string(withSig) != string(withoutSig) {
		t.Errorf("sig field leaked into canonical form: %q vs %q", withSig, withoutSig)
	}
}

func TestVerifyFailsWithoutSignature(t *testing.T) {
	key := newKey(t)
	values := map[string]any{"k": fmt.Sprint(123)}
	if crypto.VerifyStream(key, "s", values) {
		t.Error("verification passed without a signature present")
	}
}
