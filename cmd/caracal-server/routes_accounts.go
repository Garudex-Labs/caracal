// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/garudex-labs/caracal/internal/accounts"
	"github.com/garudex-labs/caracal/internal/audit"
	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/settings"
)

func mountAccounts(
	mux *http.ServeMux,
	pool *pgxpool.Pool,
	chClient *clickhouse.Client,
	settingsStore *settings.Store,
	authenticator *auth.Authenticator,
	directory httpapi.UserGate,
	auditTrail *audit.Logger,
) {
	bridge := &accounts.Minter{
		BaseURL:        envOr("CARACAL_AUTH_SERVICE_URL", "http://localhost:8001"),
		InternalSecret: configValue("AUTH_INTERNAL_SECRET"),
	}
	handler := &accounts.Handler{
		Store:    &accounts.Store{DB: pool},
		Events:   chClient,
		Settings: settingsStore,
	}
	chain := audit.Middleware(auditTrail, "standard",
		httpapi.RequireAuth(authenticator,
			httpapi.RequireActiveUser(directory,
				audit.CaptureActor(handler.Routes()))))
	mux.Handle("/api/v1/auth/", chain)
	mux.Handle("GET /api/v1/users/search", chain)

	admin := &accounts.AdminHandler{DB: pool, Events: chClient, Bridge: bridge}
	withOperator := func(next http.Handler) http.Handler {
		return audit.Middleware(auditTrail, "standard",
			httpapi.RequireAuth(authenticator,
				httpapi.RequireActiveUser(directory,
					httpapi.RequireAuthContext(auth.AuthContextOperator,
						httpapi.RequireRole("operator",
							audit.CaptureActor(next))))))
	}
	admin.Register(mux, withOperator)
}
