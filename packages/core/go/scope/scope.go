// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// OAuth 2.0 scope-string evaluation per RFC 6749 §3.3.

package scope

import "strings"

// Has reports whether scope grants target. Empty target never matches.
func Has(scope, target string) bool {
	if target == "" {
		return false
	}
	for _, s := range strings.Fields(scope) {
		if s == target {
			return true
		}
	}
	return false
}
