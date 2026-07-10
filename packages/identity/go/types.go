// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Caracal JWT claim shapes and verification configuration.

package identity

// DefaultMaxHopCount caps delegation chain depth when verifier callers leave
// Config.MaxHopCount unset. Matches the coordinator's MAX_DEPTH so a token that
// would have been blocked when a Session starts cannot pass a permissive resource server.
const DefaultMaxHopCount = 10

const (
	MandateUseSession  = "session"
	MandateUseResource = "resource"
)

const (
	SubjectTypeUser        = "user"
	SubjectTypeApplication = "application"
)

// Config configures JWT verification.
type Config struct {
	Issuer   string
	Audience string
	// ZoneID is a mandatory trust anchor. It fixes which zone's signing keyset
	// verifies the token, so key selection can never be steered by the
	// unverified zone_id claim. Verification fails closed when it is empty.
	ZoneID               string
	RequiredScopes       []string
	RequiredTargets      []string
	RequiredUse          string
	RequireSession       bool
	RequireDelegation    bool
	RequireChainContains []string
	MaxHopCount          int
	JWKSCache            *JWKSCache
}

// ChainHop is one step in a delegation chain.
type ChainHop struct {
	ApplicationID string
	SessionID     string
	DelegationID  string
}

// Claims is the validated subset of a Caracal JWT payload.
type Claims struct {
	Sub                   string
	ZoneID                string
	ClientID              string
	AuthorityRecordID     string
	RootAuthorityRecordID string
	Use                   string
	SubType               string
	JTI                   string
	IssuedAt              int64
	ExpiresAt             int64
	Scope                 string
	TargetResources       []string
	SessionID             string
	DelegationID          string
	SourceSessionID       string
	TargetSessionID       string
	DelegationPath        []string
	DelegationChain       []ChainHop
	GraphEpoch            int64
	HopCount              int
}
