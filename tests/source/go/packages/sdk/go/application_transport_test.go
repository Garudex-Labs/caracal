// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for the Go SDK governed transport own-authority cycle and credentials resolver.

package sdk_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	sdk "github.com/garudex-labs/caracal/packages/sdk/go"
)

const governedResource = "resource://pipernet"
const governedUpstream = "https://api.pipernet.example"

type governedPlatform struct {
	mu             sync.Mutex
	mintForms      []url.Values
	spawnBodies    []map[string]any
	spawnKeys      []string
	delegations    []map[string]any
	terminated     []string
	agentN         int
	mandateN       int
	failDelegation bool
}

func (p *governedPlatform) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/oauth/2/token":
			_ = r.ParseForm()
			p.mu.Lock()
			form := url.Values{}
			for k, v := range r.PostForm {
				form[k] = v
			}
			p.mintForms = append(p.mintForms, form)
			var token string
			if form.Get("agent_session_id") == "" && form.Get("scope") == "agent:lifecycle" {
				token = "boot-token"
			} else {
				p.mandateN++
				token = fmt.Sprintf("mandate-%d", p.mandateN)
			}
			p.mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"access_token":%q,"token_type":"Bearer","expires_in":900}`, token)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/agents"):
			body := map[string]any{}
			_ = json.NewDecoder(r.Body).Decode(&body)
			p.mu.Lock()
			p.spawnBodies = append(p.spawnBodies, body)
			p.spawnKeys = append(p.spawnKeys, r.Header.Get("Idempotency-Key"))
			p.agentN++
			id := fmt.Sprintf("agent-%d", p.agentN)
			p.mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"agent_session_id":%q}`, id)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/delegations"):
			body := map[string]any{}
			_ = json.NewDecoder(r.Body).Decode(&body)
			p.mu.Lock()
			p.delegations = append(p.delegations, body)
			fail := p.failDelegation
			p.mu.Unlock()
			if fail {
				w.WriteHeader(http.StatusForbidden)
				fmt.Fprint(w, `{"error":"delegation_status"}`)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"delegation_edge_id":"edge-1","scopes":["data:read"]}`)
		case r.Method == http.MethodDelete && strings.Contains(r.URL.Path, "/agents/"):
			parts := strings.Split(r.URL.Path, "/")
			p.mu.Lock()
			p.terminated = append(p.terminated, parts[len(parts)-1])
			p.mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
}

func (p *governedPlatform) finalMints() []url.Values {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := []url.Values{}
	for _, form := range p.mintForms {
		if form.Get("agent_session_id") != "" {
			out = append(out, form)
		}
	}
	return out
}

func governedEcho() *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"presented": r.Header.Get("Authorization"),
			"resource":  r.Header.Get("X-Caracal-Resource"),
			"target":    r.URL.RequestURI(),
		})
	}))
}

func governedClient(t *testing.T, platformURL, gatewayURL string, opts func(*sdk.ClientSecretOptions)) *sdk.Caracal {
	t.Helper()
	options := sdk.ClientSecretOptions{
		CoordinatorURL:   platformURL,
		STSURL:           platformURL,
		ZoneID:           "z",
		ApplicationID:    "app",
		ClientSecret:     "secret",
		Resources:        []string{governedResource},
		ResourceBindings: []sdk.ResourceBinding{{ResourceID: governedResource, UpstreamPrefix: governedUpstream}},
		GatewayURL:       gatewayURL,
	}
	if opts != nil {
		opts(&options)
	}
	c, err := sdk.FromClientSecret(options)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func governedGet(t *testing.T, client *http.Client, target string) map[string]string {
	t.Helper()
	res, err := client.Get(target)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	out := map[string]string{}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestGovernedTransportRunsOwnAuthorityCycle(t *testing.T) {
	platform := &governedPlatform{}
	server := httptest.NewServer(platform.handler())
	defer server.Close()
	gateway := governedEcho()
	defer gateway.Close()

	c := governedClient(t, server.URL, gateway.URL, nil)
	client, err := c.ApplicationTransport(nil, governedResource, sdk.ApplicationTransportOptions{
		Scopes:            []string{"data:read"},
		Labels:            []string{"worker"},
		MandateTTLSeconds: 300,
	})
	if err != nil {
		t.Fatal(err)
	}

	echo := governedGet(t, client, governedUpstream+"/tasks?x=1")
	if echo["presented"] != "Bearer mandate-1" {
		t.Fatalf("unexpected bearer: %s", echo["presented"])
	}
	if echo["resource"] != governedResource {
		t.Fatalf("unexpected resource header: %s", echo["resource"])
	}
	if echo["target"] != "/tasks?x=1" {
		t.Fatalf("unexpected rewritten target: %s", echo["target"])
	}

	platform.mu.Lock()
	defer platform.mu.Unlock()
	if len(platform.mintForms) != 2 {
		t.Fatalf("expected 2 mints, got %d", len(platform.mintForms))
	}
	boot := platform.mintForms[0]
	if boot.Get("scope") != "agent:lifecycle" || boot.Get("resource") != governedResource || boot.Get("agent_session_id") != "" {
		t.Fatalf("unexpected bootstrap mint form: %v", boot)
	}
	final := platform.mintForms[1]
	if final.Get("zone_id") != "z" || final.Get("application_id") != "app" {
		t.Fatalf("unexpected mint identity: %v", final)
	}
	if final.Get("agent_session_id") != "agent-2" || final.Get("delegation_edge_id") != "edge-1" {
		t.Fatalf("unexpected mint authority: %v", final)
	}
	if final.Get("scope") != "data:read" || final.Get("resource") != governedResource || final.Get("ttl_seconds") != "300" {
		t.Fatalf("unexpected mint request: %v", final)
	}
	if len(platform.spawnBodies) != 2 {
		t.Fatalf("expected 2 spawns, got %d", len(platform.spawnBodies))
	}
	for i, body := range platform.spawnBodies {
		if body["application_id"] != "app" || body["lifecycle"] != "task" || body["ttl_seconds"] != float64(420) {
			t.Fatalf("unexpected spawn body: %v", body)
		}
		labels, _ := body["labels"].([]any)
		if len(labels) != 1 || labels[0] != "worker" {
			t.Fatalf("unexpected spawn labels: %v", body["labels"])
		}
		if platform.spawnKeys[i] == "" {
			t.Fatal("expected idempotency key on spawn")
		}
	}
	if platform.spawnKeys[0] == platform.spawnKeys[1] {
		t.Fatal("expected distinct idempotency keys")
	}
	if len(platform.delegations) != 1 {
		t.Fatalf("expected 1 delegation, got %d", len(platform.delegations))
	}
	edge := platform.delegations[0]
	if edge["issuer_application_id"] != "app" || edge["receiver_application_id"] != "app" {
		t.Fatalf("unexpected delegation parties: %v", edge)
	}
	if edge["source_session_id"] != "agent-1" || edge["target_session_id"] != "agent-2" {
		t.Fatalf("unexpected delegation sessions: %v", edge)
	}
	if edge["ttl_seconds"] != float64(420) {
		t.Fatalf("unexpected delegation ttl: %v", edge["ttl_seconds"])
	}
	scopes, _ := edge["scopes"].([]any)
	if len(scopes) != 1 || scopes[0] != "data:read" {
		t.Fatalf("unexpected delegation scopes: %v", edge["scopes"])
	}
	constraints, _ := edge["constraints"].(map[string]any)
	resources, _ := constraints["resources"].([]any)
	if len(resources) != 1 || resources[0] != governedResource {
		t.Fatalf("unexpected delegation constraints: %v", edge["constraints"])
	}
}

func TestGovernedTransportDefaultsLabelsAndTTL(t *testing.T) {
	platform := &governedPlatform{}
	server := httptest.NewServer(platform.handler())
	defer server.Close()
	gateway := governedEcho()
	defer gateway.Close()

	c := governedClient(t, server.URL, gateway.URL, nil)
	client, err := c.ApplicationTransport(nil, governedResource, sdk.ApplicationTransportOptions{
		Scopes: []string{"data:write", "data:read", "data:read"},
	})
	if err != nil {
		t.Fatal(err)
	}
	governedGet(t, client, governedUpstream+"/tasks")

	platform.mu.Lock()
	defer platform.mu.Unlock()
	for _, body := range platform.spawnBodies {
		if body["ttl_seconds"] != float64(1020) {
			t.Fatalf("unexpected default session ttl: %v", body["ttl_seconds"])
		}
		labels, _ := body["labels"].([]any)
		if len(labels) != 1 || labels[0] != "app" {
			t.Fatalf("unexpected default labels: %v", body["labels"])
		}
	}
	final := platform.mintForms[len(platform.mintForms)-1]
	if final.Get("ttl_seconds") != "900" {
		t.Fatalf("unexpected default mandate ttl: %v", final.Get("ttl_seconds"))
	}
	if final.Get("scope") != "data:read data:write" {
		t.Fatalf("expected sorted deduplicated scopes, got %q", final.Get("scope"))
	}
}

func TestGovernedTransportCachesMandateAcrossRequests(t *testing.T) {
	platform := &governedPlatform{}
	server := httptest.NewServer(platform.handler())
	defer server.Close()
	gateway := governedEcho()
	defer gateway.Close()

	c := governedClient(t, server.URL, gateway.URL, nil)
	client, err := c.ApplicationTransport(nil, governedResource, sdk.ApplicationTransportOptions{Scopes: []string{"data:read"}})
	if err != nil {
		t.Fatal(err)
	}
	first := governedGet(t, client, governedUpstream+"/tasks")
	second := governedGet(t, client, governedUpstream+"/other")
	if first["presented"] != "Bearer mandate-1" || second["presented"] != "Bearer mandate-1" {
		t.Fatalf("expected shared cached mandate, got %s and %s", first["presented"], second["presented"])
	}
	if mints := platform.finalMints(); len(mints) != 1 {
		t.Fatalf("expected 1 provisioning cycle, got %d", len(mints))
	}
	platform.mu.Lock()
	defer platform.mu.Unlock()
	if platform.agentN != 2 {
		t.Fatalf("expected 2 spawned sessions, got %d", platform.agentN)
	}
}

func TestGovernedTransportCacheSeparatesLabelsAndTTL(t *testing.T) {
	platform := &governedPlatform{}
	server := httptest.NewServer(platform.handler())
	defer server.Close()
	gateway := governedEcho()
	defer gateway.Close()

	c := governedClient(t, server.URL, gateway.URL, nil)
	worker, err := c.ApplicationTransport(nil, governedResource, sdk.ApplicationTransportOptions{
		Scopes:            []string{"data:read"},
		Labels:            []string{"a b"},
		MandateTTLSeconds: 300,
	})
	if err != nil {
		t.Fatal(err)
	}
	admin, err := c.ApplicationTransport(nil, governedResource, sdk.ApplicationTransportOptions{
		Scopes:            []string{"data:read"},
		Labels:            []string{"a", "b"},
		MandateTTLSeconds: 60,
	})
	if err != nil {
		t.Fatal(err)
	}

	governedGet(t, worker, governedUpstream+"/worker")
	governedGet(t, admin, governedUpstream+"/admin")

	if mints := platform.finalMints(); len(mints) != 2 {
		t.Fatalf("expected 2 provisioning cycles, got %d", len(mints))
	} else if mints[1].Get("ttl_seconds") != "60" {
		t.Fatalf("expected second mandate ttl 60, got %v", mints[1])
	}
	platform.mu.Lock()
	defer platform.mu.Unlock()
	if platform.agentN != 4 {
		t.Fatalf("expected 4 spawned sessions, got %d", platform.agentN)
	}
	labels, _ := platform.spawnBodies[2]["labels"].([]any)
	if len(labels) != 2 || labels[0] != "a" || labels[1] != "b" {
		t.Fatalf("expected second cycle split labels, got %v", platform.spawnBodies[2]["labels"])
	}
	if platform.spawnBodies[2]["ttl_seconds"] != float64(180) {
		t.Fatalf("expected second session ttl 180, got %v", platform.spawnBodies[2]["ttl_seconds"])
	}
}

func TestGovernedTransportSharesConcurrentCycle(t *testing.T) {
	platform := &governedPlatform{}
	server := httptest.NewServer(platform.handler())
	defer server.Close()
	gateway := governedEcho()
	defer gateway.Close()

	c := governedClient(t, server.URL, gateway.URL, nil)
	client, err := c.ApplicationTransport(nil, governedResource, sdk.ApplicationTransportOptions{Scopes: []string{"data:read"}})
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	tokens := make([]string, 8)
	for i := range tokens {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			res, err := client.Get(governedUpstream + "/tasks")
			if err != nil {
				t.Error(err)
				return
			}
			defer res.Body.Close()
			out := map[string]string{}
			_ = json.NewDecoder(res.Body).Decode(&out)
			tokens[i] = out["presented"]
		}(i)
	}
	wg.Wait()
	for _, token := range tokens {
		if token != "Bearer mandate-1" {
			t.Fatalf("expected single shared mandate, got %v", tokens)
		}
	}
	if mints := platform.finalMints(); len(mints) != 1 {
		t.Fatalf("expected 1 provisioning cycle, got %d", len(mints))
	}
}

func TestGovernedTransportTerminatesSessionsOnDelegationFailure(t *testing.T) {
	platform := &governedPlatform{failDelegation: true}
	server := httptest.NewServer(platform.handler())
	defer server.Close()
	gateway := governedEcho()
	defer gateway.Close()

	c := governedClient(t, server.URL, gateway.URL, nil)
	client, err := c.ApplicationTransport(nil, governedResource, sdk.ApplicationTransportOptions{Scopes: []string{"data:read"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Get(governedUpstream + "/tasks"); err == nil {
		t.Fatal("expected delegation failure to propagate")
	}
	platform.mu.Lock()
	defer platform.mu.Unlock()
	if len(platform.terminated) != 2 || platform.terminated[0] != "agent-1" || platform.terminated[1] != "agent-2" {
		t.Fatalf("expected both sessions terminated, got %v", platform.terminated)
	}
	if platform.mandateN != 0 {
		t.Fatalf("expected no final mandate, got %d", platform.mandateN)
	}
}

func TestGovernedTransportGuards(t *testing.T) {
	subjectOnly := &sdk.Caracal{ZoneID: "z", ApplicationID: "app", SubjectToken: "tok"}
	if _, err := subjectOnly.ApplicationTransport(nil, governedResource, sdk.ApplicationTransportOptions{Scopes: []string{"data:read"}}); err == nil || !strings.Contains(err.Error(), "client-secret configuration") {
		t.Fatalf("expected client-secret guard, got %v", err)
	}

	platform := &governedPlatform{}
	server := httptest.NewServer(platform.handler())
	defer server.Close()
	c := governedClient(t, server.URL, "", nil)
	if _, err := c.ApplicationTransport(nil, "  ", sdk.ApplicationTransportOptions{Scopes: []string{"data:read"}}); err == nil || !strings.Contains(err.Error(), "requires resourceID") {
		t.Fatalf("expected resourceID guard, got %v", err)
	}
	if _, err := c.ApplicationTransport(nil, governedResource, sdk.ApplicationTransportOptions{}); err == nil || !strings.Contains(err.Error(), "at least one scope") {
		t.Fatalf("expected scopes guard, got %v", err)
	}
}

func TestGovernedTransportResolverFailsClosedAndRecovers(t *testing.T) {
	platform := &governedPlatform{}
	server := httptest.NewServer(platform.handler())
	defer server.Close()
	gateway := governedEcho()
	defer gateway.Close()

	var mu sync.Mutex
	var current *sdk.ClientCredentials
	resolver := func(context.Context) (*sdk.ClientCredentials, error) {
		mu.Lock()
		defer mu.Unlock()
		return current, nil
	}
	c := governedClient(t, server.URL, gateway.URL, func(o *sdk.ClientSecretOptions) {
		o.ZoneID, o.ApplicationID, o.ClientSecret = "", "", ""
		o.Resources = nil
		o.Credentials = resolver
	})
	client, err := c.ApplicationTransport(nil, governedResource, sdk.ApplicationTransportOptions{Scopes: []string{"data:read"}})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := client.Get(governedUpstream + "/tasks"); !errors.Is(err, sdk.ErrCredentialsUnavailable) {
		t.Fatalf("expected ErrCredentialsUnavailable, got %v", err)
	}
	platform.mu.Lock()
	untouched := len(platform.mintForms) == 0 && platform.agentN == 0
	platform.mu.Unlock()
	if !untouched {
		t.Fatal("expected no platform calls while credentials are unavailable")
	}

	mu.Lock()
	current = &sdk.ClientCredentials{ZoneID: "z", ApplicationID: "app", ClientSecret: "secret"}
	mu.Unlock()
	echo := governedGet(t, client, governedUpstream+"/tasks")
	if echo["presented"] != "Bearer mandate-1" {
		t.Fatalf("expected recovery after resolver returns credentials, got %s", echo["presented"])
	}
}

func TestGovernedTransportReprovisionsOnIdentityChange(t *testing.T) {
	platform := &governedPlatform{}
	server := httptest.NewServer(platform.handler())
	defer server.Close()
	gateway := governedEcho()
	defer gateway.Close()

	var mu sync.Mutex
	current := &sdk.ClientCredentials{ZoneID: "z", ApplicationID: "app", ClientSecret: "secret"}
	resolver := func(context.Context) (*sdk.ClientCredentials, error) {
		mu.Lock()
		defer mu.Unlock()
		return current, nil
	}
	c := governedClient(t, server.URL, gateway.URL, func(o *sdk.ClientSecretOptions) {
		o.ZoneID, o.ApplicationID, o.ClientSecret = "", "", ""
		o.Resources = nil
		o.Credentials = resolver
	})
	client, err := c.ApplicationTransport(nil, governedResource, sdk.ApplicationTransportOptions{Scopes: []string{"data:read"}})
	if err != nil {
		t.Fatal(err)
	}
	governedGet(t, client, governedUpstream+"/tasks")

	mu.Lock()
	current = &sdk.ClientCredentials{ZoneID: "zone-2", ApplicationID: "app-2", ClientSecret: "secret-2"}
	mu.Unlock()
	echo := governedGet(t, client, governedUpstream+"/tasks")
	if echo["presented"] != "Bearer mandate-2" {
		t.Fatalf("expected fresh mandate under new identity, got %s", echo["presented"])
	}

	mints := platform.finalMints()
	if len(mints) != 2 {
		t.Fatalf("expected 2 provisioning cycles, got %d", len(mints))
	}
	last := mints[len(mints)-1]
	if last.Get("zone_id") != "zone-2" || last.Get("application_id") != "app-2" || last.Get("client_secret") != "secret-2" {
		t.Fatalf("expected mint under new identity, got %v", last)
	}
	platform.mu.Lock()
	defer platform.mu.Unlock()
	if platform.agentN != 4 {
		t.Fatalf("expected 4 spawned sessions across identities, got %d", platform.agentN)
	}
}

func TestFromClientSecretRejectsResolverWithTriple(t *testing.T) {
	resolver := func(context.Context) (*sdk.ClientCredentials, error) { return nil, nil }
	_, err := sdk.FromClientSecret(sdk.ClientSecretOptions{
		CoordinatorURL: "http://coord",
		STSURL:         "http://sts",
		ZoneID:         "z",
		Credentials:    resolver,
	})
	if err == nil || !strings.Contains(err.Error(), "not both") {
		t.Fatalf("expected resolver/triple conflict error, got %v", err)
	}
}

func TestFromClientSecretAllowsEmptyResources(t *testing.T) {
	c, err := sdk.FromClientSecret(sdk.ClientSecretOptions{
		CoordinatorURL: "http://coord",
		STSURL:         "http://sts",
		ZoneID:         "z",
		ApplicationID:  "app",
		ClientSecret:   "secret",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Headers(context.Background(), sdk.CallOptions{AsApplication: true}); err == nil || !strings.Contains(err.Error(), "no resources configured") {
		t.Fatalf("expected lifecycle guard without resources, got %v", err)
	}
}
