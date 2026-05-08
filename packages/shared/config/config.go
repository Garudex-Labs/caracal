// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared configuration loader for Caracal Go services.

package config

import (
	"os"
	"strings"
)

// Base holds env-driven configuration common to every Go service.
type Base struct {
	Port        string
	DatabaseURL string
	RedisURL    string
	LogLevel    string
	Env         string
}

// Load reads Base from environment variables, collecting all missing required values
// into a single error rather than panicking on the first miss.
func Load() Base {
	missing := MissingRequired("PORT", "DATABASE_URL", "REDIS_URL")
	if len(missing) > 0 {
		panic("required env vars missing: " + strings.Join(missing, ", "))
	}
	return Base{
		Port:        os.Getenv("PORT"),
		DatabaseURL: os.Getenv("DATABASE_URL"),
		RedisURL:    os.Getenv("REDIS_URL"),
		LogLevel:    Getenv("LOG_LEVEL", "info"),
		Env:         Getenv("CARACAL_ENV", "development"),
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

// IsProduction reports whether the service runs in a production-like environment.
func (b Base) IsProduction() bool {
	switch b.Env {
	case "production", "prod", "staging":
		return true
	}
	return false
}

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
