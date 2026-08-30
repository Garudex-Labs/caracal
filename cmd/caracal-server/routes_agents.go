// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/garudex-labs/caracal/internal/agents"
	"github.com/garudex-labs/caracal/internal/alerts"
	"github.com/garudex-labs/caracal/internal/audit"
	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/registry"
	"github.com/garudex-labs/caracal/internal/resretention"
	"github.com/garudex-labs/caracal/internal/settings"
)

// mountAgents wires the agent read plane. The whole prefix requires
// authentication.
func mountAgents(
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
	handler := &agents.Handler{
		Store:    &agents.Store{DB: pool},
		Settings: settingsStore,
		Audit:    auditTrail,
		Registry: &registry.Store{DB: pool},
	}
	withAuth := func(next http.Handler) http.Handler {
		return audit.Middleware(auditTrail, "standard",
			httpapi.RequireAuth(authenticator,
				httpapi.RequireActiveUser(directory,
					httpapi.RequireAuthContext(auth.AuthContextTenant,
						withProjectScope(projectResolver, false, audit.CaptureActor(next))))))
	}
	withOptional := func(next http.Handler) http.Handler {
		return audit.Middleware(auditTrail, "standard",
			httpapi.OptionalAuthContext(authenticator, directory, auth.AuthContextTenant,
				withProjectScope(projectResolver, true, audit.CaptureActor(next))))
	}
	handler.Register(mux, withAuth, withOptional)
	purger := &resretention.Purger{Store: &resretention.Store{DB: pool}, Lock: alerts.RedisLock{Client: redisClient}}
	go purger.Run(ctx)
}
