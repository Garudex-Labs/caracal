// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared configuration loader for Caracal Go services.

package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Base holds env-driven configuration common to every Go service.
type Base struct {
	Port        string
	DatabaseURL string
	RedisURL    string
	LogLevel    string
	Mode        string
}

// Load reads Base from environment variables, collecting all missing required values
// into a single error rather than panicking on the first miss.
func Load() Base {
	ResolveFileSecrets("DATABASE_URL", "REDIS_URL")
	missing := MissingRequired("PORT", "DATABASE_URL", "REDIS_URL")
	if len(missing) > 0 {
		panic("required env vars missing: " + strings.Join(missing, ", "))
	}
	return Base{
		Port:        os.Getenv("PORT"),
		DatabaseURL: os.Getenv("DATABASE_URL"),
		RedisURL:    os.Getenv("REDIS_URL"),
		LogLevel:    Getenv("LOG_LEVEL", "info"),
		Mode:        Mode(),
	}
}

// ResolveFileSecrets reads `${KEY}_FILE` for each key and, when set, loads the
// file contents into the env var KEY. The `_FILE` var is unset afterwards.
// Existing values for KEY are preserved.
func ResolveFileSecrets(keys ...string) {
	for _, key := range keys {
		if os.Getenv(key) != "" {
			continue
		}
		fileVar := key + "_FILE"
		path := os.Getenv(fileVar)
		if path == "" {
			continue
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			panic(fmt.Sprintf("read secret file %s=%s: %v", fileVar, path, err))
		}
		v := strings.TrimRight(string(raw), " \t\r\n")
		if v == "" {
			panic(fmt.Sprintf("secret file empty: %s=%s", fileVar, path))
		}
		_ = os.Setenv(key, v)
		_ = os.Unsetenv(fileVar)
	}
}

// Mode returns the explicit Caracal deployment mode (dev, rc, or stable). Defaults to
// stable when unset so safety wins on misconfiguration.
func Mode() string {
	m := strings.ToLower(strings.TrimSpace(os.Getenv("CARACAL_MODE")))
	switch m {
	case "dev", "rc", "stable":
		return m
	case "":
		return "stable"
	default:
		panic("CARACAL_MODE must be 'dev', 'rc', or 'stable' (got '" + m + "')")
	}
}

// AssertPublishedSafe panics if any developer-only escape hatch is set outside dev.
// Call early in service startup; cheap and idempotent.
func AssertPublishedSafe() {
	if Mode() == "dev" {
		return
	}
	forbidden := []string{"INSECURE_STS", "INSECURE_HTTP"}
	var set []string
	for _, k := range forbidden {
		if v := strings.ToLower(os.Getenv(k)); v == "true" || v == "1" || v == "yes" {
			set = append(set, k)
		}
	}
	if len(set) > 0 {
		panic("CARACAL_MODE=rc or CARACAL_MODE=stable forbids: " + strings.Join(set, ", "))
	}
}

// MissingRequired returns the names of any required env vars that are unset or empty.
// Use this at startup to surface every missing var in one structured error.
func MissingRequired(keys ...string) []string {
	var missing []string
	for _, k := range keys {
		if os.Getenv(k) == "" {
			missing = append(missing, k)
		}
	}
	return missing
}

// IsPublished reports whether the service runs outside dev.
func (b Base) IsPublished() bool { return b.Mode != "dev" }

// MustGetenv returns the value of key or panics if it is unset or empty.
func MustGetenv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		panic("required env var missing: " + key)
	}
	return v
}

// Getenv returns the value of key or fallback when unset or empty.
func Getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// IntEnv returns a positive integer env var or fallback when unset. Panics on invalid input.
func IntEnv(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		panic(fmt.Sprintf("invalid integer for %s: %q", key, v))
	}
	return n
}

// DurationEnv returns a positive duration env var or fallback when unset. Panics on invalid input
// so misconfiguration is caught at startup rather than silently downgrading to the default.
func DurationEnv(key string, fallback time.Duration) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		panic(fmt.Sprintf("invalid duration for %s: %q", key, v))
	}
	return d
}

// Int64Env returns a positive int64 env var or fallback when unset. Panics on invalid input.
func Int64Env(key string, fallback int64) int64 {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n <= 0 {
		panic(fmt.Sprintf("invalid integer for %s: %q", key, v))
	}
	return n
}

// BoolEnv returns the boolean value of key or fallback when unset. Panics on invalid input.
func BoolEnv(key string, fallback bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		panic(fmt.Sprintf("invalid boolean for %s: %q", key, v))
	}
	return b
}

// SplitCSV trims, lowercases, and drops empty entries from a comma-separated list.
// Empty input returns nil.
func SplitCSV(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if v := strings.TrimSpace(p); v != "" {
			out = append(out, strings.ToLower(v))
		}
	}
	return out
}

// CSVEnv reads key as a comma-separated list, normalized via SplitCSV.
func CSVEnv(key string) []string {
	return SplitCSV(os.Getenv(key))
}
