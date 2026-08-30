// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// caracal-server serves the high-throughput route groups of the Caracal API
// behind the load balancer, starting with the telemetry ingest pipeline.
// Route groups are enabled individually via the load balancer configuration.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"

	"github.com/garudex-labs/caracal/internal/agents"
	"github.com/garudex-labs/caracal/internal/alerts"
	"github.com/garudex-labs/caracal/internal/audit"
	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/config"
	"github.com/garudex-labs/caracal/internal/dbinit"
	"github.com/garudex-labs/caracal/internal/events"
	"github.com/garudex-labs/caracal/internal/fernet"
	"github.com/garudex-labs/caracal/internal/harness"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/identity"
	"github.com/garudex-labs/caracal/internal/ingest"
	"github.com/garudex-labs/caracal/internal/insightsgen"
	"github.com/garudex-labs/caracal/internal/layers"
	"github.com/garudex-labs/caracal/internal/logring"
	"github.com/garudex-labs/caracal/internal/orgs"
	catalog "github.com/garudex-labs/caracal/internal/registry"
	"github.com/garudex-labs/caracal/internal/sessions"
	"github.com/garudex-labs/caracal/internal/settings"
	"github.com/garudex-labs/caracal/internal/telemetry"
)

// serverVersion is stamped at build time from the repository's canonical
// version; "dev" identifies ad-hoc builds.
var serverVersion = "dev"

func main() {
	if len(os.Args) > 1 && os.Args[1] == "init" {
		if err := runInit(); err != nil {
			slog.Error("database initialization failed", "error", err)
			os.Exit(1)
		}
		return
	}
	if err := run(); err != nil {
		slog.Error("server exited", "error", err)
		os.Exit(1)
	}
}

// runInit applies pending database migrations and exits; deployments run it
// as the init container before the API starts.
func runInit() error {
	postgresURL := configValue("CARACAL_POSTGRES_URL")
	if postgresURL == "" {
		postgresURL = configValue("DATABASE_URL")
	}
	clickhouseURL := configValue("CARACAL_CLICKHOUSE_URL")
	if clickhouseURL == "" {
		clickhouseURL = configValue("CLICKHOUSE_URL")
	}
	if postgresURL == "" && clickhouseURL == "" {
		return errors.New("no database configured: set CARACAL_POSTGRES_URL and CARACAL_CLICKHOUSE_URL")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	return dbinit.Run(ctx, postgresURL, clickhouseURL)
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

// configValue reads a setting from the environment, falling back to the
// secret-file indirection used by packaged deployments (NAME_FILE holds a
// path whose contents are the value).
func configValue(name string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	if path := os.Getenv(name + "_FILE"); path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			slog.Error("config secret file unreadable", "name", name, "error", err)
			return ""
		}
		return strings.TrimSpace(string(data))
	}
	return ""
}

func run() error {
	addr := os.Getenv("CARACAL_GO_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	// Capture every record for the administrator log window before any
	// component logs. The tee wraps an explicit handler: deriving from
	// slog.Default would loop through the log-package bridge.
	logRing := &logring.Ring{}
	slog.SetDefault(slog.New(&logring.TeeHandler{
		Next: slog.NewTextHandler(os.Stderr, nil),
		Ring: logRing,
	}))

	registry := harness.MustLoad()
	slog.Info("harness registry loaded", "harnesses", len(registry.Names()))

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintln(w, `{"status":"ok"}`)
	})
	// Runtime and process metrics; the proxy layer blocks external access.
	mux.Handle("GET /metrics", promhttp.Handler())

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cleanup, err := mountRoutes(ctx, mux, registry, logRing)
	if err != nil {
		return err
	}
	defer cleanup()

	server := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       2 * time.Minute,
		WriteTimeout:      2 * time.Minute,
		IdleTimeout:       2 * time.Minute,
	}

	errCh := make(chan error, 1)
	go func() {
		slog.Info("listening", "addr", addr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return server.Shutdown(shutdownCtx)
}

// mountRoutes wires the served route groups when the required backing
// services are configured; without them the binary serves health checks only.
// The returned cleanup drains the audit trail on shutdown.
func mountRoutes(ctx context.Context, mux *http.ServeMux, registry *harness.Registry, logRing *logring.Ring) (func(), error) {
	clickhouseURL := configValue("CARACAL_CLICKHOUSE_URL")
	redisURL := configValue("CARACAL_REDIS_URL")
	jwksURL := configValue("CARACAL_JWKS_URL")
	// Accept driver-qualified postgres URLs so one shared secret serves
	// every service that speaks to the same database.
	postgresURL := strings.Replace(configValue("CARACAL_POSTGRES_URL"), "postgresql+asyncpg://", "postgresql://", 1)
	if clickhouseURL == "" || redisURL == "" || jwksURL == "" || postgresURL == "" {
		slog.Info("api routes disabled",
			"clickhouse", clickhouseURL != "", "redis", redisURL != "",
			"jwks", jwksURL != "", "postgres", postgresURL != "")
		return func() {}, nil
	}

	chClient, err := clickhouse.New(clickhouseURL, nil)
	if err != nil {
		return nil, fmt.Errorf("configure clickhouse: %w", err)
	}
	redisOpts, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, fmt.Errorf("configure redis: %w", err)
	}
	redisClient := redis.NewClient(redisOpts)
	pool, err := pgxpool.New(context.Background(), postgresURL)
	if err != nil {
		return nil, fmt.Errorf("configure postgres: %w", err)
	}

	settingsStore := &settings.Store{DB: pool}
	health := readiness(pool, chClient, redisClient)
	mux.HandleFunc("GET /health", health)
	mux.HandleFunc("GET /readyz", health)
	authenticator := auth.New(
		auth.NewKeySet(jwksURL, nil),
		envOr("CARACAL_JWT_AUDIENCE", "caracal-api"),
		os.Getenv("CARACAL_JWT_ISSUER"),
	)
	directory := &identity.Directory{DB: pool}
	projectResolver := &orgs.AmbientProjectResolver{
		Store:    &orgs.Store{DB: pool},
		Settings: settingsStore,
	}
	handler := &ingest.Handler{
		Service: &ingest.Service{
			Store:    &ingest.CHStore{Client: chClient},
			Registry: registry,
			Agents:   &ingest.AgentResolver{DB: pool, Cache: ingest.RedisCache{Client: redisClient}},
		},
		Publish:  &events.RedisPublisher{Client: redisClient},
		Projects: projectResolver,
	}
	auditTrail := audit.NewLogger(chClient)
	mux.Handle("/api/v1/ingest/", audit.Middleware(auditTrail, "phi_adjacent",
		httpapi.RequireAuth(authenticator,
			httpapi.RequireActiveUser(directory,
				httpapi.RequireAuthContext(auth.AuthContextTenant,
					httpapi.RequireRole("user",
						audit.CaptureActor(handler.Routes())))))))
	slog.Info("ingest routes enabled")

	sessionsHandler := &sessions.Handler{
		Store:    &sessions.CHStore{Client: chClient},
		Dir:      &sessions.Directory{DB: pool},
		Settings: settingsStore,
		Registry: registry,
		Binder:   sessions.RedisBinder{Client: redisClient},
		Projects: projectResolver,
	}
	// Role floors live inside the route group (stats is admin-only).
	sessionsChain := audit.Middleware(auditTrail, "phi_adjacent",
		httpapi.RequireAuth(authenticator,
			httpapi.RequireActiveUser(directory,
				httpapi.RequireAuthContext(auth.AuthContextTenant,
					audit.CaptureActor(sessionsHandler.Routes())))))
	mux.Handle("/api/v1/sessions", sessionsChain)
	mux.Handle("/api/v1/sessions/", sessionsChain)
	operatorSessionsChain := audit.Middleware(auditTrail, "operator",
		httpapi.RequireAuth(authenticator,
			httpapi.RequireActiveUser(directory,
				httpapi.RequireAuthContext(auth.AuthContextOperator,
					httpapi.RequireRole("operator",
						audit.CaptureActor(sessionsHandler.OperatorRoutes()))))))
	mux.Handle("/api/v1/operator/sessions/", operatorSessionsChain)
	slog.Info("sessions routes enabled")

	telemetryHandler := &telemetry.Handler{Activity: telemetry.CHActivity{Client: chClient}}
	telemetryRoutes := httpapi.RequireAuth(authenticator,
		httpapi.RequireActiveUser(directory,
			audit.CaptureActor(telemetryHandler.Routes())))
	mux.Handle("/api/v1/telemetry/", audit.Middleware(auditTrail, "phi_adjacent", telemetryRoutes))
	mux.Handle("/api/v1/dashboard/", audit.Middleware(auditTrail, "standard", telemetryRoutes))
	slog.Info("telemetry routes enabled")

	cliEvents := &audit.CLIEvents{CH: chClient}
	mux.Handle("/api/v1/audit/", audit.Middleware(auditTrail, "standard",
		httpapi.RequireAuth(authenticator,
			httpapi.RequireActiveUser(directory,
				httpapi.RequireAuthContext(auth.AuthContextTenant,
					audit.CaptureActor(cliEvents.Routes()))))))
	trail := &audit.Trail{CH: chClient, PG: pool}
	mux.Handle("/api/v1/operator/audit-log", audit.Middleware(auditTrail, "operator",
		httpapi.RequireAuth(authenticator,
			httpapi.RequireActiveUser(directory,
				httpapi.RequireAuthContext(auth.AuthContextOperator,
					audit.CaptureActor(trail.Routes()))))))
	mux.Handle("/api/v1/operator/audit-log/", audit.Middleware(auditTrail, "operator",
		httpapi.RequireAuth(authenticator,
			httpapi.RequireActiveUser(directory,
				httpapi.RequireAuthContext(auth.AuthContextOperator,
					audit.CaptureActor(trail.Routes()))))))
	slog.Info("audit routes enabled")

	alertsStore := &alerts.Store{DB: pool}
	alertsDeliverer := &alerts.Deliverer{CH: chClient}
	alertsHandler := &alerts.Handler{
		Store:   alertsStore,
		Webhook: alertsDeliverer,
	}
	// Role floors live inside the route group (secret management is admin-only).
	alertsChain := audit.Middleware(auditTrail, "standard",
		httpapi.RequireAuth(authenticator,
			httpapi.RequireActiveUser(directory,
				httpapi.RequireAuthContext(auth.AuthContextTenant,
					audit.CaptureActor(alertsHandler.Routes())))))
	mux.Handle("/api/v1/alerts", alertsChain)
	mux.Handle("/api/v1/alerts/", alertsChain)
	slog.Info("alert routes enabled")

	evaluator := &alerts.Evaluator{
		Store:   alertsStore,
		CH:      chClient,
		Webhook: alertsDeliverer,
		Lock:    alerts.RedisLock{Client: redisClient},
	}
	go evaluator.Run(ctx)
	slog.Info("alert evaluation started")

	maintainer := &clickhouse.Maintainer{Client: chClient}
	go maintainer.Run(ctx)
	slog.Info("analytics store maintenance started")

	configHandler := &config.Handler{
		Settings: settingsStore,
		Registry: registry,
		Identity: &config.IdentityClient{BaseURL: envOr("CARACAL_AUTH_SERVICE_URL", "http://localhost:8001")},
		Version:  serverVersion,
	}
	// Anonymous by design: version, endpoint, branding, and capability
	// discovery all serve the login page and unauthenticated CLIs.
	mux.Handle("/api/v1/config/", audit.Middleware(auditTrail, "low", configHandler.Routes()))
	slog.Info("config routes enabled")

	insightCfg := &insightsgen.Config{Settings: settingsStore, SecretKey: fernet.DeriveKey(os.Getenv("SECRET_KEY"))}
	insightLLM := &insightsgen.Client{Config: insightCfg}
	catalogMirror := &catalog.Mirror{Settings: settingsStore}
	catalogHandler := &catalog.Handler{Store: &catalog.Store{DB: pool, CH: chClient}, ValidHarnesses: registry.Names(), Mirror: catalogMirror}
	// Reads allow anonymous callers; mutations authorize per route.
	catalogHandler.Register(mux, func(next http.Handler) http.Handler {
		return audit.Middleware(auditTrail, "standard",
			httpapi.OptionalAuthContext(authenticator, directory, auth.AuthContextTenant,
				withProjectScope(projectResolver, true, audit.CaptureActor(next))))
	})
	sourceSyncer := &catalog.SourceSyncer{DB: pool, Mirror: catalogMirror}
	go sourceSyncer.Run(ctx)
	slog.Info("registry read routes enabled")

	mountAgents(ctx, mux, pool, redisClient, settingsStore, projectResolver, authenticator, directory, auditTrail)
	slog.Info("agent read routes enabled")

	layersHandler := &layers.Handler{CH: chClient, Agents: &agents.Store{DB: pool}}
	layersHandler.Register(mux, func(next http.Handler) http.Handler {
		return audit.Middleware(auditTrail, "standard",
			httpapi.RequireAuth(authenticator,
				httpapi.RequireActiveUser(directory,
					httpapi.RequireAuthContext(auth.AuthContextTenant,
						withProjectScope(projectResolver, false, audit.CaptureActor(next))))))
	})
	slog.Info("layer snapshot routes enabled")

	mountAnalytics(mux, redisClient, pool, chClient, authenticator, projectResolver, directory, auditTrail, settingsStore, insightLLM, logRing)
	slog.Info("live event routes enabled")

	mountRetention(ctx, mux, pool, chClient, settingsStore, redisClient, authenticator, directory, auditTrail)
	slog.Info("retention routes enabled")

	mountSupport(mux, pool, chClient, settingsStore, redisClient, authenticator, directory, auditTrail,
		logRing, serverVersion, postgresURL, clickhouseURL, redisURL)
	slog.Info("support routes enabled")

	mountInsights(ctx, mux, pool, chClient, projectResolver, authenticator, directory, auditTrail, insightCfg, insightLLM)
	slog.Info("insight report routes enabled")

	mountAccounts(mux, pool, chClient, settingsStore, authenticator, directory, auditTrail)
	slog.Info("account profile routes enabled")

	mountAdminOps(mux, pool, chClient, redisClient, settingsStore, authenticator, directory, auditTrail, serverVersion, jwksURL)
	slog.Info("admin operations routes enabled")

	mountAdminMigrate(mux, pool, chClient, settingsStore, authenticator, directory, auditTrail, postgresURL, clickhouseURL)
	slog.Info("data migration routes enabled")

	mountOrgs(mux, pool, chClient, settingsStore, authenticator, directory, auditTrail)
	slog.Info("organization read routes enabled")

	mountOnboarding(mux, pool, authenticator, directory, auditTrail)
	slog.Info("onboarding routes enabled")

	mountInbox(ctx, mux, pool, redisClient, settingsStore, projectResolver, authenticator, directory, auditTrail)
	slog.Info("inbox routes enabled")
	return auditTrail.Close, nil
}
