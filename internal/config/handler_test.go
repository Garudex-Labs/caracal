// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package config

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/garudex-labs/caracal/internal/harness"
)

type fakeReader map[string]string

func (f fakeReader) String(_ context.Context, key, fallback string) string {
	if v, ok := f[key]; ok && v != "" {
		return v
	}
	return fallback
}

func (f fakeReader) Bool(_ context.Context, _ string, fallback bool) bool { return fallback }
func (f fakeReader) Int(_ context.Context, _ string, fallback int) int    { return fallback }

func newHandler(t *testing.T, cfg fakeReader, identityURL string) *Handler {
	t.Helper()
	return &Handler{
		Settings: cfg,
		Registry: harness.MustLoad(),
		Identity: &IdentityClient{BaseURL: identityURL},
		Version:  "1.0.0",
	}
}

func do(t *testing.T, h *Handler, path string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)
	body := map[string]any{}
	if strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") {
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("parse body: %v: %s", err, rec.Body.String())
		}
	}
	return rec, body
}

func TestVersionDefaults(t *testing.T) {
	h := newHandler(t, fakeReader{}, "http://identity.invalid")
	rec, body := do(t, h, "/api/v1/config/version")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if body["server_version"] != "1.0.0" || body["recommended_cli_version"] != "1.0.0" {
		t.Fatalf("version fields = %v", body)
	}
	if body["max_cli_version"] != nil || body["api_version"] != nil {
		t.Fatalf("expected null compat fields, got %v", body)
	}
	if body["frontend_version"] != "1.0.0" {
		t.Fatalf("frontend_version = %v", body["frontend_version"])
	}
}

func TestVersionOverrides(t *testing.T) {
	h := newHandler(t, fakeReader{"misc.max_cli_version": "2.0.0", "misc.frontend_version": "1.5.0"}, "http://identity.invalid")
	_, body := do(t, h, "/api/v1/config/version")
	if body["max_cli_version"] != "2.0.0" || body["frontend_version"] != "1.5.0" {
		t.Fatalf("overrides ignored: %v", body)
	}
}

func TestEndpointsFromSettings(t *testing.T) {
	h := newHandler(t, fakeReader{
		"deployment.public_url":   "https://caracal.example.com/",
		"deployment.frontend_url": "https://app.example.com/",
	}, "http://identity.invalid")
	_, body := do(t, h, "/api/v1/config/endpoints")
	if body["api"] != "https://caracal.example.com" || body["web"] != "https://app.example.com" {
		t.Fatalf("endpoints = %v", body)
	}
}

func TestEndpointsDerived(t *testing.T) {
	h := newHandler(t, fakeReader{"deployment.public_url": "https://caracal.example.com"}, "http://identity.invalid")
	_, body := do(t, h, "/api/v1/config/endpoints")
	if body["web"] != "http://localhost:8000" {
		t.Fatalf("web = %v", body["web"])
	}
}

func TestEndpointsRequestFallback(t *testing.T) {
	h := newHandler(t, fakeReader{}, "http://identity.invalid")
	req := httptest.NewRequest(http.MethodGet, "http://lb.internal:8080/api/v1/config/endpoints", nil)
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)
	body := map[string]any{}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["api"] != "http://lb.internal:8080" {
		t.Fatalf("api = %v", body["api"])
	}
	if body["web"] != "http://localhost:8000" {
		t.Fatalf("web = %v", body["web"])
	}
}

func TestFaviconDataURI(t *testing.T) {
	h := newHandler(t, fakeReader{"branding.logo": "data:image/png;base64,aGVsbG8="}, "http://identity.invalid")
	rec, _ := do(t, h, "/api/v1/config/favicon")
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("code=%d type=%s", rec.Code, rec.Header().Get("Content-Type"))
	}
	if rec.Body.String() != "hello" {
		t.Fatalf("body = %q", rec.Body.String())
	}
	if rec.Header().Get("Cache-Control") != "public, max-age=60" {
		t.Fatalf("cache = %q", rec.Header().Get("Cache-Control"))
	}
}

func TestFaviconRemoteAndDefault(t *testing.T) {
	h := newHandler(t, fakeReader{"branding.logo": "https://cdn.example.com/logo.png"}, "http://identity.invalid")
	rec, _ := do(t, h, "/api/v1/config/favicon")
	if rec.Code != http.StatusTemporaryRedirect || rec.Header().Get("Location") != "https://cdn.example.com/logo.png" {
		t.Fatalf("code=%d loc=%s", rec.Code, rec.Header().Get("Location"))
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("redirect body should be empty, got %q", rec.Body.String())
	}

	h = newHandler(t, fakeReader{"branding.logo": "data:image/png;base64,!!!"}, "http://identity.invalid")
	rec, _ = do(t, h, "/api/v1/config/favicon")
	if rec.Code != http.StatusTemporaryRedirect || rec.Header().Get("Location") != defaultFaviconPath {
		t.Fatalf("bad data URI should fall back: code=%d loc=%s", rec.Code, rec.Header().Get("Location"))
	}
}

func TestPublicCapabilities(t *testing.T) {
	identity := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/auth/public-config" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"email_password": true, "sso": false, "google": true, "github": false, "dev_login": false}`))
	}))
	defer identity.Close()

	h := newHandler(t, fakeReader{"branding.app_name": "Acme"}, identity.URL)
	_, body := do(t, h, "/api/v1/config/public")
	checks := map[string]any{
		"licensed":                  true,
		"auth_available":            true,
		"sso_enabled":               false,
		"google_sso_enabled":        true,
		"github_sso_enabled":        false,
		"sso_only":                  false,
		"self_registration_enabled": true,
		"saml_enabled":              false,
		"dev_login_enabled":         false,
		"exec_dashboard_available":  true,
		"branding_app_name":         "Acme",
		"org_subdomains":            false,
	}
	for key, want := range checks {
		if body[key] != want {
			t.Errorf("%s = %v, want %v", key, body[key], want)
		}
	}
	if body["branding_logo"] != nil {
		t.Errorf("branding_logo = %v, want null", body["branding_logo"])
	}
}

func TestPublicIdentityDown(t *testing.T) {
	h := newHandler(t, fakeReader{}, "http://127.0.0.1:1")
	_, body := do(t, h, "/api/v1/config/public")
	if body["sso_only"] != true || body["self_registration_enabled"] != false {
		t.Fatalf("down identity should read as no email_password: %v", body)
	}
	if body["auth_available"] != false {
		t.Fatalf("auth_available = %v, want false when identity is down", body["auth_available"])
	}
	auth, ok := body["auth"].(map[string]any)
	if !ok || len(auth) != 0 {
		t.Fatalf("auth = %v, want empty object", body["auth"])
	}
}

func TestSSOHealth(t *testing.T) {
	identity := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/healthz":
			w.WriteHeader(http.StatusOK)
		case "/api/auth/public-config":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"sso": true}`))
		}
	}))
	defer identity.Close()

	h := newHandler(t, fakeReader{}, identity.URL)
	rec, body := do(t, h, "/api/v1/config/sso-health")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	service := body["identity_service"].(map[string]any)
	if service["ok"] != true || service["error"] != nil {
		t.Fatalf("identity_service = %v", service)
	}
	if body["capabilities"].(map[string]any)["sso"] != true {
		t.Fatalf("capabilities = %v", body["capabilities"])
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("cache = %q", rec.Header().Get("Cache-Control"))
	}
}

func TestSSOHealthRateLimit(t *testing.T) {
	h := newHandler(t, fakeReader{"security.rate_limit_sso_health": "2/minute"}, "http://127.0.0.1:1")
	for range 2 {
		rec, _ := do(t, h, "/api/v1/config/sso-health")
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d", rec.Code)
		}
	}
	rec, body := do(t, h, "/api/v1/config/sso-health")
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rec.Code)
	}
	if body["error"] != "Rate limit exceeded: 2 per 1 minute" {
		t.Fatalf("error = %v", body["error"])
	}
}

func TestRateLimiterWindowReset(t *testing.T) {
	now := time.Now()
	limiter := rateLimiter{now: func() time.Time { return now }}
	if ok, _ := limiter.allow("a", "1/second"); !ok {
		t.Fatal("first call should pass")
	}
	if ok, _ := limiter.allow("a", "1/second"); ok {
		t.Fatal("second call should be limited")
	}
	now = now.Add(time.Second)
	if ok, _ := limiter.allow("a", "1/second"); !ok {
		t.Fatal("window should reset")
	}
}

func TestHarnessesCatalog(t *testing.T) {
	h := newHandler(t, fakeReader{}, "http://identity.invalid")
	rec, body := do(t, h, "/api/v1/config/harnesses")
	if rec.Code != http.StatusOK || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("code=%d cache=%q", rec.Code, rec.Header().Get("Cache-Control"))
	}
	list := body["harnesses"].([]any)
	if len(list) != len(h.Registry.Names()) {
		t.Fatalf("len = %d, want %d", len(list), len(h.Registry.Names()))
	}
	if body["default_harness"] != nil {
		t.Fatalf("default_harness = %v", body["default_harness"])
	}
	for _, item := range list {
		entry := item.(map[string]any)
		if entry["name"] == "pi" {
			if models := entry["supported_models"].([]any); len(models) < 900 {
				t.Fatalf("pi supported_models = %d", len(models))
			}
		}
		if _, ok := entry["supported_models"].([]any); !ok {
			t.Fatalf("%s supported_models missing", entry["name"])
		}
	}
}

func TestHarnessesAllowlistAndDefault(t *testing.T) {
	h := newHandler(t, fakeReader{
		"misc.harness_allowlist": "kiro, cursor, not-a-harness",
		"misc.default_harness":   "kiro",
	}, "http://identity.invalid")
	_, body := do(t, h, "/api/v1/config/harnesses")
	list := body["harnesses"].([]any)
	if len(list) != 2 {
		t.Fatalf("len = %d, want 2", len(list))
	}
	if body["default_harness"] != "kiro" {
		t.Fatalf("default_harness = %v", body["default_harness"])
	}

	h = newHandler(t, fakeReader{
		"misc.harness_allowlist": "cursor",
		"misc.default_harness":   "kiro",
	}, "http://identity.invalid")
	_, body = do(t, h, "/api/v1/config/harnesses")
	if body["default_harness"] != nil {
		t.Fatalf("default outside allowlist should be null, got %v", body["default_harness"])
	}
}
