// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for SDK environment and profile configuration edges: TTLs, URL fallbacks, secret sources, and resource manifests.

package sdk_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	sdk "github.com/garudex-labs/caracal/packages/sdk/go"
)

func setSubjectEnv(t *testing.T) {
	t.Helper()
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("CARACAL_COORDINATOR_URL", "http://coord")
	t.Setenv("CARACAL_ZONE_ID", "z")
	t.Setenv("CARACAL_APPLICATION_ID", "app")
	t.Setenv("CARACAL_BOOTSTRAP_TOKEN", "tok")
}

func TestFromEnvDefaultTTL(t *testing.T) {
	setSubjectEnv(t)
	t.Setenv("CARACAL_DEFAULT_TTL_SECONDS", "120")
	c, err := sdk.FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if c.DefaultTTLSeconds != 120 {
		t.Fatalf("ttl: %d", c.DefaultTTLSeconds)
	}
	for _, invalid := range []string{"abc", "-5", "0"} {
		t.Setenv("CARACAL_DEFAULT_TTL_SECONDS", invalid)
		if _, err := sdk.FromEnv(); err == nil {
			t.Fatalf("ttl %q must be rejected", invalid)
		}
	}
}

func TestFromEnvStsURLFallsBackToZoneURL(t *testing.T) {
	var hit bool
	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hit = true
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"tok","token_type":"Bearer","expires_in":3600}`))
	}))
	defer sts.Close()
	setSubjectEnv(t)
	t.Setenv("CARACAL_BOOTSTRAP_TOKEN", "")
	t.Setenv("CARACAL_APP_CLIENT_SECRET", "secret")
	t.Setenv("CARACAL_APP_RESOURCES", "resource://pipernet")
	t.Setenv("CARACAL_STS_URL", sts.URL)
	c, err := sdk.FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Headers(context.Background(), sdk.CallOptions{AsApplication: true}); err != nil {
		t.Fatal(err)
	}
	if !hit {
		t.Fatal("exchange must target the zone URL")
	}
}

func TestFromEnvProductionRequiresConfiguredURLs(t *testing.T) {
	setSubjectEnv(t)
	t.Setenv("CARACAL_ENV", "production")
	t.Setenv("CARACAL_COORDINATOR_URL", "")
	if _, err := sdk.FromEnv(); err == nil || !strings.Contains(err.Error(), "CARACAL_COORDINATOR_URL is required") {
		t.Fatalf("expected coordinator requirement, got %v", err)
	}
	t.Setenv("CARACAL_COORDINATOR_URL", "https://coordinator.internal")
	if _, err := sdk.FromEnv(); err == nil || !strings.Contains(err.Error(), "CARACAL_STS_URL is required") {
		t.Fatalf("expected sts requirement, got %v", err)
	}
	t.Setenv("CARACAL_STS_URL", "https://sts.internal")
	if _, err := sdk.FromEnv(); err == nil || !strings.Contains(err.Error(), "CARACAL_GATEWAY_URL is required") {
		t.Fatalf("expected gateway requirement, got %v", err)
	}
}

func TestFromEnvClientSecretSources(t *testing.T) {
	setSubjectEnv(t)
	t.Setenv("CARACAL_BOOTSTRAP_TOKEN", "")
	t.Setenv("CARACAL_APP_RESOURCES", "resource://pipernet")

	t.Setenv("CARACAL_APP_CLIENT_SECRET", "inline")
	t.Setenv("CARACAL_APP_CLIENT_SECRET_FILE", "/tmp/secret")
	if _, err := sdk.FromEnv(); err == nil || !strings.Contains(err.Error(), "only one of") {
		t.Fatalf("expected conflict error, got %v", err)
	}

	dir := t.TempDir()
	secretPath := filepath.Join(dir, "secret")
	t.Setenv("CARACAL_APP_CLIENT_SECRET", "")

	t.Setenv("CARACAL_APP_CLIENT_SECRET_FILE", filepath.Join(dir, "missing"))
	if _, err := sdk.FromEnv(); err == nil || !strings.Contains(err.Error(), "not readable") {
		t.Fatalf("expected unreadable secret error, got %v", err)
	}

	if err := os.WriteFile(secretPath, []byte("  \n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CARACAL_APP_CLIENT_SECRET_FILE", secretPath)
	if _, err := sdk.FromEnv(); err == nil || !strings.Contains(err.Error(), "empty") {
		t.Fatalf("expected empty secret error, got %v", err)
	}

	if err := os.WriteFile(secretPath, []byte("secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(secretPath, 0o640); err != nil {
		t.Fatal(err)
	}
	if _, err := sdk.FromEnv(); err == nil || !strings.Contains(err.Error(), "readable only by its owner") {
		t.Fatalf("expected permission error, got %v", err)
	}

	if err := os.Chmod(secretPath, 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := sdk.FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if c.TokenSource == nil {
		t.Fatal("secret file must yield a token source")
	}
}

func TestFromEnvClientSecretAllowsNoResources(t *testing.T) {
	setSubjectEnv(t)
	t.Setenv("CARACAL_BOOTSTRAP_TOKEN", "")
	t.Setenv("CARACAL_APP_CLIENT_SECRET", "secret")
	c, err := sdk.FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Resources) != 0 {
		t.Fatalf("unexpected resources: %#v", c.Resources)
	}
}

func TestFromEnvResourcesFileMapValidation(t *testing.T) {
	setSubjectEnv(t)
	dir := t.TempDir()
	path := filepath.Join(dir, "resources.json")
	t.Setenv("CARACAL_RESOURCES_FILE", path)

	if _, err := sdk.FromEnv(); err == nil {
		t.Fatal("missing bindings file must surface the read error")
	}

	if err := os.WriteFile(path, []byte(`"just a string"`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := sdk.FromEnv(); err == nil || !strings.Contains(err.Error(), "object or array") {
		t.Fatalf("expected shape error, got %v", err)
	}

	if err := os.WriteFile(path, []byte(`{"calendar": 42, "billing": "not-a-url", "": "https://x.example"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := sdk.FromEnv(); err == nil || !strings.Contains(err.Error(), "invalid CARACAL_RESOURCES_FILE") {
		t.Fatalf("expected map entry errors, got %v", err)
	}
}

func TestFromEnvResourcesEntryErrorsAndBlanks(t *testing.T) {
	setSubjectEnv(t)
	t.Setenv("CARACAL_RESOURCES", "noequals")
	if _, err := sdk.FromEnv(); err == nil || !strings.Contains(err.Error(), "resourceID=upstreamPrefix") {
		t.Fatalf("expected format error, got %v", err)
	}
	t.Setenv("CARACAL_RESOURCES", "calendar= ")
	if _, err := sdk.FromEnv(); err == nil || !strings.Contains(err.Error(), "non-empty") {
		t.Fatalf("expected empty prefix error, got %v", err)
	}
	t.Setenv("CARACAL_RESOURCES", " , ,")
	c, err := sdk.FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Resources) != 0 {
		t.Fatalf("blank entries must yield no bindings: %#v", c.Resources)
	}
}

func writeConfigProfile(t *testing.T, dir, body string) string {
	t.Helper()
	path := filepath.Join(dir, "caracal.toml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestFromConfigFillsGapsFromEnv(t *testing.T) {
	dir := t.TempDir()
	secretPath := filepath.Join(dir, "secret")
	if err := os.WriteFile(secretPath, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	path := writeConfigProfile(t, dir, fmt.Sprintf(`zone_id = "z"
application_id = "app"
app_client_secret_file = %q
`, secretPath))
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("CARACAL_STS_URL", "http://sts.local")
	t.Setenv("CARACAL_COORDINATOR_URL", "http://coordinator.local")
	t.Setenv("CARACAL_GATEWAY_URL", "http://gateway.local")
	t.Setenv("CARACAL_DEFAULT_TTL_SECONDS", "90")
	t.Setenv("CARACAL_RESOURCES", "resource://pipernet=https://api.pipernet.example")

	c, err := sdk.FromConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if c.Coordinator.BaseURL != "http://coordinator.local" || c.GatewayURL != "http://gateway.local" {
		t.Fatalf("env URLs not honored: %#v", c)
	}
	if c.DefaultTTLSeconds != 90 {
		t.Fatalf("env ttl not honored: %d", c.DefaultTTLSeconds)
	}
	if got := resourceBindingMap(c.Resources); got["resource://pipernet"] != "https://api.pipernet.example" {
		t.Fatalf("env bindings not honored: %#v", c.Resources)
	}
}

func TestFromConfigAllowsNoResources(t *testing.T) {
	dir := t.TempDir()
	secretPath := filepath.Join(dir, "secret")
	if err := os.WriteFile(secretPath, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	path := writeConfigProfile(t, dir, fmt.Sprintf(`zone_id = "z"
application_id = "app"
sts_url = "http://sts.local"
app_client_secret_file = %q
`, secretPath))
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	c, err := sdk.FromConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Resources) != 0 {
		t.Fatalf("unexpected resources: %#v", c.Resources)
	}
}

func TestFromConfigInlineSecretRules(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	dir := t.TempDir()
	path := writeConfigProfile(t, dir, `zone_id = "z"
application_id = "app"
sts_url = "http://sts.local"
app_client_secret = "inline"

[[credentials]]
resource = "resource://pipernet"
`)
	c, err := sdk.FromConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if c.TokenSource == nil {
		t.Fatal("inline secret must yield a token source")
	}

	if err := os.Chmod(path, 0o640); err != nil {
		t.Fatal(err)
	}
	if _, err := sdk.FromConfig(path); err == nil || !strings.Contains(err.Error(), "readable only by its owner") {
		t.Fatalf("expected inline secret permission error, got %v", err)
	}

	both := writeConfigProfile(t, t.TempDir(), `zone_id = "z"
application_id = "app"
sts_url = "http://sts.local"
app_client_secret = "inline"
app_client_secret_file = "/tmp/secret"

[[credentials]]
resource = "resource://pipernet"
`)
	if _, err := sdk.FromConfig(both); err == nil || !strings.Contains(err.Error(), "sets both") {
		t.Fatalf("expected secret conflict error, got %v", err)
	}

	missing := writeConfigProfile(t, t.TempDir(), `zone_id = "z"
application_id = "app"
sts_url = "http://sts.local"

[[credentials]]
resource = "resource://pipernet"
`)
	if _, err := sdk.FromConfig(missing); err == nil || !strings.Contains(err.Error(), "requires app_client_secret or app_client_secret_file") {
		t.Fatalf("expected missing secret error, got %v", err)
	}
}

func TestFromClientSecretRejectsNegativeTTL(t *testing.T) {
	_, err := sdk.FromClientSecret(sdk.ClientSecretOptions{
		CoordinatorURL:    "http://coord",
		STSURL:            "http://sts",
		ZoneID:            "z",
		ApplicationID:     "app",
		ClientSecret:      "secret",
		DefaultTTLSeconds: -1,
	})
	if err == nil || !strings.Contains(err.Error(), "DefaultTTLSeconds") {
		t.Fatalf("expected ttl validation error, got %v", err)
	}
}

func TestFromClientSecretRejectsMalformedEndpoint(t *testing.T) {
	_, err := sdk.FromClientSecret(sdk.ClientSecretOptions{
		CoordinatorURL: "coordinator.internal:4000",
		STSURL:         "http://sts",
		ZoneID:         "z",
		ApplicationID:  "app",
		ClientSecret:   "secret",
	})
	if err == nil || !strings.Contains(err.Error(), "absolute http or https URL") {
		t.Fatalf("expected endpoint validation error, got %v", err)
	}
}

func TestFromClientSecretRejectsMalformedResourceBinding(t *testing.T) {
	_, err := sdk.FromClientSecret(sdk.ClientSecretOptions{
		CoordinatorURL: "http://coord",
		STSURL:         "http://sts",
		ZoneID:         "z",
		ApplicationID:  "app",
		ClientSecret:   "secret",
		ResourceBindings: []sdk.ResourceBinding{{
			ResourceID:     "calendar",
			UpstreamPrefix: "ftp://calendar.example.com",
		}},
	})
	if err == nil || !strings.Contains(err.Error(), "absolute http or https URL") {
		t.Fatalf("expected binding validation error, got %v", err)
	}
}
