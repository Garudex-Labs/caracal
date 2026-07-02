// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Verifies a Caracal JWT against an issuer JWKS and enforces zone and scope claims.

package identity

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

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
	if raw == nil {
		return nil
	}
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
		appID, _ := m["application_id"].(string)
		if appID == "" {
			continue
		}
		session, _ := m["agent_session_id"].(string)
		edge, _ := m["delegation_edge_id"].(string)
		out = append(out, ChainHop{ApplicationID: appID, AgentSessionID: session, DelegationEdgeID: edge})
	}
	return out
}

func readStringSlice(raw any) []string {
	if raw == nil {
		return nil
	}
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

func requiredString(claims jwt.MapClaims, name string) (string, bool) {
	value, ok := claims[name].(string)
	return value, ok && value != ""
}

func optionalString(claims jwt.MapClaims, name string) (string, bool) {
	value, ok := claims[name]
	if !ok || value == nil || value == "" {
		return "", true
	}
	typed, ok := value.(string)
	return typed, ok
}

func requiredNumeric(claims jwt.MapClaims, name string) bool {
	switch v := claims[name].(type) {
	case float64:
		return v >= 0
	case int64:
		return v >= 0
	case json.Number:
		_, err := v.Int64()
		return err == nil
	default:
		return false
	}
}

func optionalInt(claims jwt.MapClaims, name string) (int, bool) {
	value, ok := claims[name]
	if !ok || value == nil {
		return 0, true
	}
	switch v := value.(type) {
	case float64:
		if v < 0 || v != float64(int(v)) {
			return 0, false
		}
		return int(v), true
	case int64:
		if v < 0 {
			return 0, false
		}
		return int(v), true
	case json.Number:
		n, err := v.Int64()
		if err != nil || n < 0 {
			return 0, false
		}
		return int(n), true
	default:
		return 0, false
	}
}

func requiredInt64(claims jwt.MapClaims, name string) (int64, bool) {
	value, ok := optionalInt(claims, name)
	if !ok {
		return 0, false
	}
	if value == 0 {
		_, present := claims[name]
		if !present {
			return 0, false
		}
	}
	return int64(value), true
}

// fetchZone resolves the zone whose JWKS keyset can verify the token: the
// configured zone wins; otherwise the unverified zone_id claim routes the key
// lookup, which is safe because the signature check against that zone's keys
// then proves the claim.
func fetchZone(tokenStr string, cfg Config) (string, error) {
	if cfg.ZoneID != "" {
		return cfg.ZoneID, nil
	}
	unverified := jwt.MapClaims{}
	if _, _, err := jwt.NewParser().ParseUnverified(tokenStr, unverified); err != nil {
		return "", ErrTokenInvalid
	}
	zoneID, _ := unverified["zone_id"].(string)
	if zoneID == "" {
		return "", ErrZoneInvalid
	}
	return zoneID, nil
}

// Verify parses and validates a JWT, returning typed Claims on success.
func Verify(tokenStr string, cfg Config) (Claims, error) {
	return VerifyContext(context.Background(), tokenStr, cfg)
}

// VerifyContext is Verify with caller-supplied cancellation, propagated to the
// JWKS fetch so verification honors the caller's deadline.
func VerifyContext(ctx context.Context, tokenStr string, cfg Config) (Claims, error) {
	zone, err := fetchZone(tokenStr, cfg)
	if err != nil {
		return Claims{}, err
	}
	mapClaims := jwt.MapClaims{}
	_, err = jwt.ParseWithClaims(tokenStr, mapClaims, func(t *jwt.Token) (any, error) {
		kid, _ := t.Header["kid"].(string)
		keys, err := GetJWKSContext(ctx, cfg.Issuer, zone)
		if err != nil {
			return nil, err
		}
		if k, ok := keys[kid]; ok {
			return k, nil
		}
		return nil, jwt.ErrTokenSignatureInvalid
	}, jwt.WithIssuer(cfg.Issuer), jwt.WithAudience(cfg.Audience), jwt.WithExpirationRequired(), jwt.WithIssuedAt(), jwt.WithLeeway(60*time.Second), jwt.WithValidMethods([]string{jwt.SigningMethodES256.Alg()}))
	if err != nil {
		return Claims{}, ErrTokenInvalid
	}

	if !requiredNumeric(mapClaims, "iat") {
		return Claims{}, ErrTokenInvalid
	}
	scope, ok := optionalString(mapClaims, "scope")
	if !ok {
		return Claims{}, ErrTokenInvalid
	}
	zoneID, _ := mapClaims["zone_id"].(string)
	if zoneID == "" || zoneID != zone || (cfg.ZoneID != "" && zoneID != cfg.ZoneID) {
		return Claims{}, ErrZoneInvalid
	}
	jti, ok := requiredString(mapClaims, "jti")
	if !ok {
		return Claims{}, ErrTokenInvalid
	}
	sub, ok := requiredString(mapClaims, "sub")
	if !ok {
		return Claims{}, ErrTokenInvalid
	}
	sid, ok := requiredString(mapClaims, "sid")
	if !ok {
		return Claims{}, ErrTokenInvalid
	}
	rootSid, ok := requiredString(mapClaims, "root_sid")
	if !ok {
		return Claims{}, ErrTokenInvalid
	}
	clientID, ok := requiredString(mapClaims, "client_id")
	if !ok {
		return Claims{}, ErrTokenInvalid
	}
	use, ok := requiredString(mapClaims, "use")
	if !ok || (use != MandateUseSession && use != MandateUseResource) || (cfg.RequiredUse != "" && use != cfg.RequiredUse) {
		return Claims{}, ErrTokenInvalid
	}
	subType, ok := requiredString(mapClaims, "sub_type")
	if !ok || (subType != SubjectTypeUser && subType != SubjectTypeApplication) {
		return Claims{}, ErrTokenInvalid
	}
	issuedAt, ok := requiredInt64(mapClaims, "iat")
	if !ok {
		return Claims{}, ErrTokenInvalid
	}
	expiresAt, ok := requiredInt64(mapClaims, "exp")
	if !ok {
		return Claims{}, ErrTokenInvalid
	}
	for _, required := range cfg.RequiredScopes {
		if !HasScope(scope, required) {
			return Claims{}, &ScopeMissingError{Scope: required}
		}
	}
	targetResources := readStringSlice(mapClaims["target"])
	for _, target := range cfg.RequiredTargets {
		found := false
		for _, resource := range targetResources {
			if resource == target {
				found = true
				break
			}
		}
		if !found {
			return Claims{}, ErrTokenInvalid
		}
	}

	agentSessionID, ok := optionalString(mapClaims, "agent_session_id")
	if !ok {
		return Claims{}, ErrTokenInvalid
	}
	delegationEdgeID, ok := optionalString(mapClaims, "delegation_edge_id")
	if !ok {
		return Claims{}, ErrTokenInvalid
	}
	sourceSessionID, ok := optionalString(mapClaims, "source_session_id")
	if !ok {
		return Claims{}, ErrTokenInvalid
	}
	targetSessionID, ok := optionalString(mapClaims, "target_session_id")
	if !ok {
		return Claims{}, ErrTokenInvalid
	}
	chain := readChain(mapClaims["delegation_chain"])
	path := readStringSlice(mapClaims["delegation_path"])

	graphEpochValue, ok := optionalInt(mapClaims, "delegation_graph_epoch")
	if !ok {
		return Claims{}, ErrTokenInvalid
	}
	graphEpoch := int64(graphEpochValue)
	hopCount, ok := optionalInt(mapClaims, "hop_count")
	if !ok {
		return Claims{}, ErrTokenInvalid
	}

	if cfg.RequireAgent && agentSessionID == "" {
		return Claims{}, ErrAgentIdentityRequired
	}
	if cfg.RequireDelegation && delegationEdgeID == "" {
		return Claims{}, ErrDelegationRequired
	}
	maxHops := cfg.MaxHopCount
	if maxHops <= 0 {
		maxHops = DefaultMaxHopCount
	}
	if hopCount > maxHops {
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
		RootSid:          rootSid,
		Use:              use,
		SubType:          subType,
		JTI:              jti,
		IssuedAt:         issuedAt,
		ExpiresAt:        expiresAt,
		Scope:            scope,
		TargetResources:  targetResources,
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
