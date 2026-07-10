// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the STS service entry point.

package main

import (
	"context"
	"errors"
	"os"
	"testing"
)

type fakeRunner struct {
	err error
}

func (f fakeRunner) Run(context.Context) error {
	return f.err
}

func TestDefaultNewRunnerReportsMissingConfiguration(t *testing.T) {
	t.Setenv("PORT", "")
	t.Setenv("DATABASE_URL", "")
	t.Setenv("DATABASE_URL_FILE", "")
	t.Setenv("REDIS_URL", "")
	t.Setenv("REDIS_URL_FILE", "")
	t.Setenv("ISSUER_URL", "")

	if _, err := newRunner(context.Background()); err == nil {
		t.Fatal("expected missing configuration error")
	}
}

func resetHooks(t *testing.T) {
	t.Helper()
	oldAssertSafe := assertSafe
	oldNotifyContext := notifyContext
	oldSetupTelemetry := setupTelemetry
	oldNewRunner := newRunner
	oldExitProcess := exitProcess
	assertSafe = func() {}
	notifyContext = func(parent context.Context, _ ...os.Signal) (context.Context, context.CancelFunc) {
		return context.WithCancel(parent)
	}
	setupTelemetry = func(context.Context, string) (func(context.Context) error, error) {
		return func(context.Context) error { return nil }, nil
	}
	newRunner = func(context.Context) (runner, error) { return fakeRunner{}, nil }
	exitProcess = func(int) { t.Fatal("unexpected process exit") }
	t.Cleanup(func() {
		assertSafe = oldAssertSafe
		notifyContext = oldNotifyContext
		setupTelemetry = oldSetupTelemetry
		newRunner = oldNewRunner
		exitProcess = oldExitProcess
	})
}

func TestRunReturnsZeroAndShutsDownTelemetry(t *testing.T) {
	resetHooks(t)
	shutdownCalled := false
	setupTelemetry = func(_ context.Context, service string) (func(context.Context) error, error) {
		if service != "caracal-sts" {
			t.Fatalf("service name = %q", service)
		}
		return func(context.Context) error {
			shutdownCalled = true
			return nil
		}, nil
	}

	if got := run(context.Background()); got != 0 {
		t.Fatalf("run status = %d, want 0", got)
	}
	if !shutdownCalled {
		t.Fatal("expected telemetry shutdown")
	}
}

func TestRunReturnsOneWhenTelemetrySetupFails(t *testing.T) {
	resetHooks(t)
	setupTelemetry = func(context.Context, string) (func(context.Context) error, error) {
		return nil, errors.New("otel unavailable")
	}

	if got := run(context.Background()); got != 1 {
		t.Fatalf("run status = %d, want 1", got)
	}
}

func TestRunReturnsOneWhenNewRunnerFails(t *testing.T) {
	resetHooks(t)
	newRunner = func(context.Context) (runner, error) {
		return nil, errors.New("database unavailable")
	}

	if got := run(context.Background()); got != 1 {
		t.Fatalf("run status = %d, want 1", got)
	}
}

func TestRunReturnsOneWhenRunnerFails(t *testing.T) {
	resetHooks(t)
	newRunner = func(context.Context) (runner, error) {
		return fakeRunner{err: errors.New("listener failed")}, nil
	}

	if got := run(context.Background()); got != 1 {
		t.Fatalf("run status = %d, want 1", got)
	}
}

func TestMainDoesNotExitOnSuccess(t *testing.T) {
	resetHooks(t)

	main()
}

func TestMainExitsWithFailureStatus(t *testing.T) {
	resetHooks(t)
	setupTelemetry = func(context.Context, string) (func(context.Context) error, error) {
		return nil, errors.New("otel unavailable")
	}
	var code int
	exitProcess = func(got int) { code = got }

	main()

	if code != 1 {
		t.Fatalf("exit code = %d, want 1", code)
	}
}
