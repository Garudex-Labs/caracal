// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Application client-secret hashing: Argon2id with backward-compatible legacy verification.

package internal

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

const (
	argon2Time    uint32 = 3
	argon2Memory  uint32 = 64 * 1024
	argon2Threads uint8  = 2
	argon2KeyLen  uint32 = 32
	argon2SaltLen        = 16
	argon2Prefix         = "argon2id$"
)

// hashClientSecret produces the canonical Argon2id storage form for a new secret.
// Encoding: argon2id$<saltB64>$<hashB64>.
func hashClientSecret(secret string) (string, error) {
	salt := make([]byte, argon2SaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	sum := argon2.IDKey([]byte(secret), salt, argon2Time, argon2Memory, argon2Threads, argon2KeyLen)
	return fmt.Sprintf("%s%s$%s",
		argon2Prefix,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(sum),
	), nil
}

// verifyClientSecret checks a presented secret against the stored hash. It accepts both
// the Argon2id format above and the legacy hex-encoded SHA-256 used by earlier deploys.
// The second return value is true when the stored hash is legacy and should be re-encoded.
func verifyClientSecret(stored, presented string) (ok bool, needsRehash bool) {
	if stored == "" || presented == "" {
		return false, false
	}
	if strings.HasPrefix(stored, argon2Prefix) {
		ok = verifyArgon2id(stored, presented)
		return ok, false
	}
	// Legacy fallback: hex-encoded SHA-256 with no salt. Constant-time compared and
	// flagged so the caller can rehash on success.
	digest := sha256.Sum256([]byte(presented))
	actual := hex.EncodeToString(digest[:])
	if subtle.ConstantTimeCompare([]byte(actual), []byte(stored)) == 1 {
		return true, true
	}
	return false, false
}

func verifyArgon2id(stored, presented string) bool {
	parts := strings.Split(strings.TrimPrefix(stored, argon2Prefix), "$")
	if len(parts) != 2 {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[0])
	if err != nil {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[1])
	if err != nil {
		return false
	}
	got := argon2.IDKey([]byte(presented), salt, argon2Time, argon2Memory, argon2Threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}

// errSecretMismatch is returned when authentication fails; kept distinct from other
// internal errors so the handler can map it to AccessDenied without leaking details.
var errSecretMismatch = errors.New("invalid client secret")
