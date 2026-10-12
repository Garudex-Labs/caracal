// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Regression tests for policy input and OPA capability trust boundaries.

package internal

import "testing"

func TestSafeCapabilitiesExcludeRuntimeEscapeBuiltins(t *testing.T) {
	forbidden := map[string]struct{}{
		"http.send":           {},
		"net.lookup_ip_addr":  {},
		"net.cidr_contains":   {},
		"net.cidr_intersects": {},
		"net.cidr_expand":     {},
		"net.cidr_merge":      {},
		"opa.runtime":         {},
		"rand.intn":           {},
		"time.now_ns":         {},
	}

	caps := safeCapabilities()
	if len(caps.AllowNet) != 0 {
		t.Fatalf("network access must remain disabled, got %v", caps.AllowNet)
	}
	for _, builtin := range caps.Builtins {
		if _, blocked := forbidden[builtin.Name]; blocked {
			t.Errorf("forbidden builtin %q is available to tenant policy", builtin.Name)
		}
	}
}

func TestGatewayActionInputOnlyCarriesTrustedOperation(t *testing.T) {
	for _, tc := range []struct {
		name         string
		gateway      bool
		wantMethod   string
		wantPath     string
		wantActionID string
	}{
		{name: "gateway exchange", gateway: true, wantMethod: "POST", wantPath: "/payments", wantActionID: "TokenExchange"},
		{name: "direct exchange", gateway: false, wantMethod: "", wantPath: "", wantActionID: "TokenExchange"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := gatewayActionInput(TokenExchangeRequest{
				GatewayAuthenticated: tc.gateway,
				RequestMethod:        " post ",
				RequestPath:          " /payments ",
			})
			if got.ID != tc.wantActionID || got.Method != tc.wantMethod || got.Path != tc.wantPath {
				t.Fatalf("gatewayActionInput = %+v, want id=%q method=%q path=%q", got, tc.wantActionID, tc.wantMethod, tc.wantPath)
			}
		})
	}
}
