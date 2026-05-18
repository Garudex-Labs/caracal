// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Control service entry point: launches the external control HTTP surface only when CARACAL_CONTROL_ENABLED=true.

package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/garudex-labs/caracal/control/internal"
	"github.com/garudex-labs/caracal/packages/core/go/config"
	"github.com/garudex-labs/caracal/packages/core/go/logging"
)

func main() {
	config.AssertPublishedSafe()
	log := logging.New("control")

	enabled := os.Getenv("CARACAL_CONTROL_ENABLED")
	if enabled != "true" {
		log.Info().Str("enabled", enabled).Msg("control surface disabled; exiting (set CARACAL_CONTROL_ENABLED=true to enable)")
		return
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	srv, err := internal.New(ctx, log)
	if err != nil {
		log.Error().Err(err).Msg("init failed")
		cancel()
		os.Exit(1)
	}
	if err := srv.Run(ctx); err != nil {
		log.Error().Err(err).Msg("run failed")
		cancel()
		os.Exit(1)
	}
}
