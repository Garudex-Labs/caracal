// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/garudex-labs/caracal/internal/audit"
	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/onboarding"
)

func mountOnboarding(
	mux *http.ServeMux,
	pool *pgxpool.Pool,
	authenticator *auth.Authenticator,
	directory httpapi.UserGate,
	auditTrail *audit.Logger,
) {
	handler := &onboarding.Handler{Store: &onboarding.Store{DB: pool}}
	withAuth := func(next http.Handler) http.Handler {
		return audit.Middleware(auditTrail, "standard",
			httpapi.RequireAuth(authenticator,
				httpapi.RequireActiveUser(directory,
					httpapi.RequireAuthContext(auth.AuthContextTenant,
						audit.CaptureActor(next)))))
	}
	handler.Register(mux, withAuth)
}
