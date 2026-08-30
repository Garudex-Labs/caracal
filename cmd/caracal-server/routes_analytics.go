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
	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/execdash"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/identity"
	"github.com/garudex-labs/caracal/internal/insights"
	"github.com/garudex-labs/caracal/internal/insightsgen"
	"github.com/garudex-labs/caracal/internal/livewire"
	"github.com/garudex-labs/caracal/internal/logring"
	"github.com/garudex-labs/caracal/internal/overview"
	catalog "github.com/garudex-labs/caracal/internal/registry"
	"github.com/garudex-labs/caracal/internal/retention"
	"github.com/garudex-labs/caracal/internal/settings"
	"github.com/garudex-labs/caracal/internal/support"
)

// mountAnalytics wires the analytics surfaces: the GraphQL endpoint serving
// UI subscriptions over WebSocket plus the health query, and the overview
// counters. The socket is mounted without wrapping middleware so the
// connection can be hijacked.
func mountAnalytics(
	mux *http.ServeMux,
	redisClient redis.UniversalClient,
	pool *pgxpool.Pool,
	chClient *clickhouse.Client,
	authenticator *auth.Authenticator,
	projectResolver requestProjectResolver,
	directory *identity.Directory,
	auditTrail *audit.Logger,
	settingsStore *settings.Store,
	strategic *insightsgen.Client,
	logRing *logring.Ring,
) {
	handler := &livewire.Handler{
		Events:        &livewire.RedisSubscriber{Client: redisClient},
		Authenticator: authenticator,
		Directory:     directory,
		Projects:      projectResolver,
	}
	routes := handler.Routes()
	mux.Handle("/api/v1/graphql", routes)
	mux.Handle("/api/v1/graphql/", routes)

	overviewHandler := &overview.Handler{Store: &overview.Store{DB: pool, CH: chClient}}
	// Reads allow anonymous callers; the trends route enforces its own
	// admin floor inside the group.
	overviewChain := audit.Middleware(auditTrail, "standard",
		httpapi.OptionalAuthContext(authenticator, directory, auth.AuthContextTenant,
			audit.CaptureActor(overviewHandler.Routes())))
	mux.Handle("/api/v1/overview/", overviewChain)

	execHandler := &execdash.Handler{
		Store: &execdash.Store{DB: pool, CH: chClient}, Redis: redisClient,
		Strategic: strategic, Settings: settingsStore,
	}
	// Every endpoint in the group is operator-only.
	execChain := audit.Middleware(auditTrail, "operator",
		httpapi.RequireAuth(authenticator,
			httpapi.RequireActiveUser(directory,
				httpapi.RequireAuthContext(auth.AuthContextOperator,
					httpapi.RequireRole("operator",
						audit.CaptureActor(execHandler.Routes()))))))
	mux.Handle("/api/v1/exec/", execChain)

	// The stream needs the raw flusher, so the audit wrapper stays off
	// this group; access is still operator-only.
	logsChain := httpapi.RequireAuth(authenticator,
		httpapi.RequireActiveUser(directory,
			httpapi.RequireAuthContext(auth.AuthContextOperator,
				httpapi.RequireRole("operator",
					(&logring.Handler{Ring: logRing}).Routes()))))
	mux.Handle("/api/v1/operator/logs", logsChain)
	mux.Handle("/api/v1/operator/logs/", logsChain)
}

// mountRetention wires the retention administration group and starts the
// scheduled purge loop.
func mountRetention(
	ctx context.Context,
	mux *http.ServeMux,
	pool *pgxpool.Pool,
	chClient *clickhouse.Client,
	settingsStore *settings.Store,
	redisClient *redis.Client,
	authenticator *auth.Authenticator,
	directory *identity.Directory,
	auditTrail *audit.Logger,
) {
	store := &retention.Store{DB: pool, CH: chClient, Settings: settingsStore, Redis: redisClient}
	handler := &retention.Handler{Store: store}
	// Reads take the operator floor; the write and preview paths
	// keep that floor inside the group.
	chain := audit.Middleware(auditTrail, "operator",
		httpapi.RequireAuth(authenticator,
			httpapi.RequireActiveUser(directory,
				httpapi.RequireAuthContext(auth.AuthContextOperator,
					httpapi.RequireRole("operator",
						audit.CaptureActor(handler.Routes()))))))
	mux.Handle("/api/v1/operator/retention", chain)
	mux.Handle("/api/v1/operator/retention/", chain)

	purger := &retention.Purger{Store: store, Lock: alerts.RedisLock{Client: redisClient}}
	go purger.Run(ctx)
}

// mountSupport wires the diagnostic-collection endpoint used by support
// bundles; the whole group is operator-only.
func mountSupport(
	mux *http.ServeMux,
	pool *pgxpool.Pool,
	chClient *clickhouse.Client,
	settingsStore *settings.Store,
	redisClient *redis.Client,
	authenticator *auth.Authenticator,
	directory *identity.Directory,
	auditTrail *audit.Logger,
	logRing *logring.Ring,
	version, postgresURL, clickhouseURL, redisURL string,
) {
	handler := &support.Handler{
		DB: pool, CH: chClient, Redis: redisClient, Settings: settingsStore,
		Ring: logRing, Version: version,
		PostgresURL: postgresURL, ClickHouseURL: clickhouseURL, RedisURL: redisURL,
	}
	chain := audit.Middleware(auditTrail, "operator",
		httpapi.RequireAuth(authenticator,
			httpapi.RequireActiveUser(directory,
				httpapi.RequireAuthContext(auth.AuthContextOperator,
					httpapi.RequireRole("operator",
						audit.CaptureActor(handler.Routes()))))))
	mux.Handle("/api/v1/support/", chain)
}

// mountInsights wires the insight-report group: reads, deletions,
// generation, HTML export, and suggestion application, plus the background
// generation runner and its schedulers.
func mountInsights(
	ctx context.Context,
	mux *http.ServeMux,
	pool *pgxpool.Pool,
	chClient *clickhouse.Client,
	projectResolver requestProjectResolver,
	authenticator *auth.Authenticator,
	directory *identity.Directory,
	auditTrail *audit.Logger,
	insightCfg *insightsgen.Config,
	insightLLM *insightsgen.Client,
) {
	catalogStore := &catalog.Store{DB: pool}
	engine := &insightsgen.Engine{DB: pool, CH: chClient, Config: insightCfg, Catalog: catalogStore, LLM: insightLLM}
	genStore := &insightsgen.Store{DB: pool}
	service := insightsgen.NewService(engine, genStore, 2)
	service.Start(ctx)
	scheduler := &insightsgen.Scheduler{Service: service, Profiles: catalogStore}
	scheduler.Start(ctx)

	handler := &insights.Handler{
		Store:    &insights.Store{DB: pool, CH: chClient},
		Agents:   &agents.Store{DB: pool},
		Engine:   engine,
		Gen:      service,
		GenStore: genStore,
		Config:   insightCfg,
	}
	// Deletions and suggestion application raise the floor to administrator
	// inside the group.
	chain := audit.Middleware(auditTrail, "standard",
		httpapi.RequireAuth(authenticator,
			httpapi.RequireActiveUser(directory,
				httpapi.RequireAuthContext(auth.AuthContextTenant,
					httpapi.RequireRole("user",
						withProjectScope(projectResolver, false, audit.CaptureActor(handler.Routes())))))))
	mux.Handle("/api/v1/insights/", chain)

	// The agent-scoped report routes win over the broader agents-prefix
	// registrations by pattern specificity.
	agentChain := audit.Middleware(auditTrail, "standard",
		httpapi.RequireAuth(authenticator,
			httpapi.RequireActiveUser(directory,
				httpapi.RequireAuthContext(auth.AuthContextTenant,
					httpapi.RequireRole("user",
						withProjectScope(projectResolver, false, audit.CaptureActor(handler.AgentRoutes())))))))
	for _, pattern := range insights.AgentPatterns() {
		mux.Handle(pattern, agentChain)
	}
}
