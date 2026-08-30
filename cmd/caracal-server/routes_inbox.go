// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/garudex-labs/caracal/internal/audit"
	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/redis/go-redis/v9"

	"github.com/garudex-labs/caracal/internal/alerts"
	"github.com/garudex-labs/caracal/internal/inbox"
	"github.com/garudex-labs/caracal/internal/settings"
)

func mountInbox(
	ctx context.Context,
	mux *http.ServeMux,
	pool *pgxpool.Pool,
	redisClient *redis.Client,
	settingsStore *settings.Store,
	projectResolver requestProjectResolver,
	authenticator *auth.Authenticator,
	directory httpapi.UserGate,
	auditTrail *audit.Logger,
) {
	handler := &inbox.Handler{Store: &inbox.Store{DB: pool}}
	chain := audit.Middleware(auditTrail, "standard",
		httpapi.RequireAuth(authenticator,
			httpapi.RequireActiveUser(directory,
				httpapi.RequireAuthContext(auth.AuthContextTenant,
					withProjectScope(projectResolver, false, audit.CaptureActor(handler.Routes()))))))
	mux.Handle("/api/v1/inbox", chain)
	mux.Handle("/api/v1/inbox/", chain)

	purger := &inbox.Purger{DB: pool, Settings: settingsStore,
		Lock: alerts.RedisLock{Client: redisClient}}
	go purger.Run(ctx)
}
