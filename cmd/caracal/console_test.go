// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"os"
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
	"github.com/garudex-labs/caracal/internal/cli/ui"
)

// captureStderrOutput runs fn while capturing process standard error.
func captureStderrOutput(t *testing.T, fn func()) string {
	t.Helper()
	old := os.Stderr
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stderr = w
	defer func() { os.Stderr = old }()
	fn()
	_ = w.Close()
	var out strings.Builder
	buf := make([]byte, 1<<16)
	for {
		n, readErr := r.Read(buf)
		out.Write(buf[:n])
		if readErr != nil {
			break
		}
	}
	_ = r.Close()
	return out.String()
}

func TestAbortErrKeepsSilentExitContract(t *testing.T) {
	var cerr *clierr.Error
	out := captureStderrOutput(t, func() { cerr = abortErr("Delete organization") })
	if cerr.Message != "Aborted!" {
		t.Errorf("abort message = %q; the entry point exits silently only on \"Aborted!\"", cerr.Message)
	}
	if cerr.Category != clierr.Unexpected || cerr.Operation != "Delete organization" {
		t.Errorf("abort error misclassified: %+v", cerr)
	}
	if !strings.Contains(out, "✗ Aborted.") {
		t.Errorf("declined confirmation not reported: %q", out)
	}
}

func TestConfirmReadsSharedInput(t *testing.T) {
	restore := ui.Input
	defer func() { ui.Input = restore }()

	ui.Input = strings.NewReader("y\n")
	got := ""
	_ = captureStderrOutput(t, func() {
		if !confirm("Proceed?") {
			got = "declined"
		}
	})
	if got == "declined" {
		t.Error("piped yes answer was not accepted")
	}

	ui.Input = strings.NewReader("")
	declined := false
	out := captureStderrOutput(t, func() { declined = !confirmDanger("Delete everything?") })
	if !declined {
		t.Error("closed input must decline the confirmation")
	}
	if !strings.Contains(out, "Delete everything? [y/N]") {
		t.Errorf("prompt missing normalized suffix: %q", out)
	}
}
