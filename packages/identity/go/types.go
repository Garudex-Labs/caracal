// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Caracal JWT claim shapes and verification configuration.

package identity

// Config configures JWT verification.
type Config struct {
	Issuer               string
	Audience             string
	ZoneID               string
	RequiredScopes       []string
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
	Scope            string
	AgentSessionID   string
	DelegationEdgeID string
	SourceSessionID  string
	TargetSessionID  string
	DelegationPath   []string
	DelegationChain  []ChainHop
	GraphEpoch       int64
	HopCount         int
}
