// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"errors"
	"net/http"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/tenancy"
)

type requestProjectResolver interface {
	ResolveProjectID(context.Context, *http.Request, uuid.UUID) (string, error)
}

// withProjectScope resolves authenticated requests to one authorized project.
// Anonymous public-registry reads remain unscoped when allowAnonymous is true.
func withProjectScope(resolver requestProjectResolver, allowAnonymous bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims, authenticated := httpapi.ClaimsFrom(r.Context())
		if !authenticated {
			if allowAnonymous {
				next.ServeHTTP(w, r)
				return
			}
			httpapi.WriteError(w, http.StatusUnauthorized, "Missing credentials")
			return
		}
		projectID, err := resolver.ResolveProjectID(r.Context(), r, claims.UserID)
		if err != nil {
			var scopeErr *tenancy.Error
			if errors.As(err, &scopeErr) {
				httpapi.WriteError(w, scopeErr.Status, scopeErr.Detail)
			} else {
				httpapi.WriteInternalError(w, r, err)
			}
			return
		}
		ctx := tenancy.ContextWithProjectID(r.Context(), projectID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
