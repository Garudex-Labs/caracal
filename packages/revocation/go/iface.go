// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Revocation store contract for resource servers consulting caracal.sessions.revoke.

package revocation

import "time"

// Store reports whether an authority, Session, or Delegation anchor has been revoked.
type Store interface {
	IsRevoked(anchorID string) bool
	MarkRevoked(anchorID string, ttl time.Duration) error
}

// DelegationEpochStore is implemented by stores that track the delegation graph epoch per zone.
type DelegationEpochStore interface {
	CurrentDelegationEpoch(zoneID string) int64
	MarkDelegationEpoch(zoneID string, epoch int64, ttl time.Duration) error
}
