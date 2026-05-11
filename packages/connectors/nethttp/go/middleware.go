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

	"github.com/garudex-labs/caracal/identity"
	transportmcp "github.com/garudex-labs/caracal/transport-mcp"
)

// Options configures the auth middleware.
type Options = transportmcp.Options

type errBody struct {
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
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
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token, _ := transportmcp.ExtractBearer(r.Header.Get("Authorization"))
			claims, authErr := transportmcp.Authenticate(token, opts)
			if authErr != nil {
				status, code := mapError(authErr.Code)
				writeErr(w, status, code, authErr.Description)
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

func writeErr(w http.ResponseWriter, status int, code, desc string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(errBody{Error: code, ErrorDescription: desc}); err != nil {
		log.Printf("mcp-nethttp: failed to encode error response: %v", err)
	}
}
