// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Bounded in-memory token cache keyed by hashed subject and resource.

package oauth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sync"
	"time"
)

// cacheKeySecret is a per-process random key so cache keys cannot be
// recomputed from a known subject token by an observer.
var cacheKeySecret = mustRandomBytes(32)

func mustRandomBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}

// TokenCache stores token exchange responses by subject and resource identity.
type TokenCache interface {
	Get(subjectToken, resource string) (TokenExchangeResponse, bool)
	Set(subjectToken, resource string, token TokenExchangeResponse)
}

// InMemoryTokenCache is a bounded process-local cache.
type InMemoryTokenCache struct {
	mu         sync.Mutex
	entries    map[string]cacheEntry
	order      []string
	maxEntries int
}

type cacheEntry struct {
	token     TokenExchangeResponse
	expiresAt int64
}

// NewInMemoryTokenCache returns a bounded token cache.
func NewInMemoryTokenCache(maxEntries int) (*InMemoryTokenCache, error) {
	if maxEntries <= 0 {
		return nil, fmt.Errorf("InMemoryTokenCache.maxEntries must be a positive integer")
	}
	return &InMemoryTokenCache{entries: map[string]cacheEntry{}, maxEntries: maxEntries}, nil
}

// MustInMemoryTokenCache returns a cache or panics on invalid construction.
func MustInMemoryTokenCache(maxEntries int) *InMemoryTokenCache {
	cache, err := NewInMemoryTokenCache(maxEntries)
	if err != nil {
		panic(err)
	}
	return cache
}

func (c *InMemoryTokenCache) Get(subjectToken, resource string) (TokenExchangeResponse, bool) {
	key := cacheKey(subjectToken, resource)
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[key]
	if !ok {
		return TokenExchangeResponse{}, false
	}
	if time.Now().Unix() >= entry.expiresAt {
		delete(c.entries, key)
		c.removeOrder(key)
		return TokenExchangeResponse{}, false
	}
	c.touch(key)
	return entry.token, true
}

func (c *InMemoryTokenCache) Set(subjectToken, resource string, token TokenExchangeResponse) {
	key := cacheKey(subjectToken, resource)
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.entries[key]; ok {
		c.removeOrder(key)
	}
	c.entries[key] = cacheEntry{token: token, expiresAt: token.IssuedAt + int64(token.ExpiresIn)}
	c.order = append(c.order, key)
	for len(c.entries) > c.maxEntries {
		oldest := c.order[0]
		c.order = c.order[1:]
		delete(c.entries, oldest)
	}
}

func (c *InMemoryTokenCache) touch(key string) {
	c.removeOrder(key)
	c.order = append(c.order, key)
}

func (c *InMemoryTokenCache) removeOrder(key string) {
	for i, value := range c.order {
		if value == key {
			c.order = append(c.order[:i], c.order[i+1:]...)
			return
		}
	}
}

func cacheKey(subjectToken, resource string) string {
	mac := hmac.New(sha256.New, cacheKeySecret)
	mac.Write([]byte(subjectToken))
	mac.Write([]byte{0})
	mac.Write([]byte(resource))
	return hex.EncodeToString(mac.Sum(nil))
}
