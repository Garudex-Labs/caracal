// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Verifies a Caracal JWT against an issuer JWKS and enforces zone and scope claims.

package identity

import (
	"errors"
	"fmt"

	"github.com/golang-jwt/jwt/v5"
)

// ErrTokenInvalid signals the token failed JWKS-backed signature or claim validation.
var ErrTokenInvalid = errors.New("token validation failed")

// ErrZoneInvalid signals the zone_id claim is missing or did not match Config.ZoneID.
var ErrZoneInvalid = errors.New("token zone validation failed")

// ErrAgentIdentityRequired signals the token has no agent_session_id.
var ErrAgentIdentityRequired = errors.New("agent identity required")

// ErrDelegationRequired signals the token has no delegation_edge_id.
var ErrDelegationRequired = errors.New("delegation required")

// ErrHopCountExceeded signals the token's hop_count exceeds Config.MaxHopCount.
var ErrHopCountExceeded = errors.New("hop count exceeded")

// ScopeMissingError signals a required scope is absent from the token.
type ScopeMissingError struct {
	Scope string
}

func (e *ScopeMissingError) Error() string {
	return fmt.Sprintf("missing scope: %s", e.Scope)
}

// ChainMismatchError signals a required delegation chain application is absent.
type ChainMismatchError struct {
	ApplicationID string
}

func (e *ChainMismatchError) Error() string {
	return fmt.Sprintf("delegation chain missing application: %s", e.ApplicationID)
}

func readChain(raw any) []ChainHop {
	list, ok := raw.([]any)
	if !ok {
		return nil
	}
	out := make([]ChainHop, 0, len(list))
	for _, item := range list {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		appID, _ := m["app"].(string)
		if appID == "" {
			appID, _ = m["application_id"].(string)
		}
		if appID == "" {
			continue
		}
		session, _ := m["session"].(string)
		if session == "" {
			session, _ = m["agent_session_id"].(string)
		}
		edge, _ := m["edge"].(string)
		if edge == "" {
			edge, _ = m["delegation_edge_id"].(string)
		}
		out = append(out, ChainHop{ApplicationID: appID, AgentSessionID: session, DelegationEdgeID: edge})
	}
	return out
}

func readStringSlice(raw any) []string {
	list, ok := raw.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(list))
	for _, v := range list {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// Verify parses and validates a JWT, returning typed Claims on success.
func Verify(tokenStr string, cfg Config) (Claims, error) {
	mapClaims := jwt.MapClaims{}
	_, err := jwt.ParseWithClaims(tokenStr, mapClaims, func(t *jwt.Token) (any, error) {
		kid, _ := t.Header["kid"].(string)
		keys, err := GetJWKS(cfg.Issuer)
		if err != nil {
			return nil, err
		}
		if k, ok := keys[kid]; ok {
			return k, nil
		}
		return nil, jwt.ErrTokenSignatureInvalid
	}, jwt.WithIssuer(cfg.Issuer), jwt.WithAudience(cfg.Audience), jwt.WithValidMethods([]string{jwt.SigningMethodES256.Alg()}))
	if err != nil {
		return Claims{}, ErrTokenInvalid
	}

	scope, _ := mapClaims["scope"].(string)
	zoneID, _ := mapClaims["zone_id"].(string)
	if zoneID == "" || (cfg.ZoneID != "" && zoneID != cfg.ZoneID) {
		return Claims{}, ErrZoneInvalid
	}
	for _, required := range cfg.RequiredScopes {
		if !HasScope(scope, required) {
			return Claims{}, &ScopeMissingError{Scope: required}
		}
	}

	sub, _ := mapClaims["sub"].(string)
	sid, _ := mapClaims["sid"].(string)
	clientID, _ := mapClaims["client_id"].(string)
	agentSessionID, _ := mapClaims["agent_session_id"].(string)
	delegationEdgeID, _ := mapClaims["delegation_edge_id"].(string)
	sourceSessionID, _ := mapClaims["source_session_id"].(string)
	targetSessionID, _ := mapClaims["target_session_id"].(string)
	chain := readChain(mapClaims["delegation_chain"])
	path := readStringSlice(mapClaims["delegation_path"])

	var graphEpoch int64
	switch v := mapClaims["delegation_graph_epoch"].(type) {
	case float64:
		graphEpoch = int64(v)
	case int64:
		graphEpoch = v
	}
	if graphEpoch == 0 {
		switch v := mapClaims["graph_epoch"].(type) {
		case float64:
			graphEpoch = int64(v)
		case int64:
			graphEpoch = v
		}
	}
	var hopCount int
	switch v := mapClaims["hop_count"].(type) {
	case float64:
		hopCount = int(v)
	case int64:
		hopCount = int(v)
	}

	if cfg.RequireAgent && agentSessionID == "" {
		return Claims{}, ErrAgentIdentityRequired
	}
	if cfg.RequireDelegation && delegationEdgeID == "" {
		return Claims{}, ErrDelegationRequired
	}
	if cfg.MaxHopCount > 0 && hopCount > cfg.MaxHopCount {
		return Claims{}, ErrHopCountExceeded
	}
	for _, expected := range cfg.RequireChainContains {
		present := false
		for _, hop := range chain {
			if hop.ApplicationID == expected {
				present = true
				break
			}
		}
		if !present {
			return Claims{}, &ChainMismatchError{ApplicationID: expected}
		}
	}

	return Claims{
		Sub:              sub,
		ZoneID:           zoneID,
		ClientID:         clientID,
		Sid:              sid,
		Scope:            scope,
		AgentSessionID:   agentSessionID,
		DelegationEdgeID: delegationEdgeID,
		SourceSessionID:  sourceSessionID,
		TargetSessionID:  targetSessionID,
		DelegationPath:   path,
		DelegationChain:  chain,
		GraphEpoch:       graphEpoch,
		HopCount:         hopCount,
	}, nil
}

// VerifyChainContains reports whether the claims include the given application
// either as an issuing party or in the delegation chain.
func VerifyChainContains(claims Claims, applicationID string) bool {
	if claims.ClientID == applicationID {
		return true
	}
	for _, hop := range claims.DelegationChain {
		if hop.ApplicationID == applicationID {
			return true
		}
	}
	return false
}
