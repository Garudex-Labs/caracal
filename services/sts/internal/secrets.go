// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Application client-secret hashing using Argon2id with a verified-credential cache.

package internal

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/argon2"
)

const (
	argon2Time    uint32 = 3
	argon2Memory  uint32 = 64 * 1024
	argon2Threads uint8  = 2
	argon2KeyLen  uint32 = 32
	argon2SaltLen        = 16
	argon2Prefix         = "argon2id$"

	secretVerifyCacheTTL = time.Hour
	secretVerifyCacheMax = 8192
)

// verifiedSecretCache remembers which presented client secrets already passed
// Argon2id verification against a specific stored hash, so steady-state token
// exchanges skip the memory-hard derivation. Entries are keyed by the stored
// hash itself: rotating a credential produces a new stored hash, so the stale
// entry can never satisfy the new credential and simply ages out. Slow-path
// derivations run under a fixed concurrency budget so a burst of cold
// verifications cannot exhaust container memory (each derivation allocates
// argon2Memory KiB). The zero value verifies with a budget of one slot.
type verifiedSecretCache struct {
	mu      sync.Mutex
	entries map[string]verifiedSecretEntry
	slots   chan struct{}
}

type verifiedSecretEntry struct {
	digest    [sha256.Size]byte
	expiresAt time.Time
}

// configure sizes the Argon2id concurrency budget; call once before serving.
func (c *verifiedSecretCache) configure(concurrency int) {
	if concurrency < 1 {
		concurrency = 1
	}
	c.mu.Lock()
	c.slots = make(chan struct{}, concurrency)
	c.mu.Unlock()
}

func (c *verifiedSecretCache) acquireSlot() chan struct{} {
	c.mu.Lock()
	if c.slots == nil {
		c.slots = make(chan struct{}, 1)
	}
	slots := c.slots
	c.mu.Unlock()
	slots <- struct{}{}
	return slots
}

// verify checks a presented secret against the stored Argon2id hash. The cached
// digest comparison is constant-time, and any miss or mismatch falls through to a
// full Argon2id derivation: the cache only ever accelerates the known-good secret,
// it can never change an outcome. The stored form at rest stays Argon2id; only a
// SHA-256 digest of an already-verified secret is held in process memory.
func (c *verifiedSecretCache) verify(stored, presented string) bool {
	if stored == "" || presented == "" {
		return false
	}
	if !strings.HasPrefix(stored, argon2Prefix) {
		return false
	}
	digest := sha256.Sum256([]byte(presented))
	now := time.Now()
	c.mu.Lock()
	entry, ok := c.entries[stored]
	c.mu.Unlock()
	if ok && now.Before(entry.expiresAt) && subtle.ConstantTimeCompare(digest[:], entry.digest[:]) == 1 {
		return true
	}
	slots := c.acquireSlot()
	verified := verifyArgon2id(stored, presented)
	<-slots
	if !verified {
		return false
	}
	c.mu.Lock()
	if c.entries == nil {
		c.entries = make(map[string]verifiedSecretEntry)
	}
	if len(c.entries) >= secretVerifyCacheMax {
		c.evictLocked(now)
	}
	c.entries[stored] = verifiedSecretEntry{digest: digest, expiresAt: now.Add(secretVerifyCacheTTL)}
	c.mu.Unlock()
	return true
}

// evictLocked drops expired entries first, then arbitrary entries until the cache
// is below capacity. Callers must hold mu.
func (c *verifiedSecretCache) evictLocked(now time.Time) {
	for key, entry := range c.entries {
		if !now.Before(entry.expiresAt) {
			delete(c.entries, key)
		}
	}
	for key := range c.entries {
		if len(c.entries) < secretVerifyCacheMax {
			break
		}
		delete(c.entries, key)
	}
}

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

// verifyArgon2id checks `presented` against an `argon2id$<saltB64>$<hashB64>` storage
// form. Malformed records are still run through one full Argon2id derivation against a
// constant dummy salt so the verification time does not reveal whether the stored hash
// is parseable: only legitimate operator misconfiguration produces a mismatch here,
// but the constant-time stance avoids leaking format-validity bits over the network.
func verifyArgon2id(stored, presented string) bool {
	parts := strings.Split(strings.TrimPrefix(stored, argon2Prefix), "$")
	var salt, want []byte
	parsed := len(parts) == 2
	if parsed {
		s, errSalt := base64.RawStdEncoding.DecodeString(parts[0])
		w, errHash := base64.RawStdEncoding.DecodeString(parts[1])
		if errSalt == nil && errHash == nil && len(s) > 0 && len(w) > 0 {
			salt, want = s, w
		} else {
			parsed = false
		}
	}
	if !parsed {
		salt = make([]byte, argon2SaltLen)
		want = make([]byte, argon2KeyLen)
	}
	got := argon2.IDKey([]byte(presented), salt, argon2Time, argon2Memory, argon2Threads, uint32(len(want)))
	if !parsed {
		return false
	}
	return subtle.ConstantTimeCompare(got, want) == 1
}

// errSecretMismatch is returned when authentication fails; kept distinct from other
// internal errors so the handler can map it to AccessDenied without leaking details.
var errSecretMismatch = errors.New("invalid client secret")
