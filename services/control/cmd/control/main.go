// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Control service entry point: launches the external control HTTP surface only when CONTROL_MODE=on.

package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/garudex-labs/caracal/control/internal"
	"github.com/garudex-labs/caracal/core/config"
	"github.com/garudex-labs/caracal/core/logging"
)

func main() {
	config.AssertRuntimeSafe()
	log := logging.New("control")

	mode := os.Getenv("CONTROL_MODE")
	if mode != "on" {
		log.Info().Str("mode", mode).Msg("control surface disabled; exiting (set CONTROL_MODE=on to enable)")
		return
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	srv, err := internal.New(ctx, log)
	if err != nil {
		log.Fatal().Err(err).Msg("init failed")
	}
	if err := srv.Run(ctx); err != nil {
		log.Fatal().Err(err).Msg("run failed")
	}
}
