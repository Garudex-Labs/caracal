// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Framework-neutral MCP authentication: bearer parse, identity verify, revocation check.

package transportmcp

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/garudex-labs/caracal/packages/identity/go"
	"github.com/garudex-labs/caracal/packages/revocation/go"
)

// Options configures the MCP authentication pipeline.
type Options struct {
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
	Hint        string
}

func (e *AuthError) Error() string { return e.Description }

// HTTPStatus returns the canonical HTTP status for an authentication failure
// code. It is the single source of truth for every HTTP adapter so boundary
// semantics stay identical across frameworks and languages.
//
// 401 means the credential itself was not accepted (missing, malformed, wrong
// zone, revoked, or stale). 403 means the mandate verified but the authority it
// carries is insufficient for the route (missing scope, wrong principal kind, or
// an unmet delegation requirement).
func HTTPStatus(code ErrorCode) int {
	switch code {
	case ErrInsufficientScope, ErrAgentRequired, ErrDelegationRequired, ErrChainMismatch, ErrHopCountExceeded:
		return 403
	default:
		return 401
	}
}

// Verifier reuses secure defaults across requests and accepts per-route requirements.
type Verifier struct {
	defaults Options
}

// NewVerifier creates a reusable mandate verifier.
func NewVerifier(defaults Options) *Verifier {
	return &Verifier{defaults: defaults}
}

// Defaults returns the verifier's base options.
func (v *Verifier) Defaults() Options {
	return v.defaults
}

// ExtractBearer pulls a non-empty bearer token from an Authorization header value, or returns false.
func ExtractBearer(authHeader string) (string, bool) {
	parts := strings.Fields(authHeader)
	if len(parts) < 2 || !strings.EqualFold(parts[0], "Bearer") {
		return "", false
	}
	token := strings.Join(parts[1:], " ")
	if token == "" {
		return "", false
	}
	return token, true
}

// Authenticate verifies a token against identity and revocation, returning typed claims or an AuthError.
func Authenticate(token string, opts Options) (identity.Claims, *AuthError) {
	return NewVerifier(opts).Authenticate(token)
}

// AuthenticateContext is Authenticate with caller-supplied cancellation.
func AuthenticateContext(ctx context.Context, token string, opts Options) (identity.Claims, *AuthError) {
	return NewVerifier(opts).AuthenticateContext(ctx, token)
}

// Authenticate verifies a token using reusable defaults and optional route requirements.
func (v *Verifier) Authenticate(token string, overrides ...Options) (identity.Claims, *AuthError) {
	return v.AuthenticateContext(context.Background(), token, overrides...)
}

// AuthenticateContext is Authenticate with caller-supplied cancellation, propagated
// through identity verification so a slow JWKS fetch honors the caller's deadline.
func (v *Verifier) AuthenticateContext(ctx context.Context, token string, overrides ...Options) (identity.Claims, *AuthError) {
	opts := v.defaults
	for _, override := range overrides {
		opts = mergeOptions(opts, override)
	}
	if token == "" {
		return identity.Claims{}, authError(ErrMissingToken, "")
	}
	requiredUse := opts.RequiredUse
	if requiredUse == "" {
		requiredUse = identity.MandateUseResource
	}
	cfg := identity.Config{
		Issuer:               opts.Issuer,
		Audience:             opts.Audience,
		ZoneID:               opts.ZoneID,
		RequiredScopes:       opts.RequiredScopes,
		RequiredTargets:      opts.RequiredTargets,
		RequiredUse:          requiredUse,
		RequireAgent:         opts.RequireAgent,
		RequireDelegation:    opts.RequireDelegation,
		RequireChainContains: opts.RequireChainContains,
		MaxHopCount:          opts.MaxHopCount,
	}
	claims, err := identity.VerifyContext(ctx, token, cfg)
	if err != nil {
		var scopeErr *identity.ScopeMissingError
		var chainErr *identity.ChainMismatchError
		switch {
		case errors.As(err, &scopeErr):
			return identity.Claims{}, authError(ErrInsufficientScope, "Missing scope: "+scopeErr.Scope)
		case errors.Is(err, identity.ErrZoneInvalid):
			return identity.Claims{}, authError(ErrInvalidZone, "")
		case errors.Is(err, identity.ErrAgentIdentityRequired):
			return identity.Claims{}, authError(ErrAgentRequired, "")
		case errors.Is(err, identity.ErrDelegationRequired):
			return identity.Claims{}, authError(ErrDelegationRequired, "")
		case errors.As(err, &chainErr):
			return identity.Claims{}, authError(ErrChainMismatch, "Delegation chain missing application: "+chainErr.ApplicationID)
		case errors.Is(err, identity.ErrHopCountExceeded):
			return identity.Claims{}, authError(ErrHopCountExceeded, "")
		default:
			return identity.Claims{}, authError(ErrInvalidToken, "")
		}
	}
	if opts.Revocations == nil {
		return identity.Claims{}, authError(ErrInvalidToken, "Revocation store required")
	}
	if claims.Sid == "" {
		return identity.Claims{}, authError(ErrInvalidToken, "")
	}
	if authErr := CheckActiveAuthority(claims, opts.Revocations, time.Now()); authErr != nil {
		return identity.Claims{}, authErr
	}
	return claims, nil
}

// Authorization extracts and verifies a bearer mandate from an Authorization header value.
func (v *Verifier) Authorization(authHeader string, overrides ...Options) (identity.Claims, *AuthError) {
	return v.AuthorizationContext(context.Background(), authHeader, overrides...)
}

// AuthorizationContext is Authorization with caller-supplied cancellation.
func (v *Verifier) AuthorizationContext(ctx context.Context, authHeader string, overrides ...Options) (identity.Claims, *AuthError) {
	token, _ := ExtractBearer(authHeader)
	return v.AuthenticateContext(ctx, token, overrides...)
}

// Require returns a verifier with extra route requirements layered onto the defaults.
func (v *Verifier) Require(overrides Options) *Verifier {
	return NewVerifier(mergeOptions(v.defaults, overrides))
}

// CheckActiveAuthority validates expiry and all revocation anchors during resource execution.
func CheckActiveAuthority(claims identity.Claims, revocations revocation.Store, now time.Time) *AuthError {
	if claims.Sid == "" {
		return authError(ErrInvalidToken, "")
	}
	if claims.ExpiresAt > 0 && claims.ExpiresAt <= now.Unix() {
		return authError(ErrInvalidToken, "Token expired during execution")
	}
	if revocations == nil {
		return authError(ErrInvalidToken, "Revocation store required")
	}
	for _, anchor := range revocationAnchors(claims) {
		if revocations.IsRevoked(anchor) {
			return authError(ErrSessionRevoked, "")
		}
	}
	return nil
}

func mergeOptions(base Options, override Options) Options {
	if override.Issuer != "" {
		base.Issuer = override.Issuer
	}
	if override.Audience != "" {
		base.Audience = override.Audience
	}
	if override.ZoneID != "" {
		base.ZoneID = override.ZoneID
	}
	if override.RequiredScopes != nil {
		base.RequiredScopes = override.RequiredScopes
	}
	if override.RequiredTargets != nil {
		base.RequiredTargets = override.RequiredTargets
	}
	if override.RequiredUse != "" {
		base.RequiredUse = override.RequiredUse
	}
	if override.RequireAgent {
		base.RequireAgent = true
	}
	if override.RequireDelegation {
		base.RequireDelegation = true
	}
	if override.RequireChainContains != nil {
		base.RequireChainContains = override.RequireChainContains
	}
	if override.MaxHopCount > 0 {
		base.MaxHopCount = override.MaxHopCount
	}
	if override.Revocations != nil {
		base.Revocations = override.Revocations
	}
	return base
}

func revocationAnchors(claims identity.Claims) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, anchor := range []string{claims.Sid, claims.RootSid, claims.AgentSessionID, claims.DelegationEdgeID} {
		if anchor == "" || seen[anchor] {
			continue
		}
		seen[anchor] = true
		out = append(out, anchor)
	}
	return out
}

func authError(code ErrorCode, description string) *AuthError {
	if description == "" {
		description = defaultDescription(code)
	}
	return &AuthError{Code: code, Description: description, Hint: defaultHint(code)}
}

func defaultDescription(code ErrorCode) string {
	switch code {
	case ErrMissingToken:
		return "Missing bearer token"
	case ErrInvalidZone:
		return "Token zone validation failed"
	case ErrInsufficientScope:
		return "Required scope is missing"
	case ErrSessionRevoked:
		return "Session revoked"
	case ErrAgentRequired:
		return "Agent identity required"
	case ErrDelegationRequired:
		return "Delegation required"
	case ErrChainMismatch:
		return "Delegation chain validation failed"
	case ErrHopCountExceeded:
		return "Hop count exceeded"
	default:
		return "Token validation failed"
	}
}

func defaultHint(code ErrorCode) string {
	switch code {
	case ErrMissingToken:
		return "Send Authorization: Bearer <Caracal mandate>."
	case ErrInvalidZone:
		return "Check the configured zone ID and the mandate zone_id claim."
	case ErrInsufficientScope:
		return "Request a mandate that includes every required scope for this route."
	case ErrSessionRevoked:
		return "Refresh the mandate or start a new authorized session."
	case ErrAgentRequired:
		return "Use an agent-issued resource mandate for this endpoint."
	case ErrDelegationRequired:
		return "Use a mandate produced by a delegated grant flow."
	case ErrChainMismatch:
		return "Check RequireChainContains and the mandate delegation chain."
	case ErrHopCountExceeded:
		return "Reduce delegation depth or raise MaxHopCount deliberately."
	default:
		return "Check issuer, audience, signature, expiry, token use, scopes, and targets."
	}
}
