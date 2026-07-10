// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for the coordinator REST client: constraint wire shape, injected transports, response validation, and event sink safety.

package sdk_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	oauth "github.com/garudex-labs/caracal/packages/oauth/go"
	sdk "github.com/garudex-labs/caracal/packages/sdk/go"
)

func TestDelegationConstraintsWireShapeCarriesAllFields(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"delegation_edge_id":"edge-1"}`))
	}))
	defer srv.Close()
	client := &sdk.CoordinatorClient{BaseURL: srv.URL}
	_, err := sdk.CreateDelegation(context.Background(), client, "tok", sdk.DelegationRequest{
		ZoneID:                "z",
		IssuerApplicationID:   "app",
		SourceSessionID:       "agent-1",
		TargetSessionID:       "agent-2",
		ReceiverApplicationID: "app-2",
		ParentEdgeID:          "edge-parent",
		ResourceID:            "resource://pipernet",
		Scopes:                []string{"data:read"},
		Constraints: &sdk.DelegationConstraints{
			Resources:      []string{"resource://pipernet"},
			MaxDepth:       3,
			MaxHops:        2,
			TTLSeconds:     60,
			Budget:         5,
			PolicyApproved: true,
			ExpiresAt:      "2026-07-05T00:00:00Z",
			BroadReason:    "batch import",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if body["parent_edge_id"] != "edge-parent" || body["resource_id"] != "resource://pipernet" {
		t.Fatalf("edge fields missing: %#v", body)
	}
	constraints, _ := body["constraints"].(map[string]any)
	want := map[string]any{
		"max_depth":       float64(3),
		"max_hops":        float64(2),
		"ttl_seconds":     float64(60),
		"budget":          float64(5),
		"policy_approved": true,
		"expires_at":      "2026-07-05T00:00:00Z",
		"broad_reason":    "batch import",
	}
	for key, value := range want {
		if constraints[key] != value {
			t.Fatalf("constraint %s: got %v, want %v", key, constraints[key], value)
		}
	}
}

func TestCoordinatorUsesInjectedHTTPClient(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"agent_session_id":"agent-1"}`))
	}))
	defer srv.Close()
	var used bool
	client := &sdk.CoordinatorClient{
		BaseURL: srv.URL,
		HTTPClient: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			used = true
			return http.DefaultTransport.RoundTrip(req)
		})},
	}
	if _, err := sdk.StartCoordinatorSession(context.Background(), client, "tok", sdk.StartSessionRequest{ZoneID: "z", ApplicationID: "app"}); err != nil {
		t.Fatal(err)
	}
	if !used {
		t.Fatal("injected client must carry the request")
	}
}

func TestCoordinatorResponsesRequireIdentifiers(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	client := &sdk.CoordinatorClient{BaseURL: srv.URL}
	if _, err := sdk.StartCoordinatorSession(context.Background(), client, "tok", sdk.StartSessionRequest{ZoneID: "z", ApplicationID: "app"}); err == nil || !strings.Contains(err.Error(), "agent_session_id") {
		t.Fatalf("expected missing session id error, got %v", err)
	}
	if _, err := sdk.CreateDelegation(context.Background(), client, "tok", sdk.DelegationRequest{ZoneID: "z"}); err == nil || !strings.Contains(err.Error(), "delegation_edge_id") {
		t.Fatalf("expected missing edge id error, got %v", err)
	}
}

func TestCoordinatorErrorFormatsMethodPathAndBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":"already_terminated"}`))
	}))
	defer srv.Close()
	client := &sdk.CoordinatorClient{BaseURL: srv.URL}
	err := sdk.TerminateAgent(context.Background(), client, "tok", "z", "agent-1")
	var coordErr *sdk.CoordinatorError
	if !errors.As(err, &coordErr) {
		t.Fatalf("expected CoordinatorError, got %v", err)
	}
	msg := coordErr.Error()
	if !strings.Contains(msg, "DELETE") || !strings.Contains(msg, "/zones/z/agents/agent-1") || !strings.Contains(msg, "409") || !strings.Contains(msg, "already_terminated") {
		t.Fatalf("unexpected error string: %s", msg)
	}
}

func TestCoordinatorErrorCarriesRetryAfterHint(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "3")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()
	client := &sdk.CoordinatorClient{BaseURL: srv.URL}
	err := sdk.TerminateAgent(context.Background(), client, "tok", "z", "agent-1")
	var coordErr *sdk.CoordinatorError
	if !errors.As(err, &coordErr) || coordErr.RetryAfterSeconds != 3 {
		t.Fatalf("expected the Retry-After hint to be carried, got %v", err)
	}
}

func TestCoordinatorErrorCapsBodyInMessage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(strings.Repeat("x", 5000)))
	}))
	defer srv.Close()
	client := &sdk.CoordinatorClient{BaseURL: srv.URL}
	err := sdk.TerminateAgent(context.Background(), client, "tok", "z", "agent-1")
	var coordErr *sdk.CoordinatorError
	if !errors.As(err, &coordErr) {
		t.Fatalf("expected CoordinatorError, got %v", err)
	}
	msg := coordErr.Error()
	if !strings.Contains(msg, "(truncated)") || len(msg) > 2300 {
		t.Fatalf("expected a capped error body, got %d chars", len(msg))
	}
}

func TestCoordinatorEventSinkPanicsAreContained(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/agents") {
			_, _ = w.Write([]byte(`{"agent_session_id":"agent-1"}`))
			return
		}
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer srv.Close()
	client := &sdk.CoordinatorClient{BaseURL: srv.URL, OnEvent: func(oauth.Event) { panic("sink failure") }}
	if _, err := sdk.StartCoordinatorSession(context.Background(), client, "tok", sdk.StartSessionRequest{ZoneID: "z", ApplicationID: "app"}); err != nil {
		t.Fatalf("panicking sink must not break the call: %v", err)
	}
	if err := sdk.TerminateAgent(context.Background(), client, "tok", "z", "agent-1"); err == nil {
		t.Fatal("expected coordinator error")
	}
}

func TestCoordinatorNetworkErrorEmitsFailureEvent(t *testing.T) {
	var events []oauth.Event
	client := &sdk.CoordinatorClient{
		BaseURL: "http://127.0.0.1:1",
		OnEvent: func(event oauth.Event) { events = append(events, event) },
	}
	if _, err := sdk.StartCoordinatorSession(context.Background(), client, "tok", sdk.StartSessionRequest{ZoneID: "z", ApplicationID: "app"}); err == nil {
		t.Fatal("expected connection failure")
	}
	if len(events) != 1 || events[0].Ok || events[0].Status != 0 {
		t.Fatalf("unexpected events: %+v", events)
	}
}

func TestHeartbeatAgentDefaultsStatusToHealthy(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"agent":{"status":"active","heartbeat_deadline_at":"2026-07-05T00:00:00Z"}}`))
	}))
	defer srv.Close()
	client := &sdk.CoordinatorClient{BaseURL: srv.URL}
	res, err := sdk.HeartbeatAgent(context.Background(), client, "tok", "z", "agent-1", "")
	if err != nil {
		t.Fatal(err)
	}
	if body["status"] != "healthy" {
		t.Fatalf("empty status must default to healthy: %#v", body)
	}
	if res.Status != "active" || res.HeartbeatDeadlineAt != "2026-07-05T00:00:00Z" {
		t.Fatalf("unexpected response: %+v", res)
	}
}
