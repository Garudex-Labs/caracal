// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// CSS1 envelope encryption for the Caracal Secret Store: per-secret data keys wrapped by the master KEK.

package secretstore

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"os"

	"golang.org/x/crypto/chacha20poly1305"
)

const (
	keyBytes    = 32
	nonceBytes  = 12
	tagBytes    = 16
	kekIDBytes  = 8
	dekBlockLen = nonceBytes + keyBytes + tagBytes
)

var (
	magic  = []byte("CSS1")
	dekAAD = []byte("caracal.css1.dek")
)

func minEnvelopeLen() int {
	return len(magic) + kekIDBytes + dekBlockLen + nonceBytes + tagBytes
}

// KEKID identifies the master key that wrapped an envelope's data key.
func KEKID(kek []byte) []byte {
	sum := sha256.Sum256(kek)
	return sum[:kekIDBytes]
}

// Seal produces a CSS1 envelope:
//
//	magic(4) | kekId(8) | dekNonce(12) | dekCt(48) | valNonce(12) | valCt(n+16)
//
// The data key is random per envelope and sealed under the KEK; the value is sealed
// under the data key with aad binding the ciphertext to its logical location, so a
// blob moved to another row or table refuses to decrypt.
func Seal(kek, plaintext []byte, aad string) ([]byte, error) {
	if len(kek) != keyBytes {
		return nil, fmt.Errorf("kek must be %d bytes", keyBytes)
	}
	if len(plaintext) > math.MaxInt-minEnvelopeLen() {
		return nil, errors.New("plaintext too large to seal")
	}
	dek := make([]byte, keyBytes)
	if _, err := rand.Read(dek); err != nil {
		return nil, err
	}
	defer clear(dek)
	kekAEAD, err := chacha20poly1305.New(kek)
	if err != nil {
		return nil, err
	}
	dekAEAD, err := chacha20poly1305.New(dek)
	if err != nil {
		return nil, err
	}
	dekNonce := make([]byte, nonceBytes)
	valNonce := make([]byte, nonceBytes)
	if _, err := rand.Read(dekNonce); err != nil {
		return nil, err
	}
	if _, err := rand.Read(valNonce); err != nil {
		return nil, err
	}
	envelope := make([]byte, 0, minEnvelopeLen()+len(plaintext))
	envelope = append(envelope, magic...)
	envelope = append(envelope, KEKID(kek)...)
	envelope = append(envelope, dekNonce...)
	envelope = kekAEAD.Seal(envelope, dekNonce, dek, dekAAD)
	envelope = append(envelope, valNonce...)
	return dekAEAD.Seal(envelope, valNonce, plaintext, []byte(aad)), nil
}

// Open decrypts a CSS1 envelope produced by Seal in any Caracal language runtime.
func Open(kek, envelope []byte, aad string) ([]byte, error) {
	if len(kek) != keyBytes {
		return nil, fmt.Errorf("kek must be %d bytes", keyBytes)
	}
	if len(envelope) < minEnvelopeLen() {
		return nil, errors.New("secret envelope too short")
	}
	offset := 0
	if !bytes.Equal(envelope[:len(magic)], magic) {
		return nil, errors.New("secret envelope has unknown format")
	}
	offset += len(magic)
	if !bytes.Equal(envelope[offset:offset+kekIDBytes], KEKID(kek)) {
		return nil, errors.New("secret envelope was sealed under a different KEK")
	}
	offset += kekIDBytes
	dekNonce := envelope[offset : offset+nonceBytes]
	offset += nonceBytes
	dekCt := envelope[offset : offset+keyBytes+tagBytes]
	offset += keyBytes + tagBytes
	valNonce := envelope[offset : offset+nonceBytes]
	offset += nonceBytes
	kekAEAD, err := chacha20poly1305.New(kek)
	if err != nil {
		return nil, err
	}
	dek, err := kekAEAD.Open(nil, dekNonce, dekCt, dekAAD)
	if err != nil {
		return nil, errors.New("secret envelope data key rejected")
	}
	defer clear(dek)
	dekAEAD, err := chacha20poly1305.New(dek)
	if err != nil {
		return nil, err
	}
	plaintext, err := dekAEAD.Open(nil, valNonce, envelope[offset:], []byte(aad))
	if err != nil {
		return nil, errors.New("secret envelope value rejected")
	}
	return plaintext, nil
}

func weakKEKReason(b []byte) string {
	allSame := true
	ascending := true
	descending := true
	alternating := true
	for i := 1; i < len(b); i++ {
		if b[i] != b[0] {
			allSame = false
		}
		if int(b[i]) != int(b[i-1])+1 {
			ascending = false
		}
		if int(b[i]) != int(b[i-1])-1 {
			descending = false
		}
		if i >= 2 && b[i] != b[i%2] {
			alternating = false
		}
	}
	switch {
	case allSame && b[0] == 0:
		return "must not be all zeros"
	case allSame:
		return "must not repeat the same byte"
	case ascending || descending:
		return "must not use a sequential byte pattern"
	case alternating:
		return "must not use a repeating byte pattern"
	default:
		return ""
	}
}

func loadKEK(name string) ([]byte, error) {
	raw := os.Getenv(name)
	if raw == "" {
		return nil, fmt.Errorf("%s is required", name)
	}
	b, err := hex.DecodeString(raw)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	if len(b) != keyBytes {
		return nil, fmt.Errorf("%s must be %d bytes, got %d", name, keyBytes, len(b))
	}
	if reason := weakKEKReason(b); reason != "" {
		return nil, fmt.Errorf("%s %s", name, reason)
	}
	return b, nil
}

// Keyring holds the active Secret Store master keys, current first. Seal always
// uses the current key; Open routes each envelope by its embedded kekId so reads
// keep working across a KEK rotation window.
type Keyring struct {
	keys [][]byte
	ids  [][]byte
}

func NewKeyring(keys ...[]byte) (*Keyring, error) {
	if len(keys) == 0 {
		return nil, errors.New("keyring requires at least one key")
	}
	ring := &Keyring{}
	for _, key := range keys {
		if len(key) != keyBytes {
			return nil, fmt.Errorf("kek must be %d bytes", keyBytes)
		}
		ring.keys = append(ring.keys, key)
		ring.ids = append(ring.ids, KEKID(key))
	}
	return ring, nil
}

// LoadKeyring reads the master keys: 32 bytes of hex delivered by file-backed
// environment, never stored in the database, so a database compromise alone cannot
// decrypt secrets. SECRET_STORE_KEK_PREVIOUS keeps the retiring key readable while
// envelopes are re-sealed during a rotation.
func LoadKeyring() (*Keyring, error) {
	current, err := loadKEK("SECRET_STORE_KEK")
	if err != nil {
		return nil, err
	}
	keys := [][]byte{current}
	if os.Getenv("SECRET_STORE_KEK_PREVIOUS") != "" {
		previous, err := loadKEK("SECRET_STORE_KEK_PREVIOUS")
		if err != nil {
			return nil, err
		}
		keys = append(keys, previous)
	}
	return NewKeyring(keys...)
}

func (k *Keyring) Seal(plaintext []byte, aad string) ([]byte, error) {
	return Seal(k.keys[0], plaintext, aad)
}

func (k *Keyring) Open(envelope []byte, aad string) ([]byte, error) {
	if len(envelope) < minEnvelopeLen() {
		return nil, errors.New("secret envelope too short")
	}
	if !bytes.Equal(envelope[:len(magic)], magic) {
		return nil, errors.New("secret envelope has unknown format")
	}
	id := envelope[len(magic) : len(magic)+kekIDBytes]
	for i, keyID := range k.ids {
		if bytes.Equal(id, keyID) {
			return Open(k.keys[i], envelope, aad)
		}
	}
	return nil, errors.New("secret envelope was sealed under a different KEK")
}
