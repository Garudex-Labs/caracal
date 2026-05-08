// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// HMAC-SHA256 origin signatures for Redis stream messages.

package crypto

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
)

// StreamSigField is the reserved key under which a stream message's origin signature
// is carried. It is excluded from the signed payload.
const StreamSigField = "_sig"

// CanonicalizeStream produces a deterministic byte serialization of a stream values
// map for signing. Keys are sorted; values are coerced to strings via Sprint, the same
// shape Redis preserves on the wire. The reserved sig field is skipped.
func CanonicalizeStream(stream string, values map[string]interface{}) []byte {
	keys := make([]string, 0, len(values))
	for k := range values {
		if k == StreamSigField {
			continue
		}
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString(stream)
	b.WriteByte('\n')
	for _, k := range keys {
		b.WriteString(k)
		b.WriteByte('=')
		b.WriteString(fmt.Sprint(values[k]))
		b.WriteByte('\n')
	}
	return []byte(b.String())
}

// SignStream returns the hex HMAC-SHA256 of the canonical form. An empty key returns
// "" so callers can keep signing optional in non-production startup paths.
func SignStream(key []byte, stream string, values map[string]interface{}) string {
	if len(key) == 0 {
		return ""
	}
	mac := hmac.New(sha256.New, key)
	mac.Write(CanonicalizeStream(stream, values))
	return hex.EncodeToString(mac.Sum(nil))
}

// VerifyStream returns true when the message carries a sig that matches the expected
// HMAC. With no key configured (dev mode) every message verifies so producers and
// consumers can be rolled out independently.
func VerifyStream(key []byte, stream string, values map[string]interface{}) bool {
	if len(key) == 0 {
		return true
	}
	got, _ := values[StreamSigField].(string)
	if got == "" {
		return false
	}
	want, err := hex.DecodeString(got)
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, key)
	mac.Write(CanonicalizeStream(stream, values))
	return hmac.Equal(want, mac.Sum(nil))
}

// DecodeStreamKey parses a hex-encoded stream HMAC key and enforces ≥32 bytes so the
// signature is computed over a key with at least the strength of SHA-256.
func DecodeStreamKey(hexKey string) ([]byte, error) {
	if hexKey == "" {
		return nil, nil
	}
	k, err := hex.DecodeString(hexKey)
	if err != nil {
		return nil, fmt.Errorf("hex decode: %w", err)
	}
	if len(k) < 32 {
		return nil, fmt.Errorf("stream hmac key must be at least 32 bytes")
	}
	return k, nil
}
