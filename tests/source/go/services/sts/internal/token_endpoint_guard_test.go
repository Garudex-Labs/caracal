// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs

package internal

import (
	"strings"
	"testing"
)

func TestProviderTokenEndpointRejectsMalformedAndLoopbackHosts(t *testing.T) {
	for _, tc := range []struct{ url, want string }{
		{"https://[", ""},
		{"https://127.0.0.1/token", "non-routable"},
		{"https://[::1]/token", "non-routable"},
	} {
		// Explicitly allowlisting a hostname, even as a private egress host,
		// must never turn a loopback OAuth token endpoint into an SSRF escape.
		_, err := validateTokenEndpoint(tc.url, []string{"127.0.0.1", "::1"}, []string{"127.0.0.1", "::1"})
		if err == nil || (tc.want != "" && !strings.Contains(err.Error(), tc.want)) {
			t.Errorf("endpoint %q must be rejected (%s): %v", tc.url, tc.want, err)
		}
	}
}
