// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

//go:build windows

package lockfile

import "os"

// Windows writes stay atomic through rename; advisory locking is skipped.
func flockExclusive(_ *os.File) error { return nil }

func flockRelease(_ *os.File) {}
