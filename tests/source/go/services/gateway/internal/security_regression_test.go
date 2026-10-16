// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Regression tests for response redirect and credential-forwarding boundaries.

package internal

import (
	"net/http"
	"testing"
)

func TestSanitizeRedirectHeadersDropsUntrustedTargets(t *testing.T) {
	for _, tc := range []struct {
		name  string
		value string
		keep  bool
	}{
		{name: "relative location", value: "/next", keep: true},
		{name: "absolute location", value: "https://internal.example/next"},
		{name: "protocol relative location", value: "//internal.example/next"},
		{name: "malformed location", value: "https://["},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := make(http.Header)
			h.Set("Location", tc.value)
			h.Set("Content-Location", tc.value)
			h.Set("Refresh", "0; url="+tc.value)

			sanitizeRedirectHeaders(h)

			if tc.keep {
				if h.Get("Location") != tc.value || h.Get("Content-Location") != tc.value {
					t.Fatalf("relative redirect headers were dropped: %#v", h)
				}
			} else if h.Get("Location") != "" || h.Get("Content-Location") != "" {
				t.Fatalf("untrusted redirect target survived: %#v", h)
			}
			if h.Get("Refresh") != "" {
				t.Fatalf("Refresh header survived: %#v", h)
			}
		})
	}
}
