// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Caracal JWT claim shapes and verification configuration.

package identity

// DefaultMaxHopCount caps delegation chain depth when verifier callers leave
// Config.MaxHopCount unset. Matches the coordinator's MAX_DEPTH so a token that
// would have been blocked at spawn time cannot pass a permissive resource server.
const DefaultMaxHopCount = 10

const (
	MandateUseSession  = "session"
	MandateUseResource = "resource"
)

// Config configures JWT verification.
type Config struct {
	Issuer               string
	Audience             string
	ZoneID               string
	RequiredScopes       []string
	RequiredTargets      []string
	RequiredUse          string
	RequireAgent         bool
	RequireDelegation    bool
	RequireChainContains []string
	MaxHopCount          int
}

// ChainHop is one step in a delegation chain.
type ChainHop struct {
	ApplicationID    string
	AgentSessionID   string
	DelegationEdgeID string
}

// Claims is the validated subset of a Caracal JWT payload.
type Claims struct {
	Sub              string
	ZoneID           string
	ClientID         string
	Sid              string
	RootSid          string
	Use              string
	JTI              string
	IssuedAt         int64
	ExpiresAt        int64
	Scope            string
	TargetResources  []string
	AgentSessionID   string
	DelegationEdgeID string
	SourceSessionID  string
	TargetSessionID  string
	DelegationPath   []string
	DelegationChain  []ChainHop
	GraphEpoch       int64
	HopCount         int
}
