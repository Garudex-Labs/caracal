// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared error unit tests for canonical Caracal error shape.

package errors

import "testing"

func TestNewCaracalError(t *testing.T) {
	err := New(AccessDenied, "denied")
	if err.Code != AccessDenied || err.Description != "denied" {
		t.Fatalf("unexpected error: %#v", err)
	}
	if err.Error() != "access_denied: denied" {
		t.Fatalf("unexpected error string: %s", err.Error())
	}
}

func TestSessionRequiredCode(t *testing.T) {
	if SessionRequired != "session_required" {
		t.Fatalf("unexpected session required code: %q", SessionRequired)
	}
}

func TestWithRequestIDMutatesError(t *testing.T) {
	err := New(InvalidToken, "bad token").WithRequestID("req-1")
	if err.RequestID != "req-1" {
		t.Fatalf("want request id req-1, got %q", err.RequestID)
	}
}
