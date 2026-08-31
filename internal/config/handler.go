// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package config serves the public configuration routes: version and
// endpoint discovery, branding, identity capabilities, and the harness
// catalog. Every route is anonymous by design; nothing here may expose
// secrets or per-user data.
package config

import (
	"encoding/base64"
	"net/http"
	"sort"
	"strings"

	"github.com/garudex-labs/caracal/internal/harness"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/settings"
)

const defaultFaviconPath = "/caracal_nobg_dark_mode.png"

// Handler serves the /api/v1/config route group.
type Handler struct {
	Settings settings.Reader
	Registry *harness.Registry
	Identity *IdentityClient
	Version  string

	ssoHealthLimiter rateLimiter
}

// Routes returns the config route group.
func (h *Handler) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/config/version", h.version)
	mux.HandleFunc("GET /api/v1/config/endpoints", h.endpoints)
	mux.HandleFunc("GET /api/v1/config/favicon", h.favicon)
	mux.HandleFunc("GET /api/v1/config/public", h.public)
	mux.HandleFunc("GET /api/v1/config/sso-health", h.ssoHealth)
	mux.HandleFunc("GET /api/v1/config/harnesses", h.harnesses)
	return mux
}

// nullable maps empty strings to JSON null.
func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// version reports the canonical server version and compatibility targets.
func (h *Handler) version(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	frontend := h.Settings.String(ctx, "misc.frontend_version", h.Version)
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"server_version":   h.Version,
		"max_cli_version":  nullable(h.Settings.String(ctx, "misc.max_cli_version", "")),
		"api_version":      nullable(h.Settings.String(ctx, "misc.api_version", "")),
		"frontend_version": frontend,
		// Deprecated: kept for backward compat with CLIs < 1.0.0. Will be removed in 1.2.0.
		"recommended_cli_version": h.Version,
	})
}

// endpoints derives the public service URLs from settings, falling back to
// the request context.
func (h *Handler) endpoints(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	publicURL := strings.TrimRight(h.Settings.String(ctx, "deployment.public_url", ""), "/")
	if publicURL == "" {
		scheme := r.Header.Get("X-Forwarded-Proto")
		if scheme == "" {
			scheme = "http"
		}
		if r.Host != "" {
			publicURL = scheme + "://" + r.Host
		}
	}
	if publicURL == "" {
		publicURL = "http://localhost:8080"
	}

	web := strings.TrimRight(h.Settings.String(ctx, "deployment.frontend_url", "http://localhost:8000"), "/")
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{"api": publicURL, "web": web})
}

// favicon serves the branding logo: inline for data URIs, a redirect for
// remote URLs, and the bundled icon otherwise.
func (h *Handler) favicon(w http.ResponseWriter, r *http.Request) {
	logo := h.Settings.String(r.Context(), "branding.logo", "")
	if header, encoded, found := strings.Cut(logo, ","); found && strings.HasPrefix(logo, "data:") {
		mimeType := strings.TrimPrefix(strings.SplitN(header, ";", 2)[0], "data:")
		if decoded, err := base64.StdEncoding.DecodeString(encoded); err == nil {
			w.Header().Set("Content-Type", mimeType)
			w.Header().Set("Cache-Control", "public, max-age=60")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(decoded)
			return
		}
	} else if strings.HasPrefix(logo, "http") {
		redirect(w, logo)
		return
	}
	redirect(w, defaultFaviconPath)
}

// redirect issues an empty-bodied temporary redirect.
func redirect(w http.ResponseWriter, location string) {
	w.Header().Set("Location", location)
	w.WriteHeader(http.StatusTemporaryRedirect)
}

// truthy mirrors JSON truthiness for capability flags.
func truthy(v any) bool {
	switch value := v.(type) {
	case bool:
		return value
	case string:
		return value != ""
	case float64:
		return value != 0
	case []any:
		return len(value) > 0
	case map[string]any:
		return len(value) > 0
	case nil:
		return false
	default:
		return true
	}
}

// public returns the anonymous frontend configuration.
func (h *Handler) public(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	authConfig := h.Identity.PublicConfig(ctx)
	enabledFeatures := []string{"all"}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		// Legacy compatibility: existing clients/deployments may still read these.
		"licensed":          true,
		"licensed_features": enabledFeatures,
		"auth":              authConfig,
		// False only when the identity service did not answer; the login UI
		// then shows an unavailable state instead of guessing at methods.
		"auth_available":            len(authConfig) > 0,
		"sso_enabled":               truthy(authConfig["sso"]),
		"google_sso_enabled":        truthy(authConfig["google"]),
		"github_sso_enabled":        truthy(authConfig["github"]),
		"sso_only":                  !truthy(authConfig["email_password"]),
		"self_registration_enabled": truthy(authConfig["email_password"]),
		"saml_enabled":              truthy(authConfig["sso"]),
		"dev_login_enabled":         truthy(authConfig["dev_login"]),
		"exec_dashboard_available":  true,
		"enabled_features":          enabledFeatures,
		"branding_logo":             nullable(h.Settings.String(ctx, "branding.logo", "")),
		"branding_app_name":         nullable(h.Settings.String(ctx, "branding.app_name", "")),
		"branding_wordmark":         nullable(h.Settings.String(ctx, "branding.wordmark", "")),
		// Whether organizations are addressed as subdomains ({org}.{base}). With
		// no base domain the deployment is single-host, so the UI keeps org
		// context on the current origin rather than crossing to a subdomain.
		"org_subdomains": h.Settings.String(ctx, "deployment.base_domain", "") != "",
	})
}

// ssoHealth reports identity-service reachability for the login page.
func (h *Handler) ssoHealth(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	limit := h.Settings.String(ctx, "security.rate_limit_sso_health", "10/minute")
	if allowed, detail := h.ssoHealthLimiter.allow(clientKey(r), limit); !allowed {
		httpapi.WriteJSON(w, http.StatusTooManyRequests, map[string]any{
			"error": "Rate limit exceeded: " + detail,
		})
		return
	}

	ok, latencyMS, errText := h.Identity.Health(ctx)
	capabilities := map[string]any{}
	if ok {
		capabilities = h.Identity.PublicConfig(ctx)
	}
	w.Header().Set("Cache-Control", "no-store")
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"identity_service": map[string]any{"ok": ok, "latency_ms": latencyMS, "error": nullable(errText)},
		"capabilities":     capabilities,
	})
}

// harnesses returns the canonical harness catalog, filtered by allowlist.
func (h *Handler) harnesses(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	allowlist := map[string]bool{}
	for _, name := range strings.Split(h.Settings.String(ctx, "misc.harness_allowlist", ""), ",") {
		name = strings.TrimSpace(name)
		if _, known := h.Registry.Spec(name); known {
			allowlist[name] = true
		}
	}

	harnesses := []map[string]any{}
	available := map[string]bool{}
	for _, name := range h.Registry.Names() {
		if len(allowlist) > 0 && !allowlist[name] {
			continue
		}
		spec, _ := h.Registry.Spec(name)
		capabilities := make([]string, 0, len(spec.Capabilities))
		for _, capability := range spec.Capabilities {
			capabilities = append(capabilities, string(capability))
		}
		sort.Strings(capabilities)
		models, err := harness.SupportedModelIDs(name)
		if err != nil {
			httpapi.WriteJSON(w, http.StatusInternalServerError, map[string]any{"detail": "harness catalog unavailable"})
			return
		}
		if models == nil {
			models = []string{}
		}
		harnesses = append(harnesses, map[string]any{
			"name":             name,
			"display_name":     spec.DisplayName,
			"capabilities":     capabilities,
			"supported_models": models,
			"skill_support":    spec.SkillSupport,
			"skill_mechanism":  spec.SkillMechanism,
			"hook_support":     spec.HookSupport,
			"hook_mechanism":   spec.HookMechanism,
			"prompt_support":   spec.PromptSupport(),
			"prompt_mechanism": spec.PromptMechanism(),
			"agent_support":    spec.AgentSupport,
			"agent_mechanism":  spec.AgentMechanism,
			"agent_multi":      spec.AgentMulti,
		})
		available[name] = true
	}

	defaultHarness := h.Settings.String(ctx, "misc.default_harness", "")
	if !available[defaultHarness] {
		defaultHarness = ""
	}
	w.Header().Set("Cache-Control", "no-store")
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"harnesses":       harnesses,
		"default_harness": nullable(defaultHarness),
	})
}
