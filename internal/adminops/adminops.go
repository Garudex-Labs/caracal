// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package adminops serves deployment administration: dynamic settings,
// security policy toggles, the security event log, and cache controls.
package adminops

import (
	"context"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/redis/go-redis/v9"

	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/settings"
)

// Redacted replaces sensitive values in every read path.
const Redacted = "**REDACTED**"

const restartPendingKey = "_system.restart_required"

const settingsCachePrefix = "settings:"

// PG is the pool surface this package needs.
type PG interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Handler carries the administration dependencies.
type Handler struct {
	DB        PG
	CH        *clickhouse.Client
	Redis     *redis.Client
	Settings  *settings.Store
	SecretKey []byte
	RawSecret string
	// Version identifies this build on the status document.
	Version string
	// JWKSURL is the identity-service key endpoint probed for status.
	JWKSURL string
	// AuthInternalSecret mirrors the identity-service bridge secret; empty
	// means the bridge is unconfigured.
	AuthInternalSecret string
	// Development permits loopback deployment URLs only when the process was
	// explicitly started in development mode.
	Development bool
	// HTTP performs identity probes; nil uses a bounded default.
	HTTP *http.Client
	// external holds file-backed settings resolved at startup.
	external map[string]string

	// status cache: probing every page load would turn the status endpoint
	// into load on the infrastructure being observed.
	statusMu  sync.Mutex
	statusDoc *statusDocument
	statusAt  time.Time
}

// externalEnvImports maps env names to the setting key they manage.
var externalEnvImports = map[string]string{
	"INSIGHTS_API_KEY": "insights.api_key",
}

// LoadExternal resolves file-backed settings (NAME_FILE env) into memory.
func (h *Handler) LoadExternal() {
	h.external = map[string]string{}
	for envKey, settingKey := range externalEnvImports {
		path := os.Getenv(envKey + "_FILE")
		if path == "" {
			continue
		}
		raw, err := os.ReadFile(path)
		if err != nil || len(raw) > 64*1024 {
			continue
		}
		text := string(raw)
		if strings.HasSuffix(text, "\r\n") {
			text = text[:len(text)-2]
		} else if strings.HasSuffix(text, "\n") || strings.HasSuffix(text, "\r") {
			text = text[:len(text)-1]
		}
		h.external[settingKey] = text
	}
}

func (h *Handler) isExternallyManaged(key string) bool {
	_, ok := h.external[key]
	return ok
}

// defaultEntry preserves declaration order; the schema and section key
// lists depend on it.
type defaultEntry struct {
	key   string
	value any
}

var defaults = []defaultEntry{
	{"insights.api_key", ""},
	{"insights.api_base", ""},
	{"insights.api_version", ""},
	{"insights.model_sections", ""},
	{"insights.model_synthesis", ""},
	{"insights.model_facets", ""},
	{"insights.batch_enabled", "true"},
	{"insights.batch_period_days", "14"},
	{"insights.min_sessions", "5"},
	{"insights.facet_max_calls", "100"},
	{"insights.facet_concurrency", "25"},
	{"insights.registry_match_enabled", "true"},
	{"insights.registry_match_per_type", "6"},
	{"insights.registry_match_max_items", "24"},
	{"deployment.frontend_url", "http://localhost:8000"},
	{"deployment.public_url", ""},
	{"deployment.cors_origins", "http://localhost:8000"},
	{"deployment.base_domain", ""},
	{"danger.purge_traces_insights", ""},
	{"security.allow_internal_git_urls", "false"},
	{"security.allow_draft_install", "false"},
	{"security.trace_privacy", "false"},
	{"registry.registered_agents_only", "false"},
	{"retention.enabled", "false"},
	{"retention.trace_days", ""},
	{"retention.score_days", ""},
	{"retention.max_trace_count", ""},
	{"security.trusted_proxy_ips", "172.16.0.0/12,10.0.0.0/8,192.168.0.0/16,127.0.0.1"},
	{"resource.db_pool_size", "10"},
	{"resource.db_max_overflow", "20"},
	{"resource.redis_max_connections", "50"},
	{"resource.redis_socket_timeout", "2.0"},
	{"resource.clickhouse_max_connections", "20"},
	{"resource.clickhouse_max_keepalive", "10"},
	{"resource.clickhouse_timeout", "10.0"},
	{"data.retention_days", "90"},
	{"inbox.retention_days", "90"},
	{"data.cache_ttl_default", "30"},
	{"data.cache_ttl_dashboard", "60"},
	{"observability.log_level", "INFO"},
	{"observability.log_format", "json"},
	{"observability.enable_openapi", "false"},
	{"observability.enable_metrics", "false"},
	{"observability.grafana_url", ""},
	{"observability.prometheus_url", ""},
	{"misc.harness_allowlist", ""},
	{"misc.default_harness", ""},
	{"misc.git_mirror_base_path", ""},
}

func defaultFor(key string) (any, bool) {
	for _, e := range defaults {
		if e.key == key {
			return e.value, true
		}
	}
	return nil, false
}

func defaultKeys(prefixes []string) []string {
	out := []string{}
	for _, e := range defaults {
		for _, p := range prefixes {
			if strings.HasPrefix(e.key, p) {
				out = append(out, e.key)
				break
			}
		}
	}
	return out
}

var sensitiveKeys = map[string]bool{"insights.api_key": true}

var restartRequiredKeys = map[string]bool{
	"data.cache_ttl_default":       true,
	"data.cache_ttl_dashboard":     true,
	"observability.log_format":     true,
	"observability.enable_openapi": true,
	"observability.enable_metrics": true,
	"misc.git_mirror_base_path":    true,
}

var labelReplacer = strings.NewReplacer(
	"Api", "API", "Url", "URL", "Sso", "SSO", "Oauth", "OAuth", "Jwt", "JWT",
	"Idp", "IdP", "Jit", "JIT", "Slo", "SLO", "Acs", "ACS", "X509", "X.509",
	"Sp ", "SP ", "Db ", "DB ", "Ttl", "TTL", " Id", " ID",
)

func settingLabel(key string) string {
	parts := strings.Split(key[strings.LastIndex(key, ".")+1:], "_")
	for i, p := range parts {
		if p != "" {
			parts[i] = strings.ToUpper(p[:1]) + p[1:]
		}
	}
	return labelReplacer.Replace(strings.Join(parts, " "))
}

type section struct {
	id, title, description, icon string
	danger                       bool
	prefixes                     []string
}

var sections = []section{
	{"insights", "AI Engine",
		"Configure the shared LLM provider, model routing, and batch policy for deployment-managed report generation.",
		"sparkles", false, []string{"insights."}},
	{"danger", "Danger Zone",
		"Destructive maintenance actions. Use only when you intentionally want to purge stored data.",
		"alert-triangle", true, []string{"danger."}},
	{"deployment", "Deployment",
		"Core deployment configuration. Changes may affect authentication and access. Proceed with caution.",
		"server", true, []string{"deployment."}},
	{"security", "Security",
		"Security policies and rate limiting. Misconfiguration can expose the instance to attacks.",
		"shield", true, []string{"security."}},
	{"resource", "Resource Tuning",
		"Connection pool sizes and query limits. Changes take effect on next connection. May require restart for pool sizes.",
		"database", false, []string{"resource."}},
	{"data", "Data & Retention",
		"Deployment-wide retention policies and cache TTLs.",
		"hard-drive", false, []string{"data.", "retention.", "inbox."}},
	{"registry", "Registry",
		"Deployment-wide registry policy.",
		"package", false, []string{"registry."}},
	{"observability", "Observability",
		"Logging and metrics configuration.",
		"activity", false, []string{"observability."}},
	{"misc", "Miscellaneous",
		"Other system settings.",
		"settings", false, []string{"misc."}},
}

func (h *Handler) schema() []map[string]any {
	out := []map[string]any{}
	for _, s := range sections {
		items := []map[string]any{}
		for _, key := range defaultKeys(s.prefixes) {
			def, _ := defaultFor(key)
			items = append(items, map[string]any{
				"key":                   key,
				"label":                 settingLabel(key),
				"subtitle":              "",
				"default":               def,
				"requires_feature":      nil,
				"restart_required":      restartRequiredKeys[key],
				"is_externally_managed": h.isExternallyManaged(key),
			})
		}
		doc := map[string]any{
			"id": s.id, "title": s.title, "description": s.description,
			"icon": s.icon, "keys": defaultKeys(s.prefixes), "settings": items,
		}
		if s.danger {
			doc["danger"] = true
		}
		out = append(out, doc)
	}
	return out
}

// actor is the authenticated admin resolved from the request claims.
type actor struct {
	ID    uuid.UUID
	Email string
	Role  string
}

func (h *Handler) caller(w http.ResponseWriter, r *http.Request) (*actor, bool) {
	claims, ok := httpapi.ClaimsFrom(r.Context())
	if !ok {
		httpapi.WriteError(w, http.StatusUnauthorized, "Missing credentials")
		return nil, false
	}
	var a actor
	a.ID = claims.UserID
	err := h.DB.QueryRow(r.Context(), `SELECT email, role FROM users WHERE id = $1`, claims.UserID).
		Scan(&a.Email, &a.Role)
	if err != nil {
		httpapi.WriteError(w, http.StatusUnauthorized, "Unknown user")
		return nil, false
	}
	return &a, true
}

func (h *Handler) emitEvent(ctx context.Context, a *actor, eventType, severity, targetID, targetType string, detail any) {
	if h.CH == nil {
		return
	}
	_ = h.CH.InsertJSONEachRow(ctx, "INSERT INTO security_events FORMAT JSONEachRow", []any{
		map[string]any{
			"event_id": uuid.NewString(), "timestamp": time.Now().UTC().Format("2006-01-02 15:04:05.000000"),
			"event_type": eventType, "severity": severity, "actor_id": a.ID.String(),
			"actor_email": a.Email, "actor_role": a.Role, "target_id": targetID,
			"target_type": targetType, "outcome": "success",
			"source_ip": nil, "user_agent": nil, "detail": detail,
		},
	})
}

// invalidateSetting clears the shared Redis cache entry and this process's
// own settings cache so both backends observe the write.
func (h *Handler) invalidateSetting(ctx context.Context, key string) {
	if h.Redis != nil {
		_ = h.Redis.Del(ctx, settingsCachePrefix+key).Err()
	}
	if h.Settings != nil {
		h.Settings.Invalidate(key)
	}
}

func internalErr(w http.ResponseWriter) {
	httpapi.WriteError(w, http.StatusInternalServerError, "Internal error")
}
