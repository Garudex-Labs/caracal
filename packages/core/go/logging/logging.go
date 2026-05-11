// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Zerolog-backed structured JSON logger for Caracal Go services.

package logging

import (
	"os"
	"strings"

	"github.com/rs/zerolog"
)

// New returns a zerolog.Logger scoped to the named service.
// Log level is read from the LOG_LEVEL environment variable (default: info).
func New(service string) zerolog.Logger {
	return zerolog.New(os.Stderr).Level(envLevel()).With().
		Timestamp().
		Str("service", service).
		Logger()
}

// SetGlobalLevel updates zerolog's process-wide log level. Call once during service init.
func SetGlobalLevel() {
	zerolog.SetGlobalLevel(envLevel())
}

func envLevel() zerolog.Level {
	switch strings.ToLower(os.Getenv("LOG_LEVEL")) {
	case "debug":
		return zerolog.DebugLevel
	case "warn":
		return zerolog.WarnLevel
	case "error":
		return zerolog.ErrorLevel
	}
	return zerolog.InfoLevel
}
