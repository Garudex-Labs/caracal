// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// net/http middleware that delegates bearer verification to the verify engine.

package nethttp

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/garudex-labs/caracal/packages/identity/go"
	verify "github.com/garudex-labs/caracal/packages/verify/go"
)

// Options configures the auth middleware.
type Options = verify.Options

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
	return VerifierMiddleware(verify.NewVerifier(opts))
}

// VerifierMiddleware returns middleware backed by a reusable mandate verifier.
func VerifierMiddleware(verifier *verify.Verifier) func(http.Handler) http.Handler {
	if verifier == nil {
		verifier = verify.NewVerifier(Options{})
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			claims, authErr := verifier.AuthorizationContext(r.Context(), r.Header.Get("Authorization"))
			if authErr != nil {
				writeErr(w, verify.HTTPStatus(authErr.Code), string(authErr.Code), authErr.Description, authErr.Hint)
				return
			}
			ctx := context.WithValue(r.Context(), claimsKey, claims)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func writeErr(w http.ResponseWriter, status int, code, desc, hint string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(errBody{Error: code, ErrorDescription: desc, ErrorHint: hint}); err != nil {
		log.Printf("mcp-nethttp: failed to encode error response: %v", err)
	}
}
