// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for upstream credential header trust-boundary validation.

package sts

import "testing"

func TestValidUpstreamCredentialHeader(t *testing.T) {
	allowed := []string{"Authorization", "X-Api-Key", "X-Vendor-Authorization"}
	for _, name := range allowed {
		if !ValidUpstreamCredentialHeader(name) {
			t.Errorf("expected %q to be allowed", name)
		}
	}

	reserved := []string{
		"",
		"Host",
		"Connection",
		"Content-Length",
		"Transfer-Encoding",
		"X-Caracal-Identity",
		"X-Forwarded-For",
		"Proxy-Authorization",
		"Traceparent",
		"Baggage",
		"X-Request-Id",
	}
	for _, name := range reserved {
		if ValidUpstreamCredentialHeader(name) {
			t.Errorf("expected %q to be rejected", name)
		}
	}
}
