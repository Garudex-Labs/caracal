// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for the Caracal facade: lifecycle hooks, delegation wrappers, mandate minting, approval waits, and scoped transport routing.

package sdk_test

import (
	"context"
	"encoding/base64"
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

	oauth "github.com/garudex-labs/caracal/packages/oauth/go"
	sdk "github.com/garudex-labs/caracal/packages/sdk/go"
)

func TestSessionFiresRegisteredHooksWithDefaultTTL(t *testing.T) {
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
	c.OnSessionStart(func(_ context.Context, cc sdk.CaracalContext) error {
		starts = append(starts, cc.SessionID)
		return nil
	})
	c.OnSessionEnd(func(_ context.Context, cc sdk.CaracalContext) error {
		ends = append(ends, cc.SessionID)
		return nil
	})
	ran := false
	if err := c.Session(context.Background(), func(ctx context.Context) error {
		ran = true
		if cur, ok := sdk.Current(ctx); !ok || cur.SessionID != "agent-1" {
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

func TestSessionStartHookErrorSkipsCallback(t *testing.T) {
	srv := newRecordingCoordinator(t, nil)
	c := &sdk.Caracal{
		Coordinator:   &sdk.CoordinatorClient{BaseURL: srv.URL},
		ZoneID:        "z",
		ApplicationID: "app",
		SubjectToken:  "tok",
	}
	hookErr := errors.New("start rejected")
	c.OnSessionStart(func(context.Context, sdk.CaracalContext) error { return hookErr })
	if err := c.Session(context.Background(), func(context.Context) error {
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
			_, _ = w.Write([]byte(`{"agent_session_id":"agent-1","heartbeat_deadline_at":"` + time.Now().Add(30*time.Second).UTC().Format(time.RFC3339Nano) + `","lease_generation":1}`))
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

func TestSessionRefreshesRejectedCachedToken(t *testing.T) {
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
			_, _ = w.Write([]byte(`{"agent_session_id":"agent-1","lease_generation":1}`))
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
	if err := c.Session(context.Background(), func(context.Context) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if len(bearers) != 2 || bearers[0] != "tok-1" || bearers[1] != "tok-2" {
		t.Fatalf("expected forced refresh after 401, got %v", bearers)
	}
}

func TestSessionServiceFacadeFiresHooksAndCloseRunsEndHook(t *testing.T) {
	srv := newRecordingCoordinator(t, nil)
	c := &sdk.Caracal{
		Coordinator:   &sdk.CoordinatorClient{BaseURL: srv.URL},
		ZoneID:        "z",
		ApplicationID: "app",
		SubjectToken:  "tok",
	}
	var events []string
	c.OnSessionStart(func(context.Context, sdk.CaracalContext) error {
		events = append(events, "start")
		return nil
	})
	c.OnSessionEnd(func(context.Context, sdk.CaracalContext) error {
		events = append(events, "end")
		return nil
	})
	svc, err := c.StartSession(context.Background(), sdk.StartSessionOptions{HeartbeatInterval: -1})
	if err != nil {
		t.Fatal(err)
	}
	if svc.SessionID() != "agent-1" {
		t.Fatalf("unexpected session: %s", svc.SessionID())
	}
	if err := svc.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if strings.Join(events, ",") != "start,end" {
		t.Fatalf("unexpected hook order: %v", events)
	}
}

func TestSessionServiceStartHookErrorTerminatesSession(t *testing.T) {
	srv, _ := makeCoordinatorServer(t)
	c := &sdk.Caracal{
		Coordinator:   &sdk.CoordinatorClient{BaseURL: srv.URL},
		ZoneID:        "z",
		ApplicationID: "app",
		SubjectToken:  "tok",
	}
	hookErr := errors.New("start rejected")
	c.OnSessionStart(func(context.Context, sdk.CaracalContext) error { return hookErr })
	if _, err := c.StartSession(context.Background()); !errors.Is(err, hookErr) {
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
		SubjectToken:  "tok",
		ZoneID:        "z",
		ApplicationID: "app",
		SessionID:     "agent-1",
	})
	edge, err := c.Delegate(ctx, sdk.DelegateOptions{
		ToSessionID:     "agent-2",
		ToApplicationID: "app-2",
		Scopes:          []string{"tool:call"},
		Constraints:     &sdk.DelegationConstraints{MaxHops: 2},
		TTLSeconds:      30,
	})
	if err != nil {
		t.Fatal(err)
	}
	if edge.DelegationID != "edge-1" {
		t.Fatalf("unexpected delegation: %+v", edge)
	}
	accepted, err := c.AcceptDelegation(ctx, edge.DelegationID)
	if err != nil {
		t.Fatal(err)
	}
	if cur, ok := sdk.Current(accepted); !ok || cur.DelegationID != "edge-1" {
		t.Fatalf("adoption did not bind the edge: %#v", cur)
	}
}

func TestDelegateDefaultsReceiverToOwnApplication(t *testing.T) {
	var receiver string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/delegations") {
			body := map[string]any{}
			_ = json.NewDecoder(r.Body).Decode(&body)
			receiver, _ = body["receiver_application_id"].(string)
			_, _ = w.Write([]byte(`{"delegation_edge_id":"edge-1"}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(srv.Close)
	c := &sdk.Caracal{
		Coordinator:   &sdk.CoordinatorClient{BaseURL: srv.URL},
		ZoneID:        "z",
		ApplicationID: "app",
		SubjectToken:  "tok",
	}
	ctx := sdk.Bind(context.Background(), sdk.CaracalContext{
		SubjectToken:  "tok",
		ZoneID:        "z",
		ApplicationID: "app",
		SessionID:     "agent-1",
	})
	edge, err := c.Delegate(ctx, sdk.DelegateOptions{
		ToSessionID: "agent-2",
		Scopes:      []string{"tool:call"},
		TTLSeconds:  30,
	})
	if err != nil {
		t.Fatal(err)
	}
	if edge.DelegationID != "edge-1" || receiver != "app" {
		t.Fatalf("expected the caller's application as receiver, got %+v receiver %q", edge, receiver)
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
		SubjectToken:  "tok",
		ZoneID:        "z",
		ApplicationID: "app",
		SessionID:     "agent-1",
		DelegationID:  "edge-1",
	})
	token, err := c.MintMandate(ctx, "resource://pipernet", []string{"data:read"}, sdk.MandateOptions{TTLSeconds: 120, ApprovalID: "chal-1"})
	if err != nil {
		t.Fatal(err)
	}
	if token.Token != "mandate-1" || token.ExpiresInSeconds != 300 {
		t.Fatalf("unexpected mandate: %+v", token)
	}
	if form.Get("agent_session_id") != "agent-1" || form.Get("delegation_edge_id") != "edge-1" {
		t.Fatalf("bound identity missing from mint: %v", form)
	}
	if form.Get("ttl_seconds") != "120" || form.Get("approval_id") != "chal-1" {
		t.Fatalf("mandate options missing from mint: %v", form)
	}
}

func TestSessionTaskOptionRecordedAsMetadataTask(t *testing.T) {
	var bodies []map[string]any
	srv := newRecordingCoordinator(t, &bodies)
	c := &sdk.Caracal{
		Coordinator:   &sdk.CoordinatorClient{BaseURL: srv.URL},
		ZoneID:        "z",
		ApplicationID: "app",
		SubjectToken:  "tok",
	}
	if err := c.Session(context.Background(), func(context.Context) error { return nil }, sdk.SessionOptions{
		Task:     "Refund order #8412",
		Metadata: map[string]any{"task": "stale", "ticket": "T-1"},
	}); err != nil {
		t.Fatal(err)
	}
	handle, err := c.StartSession(context.Background(), sdk.StartSessionOptions{
		Task:              "Nightly PiperNet reconciliation",
		HeartbeatInterval: -1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := handle.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	want := []map[string]any{
		{"task": "Refund order #8412", "ticket": "T-1"},
		{"task": "Nightly PiperNet reconciliation"},
	}
	for i, expected := range want {
		got, _ := bodies[i]["metadata"].(map[string]any)
		if fmt.Sprint(got) != fmt.Sprint(expected) {
			t.Fatalf("Session start %d metadata = %#v, want %#v", i, got, expected)
		}
	}
}

func TestSessionCallerOperationIDReusedAcrossCreationCalls(t *testing.T) {
	var keys []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/agents"):
			keys = append(keys, r.Header.Get("Idempotency-Key"))
			_, _ = w.Write([]byte(`{"agent_session_id":"agent-1"}`))
		case r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()
	c := &sdk.Caracal{
		Coordinator:   &sdk.CoordinatorClient{BaseURL: srv.URL},
		ZoneID:        "z",
		ApplicationID: "app",
		SubjectToken:  "tok",
	}
	work := func(context.Context) error { return nil }
	opts := sdk.SessionOptions{IdempotencyKey: "queue-msg-77"}
	if err := c.Session(context.Background(), work, opts); err != nil {
		t.Fatal(err)
	}
	if err := c.Session(context.Background(), work, opts); err != nil {
		t.Fatal(err)
	}
	if len(keys) != 2 || keys[0] != "queue-msg-77" || keys[1] != "queue-msg-77" {
		t.Fatalf("idempotency keys = %v", keys)
	}
}

func TestSessionRejectsUnsafeExplicitIdempotencyKeysBeforeNetwork(t *testing.T) {
	requests := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	c := &sdk.Caracal{
		Coordinator:   &sdk.CoordinatorClient{BaseURL: srv.URL},
		ZoneID:        "z",
		ApplicationID: "app",
		SubjectToken:  "tok",
	}
	for _, key := range []string{" key", "key ", "key\nvalue", strings.Repeat("x", 256)} {
		err := c.Session(context.Background(), func(context.Context) error { return nil }, sdk.SessionOptions{IdempotencyKey: key})
		if err == nil || !strings.Contains(err.Error(), "IdempotencyKey must be") {
			t.Fatalf("key %q error = %v", key, err)
		}
	}
	if requests != 0 {
		t.Fatalf("unsafe keys sent %d network requests", requests)
	}
}

func TestFederateSubjectReturnsSubjectAuthorityRecordID(t *testing.T) {
	if _, err := (&sdk.Caracal{SubjectToken: "tok"}).FederateSubject(context.Background(), "id-token"); err == nil || !strings.Contains(err.Error(), "client-secret configuration") {
		t.Fatalf("expected client-secret guard, got %v", err)
	}

	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"sid":"sess-42","sub":"richard.hendricks@piedpiper.example"}`))
	mandate := "eyJhbGciOiJFUzI1NiJ9." + payload + ".sig"
	var form url.Values
	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		form = r.PostForm
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"` + mandate + `","token_type":"Bearer","expires_in":600}`))
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
	federated, err := c.FederateSubject(context.Background(), "id-token", sdk.FederateSubjectOptions{TTLSeconds: 600})
	if err != nil {
		t.Fatal(err)
	}
	if federated.SubjectAuthorityRecordID != "sess-42" || federated.Token != mandate || federated.ExpiresInSeconds != 600 {
		t.Fatalf("unexpected federated subject: %+v", federated)
	}
	if form.Get("subject_token") != "id-token" || form.Get("subject_token_type") != "urn:ietf:params:oauth:token-type:id_token" {
		t.Fatalf("federation form = %v", form)
	}
	if form.Get("ttl_seconds") != "600" || form.Get("resource") != "" {
		t.Fatalf("federation options = %v", form)
	}
}

func TestFederateSubjectRejectsMandateWithoutAuthorityRecordID(t *testing.T) {
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"sub":"user"}`))
	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"eyJhbGciOiJFUzI1NiJ9.` + payload + `.sig","token_type":"Bearer","expires_in":600}`))
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
	if _, err := c.FederateSubject(context.Background(), "id-token"); err == nil || !strings.Contains(err.Error(), "carries no authority record ID") {
		t.Fatalf("expected missing Authority record ID error, got %v", err)
	}
}

func TestWaitForApprovalPolls(t *testing.T) {
	if _, err := (&sdk.Caracal{SubjectToken: "tok"}).WaitForApproval(context.Background(), "chal-1", time.Second); err == nil || !strings.Contains(err.Error(), "client-secret configuration") {
		t.Fatalf("expected client-secret guard, got %v", err)
	}

	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/approvals/chal-1") {
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

func stepUpClient(t *testing.T, state string) *sdk.Caracal {
	t.Helper()
	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasPrefix(r.URL.Path, "/approvals/") {
			fmt.Fprintf(w, `{"state":%q}`, state)
			return
		}
		_, _ = w.Write([]byte(`{"access_token":"tok","token_type":"Bearer","expires_in":900}`))
	}))
	t.Cleanup(sts.Close)
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
	return c
}

func TestWithApprovalRetriesOnceApproved(t *testing.T) {
	c := stepUpClient(t, "approved")
	var received []string
	out, err := sdk.WithApproval(context.Background(), c, 5*time.Second, func(_ context.Context, approvalID string) (string, error) {
		received = append(received, approvalID)
		if approvalID == "" {
			return "", &oauth.ApprovalRequiredError{Message: "held", ApprovalID: "chal-7"}
		}
		return "minted", nil
	})
	if err != nil || out != "minted" {
		t.Fatalf("unexpected result: %q %v", out, err)
	}
	if len(received) != 2 || received[0] != "" || received[1] != "chal-7" {
		t.Fatalf("unexpected invocations: %v", received)
	}
}

func TestWithApprovalReturnsHoldOnRejection(t *testing.T) {
	c := stepUpClient(t, "rejected")
	calls := 0
	_, err := sdk.WithApproval(context.Background(), c, 5*time.Second, func(_ context.Context, _ string) (string, error) {
		calls++
		return "", &oauth.ApprovalRequiredError{Message: "held", ApprovalID: "chal-7"}
	})
	var hold *oauth.ApprovalRequiredError
	if !errors.As(err, &hold) || hold.ApprovalID != "chal-7" {
		t.Fatalf("expected the original hold, got %v", err)
	}
	if calls != 1 {
		t.Fatalf("expected a single invocation, got %d", calls)
	}
}

func TestWithApprovalPassesOtherErrorsThrough(t *testing.T) {
	c := stepUpClient(t, "approved")
	boom := errors.New("boom")
	_, err := sdk.WithApproval(context.Background(), c, 5*time.Second, func(_ context.Context, _ string) (string, error) {
		return "", boom
	})
	if !errors.Is(err, boom) {
		t.Fatalf("expected passthrough error, got %v", err)
	}
}

func TestMintMandateAppendsLifecycleHint(t *testing.T) {
	sts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"access_denied","error_description":"denied by policy"}`))
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
	sessionOnly := sdk.Bind(context.Background(), sdk.CaracalContext{
		SubjectToken: "tok", ZoneID: "z", ApplicationID: "app", SessionID: "agent-1",
	})
	_, err = c.MintMandate(sessionOnly, "resource://pipernet", []string{"tickets:read"})
	var denied *oauth.CaracalError
	if !errors.As(err, &denied) || denied.Code != "access_denied" {
		t.Fatalf("expected access_denied in the chain, got %v", err)
	}
	if !strings.Contains(err.Error(), "lifecycle-only authority") {
		t.Fatalf("expected the lifecycle hint, got %v", err)
	}

	delegated := sdk.Bind(context.Background(), sdk.CaracalContext{
		SubjectToken: "tok", ZoneID: "z", ApplicationID: "app", SessionID: "agent-1", DelegationID: "edge-1",
	})
	_, err = c.MintMandate(delegated, "resource://pipernet", []string{"tickets:read"})
	if err == nil || strings.Contains(err.Error(), "lifecycle-only authority") {
		t.Fatalf("expected the plain deny under a delegation, got %v", err)
	}
}

func TestSessionHandleExposesLeaseDeadline(t *testing.T) {
	deadline := time.Now().Add(45 * time.Second).UTC().Format(time.RFC3339Nano)
	coord := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/agents"):
			fmt.Fprintf(w, `{"agent_session_id":"agent-1","heartbeat_deadline_at":%q,"lease_generation":1}`, deadline)
		case r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	defer coord.Close()
	svc, err := sdk.StartSession(context.Background(), sdk.StartSessionInput{
		Coordinator:       &sdk.CoordinatorClient{BaseURL: coord.URL},
		ZoneID:            "z",
		ApplicationID:     "app",
		SubjectToken:      "tok",
		HeartbeatInterval: -1,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer svc.Close(context.Background())
	want, _ := time.Parse(time.RFC3339Nano, deadline)
	if !svc.DeadlineAt().Equal(want) {
		t.Fatalf("unexpected deadline: %v want %v", svc.DeadlineAt(), want)
	}
}

func TestHeadersRefreshesOwnTokenThroughSource(t *testing.T) {
	fresh := &sdk.Caracal{
		ZoneID:        "z",
		ApplicationID: "app",
		TokenSource:   func(context.Context) (string, error) { return "fresh", nil },
	}
	ctx := sdk.Bind(context.Background(), sdk.CaracalContext{
		SubjectToken:  "stale",
		ZoneID:        "z",
		ApplicationID: "app",
		SessionID:     "agent-1",
		OwnToken:      true,
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
	if _, err := failing.Headers(context.Background(), sdk.CallOptions{AsApplication: true}); err == nil {
		t.Fatal("root token failure must surface")
	}
	if _, err := (&sdk.Caracal{}).Headers(context.Background(), sdk.CallOptions{AsApplication: true}); err == nil {
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

	ctx, err := c.BindFromRequest(context.Background(), req, sdk.CallOptions{
		Verify: func(context.Context, string) (*sdk.VerifiedClaims, error) {
			return &sdk.VerifiedClaims{
				ZoneID:                   "proved-zone",
				ApplicationID:            "proved-app",
				SessionID:                "proved-session",
				DelegationID:             "proved-edge",
				ParentDelegationID:       "proved-parent",
				SubjectAuthorityRecordID: "proved-subject",
				Hop:                      4,
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
		cur.SessionID != "proved-session" || cur.DelegationID != "proved-edge" ||
		cur.ParentDelegationID != "proved-parent" || cur.SubjectAuthorityRecordID != "proved-subject" || cur.Hop != 4 {
		t.Fatalf("claims must override the envelope: %#v", cur)
	}
	if cur.OwnToken {
		t.Fatal("inbound token must stay pinned")
	}

	ctx, err = c.BindFromRequest(context.Background(), req, sdk.CallOptions{
		Verify: func(context.Context, string) (*sdk.VerifiedClaims, error) {
			return &sdk.VerifiedClaims{ZoneID: "proved-zone", ApplicationID: "proved-app", Hop: 0}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	cur, _ = sdk.Current(ctx)
	if cur.SessionID != "" || cur.DelegationID != "" || cur.ParentDelegationID != "" || cur.SubjectAuthorityRecordID != "" || cur.Hop != 0 {
		t.Fatalf("omitted verified claims must clear envelope authority: %#v", cur)
	}

	bare := httptest.NewRequest(http.MethodGet, "/", nil)
	if _, err := c.BindFromRequest(context.Background(), bare); err == nil {
		t.Fatal("missing bearer without AllowRoot must be rejected")
	}
	if _, err := c.BindFromRequest(context.Background(), bare, sdk.CallOptions{AsApplication: true}); err == nil {
		t.Fatal("root fallback without a token source must surface the error")
	}

	root := &sdk.Caracal{ZoneID: "z", ApplicationID: "app", SubjectToken: "root-token"}
	trusted := httptest.NewRequest(http.MethodGet, "/", nil)
	trusted.Header.Set(sdk.HeaderBaggage, sdk.BaggageAgentSession+"=forged,"+sdk.BaggageDelegationEdge+"=forged-edge,"+sdk.BaggageHop+"=9")
	trustedCtx, err := root.BindFromRequest(context.Background(), trusted, sdk.CallOptions{AsApplication: true})
	if err != nil {
		t.Fatal(err)
	}
	trustedCur, _ := sdk.Current(trustedCtx)
	if trustedCur.SessionID != "" || trustedCur.DelegationID != "" || trustedCur.Hop != 0 || !trustedCur.OwnToken {
		t.Fatalf("application ingress must clear caller authority baggage: %#v", trustedCur)
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
		SubjectToken:  "tok",
		ZoneID:        "z",
		ApplicationID: "app",
		SessionID:     "agent-9",
		DelegationID:  "edge-9",
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, governedUpstream+"/tasks", nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := c.Transport(nil, sdk.CallOptions{Scopes: []string{"data:read"}}).Do(req)
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
	if _, err := c.Transport(nil, sdk.CallOptions{Scopes: []string{"data:read"}}).Do(req); err == nil || !strings.Contains(err.Error(), "client-secret configuration") {
		t.Fatalf("expected client-secret guard, got %v", err)
	}
}

func TestGatewayBoundRequestResolvesBearerPerContext(t *testing.T) {
	gateway := governedEcho()
	defer gateway.Close()

	issued := 0
	c := &sdk.Caracal{
		ZoneID:        "z",
		ApplicationID: "app",
		SubjectToken:  "root-token",
		GatewayURL:    gateway.URL,
		TokenSource: func(context.Context) (string, error) {
			issued++
			return fmt.Sprintf("fresh-own-%d", issued), nil
		},
	}

	rootReq, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, gateway.URL+"/direct", nil)
	echo := doGovernedEcho(t, c.Transport(nil, sdk.CallOptions{AsApplication: true}), rootReq)
	if echo["presented"] != "Bearer fresh-own-1" {
		t.Fatalf("root gateway request must use the token source: %s", echo["presented"])
	}

	ownCtx := sdk.Bind(context.Background(), sdk.CaracalContext{SubjectToken: "stale", ZoneID: "z", ApplicationID: "app", OwnToken: true})
	ownReq, _ := http.NewRequestWithContext(ownCtx, http.MethodGet, gateway.URL+"/direct", nil)
	echo = doGovernedEcho(t, c.Transport(nil), ownReq)
	if echo["presented"] != "Bearer fresh-own-2" {
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
