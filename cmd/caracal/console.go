// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"github.com/garudex-labs/caracal/internal/cli/clierr"
	"github.com/garudex-labs/caracal/internal/cli/ui"
)

// confirm asks one yes/no question in the shared prompt language,
// defaulting to no.
func confirm(prompt string) bool { return ui.Confirm(prompt) }

// confirmDanger asks the destructive-action form of confirm; deletes,
// removals, transfers, resets, and overwrites go through it.
func confirmDanger(prompt string) bool { return ui.ConfirmDestructive(prompt) }

// abortErr reports a declined confirmation and returns the stable abort
// error that the entry point converts to a silent exit status 1.
func abortErr(operation string) *clierr.Error {
	ui.Stderr().Failf("Aborted.")
	return &clierr.Error{Category: clierr.Unexpected, Message: "Aborted!", Operation: operation}
}
