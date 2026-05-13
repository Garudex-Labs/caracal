// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Revocation store contract for resource servers consulting caracal.sessions.revoke.

package revocation

import "time"

// Store reports whether a session id has been revoked and accepts new revocations.
type Store interface {
	IsRevoked(sid string) bool
	MarkRevoked(sid string, ttl time.Duration)
}
