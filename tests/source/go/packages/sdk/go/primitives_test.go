// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for Spawn and Delegate SDK primitives.

package sdk_test

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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
			_, _ = w.Write([]byte(`{"agent_session_id":"agent-1"}`))
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

func TestSpawnRunsCallbackWithBoundContext(t *testing.T) {
	srv, _ := makeCoordinatorServer(t)
	coord := &sdk.CoordinatorClient{BaseURL: srv.URL}

	var seen sdk.CaracalContext
	err := sdk.Spawn(context.Background(), sdk.SpawnInput{
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
	if seen.AgentSessionID != "agent-1" {
		t.Errorf("expected agent-1, got %q", seen.AgentSessionID)
	}
	if seen.ZoneID != "z" {
		t.Errorf("expected z, got %q", seen.ZoneID)
	}
}

func TestSpawnTerminatesOnExit(t *testing.T) {
	srv, calls := makeCoordinatorServer(t)
	coord := &sdk.CoordinatorClient{BaseURL: srv.URL}

	_ = sdk.Spawn(context.Background(), sdk.SpawnInput{
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
		t.Errorf("expected DELETE call on spawn exit; calls: %v", *calls)
	}
}

func TestSpawnServiceHeartbeatAndClose(t *testing.T) {
	calls := &[]string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*calls = append(*calls, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/heartbeat"):
			_, _ = w.Write([]byte(`{"agent":{"id":"svc-1"}}`))
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/agents"):
			_, _ = w.Write([]byte(`{"agent_session_id":"svc-1"}`))
		case r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	coord := &sdk.CoordinatorClient{BaseURL: srv.URL}

	svc, err := sdk.SpawnService(context.Background(), sdk.SpawnServiceInput{
		Coordinator:   coord,
		ZoneID:        "z",
		ApplicationID: "app",
		SubjectToken:  "tok",
		Labels:        []string{"billing-worker"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if svc.AgentSessionID() != "svc-1" {
		t.Errorf("expected svc-1, got %q", svc.AgentSessionID())
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

func TestSpawnOnAgentStartHookCalled(t *testing.T) {
	srv, _ := makeCoordinatorServer(t)
	coord := &sdk.CoordinatorClient{BaseURL: srv.URL}

	started := false
	_ = sdk.Spawn(context.Background(), sdk.SpawnInput{
		Coordinator:   coord,
		ZoneID:        "z",
		ApplicationID: "app",
		SubjectToken:  "tok",
		OnAgentStart: func(ctx context.Context, c sdk.CaracalContext) error {
			started = true
			return nil
		},
	}, func(ctx context.Context) error { return nil })

	if !started {
		t.Error("OnAgentStart hook must be called")
	}
}

func TestSpawnOnAgentStartErrorAbortsAndTerminates(t *testing.T) {
	srv, calls := makeCoordinatorServer(t)
	coord := &sdk.CoordinatorClient{BaseURL: srv.URL}

	hookErr := errors.New("hook failed")
	fnCalled := false
	err := sdk.Spawn(context.Background(), sdk.SpawnInput{
		Coordinator:   coord,
		ZoneID:        "z",
		ApplicationID: "app",
		SubjectToken:  "tok",
		OnAgentStart: func(ctx context.Context, c sdk.CaracalContext) error {
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

func TestSpawnPropagatesCoordinatorError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	coord := &sdk.CoordinatorClient{BaseURL: srv.URL}

	err := sdk.Spawn(context.Background(), sdk.SpawnInput{
		Coordinator:   coord,
		ZoneID:        "z",
		ApplicationID: "app",
		SubjectToken:  "tok",
	}, func(ctx context.Context) error { return nil })

	if err == nil {
		t.Error("expected error from coordinator 500")
	}
}

func TestDelegateRequiresActiveSession(t *testing.T) {
	srv, _ := makeCoordinatorServer(t)
	coord := &sdk.CoordinatorClient{BaseURL: srv.URL}

	err := sdk.Delegate(context.Background(), sdk.DelegateInput{
		Coordinator:      coord,
		ToAgentSessionID: "agent-2",
		ToApplicationID:  "app-2",
		Scopes:           []string{"tool:call"},
	}, func(ctx context.Context) error { return nil })

	if err == nil {
		t.Fatal("expected error when no active agent session")
	}
}

func TestDelegateIncrementsHopAndBindsEdge(t *testing.T) {
	srv, _ := makeCoordinatorServer(t)
	coord := &sdk.CoordinatorClient{BaseURL: srv.URL}

	parent := sdk.CaracalContext{
		SubjectToken:   "tok",
		ZoneID:         "z",
		ApplicationID:  "app",
		AgentSessionID: "agent-1",
		Hop:            1,
	}
	ctx := sdk.Bind(context.Background(), parent)

	var child sdk.CaracalContext
	err := sdk.Delegate(ctx, sdk.DelegateInput{
		Coordinator:      coord,
		ToAgentSessionID: "agent-2",
		ToApplicationID:  "app-2",
		Scopes:           []string{"tool:call"},
	}, func(ctx context.Context) error {
		c, _ := sdk.Current(ctx)
		child = c
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if child.DelegationEdgeID != "edge-1" {
		t.Errorf("expected edge-1, got %q", child.DelegationEdgeID)
	}
	if child.Hop != 2 {
		t.Errorf("expected hop 2, got %d", child.Hop)
	}
	if child.ParentEdgeID != parent.DelegationEdgeID {
		t.Errorf("parent edge not threaded: %q vs %q", child.ParentEdgeID, parent.DelegationEdgeID)
	}
}

func TestSpawnNarrowRequiresActiveParent(t *testing.T) {
	srv, _ := makeCoordinatorServer(t)
	coord := &sdk.CoordinatorClient{BaseURL: srv.URL}
	err := sdk.Spawn(context.Background(), sdk.SpawnInput{
		Coordinator:   coord,
		ZoneID:        "z",
		ApplicationID: "app-child",
		SubjectToken:  "tok",
		Grant:         sdk.GrantNarrow("tool:call"),
	}, func(ctx context.Context) error { return nil })
	if err == nil {
		t.Fatal("expected error without active parent")
	}
}

func TestSpawnNarrowIssuesSpawnThenDelegation(t *testing.T) {
	srv, calls := makeCoordinatorServer(t)
	coord := &sdk.CoordinatorClient{BaseURL: srv.URL}

	var child sdk.CaracalContext
	err := sdk.Spawn(context.Background(), sdk.SpawnInput{
		Coordinator: coord, ZoneID: "z", ApplicationID: "app",
		SubjectToken: "tok",
	}, func(parentCtx context.Context) error {
		return sdk.Spawn(parentCtx, sdk.SpawnInput{
			Coordinator: coord, ZoneID: "z", ApplicationID: "app-child",
			SubjectToken: "tok", Grant: sdk.GrantNarrow("tool:call"),
		}, func(ctx context.Context) error {
			c, _ := sdk.Current(ctx)
			child = c
			return nil
		})
	})
	if err != nil {
		t.Fatal(err)
	}
	if child.AgentSessionID != "agent-1" {
		t.Errorf("expected agent-1, got %q", child.AgentSessionID)
	}
	if child.DelegationEdgeID != "edge-1" || child.ParentEdgeID != "" {
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
		t.Errorf("expected 3 POSTs (parent spawn, child spawn, delegation), got %d: %v", posts, *calls)
	}
	if !hasDelegation {
		t.Errorf("delegation call missing: %v", *calls)
	}
}

func TestSpawnInheritCarriesParentEdgeForward(t *testing.T) {
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
		SubjectToken:     "tok",
		ZoneID:           "z",
		ApplicationID:    "app",
		AgentSessionID:   "parent-session",
		DelegationEdgeID: "edge-parent",
		Hop:              1,
	}
	ctx := sdk.Bind(context.Background(), parent)

	var child sdk.CaracalContext
	err := sdk.Spawn(ctx, sdk.SpawnInput{
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
	if child.DelegationEdgeID != "edge-child" {
		t.Errorf("expected child edge-child, got %q", child.DelegationEdgeID)
	}
	if child.ParentEdgeID != "edge-parent" {
		t.Errorf("expected parent edge-parent, got %q", child.ParentEdgeID)
	}
	if child.Hop != 2 {
		t.Errorf("expected hop 2, got %d", child.Hop)
	}
	if len(bodies) != 1 || !strings.Contains(bodies[0], `"inherit_parent_edge_id":"edge-parent"`) {
		t.Errorf("spawn body missing inherit_parent_edge_id: %v", bodies)
	}
}

func TestSpawnInheritSkipsEdgeCrossApp(t *testing.T) {
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
		SubjectToken:     "tok",
		ZoneID:           "z",
		ApplicationID:    "app",
		AgentSessionID:   "parent-session",
		DelegationEdgeID: "edge-parent",
		Hop:              1,
	}
	ctx := sdk.Bind(context.Background(), parent)

	var child sdk.CaracalContext
	err := sdk.Spawn(ctx, sdk.SpawnInput{
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
	if child.DelegationEdgeID != "" {
		t.Errorf("expected no child edge cross-app, got %q", child.DelegationEdgeID)
	}
	if len(bodies) != 1 || strings.Contains(bodies[0], "inherit_parent_edge_id") {
		t.Errorf("cross-app spawn should not request inherit edge: %v", bodies)
	}
}
