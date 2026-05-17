// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// OAuth 2.0 scope-string evaluation, delegated to core/scope.

package identity

import "github.com/garudex-labs/caracal/packages/core/go/scope"

// HasScope reports whether scope grants target. Empty target never matches.
func HasScope(scopeStr, target string) bool {
	return scope.Has(scopeStr, target)
}
