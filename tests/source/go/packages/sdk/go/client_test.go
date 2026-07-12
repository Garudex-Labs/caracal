// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Caracal drop-in client smoke tests for env loading, header injection, and middleware binding.

package sdk_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	oauth "github.com/garudex-labs/caracal/packages/oauth/go"
	sdk "github.com/garudex-labs/caracal/packages/sdk/go"
)

func tokenWithUse(use string) string {
	payload := base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf(`{"use":%q}`, use)))
	return "eyJhbGciOiJFUzI1NiJ9." + payload + ".signature"
}

func TestFromEnvMissing(t *testing.T) {
	t.Setenv("CARACAL_COORDINATOR_URL", "")
	t.Setenv("CARACAL_ZONE_ID", "")
	t.Setenv("CARACAL_APPLICATION_ID", "")
	t.Setenv("CARACAL_BOOTSTRAP_TOKEN", "")
	if _, err := sdk.FromEnv(); err == nil {
		t.Fatal("expected error for missing env")
	}
}

func TestFromEnvOK(t *testing.T) {
	t.Setenv("CARACAL_ZONE_ID", "z1")
	t.Setenv("CARACAL_APPLICATION_ID", "app1")
	t.Setenv("CARACAL_BOOTSTRAP_TOKEN", "tok1")
	c, err := sdk.FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if c.ZoneID != "z1" || c.ApplicationID != "app1" || c.SubjectToken != "tok1" {
		t.Fatalf("bad config: %+v", c)
	}
	if c.Coordinator.BaseURL != "http://localhost:4000" || c.GatewayURL != "http://localhost:8081" {
		t.Fatalf("unexpected default URLs: %+v", c)
	}
}

func TestFromEnvProductionRestrictsHTTPToLoopbackOrOverride(t *testing.T) {
	t.Setenv("CARACAL_ENV", "production")
	t.Setenv("CARACAL_ZONE_ID", "z1")
	t.Setenv("CARACAL_APPLICATION_ID", "app1")
	t.Setenv("CARACAL_BOOTSTRAP_TOKEN", "tok1")
	t.Setenv("CARACAL_STS_URL", "https://sts.internal")
	t.Setenv("CARACAL_GATEWAY_URL", "https://gateway.internal")
	t.Setenv("CARACAL_COORDINATOR_URL", "http://coordinator.internal:4000")

	if _, err := sdk.FromEnv(); err == nil || !strings.Contains(err.Error(), "must use https") {
		t.Fatalf("expected https enforcement error, got %v", err)
	}

	t.Setenv("CARACAL_COORDINATOR_URL", "http://127.0.0.1:4000")
	if _, err := sdk.FromEnv(); err != nil {
		t.Fatalf("loopback http should pass: %v", err)
	}

	t.Setenv("CARACAL_COORDINATOR_URL", "http://coordinator.internal:4000")
	t.Setenv("CARACAL_ALLOW_INSECURE_CONFIG_URLS", "true")
	if _, err := sdk.FromEnv(); err != nil {
		t.Fatalf("override should pass: %v", err)
	}
}

func TestFromClientSecretProductionRequiresHTTPSSTS(t *testing.T) {
	t.Setenv("CARACAL_ENV", "production")
	_, err := sdk.FromClientSecret(sdk.ClientSecretOptions{
		CoordinatorURL: "https://coordinator.internal",
		STSURL:         "http://sts.internal:8080",
		ZoneID:         "z",
		ApplicationID:  "app",
		ClientSecret:   "secret",
	})
	if err == nil || !strings.Contains(err.Error(), "STSURL must use https") {
		t.Fatalf("expected STSURL https enforcement error, got %v", err)
	}
}

func TestFromEnvClientSecretTokenSource(t *testing.T) {
	var gotResources []string
	var gotSecret string
	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		gotResources = r.Form["resource"]
		gotSecret = r.Form.Get("client_secret")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"fresh-root","token_type":"Bearer","expires_in":3600}`))
	}))
	defer sts.Close()

	t.Setenv("CARACAL_COORDINATOR_URL", "http://coord")
	t.Setenv("CARACAL_ZONE_ID", "z")
	t.Setenv("CARACAL_APPLICATION_ID", "app")
	t.Setenv("CARACAL_APP_CLIENT_SECRET", "secret")
	t.Setenv("CARACAL_STS_URL", sts.URL)
	t.Setenv("CARACAL_RESOURCES", "calendar=https://api.example.com/v1,billing=https://billing.example.com")

	c, err := sdk.FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	h, err := c.Headers(context.Background(), sdk.CallOptions{AsApplication: true})
	if err != nil {
		t.Fatal(err)
	}
	if h.Get(sdk.HeaderAuthorization) != "Bearer fresh-root" {
		t.Fatalf("unexpected authorization: %s", h.Get(sdk.HeaderAuthorization))
	}
	if gotSecret != "secret" {
		t.Fatalf("expected client secret, got %q", gotSecret)
	}
	if strings.Join(compactSorted(gotResources), ",") != "billing,calendar" {
		t.Fatalf("unexpected resources: %#v", gotResources)
	}
}

func TestFromEnvClientSecretUsesExplicitAppResources(t *testing.T) {
	var gotResources []string
	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		gotResources = r.Form["resource"]
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"fresh-root","token_type":"Bearer","expires_in":3600}`))
	}))
	defer sts.Close()

	t.Setenv("CARACAL_COORDINATOR_URL", "http://coord")
	t.Setenv("CARACAL_ZONE_ID", "z")
	t.Setenv("CARACAL_APPLICATION_ID", "app")
	t.Setenv("CARACAL_APP_CLIENT_SECRET", "secret")
	t.Setenv("CARACAL_STS_URL", sts.URL)
	t.Setenv("CARACAL_APP_RESOURCES", "billing")

	c, err := sdk.FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Headers(context.Background(), sdk.CallOptions{AsApplication: true}); err != nil {
		t.Fatal(err)
	}
	if strings.Join(compactSorted(gotResources), ",") != "billing" {
		t.Fatalf("unexpected resources: %#v", gotResources)
	}
	if len(c.Resources) != 0 {
		t.Fatalf("unexpected bindings: %#v", c.Resources)
	}
}

func TestFromEnvIgnoresImplicitCredentialFiles(t *testing.T) {
	dir := t.TempDir()
	credentialDir := filepath.Join(dir, "caracal", "runtime", "z", "app")
	if err := os.MkdirAll(credentialDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(credentialDir, "client-secret"), []byte("secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(credentialDir, "credentials.json"), []byte(`[{"resource":"calendar"}]`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("CARACAL_ZONE_ID", "z")
	t.Setenv("CARACAL_APPLICATION_ID", "app")
	t.Setenv("CARACAL_STS_URL", "http://sts")

	if _, err := sdk.FromEnv(); err == nil || !strings.Contains(err.Error(), "CARACAL_APP_CLIENT_SECRET") {
		t.Fatalf("expected explicit credential error, got %v", err)
	}
}

func TestFromConfigGeneratedProfile(t *testing.T) {
	var gotResources []string
	var gotSecret string
	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		gotResources = r.Form["resource"]
		gotSecret = r.Form.Get("client_secret")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"fresh-root","token_type":"Bearer","expires_in":3600}`))
	}))
	defer sts.Close()
	dir := t.TempDir()
	secretPath := filepath.Join(dir, "secret")
	if err := os.WriteFile(secretPath, []byte("secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	profilePath := filepath.Join(dir, "caracal.toml")
	profile := fmt.Sprintf(`coordinator_url = "http://coord"
sts_url = %q
gateway_url = "https://gateway.example.com/proxy"
zone_id = "z"
application_id = "app"
app_client_secret_file = %q

[[credentials]]
resource = "calendar"

[[credentials]]
resource = "billing"
upstream_prefix = "https://billing.example.com"
`, sts.URL, secretPath)
	if err := os.WriteFile(profilePath, []byte(profile), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := sdk.FromConfig(profilePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Headers(context.Background(), sdk.CallOptions{AsApplication: true}); err != nil {
		t.Fatal(err)
	}
	if gotSecret != "secret" {
		t.Fatalf("expected secret file value, got %q", gotSecret)
	}
	if strings.Join(compactSorted(gotResources), ",") != "billing,calendar" {
		t.Fatalf("unexpected resources: %#v", gotResources)
	}
	if len(c.Resources) != 1 || c.Resources[0].ResourceID != "billing" {
		t.Fatalf("unexpected bindings: %#v", c.Resources)
	}
}

func TestNewUsesExplicitOptionsConfigProfileAndEnv(t *testing.T) {
	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"fresh-root","token_type":"Bearer","expires_in":3600}`))
	}))
	defer sts.Close()

	explicit, err := sdk.FromClientSecret(sdk.ClientSecretOptions{
		CoordinatorURL: "http://coord",
		STSURL:         sts.URL,
		ZoneID:         "z",
		ApplicationID:  "app",
		ClientSecret:   "secret",
		Resources:      []string{"resource://pipernet"},
	})
	if err != nil {
		t.Fatalf("explicit connect: %v", err)
	}
	if explicit.TokenSource == nil {
		t.Fatal("explicit connect should use client secret token source")
	}

	dir := t.TempDir()
	secretPath := filepath.Join(dir, "secret")
	if err := os.WriteFile(secretPath, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(dir, "caracal.toml")
	if err := os.WriteFile(configPath, []byte(fmt.Sprintf(`
zone_id = "z"
application_id = "app"
sts_url = %q
app_client_secret_file = %q

[[credentials]]
resource = "resource://pipernet"
`, sts.URL, secretPath)), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CARACAL_CONFIG", configPath)
	fromConfig, err := sdk.New()
	if err != nil {
		t.Fatalf("config connect: %v", err)
	}
	if fromConfig.ZoneID != "z" || fromConfig.ApplicationID != "app" {
		t.Fatalf("unexpected config client: %#v", fromConfig)
	}

	t.Setenv("CARACAL_CONFIG", "")
	t.Setenv("XDG_CONFIG_HOME", dir)
	profileDir := filepath.Join(dir, "caracal")
	if err := os.MkdirAll(profileDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(profileDir, "caracal.toml"), []byte(fmt.Sprintf(`
zone_id = "z-profile"
application_id = "app-profile"
sts_url = %q
app_client_secret_file = %q

[[credentials]]
resource = "resource://pipernet"
`, sts.URL, secretPath)), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CARACAL_ZONE_ID", "z-env")
	t.Setenv("CARACAL_APPLICATION_ID", "app-env")
	t.Setenv("CARACAL_BOOTSTRAP_TOKEN", "tok-env")
	fromEnv, err := sdk.New()
	if err != nil {
		t.Fatalf("env connect: %v", err)
	}
	if fromEnv.SubjectToken != "tok-env" {
		t.Fatalf("unexpected env client: %#v", fromEnv)
	}
	if fromEnv.ZoneID == "z-profile" {
		t.Fatalf("New must not inspect default profile paths: %#v", fromEnv)
	}
}

func compactSorted(values []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, value := range values {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	sort.Strings(out)
	return out
}

func TestHeadersRequiresRootOptIn(t *testing.T) {
	c := &sdk.Caracal{SubjectToken: "tok"}
	if _, err := c.Headers(context.Background()); err == nil {
		t.Fatal("expected missing context error")
	}
	h, err := c.Headers(context.Background(), sdk.CallOptions{AsApplication: true})
	if err != nil {
		t.Fatal(err)
	}
	if h.Get(sdk.HeaderAuthorization) != "Bearer tok" {
		t.Fatalf("missing authorization: %v", h)
	}
	if tid, _ := sdk.ParseTraceparent(h.Get(sdk.HeaderTraceparent)); tid == "" {
		t.Fatalf("missing traceparent: %v", h)
	}
}

func TestCaracalCurrentAndBindFromRequestRootFallback(t *testing.T) {
	c := &sdk.Caracal{ZoneID: "z", ApplicationID: "app", SubjectToken: "root-token"}
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	bound, err := c.BindFromRequest(context.Background(), req, sdk.CallOptions{AsApplication: true})
	if err != nil {
		t.Fatalf("bind from root fallback: %v", err)
	}
	cur, ok := c.Current(bound)
	if !ok {
		t.Fatal("client Current should return bound context")
	}
	if cur.SubjectToken != "root-token" || cur.ZoneID != "z" || cur.ApplicationID != "app" {
		t.Fatalf("unexpected bound context: %#v", cur)
	}
}

func TestCloseIsANoop(t *testing.T) {
	if err := (&sdk.Caracal{}).Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
}

func TestMiddlewareRejectsMissingBearer(t *testing.T) {
	c := &sdk.Caracal{ZoneID: "z", ApplicationID: "a", SubjectToken: "fallback"}
	handler := c.ContextMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("handler should not run")
	}))
	req := httptest.NewRequest("GET", "/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
	if strings.TrimSpace(rec.Body.String()) != "invalid or missing authorization" {
		t.Fatalf("unexpected response body: %q", rec.Body.String())
	}
}

func TestMiddlewareBindsContext(t *testing.T) {
	c := &sdk.Caracal{ZoneID: "z", ApplicationID: "a", SubjectToken: "fallback"}
	var seen string
	handler := c.ContextMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cur, ok := sdk.Current(r.Context())
		if !ok {
			t.Errorf("no context")
		}
		seen = cur.SubjectToken
		w.WriteHeader(200)
	}))
	srv := httptest.NewServer(handler)
	defer srv.Close()
	req, _ := http.NewRequest("GET", srv.URL, nil)
	req.Header.Set(sdk.HeaderAuthorization, "Bearer inbound")
	req.Header.Set(sdk.HeaderTraceparent, "00-0123456789abcdef0123456789abcdef-aabbccddeeff0011-01")
	req.Header.Set(sdk.HeaderBaggage, sdk.BaggageAgentSession+"=sess1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if seen != "inbound" {
		t.Fatalf("expected inbound token, got %q", seen)
	}
}

func TestHTTPClientInjects(t *testing.T) {
	c := &sdk.Caracal{ZoneID: "z", ApplicationID: "a", SubjectToken: "tok"}
	var got http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		w.WriteHeader(204)
	}))
	defer srv.Close()
	ctx := sdk.Bind(context.Background(), sdk.CaracalContext{
		SubjectToken:  "tok",
		ZoneID:        "z",
		ApplicationID: "a",
		SessionID:     "sess9",
		Hop:           1,
	})
	client := c.Transport(nil, sdk.CallOptions{Propagation: sdk.PropagationAlways})
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL, nil)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	bag := sdk.ParseBaggage(got.Get(sdk.HeaderBaggage))
	if bag[sdk.BaggageAgentSession] != "sess9" {
		t.Fatalf("envelope not injected: %v", got)
	}
	if bag[sdk.BaggageHop] != "1" {
		t.Fatalf("hop not injected: %v", got)
	}
	if got.Get(sdk.HeaderAuthorization) != "" {
		t.Fatalf("direct upstream must not receive the subject token: %v", got)
	}
}

func TestGatewayRequestBuildsExplicitGatewayTarget(t *testing.T) {
	c := &sdk.Caracal{
		ZoneID:        "z",
		ApplicationID: "a",
		SubjectToken:  "tok",
		GatewayURL:    "https://gateway.example.com/proxy",
	}
	var got http.Header
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		gotPath = r.URL.String()
		w.WriteHeader(204)
	}))
	defer srv.Close()
	c.GatewayURL = srv.URL + "/proxy"
	target, err := c.GatewayRequest("resource://calendar", "events?limit=10")
	if err != nil {
		t.Fatal(err)
	}
	ctx := sdk.Bind(context.Background(), sdk.CaracalContext{
		SubjectToken:  "tok",
		ZoneID:        "z",
		ApplicationID: "a",
		Hop:           1,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header = target.Header.Clone()
	resp, err := c.Transport(nil).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if target.Header.Get("X-Caracal-Resource") != "resource://calendar" {
		t.Fatalf("unexpected helper header: %v", target.Header)
	}
	if gotPath != "/proxy/events?limit=10" {
		t.Fatalf("unexpected path: %s", gotPath)
	}
	if got.Get("X-Caracal-Resource") != "resource://calendar" {
		t.Fatalf("missing resource header: %v", got)
	}
	if got.Get(sdk.HeaderAuthorization) != "Bearer tok" {
		t.Fatalf("missing authorization: %v", got)
	}
}

func TestTransportRejectsLifecycleMandateAtGateway(t *testing.T) {
	var calls int
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.WriteHeader(http.StatusNoContent)
	}))
	defer gateway.Close()
	c := &sdk.Caracal{ZoneID: "z", ApplicationID: "a", SubjectToken: tokenWithUse("session"), GatewayURL: gateway.URL + "/proxy"}
	req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, gateway.URL+"/proxy/events", nil)
	req.Header.Set("X-Caracal-Resource", "resource://calendar")

	_, err := c.Transport(nil, sdk.CallOptions{AsApplication: true}).Do(req)
	if err == nil || !strings.Contains(err.Error(), "use=gateway") || !strings.Contains(err.Error(), "use=session") {
		t.Fatalf("expected token-use rejection, got %v", err)
	}
	if calls != 0 {
		t.Fatalf("Gateway received %d requests", calls)
	}
}

func TestTransportRequiresResourceForScopes(t *testing.T) {
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer gateway.Close()
	c := &sdk.Caracal{ZoneID: "z", ApplicationID: "a", SubjectToken: "tok", GatewayURL: gateway.URL + "/proxy"}
	req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, gateway.URL+"/proxy/events", nil)

	_, err := c.Transport(nil, sdk.CallOptions{AsApplication: true, Scopes: []string{"events:read"}}).Do(req)
	if err == nil || !strings.Contains(err.Error(), "scopes require X-Caracal-Resource") {
		t.Fatalf("expected missing resource rejection, got %v", err)
	}
}

func TestTransportContainsGatewayAuthorityToBasePath(t *testing.T) {
	var headers []http.Header
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		headers = append(headers, r.Header.Clone())
		w.WriteHeader(http.StatusNoContent)
	}))
	defer gateway.Close()
	c := &sdk.Caracal{ZoneID: "z", ApplicationID: "a", SubjectToken: "tok", GatewayURL: gateway.URL + "/proxy"}
	client := c.Transport(nil, sdk.CallOptions{AsApplication: true, Propagation: sdk.PropagationGatewayOnly})

	for _, path := range []string{"/unrelated", "/proxy/%252e%252e/admin"} {
		req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, gateway.URL+path, nil)
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
	}
	for _, header := range headers {
		if header.Get(sdk.HeaderAuthorization) != "" || header.Get(sdk.HeaderTraceparent) != "" {
			t.Fatalf("authority escaped Gateway base path: %v", header)
		}
	}
}

func TestTransportDoesNotReplayMandateAcrossRedirect(t *testing.T) {
	var calls int
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path == "/proxy/start" {
			w.Header().Set("Location", "/proxy/next")
			w.WriteHeader(http.StatusTemporaryRedirect)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer gateway.Close()
	c := &sdk.Caracal{ZoneID: "z", ApplicationID: "a", SubjectToken: "tok", GatewayURL: gateway.URL + "/proxy"}
	req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, gateway.URL+"/proxy/start", nil)
	req.Header.Set("X-Caracal-Resource", "resource://calendar")

	resp, err := c.Transport(nil, sdk.CallOptions{AsApplication: true}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusTemporaryRedirect || calls != 1 {
		t.Fatalf("expected one surfaced redirect, status=%d calls=%d", resp.StatusCode, calls)
	}
}

func TestFetchComposesGatewayRequestAndTransport(t *testing.T) {
	c := &sdk.Caracal{
		ZoneID:        "z",
		ApplicationID: "a",
		SubjectToken:  "tok",
		GatewayURL:    "https://gateway.example.com/proxy",
	}
	var got http.Header
	var gotPath, gotMethod string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		gotPath = r.URL.String()
		gotMethod = r.Method
		w.WriteHeader(204)
	}))
	defer srv.Close()
	c.GatewayURL = srv.URL + "/proxy"
	ctx := sdk.Bind(context.Background(), sdk.CaracalContext{
		SubjectToken:  "tok",
		ZoneID:        "z",
		ApplicationID: "a",
		Hop:           1,
	})
	header := http.Header{}
	header.Set("Content-Type", "application/json")
	resp, err := c.Fetch(ctx, http.MethodPost, "resource://calendar", "events?limit=10", sdk.FetchOptions{Header: header})
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if gotMethod != http.MethodPost {
		t.Fatalf("unexpected method: %s", gotMethod)
	}
	if gotPath != "/proxy/events?limit=10" {
		t.Fatalf("unexpected path: %s", gotPath)
	}
	if got.Get("X-Caracal-Resource") != "resource://calendar" {
		t.Fatalf("missing resource header: %v", got)
	}
	if got.Get("Content-Type") != "application/json" {
		t.Fatalf("missing caller header: %v", got)
	}
	if got.Get(sdk.HeaderAuthorization) != "Bearer tok" {
		t.Fatalf("missing authorization: %v", got)
	}
}

func TestTransportRoutesMatchingResourceBindingsThroughGateway(t *testing.T) {
	c := &sdk.Caracal{
		ZoneID:        "z",
		ApplicationID: "a",
		SubjectToken:  "tok",
		Resources: []sdk.ResourceBinding{
			{ResourceID: "resource://pipernet-api", UpstreamPrefix: "https://api.pipernet.example/v1"},
			{ResourceID: "resource://pipernet", UpstreamPrefix: "https://api.pipernet.example"},
		},
	}
	var gotPath string
	var gotHeader http.Header
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.String()
		gotHeader = r.Header.Clone()
		w.WriteHeader(http.StatusNoContent)
	}))
	defer gateway.Close()
	c.GatewayURL = gateway.URL + "/gateway"
	ctx := sdk.Bind(context.Background(), sdk.CaracalContext{SubjectToken: "tok", ZoneID: "z", ApplicationID: "a"})
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.pipernet.example/v1/users?limit=10", nil)
	if err != nil {
		t.Fatal(err)
	}

	resp, err := c.Transport(nil).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()

	if gotPath != "/gateway/users?limit=10" {
		t.Fatalf("unexpected gateway path: %s", gotPath)
	}
	if gotHeader.Get("X-Caracal-Resource") != "resource://pipernet-api" {
		t.Fatalf("expected longest matching resource binding, got %v", gotHeader)
	}
	if gotHeader.Get(sdk.HeaderAuthorization) != "Bearer tok" {
		t.Fatalf("expected gateway authorization header, got %v", gotHeader)
	}
}

func TestTransportUsesExplicitResourceBindingAndSkipsGatewayOrigin(t *testing.T) {
	c := &sdk.Caracal{
		ZoneID:        "z",
		ApplicationID: "a",
		SubjectToken:  "tok",
		Resources: []sdk.ResourceBinding{
			{ResourceID: "resource://pipernet", UpstreamPrefix: "https://api.pipernet.example"},
		},
	}
	var paths []string
	var resources []string
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.String())
		resources = append(resources, r.Header.Get("X-Caracal-Resource"))
		w.WriteHeader(http.StatusNoContent)
	}))
	defer gateway.Close()
	c.GatewayURL = gateway.URL + "/gateway"
	ctx := sdk.Bind(context.Background(), sdk.CaracalContext{SubjectToken: "tok", ZoneID: "z", ApplicationID: "a"})

	explicit, _ := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.other.example/raw", nil)
	explicit.Header.Set("X-Caracal-Resource", "resource://pipernet")
	resp, err := c.Transport(nil).Do(explicit)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()

	directGateway, _ := http.NewRequestWithContext(ctx, http.MethodGet, gateway.URL+"/gateway/already", nil)
	resp, err = c.Transport(nil).Do(directGateway)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()

	if paths[0] != "/gateway/raw" || resources[0] != "resource://pipernet" {
		t.Fatalf("explicit resource was not routed through gateway: paths=%v resources=%v", paths, resources)
	}
	if paths[1] != "/gateway/already" || resources[1] != "" {
		t.Fatalf("gateway-origin request should not be rewritten: paths=%v resources=%v", paths, resources)
	}
}

func TestGatewayRequestRejectsInvalidInputs(t *testing.T) {
	c := &sdk.Caracal{GatewayURL: "https://gateway.example.com/proxy"}
	if _, err := (&sdk.Caracal{}).GatewayRequest("resource://calendar", "/events"); err == nil {
		t.Fatal("expected GatewayURL error")
	}
	if _, err := c.GatewayRequest("", "/events"); err == nil {
		t.Fatal("expected resourceID error")
	}
	if _, err := c.GatewayRequest("resource://calendar", "https://api.example.com/events"); err == nil {
		t.Fatal("expected relative path error")
	}
	if _, err := c.GatewayRequest("resource://calendar", "/events/../admin"); err == nil || !strings.Contains(err.Error(), "dot segments") {
		t.Fatalf("expected dot segment rejection, got %v", err)
	}
	if _, err := c.GatewayRequest("resource://calendar", "./events"); err == nil || !strings.Contains(err.Error(), "dot segments") {
		t.Fatalf("expected dot segment rejection, got %v", err)
	}
	if _, err := c.GatewayRequest("resource://calendar", "/events/%252e%252e/admin"); err == nil || !strings.Contains(err.Error(), "dot segments") {
		t.Fatalf("expected encoded dot segment rejection, got %v", err)
	}
	if _, err := c.GatewayRequest("resource://calendar", "/events#fragment"); err == nil || !strings.Contains(err.Error(), "fragment") {
		t.Fatalf("expected fragment rejection, got %v", err)
	}
}

func TestHTTPClientRejectsUnboundRootByDefault(t *testing.T) {
	c := &sdk.Caracal{ZoneID: "z", ApplicationID: "a", SubjectToken: "tok"}
	client := c.Transport(nil)
	req, _ := http.NewRequestWithContext(context.Background(), "GET", "https://example.com", nil)
	if _, err := client.Do(req); err == nil {
		t.Fatal("expected missing context error")
	}
}

func TestTransportAllowsUnboundRootWhenOptedIn(t *testing.T) {
	c := &sdk.Caracal{
		ZoneID:       "z",
		SubjectToken: "root-token",
	}
	var got http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, srv.URL, nil)
	if err != nil {
		t.Fatal(err)
	}

	resp, err := c.Transport(nil, sdk.CallOptions{AsApplication: true, Propagation: sdk.PropagationAlways}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()

	if got.Get(sdk.HeaderAuthorization) != "" {
		t.Fatalf("direct upstream must not receive the subject token: %v", got)
	}
	if tid, _ := sdk.ParseTraceparent(got.Get(sdk.HeaderTraceparent)); tid == "" {
		t.Fatalf("missing traceparent: %v", got)
	}
}

func TestBindFromRequestVerifyHook(t *testing.T) {
	c := &sdk.Caracal{ZoneID: "z", ApplicationID: "a"}
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set(sdk.HeaderAuthorization, "Bearer inbound")

	var seen string
	ctx, err := c.BindFromRequest(context.Background(), req, sdk.CallOptions{
		Verify: func(_ context.Context, token string) (*sdk.VerifiedClaims, error) {
			seen = token
			return &sdk.VerifiedClaims{ZoneID: "z", ApplicationID: "a", Hop: 0}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if seen != "inbound" {
		t.Fatalf("verify hook must receive the inbound token, got %q", seen)
	}
	if cur, ok := sdk.Current(ctx); !ok || cur.SubjectToken != "inbound" {
		t.Fatalf("unexpected bound context: %#v", cur)
	}
	t.Setenv("CARACAL_ENV", "production")
	if _, err := c.BindFromRequest(context.Background(), req); err == nil || !strings.Contains(err.Error(), "production ingress requires") {
		t.Fatalf("production ingress must require an explicit trust posture: %v", err)
	}
	if _, err := c.BindFromRequest(context.Background(), req, sdk.CallOptions{TrustedPropagation: true}); err != nil {
		t.Fatalf("trusted upstream propagation must bind: %v", err)
	}
	if _, err := c.BindFromRequest(context.Background(), req, sdk.CallOptions{
		Verify: func(_ context.Context, _ string) (*sdk.VerifiedClaims, error) { return nil, nil },
	}); err == nil {
		t.Fatal("empty verified projection must reject the bind")
	}
	if _, err := c.BindFromRequest(context.Background(), req, sdk.CallOptions{
		Verify: func(_ context.Context, _ string) (*sdk.VerifiedClaims, error) {
			return &sdk.VerifiedClaims{ZoneID: "z", ApplicationID: "a", Hop: sdk.MaxHop + 1}, nil
		},
	}); err == nil {
		t.Fatal("invalid verified hop must reject the bind")
	}

	if _, err := c.BindFromRequest(context.Background(), req, sdk.CallOptions{
		Verify: func(_ context.Context, _ string) (*sdk.VerifiedClaims, error) { return nil, fmt.Errorf("revoked") },
	}); err == nil {
		t.Fatal("verify failure must reject the bind")
	}
}

func TestCoordinatorResponsesUseExplicitIDs(t *testing.T) {
	var bodies []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if r.Body != nil {
			if err := json.NewDecoder(r.Body).Decode(&body); err == nil {
				bodies = append(bodies, body)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/agents"):
			_, _ = w.Write([]byte(`{"agent_session_id":"agent-1","lease_generation":1}`))
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/delegations"):
			_, _ = w.Write([]byte(`{"delegation_edge_id":"edge-1"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	client := &sdk.CoordinatorClient{BaseURL: srv.URL}
	agent, err := sdk.StartCoordinatorSession(context.Background(), client, "tok", sdk.StartSessionRequest{
		ZoneID:        "z",
		ApplicationID: "app",
		Lifecycle:     sdk.LifecycleService,
		TTLSeconds:    60,
	})
	if err != nil {
		t.Fatal(err)
	}
	if agent.SessionID != "agent-1" {
		t.Fatalf("expected agent-1, got %q", agent.SessionID)
	}
	edge, err := sdk.CreateDelegation(context.Background(), client, "tok", sdk.DelegationRequest{
		ZoneID:                "z",
		IssuerApplicationID:   "app",
		SourceSessionID:       "agent-1",
		TargetSessionID:       "agent-2",
		ReceiverApplicationID: "app-2",
		Scopes:                []string{"tool:call"},
		Constraints:           &sdk.DelegationConstraints{Resources: []string{"calendar"}, MaxDepth: 2},
		TTLSeconds:            30,
	})
	if err != nil {
		t.Fatal(err)
	}
	if edge.DelegationID != "edge-1" {
		t.Fatalf("expected edge-1, got %q", edge.DelegationID)
	}
	if len(bodies) != 2 || bodies[0]["ttl_seconds"] != float64(60) || bodies[1]["ttl_seconds"] != float64(30) {
		t.Fatalf("unexpected coordinator request bodies: %#v", bodies)
	}
}

func TestStartCoordinatorSessionNoIdempotencyKeyByDefault(t *testing.T) {
	var seen http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Clone()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"agent_session_id":"a-1"}`))
	}))
	defer srv.Close()
	client := &sdk.CoordinatorClient{BaseURL: srv.URL}
	_, err := sdk.StartCoordinatorSession(context.Background(), client, "tok", sdk.StartSessionRequest{
		ZoneID: "z", ApplicationID: "app", SubjectAuthorityRecordID: "sid", ParentID: "parent",
	})
	if err != nil {
		t.Fatal(err)
	}
	if key := seen.Get("Idempotency-Key"); key != "" {
		t.Fatalf("expected no idempotency key, got %q", key)
	}
}

func TestStartCoordinatorSessionExplicitIdempotencyKey(t *testing.T) {
	var seen http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Clone()
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"agent_session_id":"a-1"}`))
	}))
	defer srv.Close()
	client := &sdk.CoordinatorClient{BaseURL: srv.URL}
	_, err := sdk.StartCoordinatorSession(context.Background(), client, "tok", sdk.StartSessionRequest{
		ZoneID: "z", ApplicationID: "app", IdempotencyKey: "user-key",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := seen.Get("Idempotency-Key"); got != "user-key" {
		t.Fatalf("expected user-key, got %q", got)
	}
}

func TestFromClientSecretPropagatesHTTPClientToCoordinator(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(`{"session_id":"session-1"}`)),
			Request:    req,
		}, nil
	})}
	c, err := sdk.FromClientSecret(sdk.ClientSecretOptions{
		CoordinatorURL: "https://coordinator.example.com",
		STSURL:         "https://sts.example.com",
		ZoneID:         "z",
		ApplicationID:  "app",
		ClientSecret:   "secret",
		Resources:      []string{"resource://pipernet"},
		HTTPClient:     client,
	})
	if err != nil {
		t.Fatal(err)
	}
	if c.Coordinator.HTTPClient != client {
		t.Fatal("custom HTTP client must be shared with Coordinator")
	}
}

func TestFromEnvRejectsExpiredJWT(t *testing.T) {
	// Header.Payload.Sig where payload claims exp=1000000 (year 1970).
	expired := "eyJhbGciOiJFUzI1NiJ9.eyJleHAiOjEwMDAwMDB9.sig"
	t.Setenv("CARACAL_COORDINATOR_URL", "http://coord")
	t.Setenv("CARACAL_ZONE_ID", "z")
	t.Setenv("CARACAL_APPLICATION_ID", "app")
	t.Setenv("CARACAL_BOOTSTRAP_TOKEN", expired)
	if _, err := sdk.FromEnv(); err == nil {
		t.Fatal("expected error for expired bootstrap token")
	}
}

func TestFromEnvRejectsAlgNoneJWT(t *testing.T) {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`))
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"exp":4000000000}`))
	t.Setenv("CARACAL_COORDINATOR_URL", "http://coord")
	t.Setenv("CARACAL_ZONE_ID", "z")
	t.Setenv("CARACAL_APPLICATION_ID", "app")
	t.Setenv("CARACAL_BOOTSTRAP_TOKEN", header+"."+payload+".")
	if _, err := sdk.FromEnv(); err == nil || !strings.Contains(err.Error(), `alg "none"`) {
		t.Fatalf("expected alg none rejection, got %v", err)
	}
}

func TestFromEnvSortsResourcesLongestFirst(t *testing.T) {
	t.Setenv("CARACAL_COORDINATOR_URL", "http://coord")
	t.Setenv("CARACAL_ZONE_ID", "z")
	t.Setenv("CARACAL_APPLICATION_ID", "app")
	t.Setenv("CARACAL_BOOTSTRAP_TOKEN", "tok")
	t.Setenv("CARACAL_RESOURCES", strings.Join([]string{
		"short=https://api.example.com/v1",
		"long=https://api.example.com/v1/accounts/treasury",
		"mid=https://api.example.com/v1/accounts",
	}, ","))
	c, err := sdk.FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if len(c.Resources) != 3 || c.Resources[0].ResourceID != "long" ||
		c.Resources[1].ResourceID != "mid" || c.Resources[2].ResourceID != "short" {
		t.Fatalf("bindings not sorted longest-first: %+v", c.Resources)
	}
}

func TestFromEnvResourceBindingsFileObjectAndEnvPrecedence(t *testing.T) {
	dir := t.TempDir()
	bindingsPath := filepath.Join(dir, "resources.json")
	if err := os.WriteFile(bindingsPath, []byte(`{
		"calendar": "https://file.example.com/v1",
		"billing": "https://billing.example.com"
	}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CARACAL_COORDINATOR_URL", "http://coord")
	t.Setenv("CARACAL_ZONE_ID", "z")
	t.Setenv("CARACAL_APPLICATION_ID", "app")
	t.Setenv("CARACAL_BOOTSTRAP_TOKEN", "tok")
	t.Setenv("CARACAL_RESOURCES_FILE", bindingsPath)
	t.Setenv("CARACAL_RESOURCES", "calendar=https://env.example.com/v2")
	c, err := sdk.FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	got := resourceBindingMap(c.Resources)
	if got["calendar"] != "https://env.example.com/v2" {
		t.Fatalf("expected env binding precedence, got %#v", got)
	}
	if got["billing"] != "https://billing.example.com" {
		t.Fatalf("expected file binding, got %#v", got)
	}
	if len(got) != 2 {
		t.Fatalf("expected deduplicated bindings, got %#v", c.Resources)
	}
}

func TestFromConfigHonorsResourceBindingsFileAndEnv(t *testing.T) {
	var gotResources []string
	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		gotResources = r.Form["resource"]
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"fresh-root","token_type":"Bearer","expires_in":3600}`))
	}))
	defer sts.Close()
	dir := t.TempDir()
	secretPath := filepath.Join(dir, "secret")
	if err := os.WriteFile(secretPath, []byte("secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	bindingsPath := filepath.Join(dir, "resources.json")
	if err := os.WriteFile(bindingsPath, []byte(`[
		{"resource_id":"calendar","upstream_prefix":"https://file.example.com/v1"},
		{"resource_id":"billing","upstream_prefix":"https://billing.example.com"}
	]`), 0o600); err != nil {
		t.Fatal(err)
	}
	profilePath := filepath.Join(dir, "caracal.toml")
	profile := fmt.Sprintf(`coordinator_url = "http://coord"
sts_url = %q
zone_id = "z"
application_id = "app"
app_client_secret_file = %q
`, sts.URL, secretPath)
	if err := os.WriteFile(profilePath, []byte(profile), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CARACAL_RESOURCES_FILE", bindingsPath)
	t.Setenv("CARACAL_RESOURCES", "calendar=https://env.example.com/v2")
	c, err := sdk.FromConfig(profilePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Headers(context.Background(), sdk.CallOptions{AsApplication: true}); err != nil {
		t.Fatal(err)
	}
	if strings.Join(compactSorted(gotResources), ",") != "billing,calendar" {
		t.Fatalf("unexpected resources: %#v", gotResources)
	}
	got := resourceBindingMap(c.Resources)
	if got["calendar"] != "https://env.example.com/v2" || got["billing"] != "https://billing.example.com" {
		t.Fatalf("unexpected bindings: %#v", got)
	}
}

func TestFromEnvRejectsMalformedResources(t *testing.T) {
	t.Setenv("CARACAL_COORDINATOR_URL", "http://coord")
	t.Setenv("CARACAL_ZONE_ID", "z")
	t.Setenv("CARACAL_APPLICATION_ID", "app")
	t.Setenv("CARACAL_BOOTSTRAP_TOKEN", "tok")
	t.Setenv("CARACAL_RESOURCES", "calendar=not-a-url")
	if _, err := sdk.FromEnv(); err == nil {
		t.Fatal("expected malformed resource error")
	}
}
func TestFromEnvRejectsMalformedResourceBindingsFile(t *testing.T) {
	dir := t.TempDir()
	bindingsPath := filepath.Join(dir, "resources.json")
	if err := os.WriteFile(bindingsPath, []byte(`[
		{"resource_id":"calendar","upstream_prefix":"not-a-url"},
		{"resource_id":"billing","upstream_prefix":"https://billing.example.com","extra":true}
	]`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CARACAL_COORDINATOR_URL", "http://coord")
	t.Setenv("CARACAL_ZONE_ID", "z")
	t.Setenv("CARACAL_APPLICATION_ID", "app")
	t.Setenv("CARACAL_BOOTSTRAP_TOKEN", "tok")
	t.Setenv("CARACAL_RESOURCES_FILE", bindingsPath)
	if _, err := sdk.FromEnv(); err == nil || !strings.Contains(err.Error(), "invalid CARACAL_RESOURCES_FILE") {
		t.Fatalf("expected malformed resource file error, got %v", err)
	}
}

func resourceBindingMap(bindings []sdk.ResourceBinding) map[string]string {
	out := map[string]string{}
	for _, binding := range bindings {
		out[binding.ResourceID] = binding.UpstreamPrefix
	}
	return out
}

func TestFromClientSecretCustomHTTPClient(t *testing.T) {
	var gotCalled bool
	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"custom-token","token_type":"Bearer","expires_in":3600}`))
	}))
	defer sts.Close()

	customClient := &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			gotCalled = true
			return http.DefaultTransport.RoundTrip(req)
		}),
	}

	c, err := sdk.FromClientSecret(sdk.ClientSecretOptions{
		CoordinatorURL: "http://coord",
		STSURL:         sts.URL,
		ZoneID:         "z",
		ApplicationID:  "app",
		ClientSecret:   "secret",
		Resources:      []string{"calendar"},
		HTTPClient:     customClient,
	})
	if err != nil {
		t.Fatal(err)
	}

	h, err := c.Headers(context.Background(), sdk.CallOptions{AsApplication: true})
	if err != nil {
		t.Fatal(err)
	}

	if h.Get(sdk.HeaderAuthorization) != "Bearer custom-token" {
		t.Fatalf("unexpected authorization: %s", h.Get(sdk.HeaderAuthorization))
	}
	if !gotCalled {
		t.Fatal("expected custom client to be called")
	}
}

type roundTripFunc func(req *http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestOnEventForwardsCoordinatorAndExchangeEvents(t *testing.T) {
	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"fresh-root","token_type":"Bearer","expires_in":3600}`))
	}))
	defer sts.Close()
	coord := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/agents") {
			_, _ = w.Write([]byte(`{"agent_session_id":"agent-1"}`))
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer coord.Close()

	c, err := sdk.FromClientSecret(sdk.ClientSecretOptions{
		CoordinatorURL: coord.URL,
		STSURL:         sts.URL,
		ZoneID:         "z",
		ApplicationID:  "app",
		ClientSecret:   "secret",
		Resources:      []string{"resource://pipernet"},
	})
	if err != nil {
		t.Fatal(err)
	}
	var events []oauth.Event
	c.OnEvent(func(event oauth.Event) {
		events = append(events, event)
		panic("sink failure")
	})

	if _, err := c.Headers(context.Background(), sdk.CallOptions{AsApplication: true}); err != nil {
		t.Fatal(err)
	}
	if err := c.Session(context.Background(), func(context.Context) error { return nil }); err != nil {
		t.Fatal(err)
	}

	var types []string
	for _, event := range events {
		types = append(types, event.Type)
	}
	if len(events) < 3 || types[0] != "token.exchange" {
		t.Fatalf("unexpected event sequence: %v", types)
	}
	if !events[0].Ok || events[0].Cached {
		t.Fatalf("unexpected exchange event: %+v", events[0])
	}
	sawSpawn := false
	for _, event := range events[1:] {
		if !event.Ok {
			t.Fatalf("unexpected failed event: %+v", event)
		}
		if event.Type == "coordinator.call" && event.Method == http.MethodPost && strings.HasSuffix(event.Path, "/agents") {
			sawSpawn = true
		}
	}
	if !sawSpawn {
		t.Fatal("expected a coordinator.call event for the Session-start request")
	}
}

func TestOnEventDisposerStopsDelivery(t *testing.T) {
	coord := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/agents") {
			_, _ = w.Write([]byte(`{"agent_session_id":"agent-1"}`))
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer coord.Close()
	c := &sdk.Caracal{
		Coordinator:   &sdk.CoordinatorClient{BaseURL: coord.URL},
		ZoneID:        "z",
		ApplicationID: "app",
		SubjectToken:  "tok",
	}
	var events []oauth.Event
	dispose := c.OnEvent(func(event oauth.Event) { events = append(events, event) })

	if err := c.Session(context.Background(), func(context.Context) error { return nil }); err != nil {
		t.Fatal(err)
	}
	delivered := len(events)
	if delivered == 0 {
		t.Fatal("expected events before disposal")
	}
	dispose()
	if err := c.Session(context.Background(), func(context.Context) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if len(events) != delivered {
		t.Fatalf("expected no delivery after disposal: %d -> %d", delivered, len(events))
	}
}

func TestIdentityExposesActingIdentity(t *testing.T) {
	c := &sdk.Caracal{ZoneID: "z", ApplicationID: "app", SubjectToken: "tok"}
	zoneID, applicationID, err := c.Identity(context.Background())
	if err != nil || zoneID != "z" || applicationID != "app" {
		t.Fatalf("unexpected identity: %s %s %v", zoneID, applicationID, err)
	}
	if _, _, err := (&sdk.Caracal{SubjectToken: "tok"}).Identity(context.Background()); err == nil {
		t.Fatal("expected unresolved identity to fail closed")
	}
}

func TestAcceptDelegationValidatesAgainstInboundList(t *testing.T) {
	status := "active"
	coord := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/delegations/inbound/") {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"id":"edge-42","status":%q}`, status)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer coord.Close()
	c := &sdk.Caracal{
		Coordinator:   &sdk.CoordinatorClient{BaseURL: coord.URL},
		ZoneID:        "z",
		ApplicationID: "app",
		SubjectToken:  "tok",
	}
	ctx := sdk.Bind(context.Background(), sdk.CaracalContext{
		SubjectToken:  "tok",
		ZoneID:        "z",
		ApplicationID: "app",
		SessionID:     "s1",
	})
	var accepts []oauth.Event
	c.OnEvent(func(event oauth.Event) {
		if event.Type == "delegation.accept" {
			accepts = append(accepts, event)
		}
	})

	accepted, err := c.AcceptDelegation(ctx, "edge-42", sdk.AcceptDelegationOptions{Validate: true})
	if err != nil {
		t.Fatal(err)
	}
	if cur, _ := sdk.Current(accepted); cur.DelegationID != "edge-42" {
		t.Fatalf("unexpected accepted context: %+v", cur)
	}

	status = "revoked"
	if _, err := c.AcceptDelegation(ctx, "edge-42", sdk.AcceptDelegationOptions{Validate: true}); err == nil || !strings.Contains(err.Error(), "not live for session s1") {
		t.Fatalf("expected a revoked delegation to be rejected, got %v", err)
	}

	if _, err := c.AcceptDelegation(ctx, "edge-77"); err != nil {
		t.Fatalf("expected unvalidated acceptance to skip the pre-flight: %v", err)
	}

	if len(accepts) != 3 {
		t.Fatalf("expected 3 delegation.accept events, got %d", len(accepts))
	}
	for i, want := range []struct {
		id string
		ok bool
	}{{"edge-42", true}, {"edge-42", false}, {"edge-77", true}} {
		if accepts[i].DelegationID != want.id || accepts[i].Ok != want.ok || accepts[i].SessionID != "s1" {
			t.Fatalf("unexpected event %d: %+v", i, accepts[i])
		}
	}
}

func TestAttachSessionFacadeRevalidatesPersistedSession(t *testing.T) {
	paths := []string{}
	coord := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.Method+" "+r.URL.Path)
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"status":"active","heartbeat_deadline_at":"2026-07-09T12:00:00Z","lease_generation":2}`)
	}))
	defer coord.Close()
	c := &sdk.Caracal{
		Coordinator:   &sdk.CoordinatorClient{BaseURL: coord.URL},
		ZoneID:        "z",
		ApplicationID: "app",
		SubjectToken:  "tok",
	}
	ends := []string{}
	c.OnSessionEnd(func(_ context.Context, cc sdk.CaracalContext) error {
		ends = append(ends, cc.SessionID)
		return nil
	})

	handle, err := c.AttachSession(context.Background(), "agent-persisted", sdk.AttachSessionOptions{HeartbeatInterval: -1})
	if err != nil {
		t.Fatal(err)
	}
	if handle.SessionID() != "agent-persisted" || handle.DeadlineAt().IsZero() {
		t.Fatalf("unexpected handle: %s %v", handle.SessionID(), handle.DeadlineAt())
	}
	if paths[0] != "POST /zones/z/agents/agent-persisted/lease" {
		t.Fatalf("expected an immediate fenced lease acquisition, got %v", paths)
	}
	if err := handle.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(ends) != 1 || ends[0] != "agent-persisted" {
		t.Fatalf("expected the end hook to fire once: %v", ends)
	}
}

func TestPropagationDefaultsToGatewayOnlyAndAllowsExplicitAlways(t *testing.T) {
	type seen struct {
		target      string
		traceparent string
		baggage     string
	}
	calls := []seen{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, seen{target: r.URL.RequestURI(), traceparent: r.Header.Get("traceparent"), baggage: r.Header.Get("baggage")})
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()

	c := &sdk.Caracal{
		ZoneID:        "z",
		ApplicationID: "app",
		SubjectToken:  "tok",
		Coordinator:   &sdk.CoordinatorClient{BaseURL: "http://coord"},
	}
	client := c.Transport(nil, sdk.CallOptions{AsApplication: true})
	res, err := client.Get(upstream.URL + "/data")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if calls[0].traceparent != "" || calls[0].baggage != "" {
		t.Fatalf("expected no envelope on a non-gateway host: %+v", calls[0])
	}

	gatewayClient := c.Transport(nil, sdk.CallOptions{AsApplication: true, Propagation: sdk.PropagationAlways})
	res, err = gatewayClient.Get(upstream.URL + "/data")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if calls[1].traceparent == "" {
		t.Fatalf("expected explicit always propagation to carry the envelope: %+v", calls[1])
	}
}
