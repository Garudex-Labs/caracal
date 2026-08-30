// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package clierr

import (
	"strings"
	"testing"
)

func TestErrorImplementsError(t *testing.T) {
	e := &Error{Category: NotFound, Message: "Agent not found."}
	if e.Error() != "Agent not found." {
		t.Errorf("Error() = %q", e.Error())
	}
	// The value satisfies the standard error interface.
	var err error = e
	if err.Error() != "Agent not found." {
		t.Errorf("error interface = %q", err.Error())
	}
}

func TestEmitHumanBlockRequestIDAndDebugDetail(t *testing.T) {
	e := &Error{
		Category: Unavailable, Message: "Server down.", Operation: "Fetch status",
		RequestID: "req-42", Detail: "dial tcp: refused",
	}
	out := captureStderr(t, func() { Emit(e, false, true) })
	if !strings.Contains(out, "Request ID: req-42\n") {
		t.Errorf("human block missing request id:\n%s", out)
	}
	if !strings.Contains(out, "Detail: dial tcp: refused\n") {
		t.Errorf("human block missing debug detail:\n%s", out)
	}
}

func TestEmitHumanBlockHidesDetailWithoutDebug(t *testing.T) {
	e := &Error{Category: Unavailable, Message: "m", Operation: "o", Detail: "secret-ish"}
	out := captureStderr(t, func() { Emit(e, false, false) })
	if strings.Contains(out, "secret-ish") {
		t.Errorf("detail leaked without debug:\n%s", out)
	}
}
