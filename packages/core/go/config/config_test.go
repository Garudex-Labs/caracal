// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared config unit tests for environment-driven defaults and required values.

package config_test

import (
	"os"
	"reflect"
	"testing"
	"time"

	. "github.com/garudex-labs/caracal/packages/core/go/config"
)

func TestGetenvUsesFallbackForMissingOrEmptyValue(t *testing.T) {
	t.Setenv("CARACAL_TEST_EMPTY", "")
	if got := Getenv("CARACAL_TEST_MISSING", "fallback"); got != "fallback" {
		t.Fatalf("want fallback for missing env, got %q", got)
	}
	if got := Getenv("CARACAL_TEST_EMPTY", "fallback"); got != "fallback" {
		t.Fatalf("want fallback for empty env, got %q", got)
	}
}

func TestMustGetenvPanicsWhenMissing(t *testing.T) {
	defer func() {
		if recovered := recover(); recovered == nil {
			t.Fatal("expected panic for missing env var")
		}
	}()
	MustGetenv("CARACAL_TEST_REQUIRED")
}

func TestIntEnvUsesFallbackForMissingAndPanicsForInvalidValues(t *testing.T) {
	t.Setenv("CARACAL_TEST_ZERO", "0")
	t.Setenv("CARACAL_TEST_INVALID", "abc")
	t.Setenv("CARACAL_TEST_VALUE", "12")

	if got := IntEnv("CARACAL_TEST_MISSING", 7); got != 7 {
		t.Fatalf("want fallback for missing env, got %d", got)
	}
	assertPanics(t, func() { IntEnv("CARACAL_TEST_ZERO", 7) })
	assertPanics(t, func() { IntEnv("CARACAL_TEST_INVALID", 7) })
	if got := IntEnv("CARACAL_TEST_VALUE", 7); got != 12 {
		t.Fatalf("want parsed env, got %d", got)
	}
}

func TestInt32EnvUsesFallbackAndRejectsOutOfRangeValues(t *testing.T) {
	t.Setenv("CARACAL_TEST_INT32_VALUE", "12")
	t.Setenv("CARACAL_TEST_INT32_OVERFLOW", "2147483648")

	if got := Int32Env("CARACAL_TEST_INT32_MISSING", 7); got != 7 {
		t.Fatalf("want fallback for missing env, got %d", got)
	}
	if got := Int32Env("CARACAL_TEST_INT32_VALUE", 7); got != 12 {
		t.Fatalf("want parsed env, got %d", got)
	}
	assertPanics(t, func() { Int32Env("CARACAL_TEST_INT32_OVERFLOW", 7) })
}

func assertPanics(t *testing.T, f func()) {
	t.Helper()
	defer func() {
		if recovered := recover(); recovered == nil {
			t.Fatal("expected panic")
		}
	}()
	f()
}

func TestStrictEnvParsers(t *testing.T) {
	t.Setenv("CARACAL_TEST_DURATION", "3s")
	t.Setenv("CARACAL_TEST_INT64", "42")
	t.Setenv("CARACAL_TEST_BOOL", "true")
	t.Setenv("CARACAL_TEST_CSV", "a, B ,c,, d ")

	if got := DurationEnv("CARACAL_TEST_DURATION", time.Second); got != 3*time.Second {
		t.Fatalf("want parsed duration, got %s", got)
	}
	if got := Int64Env("CARACAL_TEST_INT64", 7); got != 42 {
		t.Fatalf("want parsed int64, got %d", got)
	}
	if got := BoolEnv("CARACAL_TEST_BOOL", false); !got {
		t.Fatalf("want parsed bool")
	}
	if got := CSVEnv("CARACAL_TEST_CSV"); !reflect.DeepEqual(got, []string{"a", "b", "c", "d"}) {
		t.Fatalf("want normalized csv values, got %v", got)
	}
}

func TestLoadReadsBaseConfig(t *testing.T) {
	t.Setenv("PORT", "8080")
	t.Setenv("DATABASE_URL", "postgres://example")
	t.Setenv("REDIS_URL", "redis://example")
	t.Setenv("LOG_LEVEL", "debug")

	cfg := Load()
	if cfg.Port != "8080" || cfg.DatabaseURL != "postgres://example" || cfg.RedisURL != "redis://example" || cfg.LogLevel != "debug" {
		t.Fatalf("unexpected config: %#v", cfg)
	}
}

func TestModeDefaultsToStableAndNormalizesExplicitModes(t *testing.T) {
	t.Setenv("CARACAL_MODE", "")
	if got := Mode(); got != "stable" {
		t.Fatalf("unset mode should default to stable, got %q", got)
	}
	for _, tc := range []struct {
		raw  string
		want string
	}{
		{raw: " DEV ", want: "dev"},
		{raw: "rc", want: "rc"},
		{raw: "stable", want: "stable"},
	} {
		t.Setenv("CARACAL_MODE", tc.raw)
		if got := Mode(); got != tc.want {
			t.Fatalf("Mode(%q) = %q, want %q", tc.raw, got, tc.want)
		}
	}
}

func TestModeRejectsInvalidValues(t *testing.T) {
	t.Setenv("CARACAL_MODE", "prod")
	assertPanics(t, func() { Mode() })
}

func TestAssertPublishedSafeBlocksInsecureTogglesOutsideDev(t *testing.T) {
	for _, mode := range []string{"rc", "stable"} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("CARACAL_MODE", mode)
			t.Setenv("INSECURE_STS", "true")
			t.Setenv("INSECURE_HTTP", "1")
			assertPanics(t, func() { AssertPublishedSafe() })
		})
	}
}

func TestAssertPublishedSafeAllowsDevAndFalseValues(t *testing.T) {
	t.Setenv("CARACAL_MODE", "dev")
	t.Setenv("INSECURE_STS", "true")
	t.Setenv("INSECURE_HTTP", "yes")
	AssertPublishedSafe()

	t.Setenv("CARACAL_MODE", "stable")
	t.Setenv("INSECURE_STS", "false")
	t.Setenv("INSECURE_HTTP", "0")
	AssertPublishedSafe()
}

func TestResolveFileSecretsReadsTrimsAndClearsFileVars(t *testing.T) {
	path := t.TempDir() + "/secret"
	if err := os.WriteFile(path, []byte("secret-value\n\n"), 0o600); err != nil {
		t.Fatalf("write secret: %v", err)
	}
	t.Setenv("CARACAL_TEST_VALUE_FILE", path)

	ResolveFileSecrets("CARACAL_TEST_VALUE")

	if got := os.Getenv("CARACAL_TEST_VALUE"); got != "secret-value" {
		t.Fatalf("secret value = %q", got)
	}
	if got := os.Getenv("CARACAL_TEST_VALUE_FILE"); got != "" {
		t.Fatalf("file env var should be cleared, got %q", got)
	}
}

func TestResolveFileSecretsPreservesDirectValue(t *testing.T) {
	path := t.TempDir() + "/secret"
	if err := os.WriteFile(path, []byte("from-file\n"), 0o600); err != nil {
		t.Fatalf("write secret: %v", err)
	}
	t.Setenv("CARACAL_TEST_VALUE", "from-env")
	t.Setenv("CARACAL_TEST_VALUE_FILE", path)

	ResolveFileSecrets("CARACAL_TEST_VALUE")

	if got := os.Getenv("CARACAL_TEST_VALUE"); got != "from-env" {
		t.Fatalf("direct env value should win, got %q", got)
	}
	if got := os.Getenv("CARACAL_TEST_VALUE_FILE"); got != path {
		t.Fatalf("file env var should remain untouched, got %q", got)
	}
}

func TestResolveFileSecretsPanicsForEmptyOrMissingFiles(t *testing.T) {
	t.Setenv("CARACAL_TEST_VALUE", "")
	empty := t.TempDir() + "/empty"
	if err := os.WriteFile(empty, []byte(" \n"), 0o600); err != nil {
		t.Fatalf("write secret: %v", err)
	}
	t.Setenv("CARACAL_TEST_VALUE_FILE", empty)
	assertPanics(t, func() { ResolveFileSecrets("CARACAL_TEST_VALUE") })

	t.Setenv("CARACAL_TEST_VALUE_FILE", t.TempDir()+"/missing")
	assertPanics(t, func() { ResolveFileSecrets("CARACAL_TEST_VALUE") })
}

func TestIsPublished(t *testing.T) {
	if (Base{Mode: "dev"}).IsPublished() {
		t.Fatal("dev mode must not be published")
	}
	for _, mode := range []string{"rc", "stable"} {
		if !(Base{Mode: mode}).IsPublished() {
			t.Fatalf("mode %q must be published", mode)
		}
	}
}

func TestMustGetenvReturnsValue(t *testing.T) {
	t.Setenv("CARACAL_TEST_PRESENT", "value")
	if got := MustGetenv("CARACAL_TEST_PRESENT"); got != "value" {
		t.Fatalf("want present value, got %q", got)
	}
}

func TestMissingRequiredReportsUnsetKeys(t *testing.T) {
	t.Setenv("CARACAL_TEST_SET", "v")
	t.Setenv("CARACAL_TEST_UNSET", "")
	missing := MissingRequired("CARACAL_TEST_SET", "CARACAL_TEST_UNSET")
	if len(missing) != 1 || missing[0] != "CARACAL_TEST_UNSET" {
		t.Fatalf("want only the unset key reported, got %v", missing)
	}
	if got := MissingRequired("CARACAL_TEST_SET"); got != nil {
		t.Fatalf("want nil when all present, got %v", got)
	}
}

func TestLoadPanicsWhenRequiredMissing(t *testing.T) {
	t.Setenv("PORT", "")
	t.Setenv("DATABASE_URL", "")
	t.Setenv("REDIS_URL", "")
	t.Setenv("DATABASE_URL_FILE", "")
	t.Setenv("REDIS_URL_FILE", "")
	assertPanics(t, func() { Load() })
}

func TestStrictEnvParsersPanicOnInvalidInput(t *testing.T) {
	t.Setenv("CARACAL_TEST_BAD_DURATION", "nope")
	assertPanics(t, func() { DurationEnv("CARACAL_TEST_BAD_DURATION", time.Second) })
	t.Setenv("CARACAL_TEST_NONPOS_DURATION", "0s")
	assertPanics(t, func() { DurationEnv("CARACAL_TEST_NONPOS_DURATION", time.Second) })

	t.Setenv("CARACAL_TEST_BAD_INT64", "x")
	assertPanics(t, func() { Int64Env("CARACAL_TEST_BAD_INT64", 1) })
	t.Setenv("CARACAL_TEST_NONPOS_INT64", "-1")
	assertPanics(t, func() { Int64Env("CARACAL_TEST_NONPOS_INT64", 1) })

	t.Setenv("CARACAL_TEST_BAD_BOOL", "maybe")
	assertPanics(t, func() { BoolEnv("CARACAL_TEST_BAD_BOOL", false) })
}

func TestStrictEnvParsersUseFallbackWhenUnset(t *testing.T) {
	t.Setenv("CARACAL_TEST_DUR_MISSING", "")
	if got := DurationEnv("CARACAL_TEST_DUR_MISSING", 5*time.Second); got != 5*time.Second {
		t.Fatalf("want duration fallback, got %s", got)
	}
	t.Setenv("CARACAL_TEST_I64_MISSING", "")
	if got := Int64Env("CARACAL_TEST_I64_MISSING", 9); got != 9 {
		t.Fatalf("want int64 fallback, got %d", got)
	}
	t.Setenv("CARACAL_TEST_BOOL_MISSING", "")
	if got := BoolEnv("CARACAL_TEST_BOOL_MISSING", true); !got {
		t.Fatalf("want bool fallback true")
	}
}

func TestSplitCSVEmptyReturnsNil(t *testing.T) {
	if got := SplitCSV(""); got != nil {
		t.Fatalf("empty input must return nil, got %v", got)
	}
	if got := SplitCSV("  , ,  "); len(got) != 0 {
		t.Fatalf("whitespace-only entries must produce no values, got %v", got)
	}
}
