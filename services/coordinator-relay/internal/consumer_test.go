// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Coordinator relay configuration tests.

package internal

import (
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLoadConfigDoesNotRequirePortOrDatabase(t *testing.T) {
	t.Setenv("CARACAL_MODE", "dev")
	t.Setenv("REDIS_URL", "redis://localhost:6379/0")
	t.Setenv("PORT", "")
	t.Setenv("DATABASE_URL", "")
	t.Setenv("STREAMS_HMAC_KEY", "")
	t.Setenv("STREAMS_HMAC_KEY_FILE", "")

	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig should not require unrelated service env vars: %v", err)
	}
	if cfg.RedisURL == "" {
		t.Fatal("Redis URL must be loaded")
	}
}

func TestLoadConfigResolvesStreamHMACKeyFile(t *testing.T) {
	key := make([]byte, 32)
	encoded := hex.EncodeToString(key)
	path := filepath.Join(t.TempDir(), "stream-key")
	if err := os.WriteFile(path, []byte(encoded+"\n"), 0o600); err != nil {
		t.Fatalf("write key file: %v", err)
	}

	t.Setenv("CARACAL_MODE", "stable")
	t.Setenv("REDIS_URL", "redis://localhost:6379/0")
	t.Setenv("STREAMS_HMAC_KEY", "")
	t.Setenv("STREAMS_HMAC_KEY_FILE", path)

	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig should resolve STREAMS_HMAC_KEY_FILE: %v", err)
	}
	if !cfg.RequireSig || len(cfg.StreamHMACKey) != 32 {
		t.Fatalf("stable relay must require and load a 32-byte stream key, got require=%v len=%d", cfg.RequireSig, len(cfg.StreamHMACKey))
	}
}

func TestPositiveSecondsRejectsInvalidValues(t *testing.T) {
	t.Setenv("RELAY_CLAIM_IDLE_SEC", "0")
	if _, err := positiveSeconds("RELAY_CLAIM_IDLE_SEC", int(time.Minute/time.Second)); err == nil {
		t.Fatal("zero seconds must fail")
	}
}
