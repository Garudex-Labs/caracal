// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Framework-neutral MCP authentication: bearer parse, identity verify, revocation check.

package transportmcp

import (
	"errors"
	"strings"

	"github.com/garudex-labs/caracal/identity"
	"github.com/garudex-labs/caracal/revocation"
)

// Options configures the MCP authentication pipeline.
type Options struct {
	Issuer               string
	Audience             string
	ZoneID               string
	RequiredScopes       []string
	RequireAgent         bool
	RequireDelegation    bool
	RequireChainContains []string
	MaxHopCount          int
	Revocations          revocation.Store
}

// ErrorCode names every transport-neutral failure mode.
type ErrorCode string

const (
	ErrMissingToken       ErrorCode = "missing_token"
	ErrInvalidToken       ErrorCode = "invalid_token"
	ErrInvalidZone        ErrorCode = "invalid_zone"
	ErrInsufficientScope  ErrorCode = "insufficient_scope"
	ErrSessionRevoked     ErrorCode = "session_revoked"
	ErrAgentRequired      ErrorCode = "agent_required"
	ErrDelegationRequired ErrorCode = "delegation_required"
	ErrChainMismatch      ErrorCode = "chain_mismatch"
	ErrHopCountExceeded   ErrorCode = "hop_count_exceeded"
)

// AuthError is the typed failure returned by Authenticate.
type AuthError struct {
	Code        ErrorCode
	Description string
}

func (e *AuthError) Error() string { return e.Description }

// ExtractBearer pulls a non-empty bearer token from an Authorization header value, or returns false.
func ExtractBearer(authHeader string) (string, bool) {
	if !strings.HasPrefix(authHeader, "Bearer ") {
		return "", false
	}
	token := strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))
	if token == "" {
		return "", false
	}
	return token, true
}

// Authenticate verifies a token against identity and revocation, returning typed claims or an AuthError.
func Authenticate(token string, opts Options) (identity.Claims, *AuthError) {
	if token == "" {
		return identity.Claims{}, &AuthError{Code: ErrMissingToken, Description: "Missing bearer token"}
	}
	cfg := identity.Config{
		Issuer:               opts.Issuer,
		Audience:             opts.Audience,
		ZoneID:               opts.ZoneID,
		RequiredScopes:       opts.RequiredScopes,
		RequireAgent:         opts.RequireAgent,
		RequireDelegation:    opts.RequireDelegation,
		RequireChainContains: opts.RequireChainContains,
		MaxHopCount:          opts.MaxHopCount,
	}
	claims, err := identity.Verify(token, cfg)
	if err != nil {
		var scopeErr *identity.ScopeMissingError
		var chainErr *identity.ChainMismatchError
		switch {
		case errors.As(err, &scopeErr):
			return identity.Claims{}, &AuthError{Code: ErrInsufficientScope, Description: "Missing scope: " + scopeErr.Scope}
		case errors.Is(err, identity.ErrZoneInvalid):
			return identity.Claims{}, &AuthError{Code: ErrInvalidZone, Description: "Token zone validation failed"}
		case errors.Is(err, identity.ErrAgentIdentityRequired):
			return identity.Claims{}, &AuthError{Code: ErrAgentRequired, Description: "Agent identity required"}
		case errors.Is(err, identity.ErrDelegationRequired):
			return identity.Claims{}, &AuthError{Code: ErrDelegationRequired, Description: "Delegation required"}
		case errors.As(err, &chainErr):
			return identity.Claims{}, &AuthError{Code: ErrChainMismatch, Description: "Delegation chain missing application: " + chainErr.ApplicationID}
		case errors.Is(err, identity.ErrHopCountExceeded):
			return identity.Claims{}, &AuthError{Code: ErrHopCountExceeded, Description: "Hop count exceeded"}
		default:
			return identity.Claims{}, &AuthError{Code: ErrInvalidToken, Description: "Token validation failed"}
		}
	}
	if opts.Revocations != nil && claims.Sid != "" && opts.Revocations.IsRevoked(claims.Sid) {
		return identity.Claims{}, &AuthError{Code: ErrSessionRevoked, Description: "Session revoked"}
	}
	return claims, nil
}
