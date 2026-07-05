// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for the Caracal facade: lifecycle hooks, delegation wrappers, mandate minting, approval waits, and scoped transport routing.

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
	"time"

	sdk "github.com/garudex-labs/caracal/packages/sdk/go"
)

func TestSpawnFiresRegisteredHooksWithDefaultTTL(t *testing.T) {
	var bodies []map[string]any
	srv := newRecordingCoordinator(t, &bodies)
	c := &sdk.Caracal{
		Coordinator:       &sdk.CoordinatorClient{BaseURL: srv.URL},
		ZoneID:            "z",
		ApplicationID:     "app",
		SubjectToken:      "tok",
		DefaultTTLSeconds: 45,
	}
	var starts, ends []string
	c.OnAgentStart(func(_ context.Context, cc sdk.CaracalContext) error {
		starts = append(starts, cc.AgentSessionID)
		return nil
	})
	c.OnAgentEnd(func(_ context.Context, cc sdk.CaracalContext) error {
		ends = append(ends, cc.AgentSessionID)
		return nil
	})
	ran := false
	if err := c.Spawn(context.Background(), func(ctx context.Context) error {
		ran = true
		if cur, ok := sdk.Current(ctx); !ok || cur.AgentSessionID != "agent-1" {
			t.Errorf("unexpected bound context: %#v", cur)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if !ran || len(starts) != 1 || len(ends) != 1 || starts[0] != "agent-1" || ends[0] != "agent-1" {
		t.Fatalf("hooks not fired: starts=%v ends=%v", starts, ends)
	}
	if len(bodies) == 0 || bodies[0]["ttl_seconds"] != float64(45) {
		t.Fatalf("default ttl not applied: %#v", bodies)
	}
}

func TestSpawnStartHookErrorSkipsCallback(t *testing.T) {
	srv := newRecordingCoordinator(t, nil)
	c := &sdk.Caracal{
		Coordinator:   &sdk.CoordinatorClient{BaseURL: srv.URL},
		ZoneID:        "z",
		ApplicationID: "app",
		SubjectToken:  "tok",
	}
	hookErr := errors.New("start rejected")
	c.OnAgentStart(func(context.Context, sdk.CaracalContext) error { return hookErr })
	if err := c.Spawn(context.Background(), func(context.Context) error {
		t.Error("callback must not run after a start hook failure")
		return nil
	}); !errors.Is(err, hookErr) {
		t.Fatalf("expected hook error, got %v", err)
	}
}

func newRecordingCoordinator(t *testing.T, bodies *[]map[string]any) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/agents"):
			if bodies != nil {
				body := map[string]any{}
				_ = json.NewDecoder(r.Body).Decode(&body)
				*bodies = append(*bodies, body)
			}
			_, _ = w.Write([]byte(`{"agent_session_id":"agent-1","heartbeat_deadline_at":"` + time.Now().Add(30*time.Second).UTC().Format(time.RFC3339Nano) + `"}`))
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/delegations"):
			_, _ = w.Write([]byte(`{"delegation_edge_id":"edge-1"}`))
		case r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestSpawnRefreshesRejectedCachedToken(t *testing.T) {
	var mu sync.Mutex
	mintN := 0
	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		mintN++
		token := fmt.Sprintf("tok-%d", mintN)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"access_token":%q,"token_type":"Bearer","expires_in":3600}`, token)
	}))
	defer sts.Close()
	var bearers []string
	coord := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/agents"):
			bearer := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			bearers = append(bearers, bearer)
			if bearer == "tok-1" {
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = w.Write([]byte(`{"error":"revoked"}`))
				return
			}
			_, _ = w.Write([]byte(`{"agent_session_id":"agent-1"}`))
		case r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		}
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
	if err := c.Spawn(context.Background(), func(context.Context) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if len(bearers) != 2 || bearers[0] != "tok-1" || bearers[1] != "tok-2" {
		t.Fatalf("expected forced refresh after 401, got %v", bearers)
	}
}

func TestSpawnServiceFacadeFiresHooksAndCloseRunsEndHook(t *testing.T) {
	srv := newRecordingCoordinator(t, nil)
	c := &sdk.Caracal{
		Coordinator:   &sdk.CoordinatorClient{BaseURL: srv.URL},
		ZoneID:        "z",
		ApplicationID: "app",
		SubjectToken:  "tok",
	}
	var events []string
	c.OnAgentStart(func(context.Context, sdk.CaracalContext) error {
		events = append(events, "start")
		return nil
	})
	c.OnAgentEnd(func(context.Context, sdk.CaracalContext) error {
		events = append(events, "end")
		return nil
	})
	svc, err := c.SpawnService(context.Background(), sdk.ServiceOptions{HeartbeatInterval: -1})
	if err != nil {
		t.Fatal(err)
	}
	if svc.AgentSessionID() != "agent-1" {
		t.Fatalf("unexpected session: %s", svc.AgentSessionID())
	}
	if err := svc.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if strings.Join(events, ",") != "start,end" {
		t.Fatalf("unexpected hook order: %v", events)
	}
}

func TestSpawnServiceStartHookErrorTerminatesSession(t *testing.T) {
	srv, _ := makeCoordinatorServer(t)
	c := &sdk.Caracal{
		Coordinator:   &sdk.CoordinatorClient{BaseURL: srv.URL},
		ZoneID:        "z",
		ApplicationID: "app",
		SubjectToken:  "tok",
	}
	hookErr := errors.New("start rejected")
	c.OnAgentStart(func(context.Context, sdk.CaracalContext) error { return hookErr })
	if _, err := c.SpawnService(context.Background()); !errors.Is(err, hookErr) {
		t.Fatalf("expected hook error, got %v", err)
	}
}

func TestDelegateAndAdoptDelegationFacade(t *testing.T) {
	srv, _ := makeCoordinatorServer(t)
	c := &sdk.Caracal{
		Coordinator:   &sdk.CoordinatorClient{BaseURL: srv.URL},
		ZoneID:        "z",
		ApplicationID: "app",
		SubjectToken:  "tok",
	}
	ctx := sdk.Bind(context.Background(), sdk.CaracalContext{
		SubjectToken:   "tok",
		ZoneID:         "z",
		ApplicationID:  "app",
		AgentSessionID: "agent-1",
	})
	edge, err := c.Delegate(ctx, sdk.DelegateOptions{
		To:              "agent-2",
		ToApplicationID: "app-2",
		Scopes:          []string{"tool:call"},
		Constraints:     &sdk.DelegationConstraints{MaxHops: 2},
		TTLSeconds:      30,
	})
	if err != nil {
		t.Fatal(err)
	}
	if edge.DelegationEdgeID != "edge-1" {
		t.Fatalf("unexpected edge: %+v", edge)
	}
	adopted, err := c.AdoptDelegation(ctx, edge.DelegationEdgeID)
	if err != nil {
		t.Fatal(err)
	}
	if cur, ok := sdk.Current(adopted); !ok || cur.DelegationEdgeID != "edge-1" {
		t.Fatalf("adoption did not bind the edge: %#v", cur)
	}
}

func TestMintMandateCarriesBoundIdentityAndOptions(t *testing.T) {
	if _, err := (&sdk.Caracal{SubjectToken: "tok"}).MintMandate(context.Background(), "resource://pipernet", []string{"data:read"}); err == nil || !strings.Contains(err.Error(), "client-secret configuration") {
		t.Fatalf("expected client-secret guard, got %v", err)
	}

	var form url.Values
	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		form = r.PostForm
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"mandate-1","token_type":"Bearer","expires_in":300}`))
	}))
	defer sts.Close()
	c, err := sdk.FromClientSecret(sdk.ClientSecretOptions{
		CoordinatorURL: "http://coord",
		STSURL:         sts.URL,
		ZoneID:         "z",
		ApplicationID:  "app",
		ClientSecret:   "secret",
		Resources:      []string{"resource://pipernet"},
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx := sdk.Bind(context.Background(), sdk.CaracalContext{
		SubjectToken:     "tok",
		ZoneID:           "z",
		ApplicationID:    "app",
		AgentSessionID:   "agent-1",
		DelegationEdgeID: "edge-1",
	})
	token, err := c.MintMandate(ctx, "resource://pipernet", []string{"data:read"}, sdk.MandateOptions{TTLSeconds: 120, ApprovalID: "chal-1"})
	if err != nil {
		t.Fatal(err)
	}
	if token != "mandate-1" {
		t.Fatalf("unexpected token: %s", token)
	}
	if form.Get("agent_session_id") != "agent-1" || form.Get("delegation_edge_id") != "edge-1" {
		t.Fatalf("bound identity missing from mint: %v", form)
	}
	if form.Get("ttl_seconds") != "120" || form.Get("challenge_id") != "chal-1" {
		t.Fatalf("mandate options missing from mint: %v", form)
	}
}

func TestWaitForApprovalPolls(t *testing.T) {
	if _, err := (&sdk.Caracal{SubjectToken: "tok"}).WaitForApproval(context.Background(), "chal-1", time.Second); err == nil || !strings.Contains(err.Error(), "client-secret configuration") {
		t.Fatalf("expected client-secret guard, got %v", err)
	}

	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/step-up/chal-1") {
			t.Errorf("unexpected poll path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"state":"approved"}`))
	}))
	defer sts.Close()
	c, err := sdk.FromClientSecret(sdk.ClientSecretOptions{
		CoordinatorURL: "http://coord",
		STSURL:         sts.URL,
		ZoneID:         "z",
		ApplicationID:  "app",
		ClientSecret:   "secret",
		Resources:      []string{"resource://pipernet"},
	})
	if err != nil {
		t.Fatal(err)
	}
	state, err := c.WaitForApproval(context.Background(), "chal-1", 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if state != "approved" {
		t.Fatalf("unexpected state: %s", state)
	}
}

func TestHeadersRefreshesOwnTokenThroughSource(t *testing.T) {
	fresh := &sdk.Caracal{
		ZoneID:        "z",
		ApplicationID: "app",
		TokenSource:   func(context.Context) (string, error) { return "fresh", nil },
	}
	ctx := sdk.Bind(context.Background(), sdk.CaracalContext{
		SubjectToken:   "stale",
		ZoneID:         "z",
		ApplicationID:  "app",
		AgentSessionID: "agent-1",
		OwnToken:       true,
	})
	h, err := fresh.Headers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if h.Get(sdk.HeaderAuthorization) != "Bearer fresh" {
		t.Fatalf("own token must be refreshed: %v", h)
	}

	pinned := sdk.Bind(context.Background(), sdk.CaracalContext{SubjectToken: "inbound", ZoneID: "z", ApplicationID: "app"})
	h, err = fresh.Headers(pinned)
	if err != nil {
		t.Fatal(err)
	}
	if h.Get(sdk.HeaderAuthorization) != "Bearer inbound" {
		t.Fatalf("inbound token must stay pinned: %v", h)
	}

	failing := &sdk.Caracal{
		ZoneID:      "z",
		TokenSource: func(context.Context) (string, error) { return "", errors.New("sts down") },
	}
	if _, err := failing.Headers(ctx); err == nil {
		t.Fatal("token source failure must surface")
	}
	if _, err := failing.Headers(context.Background(), sdk.RootOptions{AllowRoot: true}); err == nil {
		t.Fatal("root token failure must surface")
	}
	if _, err := (&sdk.Caracal{}).Headers(context.Background(), sdk.RootOptions{AllowRoot: true}); err == nil {
		t.Fatal("missing token source must surface")
	}
}

func TestBindFromRequestVerifiedClaimsOverrideEnvelope(t *testing.T) {
	c := &sdk.Caracal{ZoneID: "env-zone", ApplicationID: "env-app"}
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set(sdk.HeaderAuthorization, "Bearer inbound")
	req.Header.Set(sdk.HeaderBaggage, strings.Join([]string{
		sdk.BaggageAgentSession + "=envelope-session",
		sdk.BaggageHop + "=1",
	}, ","))

	hop := 4
	ctx, err := c.BindFromRequest(context.Background(), req, sdk.RootOptions{
		Verify: func(context.Context, string) (*sdk.VerifiedClaims, error) {
			return &sdk.VerifiedClaims{
				ZoneID:           "proved-zone",
				ApplicationID:    "proved-app",
				AgentSessionID:   "proved-session",
				DelegationEdgeID: "proved-edge",
				ParentEdgeID:     "proved-parent",
				SessionID:        "proved-subject",
				Hop:              &hop,
			}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	cur, ok := sdk.Current(ctx)
	if !ok {
		t.Fatal("context not bound")
	}
	if cur.ZoneID != "proved-zone" || cur.ApplicationID != "proved-app" ||
		cur.AgentSessionID != "proved-session" || cur.DelegationEdgeID != "proved-edge" ||
		cur.ParentEdgeID != "proved-parent" || cur.SessionID != "proved-subject" || cur.Hop != 4 {
		t.Fatalf("claims must override the envelope: %#v", cur)
	}
	if cur.OwnToken {
		t.Fatal("inbound token must stay pinned")
	}

	bare := httptest.NewRequest(http.MethodGet, "/", nil)
	if _, err := c.BindFromRequest(context.Background(), bare); err == nil {
		t.Fatal("missing bearer without AllowRoot must be rejected")
	}
	if _, err := c.BindFromRequest(context.Background(), bare, sdk.RootOptions{AllowRoot: true}); err == nil {
		t.Fatal("root fallback without a token source must surface the error")
	}
}

func TestTransportScopesMintMandateForRoutedResource(t *testing.T) {
	platform := &governedPlatform{}
	server := httptest.NewServer(platform.handler())
	defer server.Close()
	gateway := governedEcho()
	defer gateway.Close()

	c := governedClient(t, server.URL, gateway.URL, nil)
	ctx := sdk.Bind(context.Background(), sdk.CaracalContext{
		SubjectToken:     "tok",
		ZoneID:           "z",
		ApplicationID:    "app",
		AgentSessionID:   "agent-9",
		DelegationEdgeID: "edge-9",
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, governedUpstream+"/tasks", nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := c.Transport(nil, sdk.RootOptions{Scopes: []string{"data:read"}}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()

	platform.mu.Lock()
	defer platform.mu.Unlock()
	if len(platform.mintForms) != 1 {
		t.Fatalf("expected one mint, got %d", len(platform.mintForms))
	}
	form := platform.mintForms[0]
	if form.Get("scope") != "data:read" || form.Get("resource") != governedResource {
		t.Fatalf("unexpected mint request: %v", form)
	}
	if form.Get("agent_session_id") != "agent-9" || form.Get("delegation_edge_id") != "edge-9" {
		t.Fatalf("bound identity missing from mint: %v", form)
	}
}

func TestTransportScopesRequireClientSecretConfiguration(t *testing.T) {
	gateway := governedEcho()
	defer gateway.Close()
	c := &sdk.Caracal{
		ZoneID:        "z",
		ApplicationID: "app",
		SubjectToken:  "tok",
		GatewayURL:    gateway.URL,
		Resources:     []sdk.ResourceBinding{{ResourceID: governedResource, UpstreamPrefix: governedUpstream}},
	}
	ctx := sdk.Bind(context.Background(), sdk.CaracalContext{SubjectToken: "tok", ZoneID: "z", ApplicationID: "app"})
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, governedUpstream+"/tasks", nil)
	if _, err := c.Transport(nil, sdk.RootOptions{Scopes: []string{"data:read"}}).Do(req); err == nil || !strings.Contains(err.Error(), "client-secret configuration") {
		t.Fatalf("expected client-secret guard, got %v", err)
	}
}

func TestGatewayBoundRequestResolvesBearerPerContext(t *testing.T) {
	gateway := governedEcho()
	defer gateway.Close()

	c := &sdk.Caracal{
		ZoneID:        "z",
		ApplicationID: "app",
		SubjectToken:  "root-token",
		GatewayURL:    gateway.URL,
		TokenSource:   func(context.Context) (string, error) { return "fresh-own", nil },
	}

	rootReq, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, gateway.URL+"/direct", nil)
	echo := doGovernedEcho(t, c.Transport(nil, sdk.RootOptions{AllowRoot: true}), rootReq)
	if echo["presented"] != "Bearer fresh-own" {
		t.Fatalf("root gateway request must use the token source: %s", echo["presented"])
	}

	ownCtx := sdk.Bind(context.Background(), sdk.CaracalContext{SubjectToken: "stale", ZoneID: "z", ApplicationID: "app", OwnToken: true})
	ownReq, _ := http.NewRequestWithContext(ownCtx, http.MethodGet, gateway.URL+"/direct", nil)
	echo = doGovernedEcho(t, c.Transport(nil), ownReq)
	if echo["presented"] != "Bearer fresh-own" {
		t.Fatalf("own-token context must refresh through the source: %s", echo["presented"])
	}
}

func doGovernedEcho(t *testing.T, client *http.Client, req *http.Request) map[string]string {
	t.Helper()
	res, err := client.Do(req)
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

func TestFetchSurfacesRequestBuildErrors(t *testing.T) {
	c := &sdk.Caracal{ZoneID: "z", SubjectToken: "tok", GatewayURL: "https://gateway.example.com"}
	if _, err := c.Fetch(context.Background(), "BAD METHOD", "resource://pipernet", "/events"); err == nil {
		t.Fatal("invalid method must fail request construction")
	}
	if _, err := (&sdk.Caracal{}).Fetch(context.Background(), http.MethodGet, "resource://pipernet", "/events"); err == nil {
		t.Fatal("missing gateway must fail")
	}
}
