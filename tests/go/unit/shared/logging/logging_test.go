// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared logging unit tests for service-scoped logger configuration.

package logging

import (
	"testing"

	"github.com/rs/zerolog"
)

func TestNewAttachesServiceFieldAndPerLoggerLevel(t *testing.T) {
	t.Setenv("LOG_LEVEL", "debug")
	logger := New("gateway")

	if logger.GetLevel() != zerolog.DebugLevel {
		t.Fatalf("want debug logger level, got %s", logger.GetLevel())
	}
}

func TestNewDefaultsUnknownLevelToInfo(t *testing.T) {
	t.Setenv("LOG_LEVEL", "verbose")
	logger := New("sts")

	if logger.GetLevel() != zerolog.InfoLevel {
		t.Fatalf("want info logger level, got %s", logger.GetLevel())
	}
}

func TestSetGlobalLevelHonoursEnv(t *testing.T) {
	t.Setenv("LOG_LEVEL", "warn")
	prev := zerolog.GlobalLevel()
	defer zerolog.SetGlobalLevel(prev)

	SetGlobalLevel()
	if zerolog.GlobalLevel() != zerolog.WarnLevel {
		t.Fatalf("want warn global level, got %s", zerolog.GlobalLevel())
	}
}
