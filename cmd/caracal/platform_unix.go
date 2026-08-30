// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package main

import (
	"syscall"
)

func fileWritable(path string) bool { return syscall.Access(path, 2) == nil }

func processAlive(pid int) bool { return syscall.Kill(pid, 0) == nil }
