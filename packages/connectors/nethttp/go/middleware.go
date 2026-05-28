// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// net/http middleware that delegates MCP auth to transport-mcp.

package mcpnethttp

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/garudex-labs/caracal/packages/identity/go"
	transportmcp "github.com/garudex-labs/caracal/packages/transport/mcp/go"
)

// Options configures the auth middleware.
type Options = transportmcp.Options

type errBody struct {
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
	ErrorHint        string `json:"error_hint,omitempty"`
}

type ctxKey int

const (
	claimsKey ctxKey = iota
)

// ClaimsFromContext returns the verified Caracal claims attached by Middleware,
// or false when the request was not authenticated through this middleware.
func ClaimsFromContext(ctx context.Context) (identity.Claims, bool) {
	c, ok := ctx.Value(claimsKey).(identity.Claims)
	return c, ok
}

// Middleware returns a net/http middleware that validates Caracal JWTs and
// attaches the verified principal to the request context.
func Middleware(opts Options) func(http.Handler) http.Handler {
	return VerifierMiddleware(transportmcp.NewVerifier(opts))
}

// VerifierMiddleware returns middleware backed by a reusable mandate verifier.
func VerifierMiddleware(verifier *transportmcp.Verifier) func(http.Handler) http.Handler {
	if verifier == nil {
		verifier = transportmcp.NewVerifier(Options{})
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			claims, authErr := verifier.Authorization(r.Header.Get("Authorization"))
			if authErr != nil {
				status, code := mapError(authErr.Code)
				writeErr(w, status, code, authErr.Description, authErr.Hint)
				return
			}
			ctx := context.WithValue(r.Context(), claimsKey, claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func mapError(code transportmcp.ErrorCode) (int, string) {
	switch code {
	case transportmcp.ErrInsufficientScope:
		return http.StatusForbidden, "insufficient_scope"
	case transportmcp.ErrAgentRequired:
		return http.StatusUnauthorized, "agent_required"
	case transportmcp.ErrDelegationRequired:
		return http.StatusUnauthorized, "delegation_required"
	case transportmcp.ErrChainMismatch:
		return http.StatusUnauthorized, "chain_mismatch"
	case transportmcp.ErrHopCountExceeded:
		return http.StatusUnauthorized, "hop_count_exceeded"
	case transportmcp.ErrSessionRevoked:
		return http.StatusUnauthorized, "session_revoked"
	case transportmcp.ErrInvalidZone:
		return http.StatusUnauthorized, "invalid_zone"
	case transportmcp.ErrMissingToken:
		return http.StatusUnauthorized, "missing_token"
	default:
		return http.StatusUnauthorized, "invalid_token"
	}
}

func writeErr(w http.ResponseWriter, status int, code, desc, hint string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(errBody{Error: code, ErrorDescription: desc, ErrorHint: hint}); err != nil {
		log.Printf("mcp-nethttp: failed to encode error response: %v", err)
	}
}
