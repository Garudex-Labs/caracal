// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Audit service entry point.

package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/garudex-labs/caracal/audit/internal"
	"github.com/garudex-labs/caracal/core/config"
	"github.com/garudex-labs/caracal/core/logging"
)

func main() {
	config.AssertRuntimeSafe()
	log := logging.New("audit")
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	srv, err := internal.New(ctx)
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
