// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"net/http"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/garudex-labs/caracal/internal/audit"
	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/fernet"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/orgs"
	"github.com/garudex-labs/caracal/internal/settings"
)

func mountOrgs(
	mux *http.ServeMux,
	pool *pgxpool.Pool,
	chClient *clickhouse.Client,
	settingsStore *settings.Store,
	authenticator *auth.Authenticator,
	directory httpapi.UserGate,
	auditTrail *audit.Logger,
) {
	secret := os.Getenv("SECRET_KEY")
	if secret == "" {
		secret = "change-me-to-a-random-string"
	}
	handler := &orgs.Handler{
		Store:     &orgs.Store{DB: pool},
		Settings:  settingsStore,
		CH:        chClient,
		Pool:      pool,
		Events:    chClient,
		SecretKey: fernet.DeriveKey(secret),
	}
	withAuth := func(next http.Handler) http.Handler {
		return audit.Middleware(auditTrail, "standard",
			httpapi.RequireAuth(authenticator,
				httpapi.RequireActiveUser(directory,
					httpapi.RequireAuthContext(auth.AuthContextTenant,
						audit.CaptureActor(next)))))
	}
	handler.Register(mux, withAuth)
}
