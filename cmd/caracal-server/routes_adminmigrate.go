// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"net/http"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/garudex-labs/caracal/internal/adminmigrate"
	"github.com/garudex-labs/caracal/internal/audit"
	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/settings"
)

func mountAdminMigrate(
	mux *http.ServeMux,
	pool *pgxpool.Pool,
	chClient *clickhouse.Client,
	settingsStore *settings.Store,
	authenticator *auth.Authenticator,
	directory httpapi.UserGate,
	auditTrail *audit.Logger,
	postgresURL string,
	clickhouseURL string,
) {
	secret := os.Getenv("SECRET_KEY")
	if secret == "" {
		secret = "change-me-to-a-random-string"
	}
	store := &adminmigrate.Store{DB: pool}
	runner := &adminmigrate.Runner{
		Store:         store,
		Settings:      settingsStore,
		PostgresDSN:   postgresURL,
		ClickHouseURL: clickhouseURL,
	}
	handler := adminmigrate.NewHandler(store, runner,
		&adminmigrate.TokenSigner{Secret: []byte(secret)}, settingsStore, chClient)
	go handler.RunArtifactPurge(context.Background())

	withOperator := func(next http.Handler) http.Handler {
		return audit.Middleware(auditTrail, "standard",
			httpapi.RequireAuth(authenticator,
				httpapi.RequireActiveUser(directory,
					httpapi.RequireAuthContext(auth.AuthContextOperator,
						httpapi.RequireRole("operator",
							audit.CaptureActor(next))))))
	}
	// Downloads are authorized by the short-lived signed token in the
	// query string, not by a bearer credential.
	withPublic := func(next http.Handler) http.Handler {
		return audit.Middleware(auditTrail, "standard", next)
	}
	handler.Register(mux, withOperator, withPublic)
}
