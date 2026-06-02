// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Caracal drop-in client smoke tests for env loading, header injection, and middleware binding.

package sdk_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	sdk "github.com/garudex-labs/caracal/packages/sdk/go"
)

func TestFromEnvMissing(t *testing.T) {
	t.Setenv("CARACAL_COORDINATOR_URL", "")
	t.Setenv("CARACAL_ZONE_ID", "")
	t.Setenv("CARACAL_APPLICATION_ID", "")
	t.Setenv("CARACAL_SUBJECT_TOKEN", "")
	if _, err := sdk.FromEnv(); err == nil {
		t.Fatal("expected error for missing env")
	}
}

func TestFromEnvOK(t *testing.T) {
	t.Setenv("CARACAL_ZONE_ID", "z1")
	t.Setenv("CARACAL_APPLICATION_ID", "app1")
	t.Setenv("CARACAL_SUBJECT_TOKEN", "tok1")
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
	h, err := c.Headers(context.Background(), sdk.RootOptions{AllowRoot: true})
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

func TestFromEnvClientSecretKeepsCredentialResourcesWithExplicitAppResources(t *testing.T) {
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
	t.Setenv("CARACAL_RUN_CREDENTIALS", `[{"resource":"calendar","upstream_prefix":"https://calendar.example.com"}]`)
	t.Setenv("CARACAL_APP_RESOURCES", "billing")

	c, err := sdk.FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Headers(context.Background(), sdk.RootOptions{AllowRoot: true}); err != nil {
		t.Fatal(err)
	}
	if strings.Join(compactSorted(gotResources), ",") != "billing,calendar" {
		t.Fatalf("unexpected resources: %#v", gotResources)
	}
	got := resourceBindingMap(c.Resources)
	if got["calendar"] != "https://calendar.example.com" {
		t.Fatalf("expected credential binding, got %#v", got)
	}
}

func TestFromEnvAutoDetectsCredentialFiles(t *testing.T) {
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
	t.Setenv("CARACAL_STS_URL", sts.URL)

	c, err := sdk.FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Headers(context.Background(), sdk.RootOptions{AllowRoot: true}); err != nil {
		t.Fatal(err)
	}
	if gotSecret != "secret" {
		t.Fatalf("expected auto-detected client secret, got %q", gotSecret)
	}
	if strings.Join(compactSorted(gotResources), ",") != "calendar" {
		t.Fatalf("unexpected resources: %#v", gotResources)
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
	profile := `coordinator_url = "http://coord"
sts_url = "` + sts.URL + `"
gateway_url = "https://gateway.example.com/proxy"
zone_id = "z"
application_id = "app"
app_client_secret_file = "` + secretPath + `"

[[credentials]]
resource = "calendar"

[[credentials]]
resource = "billing"
upstream_prefix = "https://billing.example.com"
`
	if err := os.WriteFile(profilePath, []byte(profile), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := sdk.FromConfig(profilePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Headers(context.Background(), sdk.RootOptions{AllowRoot: true}); err != nil {
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
	h, err := c.Headers(context.Background(), sdk.RootOptions{AllowRoot: true})
	if err != nil {
		t.Fatal(err)
	}
	if h.Get(sdk.HeaderAuthorization) != "Bearer tok" {
		t.Fatalf("missing authorization: %v", h)
	}
	if sdk.ParseTraceparent(h.Get(sdk.HeaderTraceparent)) == "" {
		t.Fatalf("missing traceparent: %v", h)
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
		SubjectToken:   "tok",
		ZoneID:         "z",
		ClientID:       "a",
		AgentSessionID: "sess9",
		Hop:            1,
	})
	client := c.Transport(nil)
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
		SubjectToken: "tok",
		ZoneID:       "z",
		ClientID:     "a",
		Hop:          1,
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
		SubjectToken: "tok",
		ZoneID:       "z",
		ClientID:     "a",
		Hop:          1,
	})
	header := http.Header{}
	header.Set("Content-Type", "application/json")
	resp, err := c.Fetch(ctx, http.MethodPost, "resource://calendar", "events?limit=10", nil, header)
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
}

func TestHTTPClientRejectsUnboundRootByDefault(t *testing.T) {
	c := &sdk.Caracal{ZoneID: "z", ApplicationID: "a", SubjectToken: "tok"}
	client := c.Transport(nil)
	req, _ := http.NewRequestWithContext(context.Background(), "GET", "https://example.com", nil)
	if _, err := client.Do(req); err == nil {
		t.Fatal("expected missing context error")
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
			_, _ = w.Write([]byte(`{"agent_session_id":"agent-1"}`))
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/delegations"):
			_, _ = w.Write([]byte(`{"delegation_edge_id":"edge-1"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	client := &sdk.CoordinatorClient{BaseURL: srv.URL}
	agent, err := sdk.SpawnAgent(context.Background(), client, "tok", sdk.SpawnRequest{
		ZoneID:        "z",
		ApplicationID: "app",
		Kind:          sdk.KindEphemeral,
		TTLSeconds:    60,
	})
	if err != nil {
		t.Fatal(err)
	}
	if agent.AgentSessionID != "agent-1" {
		t.Fatalf("expected agent-1, got %q", agent.AgentSessionID)
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
	if edge.DelegationEdgeID != "edge-1" {
		t.Fatalf("expected edge-1, got %q", edge.DelegationEdgeID)
	}
	if len(bodies) != 2 || bodies[0]["ttl_seconds"] != float64(60) || bodies[1]["ttl_seconds"] != float64(30) {
		t.Fatalf("unexpected coordinator request bodies: %#v", bodies)
	}
}

func TestSpawnAgentDerivesIdempotencyKey(t *testing.T) {
	var seen http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Clone()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"agent_session_id":"a-1"}`))
	}))
	defer srv.Close()
	client := &sdk.CoordinatorClient{BaseURL: srv.URL}
	_, err := sdk.SpawnAgent(context.Background(), client, "tok", sdk.SpawnRequest{
		ZoneID: "z", ApplicationID: "app", SubjectSessionID: "sid", ParentID: "parent",
	})
	if err != nil {
		t.Fatal(err)
	}
	key := seen.Get("Idempotency-Key")
	if len(key) != 64 {
		t.Fatalf("expected 64-char idempotency key, got %q", key)
	}
}

func TestSpawnAgentExplicitIdempotencyKey(t *testing.T) {
	var seen http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Clone()
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"agent_session_id":"a-1"}`))
	}))
	defer srv.Close()
	client := &sdk.CoordinatorClient{BaseURL: srv.URL}
	_, err := sdk.SpawnAgent(context.Background(), client, "tok", sdk.SpawnRequest{
		ZoneID: "z", ApplicationID: "app", IdempotencyKey: "user-key",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := seen.Get("Idempotency-Key"); got != "user-key" {
		t.Fatalf("expected user-key, got %q", got)
	}
}

func TestFromEnvRejectsExpiredJWT(t *testing.T) {
	// Header.Payload.Sig where payload claims exp=1000000 (year 1970).
	expired := "eyJhbGciOiJFUzI1NiJ9.eyJleHAiOjEwMDAwMDB9.sig"
	t.Setenv("CARACAL_COORDINATOR_URL", "http://coord")
	t.Setenv("CARACAL_ZONE_ID", "z")
	t.Setenv("CARACAL_APPLICATION_ID", "app")
	t.Setenv("CARACAL_SUBJECT_TOKEN", expired)
	if _, err := sdk.FromEnv(); err == nil {
		t.Fatal("expected error for expired bootstrap token")
	}
}

func TestFromEnvSortsResourcesLongestFirst(t *testing.T) {
	t.Setenv("CARACAL_COORDINATOR_URL", "http://coord")
	t.Setenv("CARACAL_ZONE_ID", "z")
	t.Setenv("CARACAL_APPLICATION_ID", "app")
	t.Setenv("CARACAL_SUBJECT_TOKEN", "tok")
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
	t.Setenv("CARACAL_SUBJECT_TOKEN", "tok")
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
	profile := `coordinator_url = "http://coord"
sts_url = "` + sts.URL + `"
zone_id = "z"
application_id = "app"
app_client_secret_file = "` + secretPath + `"
`
	if err := os.WriteFile(profilePath, []byte(profile), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CARACAL_RESOURCES_FILE", bindingsPath)
	t.Setenv("CARACAL_RESOURCES", "calendar=https://env.example.com/v2")
	c, err := sdk.FromConfig(profilePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Headers(context.Background(), sdk.RootOptions{AllowRoot: true}); err != nil {
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
	t.Setenv("CARACAL_SUBJECT_TOKEN", "tok")
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
	t.Setenv("CARACAL_SUBJECT_TOKEN", "tok")
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
