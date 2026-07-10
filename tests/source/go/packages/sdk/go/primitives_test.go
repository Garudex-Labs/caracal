// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for Session and Delegate SDK primitives.

package sdk_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	sdk "github.com/garudex-labs/caracal/packages/sdk/go"
)

func makeCoordinatorServer(t *testing.T) (*httptest.Server, *[]string) {
	t.Helper()
	calls := &[]string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*calls = append(*calls, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/agents"):
			_, _ = w.Write([]byte(`{"agent_session_id":"agent-1","heartbeat_deadline_at":"2099-07-09T12:00:00Z","lease_generation":1}`))
		case r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/delegations"):
			_, _ = w.Write([]byte(`{"delegation_edge_id":"edge-1"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, calls
}

func TestSessionRunsCallbackWithBoundContext(t *testing.T) {
	srv, _ := makeCoordinatorServer(t)
	coord := &sdk.CoordinatorClient{BaseURL: srv.URL}

	var seen sdk.CaracalContext
	err := sdk.Session(context.Background(), sdk.SessionInput{
		Coordinator:   coord,
		ZoneID:        "z",
		ApplicationID: "app",
		SubjectToken:  "tok",
	}, func(ctx context.Context) error {
		c, ok := sdk.Current(ctx)
		if !ok {
			return errors.New("no context")
		}
		seen = c
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if seen.SessionID != "agent-1" {
		t.Errorf("expected agent-1, got %q", seen.SessionID)
	}
	if seen.ZoneID != "z" {
		t.Errorf("expected z, got %q", seen.ZoneID)
	}
}

func TestSessionTerminatesOnExit(t *testing.T) {
	srv, calls := makeCoordinatorServer(t)
	coord := &sdk.CoordinatorClient{BaseURL: srv.URL}

	_ = sdk.Session(context.Background(), sdk.SessionInput{
		Coordinator:   coord,
		ZoneID:        "z",
		ApplicationID: "app",
		SubjectToken:  "tok",
	}, func(ctx context.Context) error { return nil })

	var deleted bool
	for _, c := range *calls {
		if strings.HasPrefix(c, "DELETE") {
			deleted = true
		}
	}
	if !deleted {
		t.Errorf("expected DELETE call on Session exit; calls: %v", *calls)
	}
}

func TestSessionServiceHeartbeatAndClose(t *testing.T) {
	calls := &[]string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*calls = append(*calls, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/heartbeat"):
			_, _ = w.Write([]byte(`{"agent":{"id":"svc-1","status":"active","heartbeat_deadline_at":"2099-07-09T12:00:00Z","lease_generation":1}}`))
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/agents"):
			_, _ = w.Write([]byte(`{"agent_session_id":"svc-1","heartbeat_deadline_at":"2099-07-09T12:00:00Z","lease_generation":1}`))
		case r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	coord := &sdk.CoordinatorClient{BaseURL: srv.URL}

	svc, err := sdk.StartSession(context.Background(), sdk.StartSessionInput{
		Coordinator:   coord,
		ZoneID:        "z",
		ApplicationID: "app",
		SubjectToken:  "tok",
		Labels:        []string{"billing-worker"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if svc.SessionID() != "svc-1" {
		t.Errorf("expected svc-1, got %q", svc.SessionID())
	}
	if err := svc.Heartbeat(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := svc.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"POST /zones/z/agents",
		"POST /zones/z/agents/svc-1/heartbeat",
		"DELETE /zones/z/agents/svc-1",
	}
	if strings.Join(*calls, ",") != strings.Join(want, ",") {
		t.Errorf("unexpected calls: %v", *calls)
	}
}

func TestSessionOnAgentStartHookCalled(t *testing.T) {
	srv, _ := makeCoordinatorServer(t)
	coord := &sdk.CoordinatorClient{BaseURL: srv.URL}

	started := false
	_ = sdk.Session(context.Background(), sdk.SessionInput{
		Coordinator:   coord,
		ZoneID:        "z",
		ApplicationID: "app",
		SubjectToken:  "tok",
		OnSessionStart: func(ctx context.Context, c sdk.CaracalContext) error {
			started = true
			return nil
		},
	}, func(ctx context.Context) error { return nil })

	if !started {
		t.Error("OnAgentStart hook must be called")
	}
}

func TestSessionOnAgentStartErrorAbortsAndTerminates(t *testing.T) {
	srv, calls := makeCoordinatorServer(t)
	coord := &sdk.CoordinatorClient{BaseURL: srv.URL}

	hookErr := errors.New("hook failed")
	fnCalled := false
	err := sdk.Session(context.Background(), sdk.SessionInput{
		Coordinator:   coord,
		ZoneID:        "z",
		ApplicationID: "app",
		SubjectToken:  "tok",
		OnSessionStart: func(ctx context.Context, c sdk.CaracalContext) error {
			return hookErr
		},
	}, func(ctx context.Context) error {
		fnCalled = true
		return nil
	})

	if !errors.Is(err, hookErr) {
		t.Errorf("expected hookErr, got: %v", err)
	}
	if fnCalled {
		t.Error("fn must not be called when OnAgentStart fails")
	}
	var deleted bool
	for _, c := range *calls {
		if strings.HasPrefix(c, "DELETE") {
			deleted = true
		}
	}
	if !deleted {
		t.Error("session must be terminated when OnAgentStart fails")
	}
}

func TestSessionPropagatesCoordinatorError(t *testing.T) {
	attempts := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()
	coord := &sdk.CoordinatorClient{BaseURL: srv.URL}

	err := sdk.Session(context.Background(), sdk.SessionInput{
		Coordinator:   coord,
		ZoneID:        "z",
		ApplicationID: "app",
		SubjectToken:  "tok",
	}, func(ctx context.Context) error { return nil })

	var coordErr *sdk.CoordinatorError
	if !errors.As(err, &coordErr) || coordErr.StatusCode != http.StatusForbidden {
		t.Errorf("expected 403 CoordinatorError, got: %v", err)
	}
	if attempts != 1 {
		t.Errorf("client errors must not be retried, got %d attempts", attempts)
	}
}

func TestSessionRetriesTransientFailureWithSameIdempotencyKey(t *testing.T) {
	var keys []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/agents"):
			keys = append(keys, r.Header.Get("Idempotency-Key"))
			if len(keys) == 1 {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			_, _ = w.Write([]byte(`{"agent_session_id":"agent-1"}`))
		case r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	defer srv.Close()
	coord := &sdk.CoordinatorClient{BaseURL: srv.URL}

	err := sdk.Session(context.Background(), sdk.SessionInput{
		Coordinator:   coord,
		ZoneID:        "z",
		ApplicationID: "app",
		SubjectToken:  "tok",
	}, func(ctx context.Context) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if len(keys) != 2 {
		t.Fatalf("expected 2 Session-start attempts, got %d", len(keys))
	}
	if keys[0] == "" || keys[0] != keys[1] {
		t.Errorf("retry must reuse the same idempotency key, got %q then %q", keys[0], keys[1])
	}
}

func TestSessionServiceLeaseLostStopsAutoHeartbeatAndNotifiesOnce(t *testing.T) {
	var mu sync.Mutex
	heartbeats := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/heartbeat"):
			mu.Lock()
			heartbeats++
			mu.Unlock()
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"not found"}`))
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/agents"):
			_, _ = w.Write([]byte(`{"agent_session_id":"svc-1","heartbeat_deadline_at":"2099-07-09T12:00:00Z","lease_generation":1}`))
		case r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	t.Cleanup(srv.Close)
	coord := &sdk.CoordinatorClient{BaseURL: srv.URL}

	lost := make(chan error, 2)
	svc, err := sdk.StartSession(context.Background(), sdk.StartSessionInput{
		Coordinator:       coord,
		ZoneID:            "z",
		ApplicationID:     "app",
		SubjectToken:      "tok",
		HeartbeatInterval: 5 * time.Millisecond,
		OnLeaseLost:       func(err error) { lost <- err },
	})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-lost:
		var coordErr *sdk.CoordinatorError
		if !errors.As(err, &coordErr) || coordErr.StatusCode != http.StatusNotFound {
			t.Errorf("expected 404 CoordinatorError, got: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("OnLeaseLost never fired")
	}
	time.Sleep(30 * time.Millisecond)
	mu.Lock()
	beats := heartbeats
	mu.Unlock()
	if beats != 1 {
		t.Errorf("auto-heartbeat must stop after the lease is lost, got %d beats", beats)
	}
	if len(lost) != 0 {
		t.Error("OnLeaseLost must fire exactly once")
	}
	if err := svc.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestServiceCloseTreatsRetiredSessionAsSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/agents"):
			_, _ = w.Write([]byte(`{"agent_session_id":"svc-1","heartbeat_deadline_at":"2099-07-09T12:00:00Z","lease_generation":1}`))
		case r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"not found"}`))
		}
	}))
	t.Cleanup(srv.Close)
	coord := &sdk.CoordinatorClient{BaseURL: srv.URL}

	svc, err := sdk.StartSession(context.Background(), sdk.StartSessionInput{
		Coordinator:       coord,
		ZoneID:            "z",
		ApplicationID:     "app",
		SubjectToken:      "tok",
		HeartbeatInterval: -1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Close(context.Background()); err != nil {
		t.Errorf("close must treat an already-retired session as success, got: %v", err)
	}
}

func TestServiceHeartbeatReportsStatusAndUpdatesDeadline(t *testing.T) {
	var body map[string]any
	states := []string{}
	deadline := time.Now().Add(30 * time.Second).UTC().Format(time.RFC3339Nano)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/heartbeat"):
			raw, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(raw, &body)
			_, _ = w.Write([]byte(`{"agent":{"status":"suspended","heartbeat_deadline_at":"` + deadline + `","lease_generation":1}}`))
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/agents"):
			_, _ = w.Write([]byte(`{"agent_session_id":"svc-1","heartbeat_deadline_at":"` + deadline + `","lease_generation":1}`))
		case r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	t.Cleanup(srv.Close)
	coord := &sdk.CoordinatorClient{BaseURL: srv.URL}

	svc, err := sdk.StartSession(context.Background(), sdk.StartSessionInput{
		Coordinator:       coord,
		ZoneID:            "z",
		ApplicationID:     "app",
		SubjectToken:      "tok",
		HeartbeatInterval: -1,
		OnStateChange:     func(status string) { states = append(states, status) },
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Heartbeat(context.Background(), "degraded"); err != nil {
		t.Fatal(err)
	}
	if body["status"] != "degraded" {
		t.Errorf("expected degraded status in heartbeat body, got %#v", body)
	}
	if svc.Status() != "suspended" || len(states) != 1 || states[0] != "suspended" {
		t.Fatalf("expected suspended state callback, status=%q states=%v", svc.Status(), states)
	}
	if err := svc.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestDelegateRequiresActiveSession(t *testing.T) {
	srv, _ := makeCoordinatorServer(t)
	coord := &sdk.CoordinatorClient{BaseURL: srv.URL}

	_, err := sdk.Delegate(context.Background(), sdk.DelegateInput{
		Coordinator:     coord,
		ToSessionID:     "agent-2",
		ToApplicationID: "app-2",
		Scopes:          []string{"tool:call"},
	})

	if err == nil {
		t.Fatal("expected error when no active agent session")
	}
}

func TestDelegateRetriesTransientFailureWithSameIdempotencyKey(t *testing.T) {
	keys := []string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/delegations") {
			keys = append(keys, r.Header.Get("Idempotency-Key"))
			if len(keys) == 1 {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"delegation_edge_id":"edge-retry"}`)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	coord := &sdk.CoordinatorClient{BaseURL: srv.URL}
	ctx := sdk.Bind(context.Background(), sdk.CaracalContext{
		SubjectToken:  "tok",
		ZoneID:        "z",
		ApplicationID: "app",
		SessionID:     "agent-1",
	})

	res, err := sdk.Delegate(ctx, sdk.DelegateInput{
		Coordinator:     coord,
		ToSessionID:     "agent-2",
		ToApplicationID: "app-2",
		Scopes:          []string{"tool:call"},
		TTLSeconds:      600,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.DelegationID != "edge-retry" {
		t.Fatalf("unexpected delegation: %+v", res)
	}
	if len(keys) != 2 || keys[0] == "" || keys[0] != keys[1] {
		t.Fatalf("expected one retry under the same idempotency key, got %v", keys)
	}
}

func TestDelegateDoesNotRetryPolicyRejection(t *testing.T) {
	attempts := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()
	coord := &sdk.CoordinatorClient{BaseURL: srv.URL}
	ctx := sdk.Bind(context.Background(), sdk.CaracalContext{
		SubjectToken:  "tok",
		ZoneID:        "z",
		ApplicationID: "app",
		SessionID:     "agent-1",
	})

	if _, err := sdk.Delegate(ctx, sdk.DelegateInput{
		Coordinator:     coord,
		ToSessionID:     "agent-2",
		ToApplicationID: "app-2",
		Scopes:          []string{"tool:call"},
		TTLSeconds:      600,
	}); err == nil {
		t.Fatal("expected policy rejection to surface")
	}
	if attempts != 1 {
		t.Fatalf("expected no retry on 403, got %d attempts", attempts)
	}
}

func TestAttachSessionValidatesLeaseAndReturnsLiveHandle(t *testing.T) {
	paths := []string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.Method+" "+r.URL.Path)
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"status":"active","heartbeat_deadline_at":"2099-07-09T12:00:00Z","lease_generation":2}`)
	}))
	defer srv.Close()
	coord := &sdk.CoordinatorClient{BaseURL: srv.URL}

	handle, err := sdk.AttachSession(context.Background(), sdk.AttachSessionInput{
		Coordinator:       coord,
		ZoneID:            "z",
		ApplicationID:     "app",
		SubjectToken:      "tok",
		SessionID:         "agent-persisted",
		HeartbeatInterval: -1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if handle.SessionID() != "agent-persisted" || handle.Context.SessionID != "agent-persisted" {
		t.Fatalf("unexpected handle session: %+v", handle.Context)
	}
	if handle.DeadlineAt().IsZero() {
		t.Fatal("expected the validated lease deadline to be exposed")
	}
	if paths[0] != "POST /zones/z/agents/agent-persisted/lease" {
		t.Fatalf("expected an immediate lease renewal, got %v", paths)
	}
	if err := handle.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if paths[len(paths)-1] != "DELETE /zones/z/agents/agent-persisted" {
		t.Fatalf("expected Close to terminate the session, got %v", paths)
	}
}

func TestAttachSessionFailsFastWhenSessionGone(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()
	coord := &sdk.CoordinatorClient{BaseURL: srv.URL}

	_, err := sdk.AttachSession(context.Background(), sdk.AttachSessionInput{
		Coordinator:       coord,
		ZoneID:            "z",
		ApplicationID:     "app",
		SubjectToken:      "tok",
		SessionID:         "agent-reaped",
		HeartbeatInterval: -1,
	})
	var coordErr *sdk.CoordinatorError
	if !errors.As(err, &coordErr) || coordErr.StatusCode != 404 {
		t.Fatalf("expected a 404 CoordinatorError, got %v", err)
	}
}

func TestDelegateReturnsEdgeWithoutRebindingIssuer(t *testing.T) {
	srv, _ := makeCoordinatorServer(t)
	coord := &sdk.CoordinatorClient{BaseURL: srv.URL}

	parent := sdk.CaracalContext{
		SubjectToken:  "tok",
		ZoneID:        "z",
		ApplicationID: "app",
		SessionID:     "agent-1",
		Hop:           1,
	}
	ctx := sdk.Bind(context.Background(), parent)

	res, err := sdk.Delegate(ctx, sdk.DelegateInput{
		Coordinator:     coord,
		ToSessionID:     "agent-2",
		ToApplicationID: "app-2",
		Scopes:          []string{"tool:call"},
		TTLSeconds:      600,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.DelegationID != "edge-1" {
		t.Errorf("expected edge-1, got %q", res.DelegationID)
	}
	issuer, _ := sdk.Current(ctx)
	if issuer.DelegationID != parent.DelegationID || issuer.Hop != parent.Hop {
		t.Errorf("issuer context changed: %+v", issuer)
	}
}

func TestAdoptDelegationDerivesReceiverContext(t *testing.T) {
	receiver := sdk.CaracalContext{
		SubjectToken:  "tok",
		ZoneID:        "z",
		ApplicationID: "app-2",
		SessionID:     "agent-2",
		DelegationID:  "edge-own",
		Hop:           1,
	}
	ctx := sdk.Bind(context.Background(), receiver)

	adopted, err := sdk.AcceptDelegation(ctx, "edge-42")
	if err != nil {
		t.Fatal(err)
	}
	child, _ := sdk.Current(adopted)
	if child.DelegationID != "edge-42" {
		t.Errorf("expected edge-42, got %q", child.DelegationID)
	}
	if child.ParentDelegationID != "edge-own" {
		t.Errorf("parent edge not threaded: %q", child.ParentDelegationID)
	}
	if child.Hop != 2 {
		t.Errorf("expected hop 2, got %d", child.Hop)
	}
	if child.SessionID != "agent-2" {
		t.Errorf("receiver session changed: %q", child.SessionID)
	}

	if _, err := sdk.AcceptDelegation(context.Background(), "edge-42"); err == nil {
		t.Fatal("expected error without a bound Caracal context")
	}
}

func TestSessionNarrowRequiresActiveParent(t *testing.T) {
	srv, _ := makeCoordinatorServer(t)
	coord := &sdk.CoordinatorClient{BaseURL: srv.URL}
	err := sdk.Session(context.Background(), sdk.SessionInput{
		Coordinator:   coord,
		ZoneID:        "z",
		ApplicationID: "app-child",
		SubjectToken:  "tok",
		Authority:     sdk.AuthorityNarrow([]string{"tool:call"}, sdk.NarrowOptions{}),
	}, func(ctx context.Context) error { return nil })
	if err == nil {
		t.Fatal("expected error without active parent")
	}
}

func TestSessionNarrowIssuesSpawnThenDelegation(t *testing.T) {
	srv, calls := makeCoordinatorServer(t)
	coord := &sdk.CoordinatorClient{BaseURL: srv.URL}

	var child sdk.CaracalContext
	err := sdk.Session(context.Background(), sdk.SessionInput{
		Coordinator: coord, ZoneID: "z", ApplicationID: "app",
		SubjectToken: "tok",
	}, func(parentCtx context.Context) error {
		return sdk.Session(parentCtx, sdk.SessionInput{
			Coordinator: coord, ZoneID: "z", ApplicationID: "app-child",
			SubjectToken: "tok", Authority: sdk.AuthorityNarrow([]string{"tool:call"}, sdk.NarrowOptions{TTLSeconds: 600}),
		}, func(ctx context.Context) error {
			c, _ := sdk.Current(ctx)
			child = c
			return nil
		})
	})
	if err != nil {
		t.Fatal(err)
	}
	if child.SessionID != "agent-1" {
		t.Errorf("expected agent-1, got %q", child.SessionID)
	}
	if child.DelegationID != "edge-1" || child.ParentDelegationID != "" {
		t.Errorf("expected child edge=edge-1 & parent_edge empty, got %+v", child)
	}
	if child.Hop != 1 {
		t.Errorf("expected hop 1, got %d", child.Hop)
	}
	posts := 0
	hasDelegation := false
	for _, c := range *calls {
		if strings.HasPrefix(c, "POST ") {
			posts++
		}
		if strings.Contains(c, "/delegations") {
			hasDelegation = true
		}
	}
	if posts != 3 {
		t.Errorf("expected 3 POSTs (parent Session start, child Session start, delegation), got %d: %v", posts, *calls)
	}
	if !hasDelegation {
		t.Errorf("delegation call missing: %v", *calls)
	}
}

func TestSessionInheritCarriesParentEdgeForward(t *testing.T) {
	var bodies []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/agents"):
			buf := new(strings.Builder)
			_, _ = io.Copy(buf, r.Body)
			bodies = append(bodies, buf.String())
			_, _ = w.Write([]byte(`{"agent_session_id":"agent-child","delegation_edge_id":"edge-child"}`))
		case r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	coord := &sdk.CoordinatorClient{BaseURL: srv.URL}

	parent := sdk.CaracalContext{
		SubjectToken:  "tok",
		ZoneID:        "z",
		ApplicationID: "app",
		SessionID:     "parent-session",
		DelegationID:  "edge-parent",
		Hop:           1,
	}
	ctx := sdk.Bind(context.Background(), parent)

	var child sdk.CaracalContext
	err := sdk.Session(ctx, sdk.SessionInput{
		Coordinator:   coord,
		ZoneID:        "z",
		ApplicationID: "app",
		SubjectToken:  "tok",
	}, func(ctx context.Context) error {
		child, _ = sdk.Current(ctx)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if child.DelegationID != "edge-child" {
		t.Errorf("expected child edge-child, got %q", child.DelegationID)
	}
	if child.ParentDelegationID != "edge-parent" {
		t.Errorf("expected parent edge-parent, got %q", child.ParentDelegationID)
	}
	if child.Hop != 2 {
		t.Errorf("expected hop 2, got %d", child.Hop)
	}
	if len(bodies) != 1 || !strings.Contains(bodies[0], `"parent_authority":"inherit"`) {
		t.Errorf("Session-start body missing parent_authority inherit: %v", bodies)
	}
	if strings.Contains(bodies[0], "inherit_parent_edge_id") {
		t.Errorf("Session-start body should not carry a client-resolved edge id: %v", bodies)
	}
}

func TestSessionInheritSkipsEdgeCrossApp(t *testing.T) {
	var bodies []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/agents"):
			buf := new(strings.Builder)
			_, _ = io.Copy(buf, r.Body)
			bodies = append(bodies, buf.String())
			_, _ = w.Write([]byte(`{"agent_session_id":"agent-child"}`))
		case r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	coord := &sdk.CoordinatorClient{BaseURL: srv.URL}

	parent := sdk.CaracalContext{
		SubjectToken:  "tok",
		ZoneID:        "z",
		ApplicationID: "app",
		SessionID:     "parent-session",
		DelegationID:  "edge-parent",
		Hop:           1,
	}
	ctx := sdk.Bind(context.Background(), parent)

	var child sdk.CaracalContext
	err := sdk.Session(ctx, sdk.SessionInput{
		Coordinator:   coord,
		ZoneID:        "z",
		ApplicationID: "other-app",
		SubjectToken:  "tok",
	}, func(ctx context.Context) error {
		child, _ = sdk.Current(ctx)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if child.DelegationID != "" {
		t.Errorf("expected no child edge cross-app, got %q", child.DelegationID)
	}
	if len(bodies) != 1 || !strings.Contains(bodies[0], `"parent_authority":"inherit"`) {
		t.Errorf("Session-start body missing parent_authority inherit: %v", bodies)
	}
	if strings.Contains(bodies[0], "inherit_parent_edge_id") {
		t.Errorf("cross-app spawn should not resolve an edge client-side: %v", bodies)
	}
}
