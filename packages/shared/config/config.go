// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared configuration loader for Caracal Go services.

package config

import "os"

// Base holds env-driven configuration common to every Go service.
type Base struct {
	Port        string
	DatabaseURL string
	RedisURL    string
	LogLevel    string
	Env         string
}

// Load reads Base from environment variables, panicking on missing required values.
func Load() Base {
	return Base{
		Port:        MustGetenv("PORT"),
		DatabaseURL: MustGetenv("DATABASE_URL"),
		RedisURL:    MustGetenv("REDIS_URL"),
		LogLevel:    Getenv("LOG_LEVEL", "info"),
		Env:         Getenv("CARACAL_ENV", "development"),
	}
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
