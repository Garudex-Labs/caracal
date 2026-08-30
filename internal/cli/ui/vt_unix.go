// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package ui

import "os"

// enableVirtualTerminal reports escape-sequence support; every non-Windows
// terminal that passes the TTY check accepts SGR sequences.
func enableVirtualTerminal(*os.File) bool { return true }
