// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// net/http middleware that validates Caracal JWTs at every MCP tool boundary.

package mcp

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/golang-jwt/jwt/v5"
)

// Options configures the auth middleware.
type Options struct {
	Issuer         string
	Audience       string
	ZoneID         string
	RequiredScopes []string
}

type errBody struct {
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
}

// Middleware returns a net/http middleware that validates Caracal JWTs.
func Middleware(opts Options) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token, err := extractBearer(r)
			if err != nil {
				writeErr(w, http.StatusUnauthorized, "invalid_token", "Missing bearer token")
				return
			}

			claims, err := validateToken(token, opts)
			if err != nil {
				writeErr(w, http.StatusUnauthorized, "invalid_token", "Token validation failed")
				return
			}

			scope, _ := claims["scope"].(string)
			zoneID, _ := claims["zone_id"].(string)
			if zoneID == "" || (opts.ZoneID != "" && zoneID != opts.ZoneID) {
				writeErr(w, http.StatusUnauthorized, "invalid_token", "Token zone validation failed")
				return
			}
			for _, required := range opts.RequiredScopes {
				if !containsScope(scope, required) {
					writeErr(w, http.StatusForbidden, "insufficient_scope", "Missing scope: "+required)
					return
				}
			}

			next.ServeHTTP(w, r)
		})
	}
}

func extractBearer(r *http.Request) (string, error) {
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return "", jwt.ErrTokenMalformed
	}
	return strings.TrimPrefix(auth, "Bearer "), nil
}

func validateToken(tokenStr string, opts Options) (jwt.MapClaims, error) {
	claims := jwt.MapClaims{}
	_, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (interface{}, error) {
		kid, _ := t.Header["kid"].(string)
		keys, err := getJWKS(opts.Issuer)
		if err != nil {
			return nil, err
		}
		if k, ok := keys[kid]; ok {
			return k, nil
		}
		return nil, jwt.ErrTokenSignatureInvalid
	}, jwt.WithIssuer(opts.Issuer), jwt.WithAudience(opts.Audience), jwt.WithValidMethods([]string{jwt.SigningMethodES256.Alg()}))
	return claims, err
}

func containsScope(scope, target string) bool {
	for _, s := range strings.Fields(scope) {
		if s == target {
			return true
		}
	}
	return false
}

func writeErr(w http.ResponseWriter, status int, code, desc string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(errBody{Error: code, ErrorDescription: desc}) //nolint:errcheck
}
