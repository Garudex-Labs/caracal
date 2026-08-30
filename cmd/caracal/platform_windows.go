// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

//go:build windows

package main

import "os"

func fileWritable(path string) bool {
	file, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		return false
	}
	file.Close()
	return true
}

func processAlive(pid int) bool {
	_, err := os.FindProcess(pid)
	return err == nil
}
