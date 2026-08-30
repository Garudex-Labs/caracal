// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"net/http"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/garudex-labs/caracal/internal/adminops"
	"github.com/garudex-labs/caracal/internal/audit"
	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/fernet"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/operatorops"
	"github.com/garudex-labs/caracal/internal/orgs"
	"github.com/garudex-labs/caracal/internal/settings"
)

func mountAdminOps(
	mux *http.ServeMux,
	pool *pgxpool.Pool,
	chClient *clickhouse.Client,
	redisClient *redis.Client,
	settingsStore *settings.Store,
	authenticator *auth.Authenticator,
	directory httpapi.UserGate,
	auditTrail *audit.Logger,
	version string,
	jwksURL string,
) {
	secret := os.Getenv("SECRET_KEY")
	if secret == "" {
		secret = "change-me-to-a-random-string"
	}
	handler := &adminops.Handler{
		DB:                 pool,
		CH:                 chClient,
		Redis:              redisClient,
		Settings:           settingsStore,
		SecretKey:          fernet.DeriveKey(secret),
		RawSecret:          secret,
		Version:            version,
		JWKSURL:            jwksURL,
		AuthInternalSecret: configValue("AUTH_INTERNAL_SECRET"),
		Development:        configValue("CARACAL_ENV") == "development",
	}
	handler.LoadExternal()
	withFloor := func(minRole string) func(http.Handler) http.Handler {
		return func(next http.Handler) http.Handler {
			return audit.Middleware(auditTrail, "standard",
				httpapi.RequireAuth(authenticator,
					httpapi.RequireActiveUser(directory,
						httpapi.RequireAuthContext(auth.AuthContextOperator,
							httpapi.RequireRole(minRole,
								audit.CaptureActor(next))))))
		}
	}
	handler.Register(mux, withFloor("operator"), withFloor("user"))

	// Deployment control plane: platform stats and tenant lifecycle.
	controlPlane := &operatorops.Handler{
		DB:   pool,
		CH:   chClient,
		Tx:   pool,
		Orgs: &orgs.Store{DB: pool},
	}
	controlPlane.Register(mux, withFloor("operator"))
}
