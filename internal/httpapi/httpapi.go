// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package httpapi carries the HTTP middleware and response helpers shared by
// caracal-server route groups.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/identity"
)

type contextKey struct{}

// ContextWithClaims returns a context carrying pre-verified claims, for
// handler composition and tests.
func ContextWithClaims(ctx context.Context, claims auth.Claims) context.Context {
	return context.WithValue(ctx, contextKey{}, claims)
}

// ClaimsFrom returns the authenticated identity placed by RequireAuth.
func ClaimsFrom(ctx context.Context) (auth.Claims, bool) {
	claims, ok := ctx.Value(contextKey{}).(auth.Claims)
	return claims, ok
}

// RequireAuth authenticates the bearer token on every request and stores the
// verified claims in the request context.
func RequireAuth(authenticator *auth.Authenticator, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, ok := auth.BearerToken(r.Header.Get("Authorization"))
		if !ok {
			WriteError(w, http.StatusUnauthorized, "Missing credentials")
			return
		}
		claims, err := authenticator.Authenticate(r.Context(), token)
		if err != nil {
			WriteError(w, http.StatusUnauthorized, "Invalid or expired token")
			return
		}
		next.ServeHTTP(w, r.WithContext(ContextWithClaims(r.Context(), claims)))
	})
}

// UserGate maps a verified identity to an active registry account,
// provisioning the account on first contact.
type UserGate interface {
	ResolveActive(ctx context.Context, claims auth.Claims) (uuid.UUID, error)
}

// RequireActiveUser blocks tokens whose account no longer exists or is
// deactivated, and rewrites the context claims so UserID carries the
// registry user id. Run it after RequireAuth.
func RequireActiveUser(gate UserGate, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims, ok := ClaimsFrom(r.Context())
		if !ok {
			WriteError(w, http.StatusUnauthorized, "Missing credentials")
			return
		}
		localID, err := gate.ResolveActive(r.Context(), claims)
		switch {
		case err == nil:
			claims.UserID = localID
			next.ServeHTTP(w, r.WithContext(ContextWithClaims(r.Context(), claims)))
		case errors.Is(err, identity.ErrUnknownUser):
			WriteError(w, http.StatusUnauthorized, "Invalid or expired token")
		case errors.Is(err, identity.ErrDeactivated):
			WriteError(w, http.StatusForbidden, "Account deactivated")
		default:
			WriteError(w, http.StatusServiceUnavailable, "Auth service temporarily unavailable")
		}
	})
}

// RequireAuthContext rejects a valid identity token minted for the wrong
// authority context. It must run after RequireAuth.
func RequireAuthContext(context string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims, ok := ClaimsFrom(r.Context())
		if !ok {
			WriteError(w, http.StatusUnauthorized, "Missing credentials")
			return
		}
		if claims.AuthContext != context {
			WriteError(w, http.StatusForbidden, "Wrong authentication context")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// roleLevels orders roles from most to least privileged; roles outside the
// hierarchy carry no permissions at all.
var roleLevels = map[string]int{
	"operator": 0,
	"reviewer": 1,
	"user":     2,
}

// RequireRole rejects claims below the given role floor. Run it after
// RequireAuth.
func RequireRole(minRole string, next http.Handler) http.Handler {
	required, ok := roleLevels[minRole]
	if !ok {
		panic(fmt.Sprintf("httpapi: unknown role %q", minRole))
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims, ok := ClaimsFrom(r.Context())
		if !ok {
			WriteError(w, http.StatusUnauthorized, "Missing credentials")
			return
		}
		level, known := roleLevels[claims.Role]
		if !known || level > required {
			WriteError(w, http.StatusForbidden, "Insufficient permissions")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// WriteJSON writes a JSON response with the given status.
func WriteJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// errorCodes gives every error status a stable machine-readable code.
var errorCodes = map[int]string{
	http.StatusBadRequest:            "bad_request",
	http.StatusUnauthorized:          "authentication_required",
	http.StatusForbidden:             "permission_denied",
	http.StatusNotFound:              "not_found",
	http.StatusMethodNotAllowed:      "method_not_allowed",
	http.StatusConflict:              "conflict",
	http.StatusGone:                  "gone",
	http.StatusRequestEntityTooLarge: "payload_too_large",
	http.StatusUnsupportedMediaType:  "unsupported_media_type",
	http.StatusUnprocessableEntity:   "validation_error",
	http.StatusUpgradeRequired:       "upgrade_required",
	http.StatusTooManyRequests:       "rate_limited",
	http.StatusInternalServerError:   "internal_error",
	http.StatusBadGateway:            "bad_gateway",
	http.StatusServiceUnavailable:    "unavailable",
	http.StatusGatewayTimeout:        "timeout",
}

// ErrorCode returns the stable machine-readable code for an error status.
func ErrorCode(status int) string {
	if code, ok := errorCodes[status]; ok {
		return code
	}
	if status < 500 {
		return "client_error"
	}
	return "internal_error"
}

// Retryable reports whether a client may retry the request unchanged.
func Retryable(status int) bool {
	return status == http.StatusTooManyRequests || (status >= 502 && status <= 504)
}

// WriteError writes the error envelope used across the API: detail (the
// human-readable message), a stable machine-readable code, whether the
// request may be retried unchanged, and the correlation id when the request
// passed through the audit middleware.
func WriteError(w http.ResponseWriter, status int, detail string) {
	WriteErrorDetail(w, status, detail)
}

// WriteErrorDetail is WriteError for structured detail payloads
// (validation lists, nested conflict objects).
func WriteErrorDetail(w http.ResponseWriter, status int, detail any) {
	body := map[string]any{
		"detail":    detail,
		"code":      ErrorCode(status),
		"retryable": Retryable(status),
	}
	if rid := w.Header().Get("X-Request-ID"); rid != "" {
		body["request_id"] = rid
	}
	WriteJSON(w, status, body)
}

// WriteInternalError logs the cause with the request's correlation id and
// writes a sanitized 500. Use it wherever a handler would otherwise discard
// the error, so production 500s stay diagnosable.
func WriteInternalError(w http.ResponseWriter, r *http.Request, err error) {
	slog.Error("internal error",
		"method", r.Method,
		"path", r.URL.Path,
		"request_id", w.Header().Get("X-Request-ID"),
		"error", err,
	)
	WriteError(w, http.StatusInternalServerError, "Internal server error")
}

// OptionalAuth authenticates the bearer token when one is present and passes
// anonymous requests through untouched. A presented-but-bad credential is
// still an error: that distinguishes "no credentials" from "bad credentials".
func OptionalAuth(authenticator *auth.Authenticator, gate UserGate, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, ok := auth.BearerToken(r.Header.Get("Authorization"))
		if !ok {
			next.ServeHTTP(w, r)
			return
		}
		claims, err := authenticator.Authenticate(r.Context(), token)
		if err != nil {
			WriteError(w, http.StatusUnauthorized, "Invalid or expired token")
			return
		}
		localID, err := gate.ResolveActive(r.Context(), claims)
		switch {
		case err == nil:
			claims.UserID = localID
			next.ServeHTTP(w, r.WithContext(ContextWithClaims(r.Context(), claims)))
		case errors.Is(err, identity.ErrUnknownUser):
			WriteError(w, http.StatusUnauthorized, "Invalid or expired token")
		case errors.Is(err, identity.ErrDeactivated):
			WriteError(w, http.StatusUnauthorized, "Account deactivated")
		default:
			WriteError(w, http.StatusServiceUnavailable, "Auth service temporarily unavailable")
		}
	})
}

// OptionalAuthContext is OptionalAuth for route families that permit anonymous
// reads but reject authenticated tokens minted for another authority context.
func OptionalAuthContext(authenticator *auth.Authenticator, gate UserGate, context string, next http.Handler) http.Handler {
	return OptionalAuth(authenticator, gate, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims, ok := ClaimsFrom(r.Context())
		if ok && claims.AuthContext != context {
			WriteError(w, http.StatusForbidden, "Wrong authentication context")
			return
		}
		next.ServeHTTP(w, r)
	}))
}
