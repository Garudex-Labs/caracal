// Copyright (C) 2026 Garudex Labs. All Rights Reserved.
// Caracal, a product of Garudex Labs
package internal

import (
	"context"
	"os"
	"os/signal"
	"testing"
	"time"
)

// Subprocess entrypoint for the STS live integration suite. New validates the
// ordinary deployment configuration; only the listener port is changed to avoid
// disturbing a concurrently running development Gateway. No dependencies or
// authorization paths are mocked.
func TestGatewaySTSDeploymentProcess(t *testing.T) {
	if os.Getenv("CARACAL_GATEWAY_STS_TEST_PROCESS") != "1" {
		t.Skip("live STS harness subprocess only")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	ctx, stop := context.WithTimeout(ctx, 110*time.Second)
	defer stop()
	s, err := New(ctx)
	if err != nil {
		t.Fatal(err)
	}
	s.cfg.Port = os.Getenv("CARACAL_GATEWAY_TEST_PORT")
	if s.cfg.Port == "" {
		t.Fatal("test listener port missing")
	}
	if err := s.Run(ctx); err != nil {
		t.Fatal(err)
	}
}
