// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for Spawn and Delegate SDK primitives.

package sdk_test

import (
	"context"
	"errors"
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
		Kind:          sdk.KindEphemeral,
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

func TestSpawnTerminatesNonServiceKind(t *testing.T) {
	srv, calls := makeCoordinatorServer(t)
	coord := &sdk.CoordinatorClient{BaseURL: srv.URL}

	_ = sdk.Spawn(context.Background(), sdk.SpawnInput{
		Coordinator:   coord,
		ZoneID:        "z",
		ApplicationID: "app",
		SubjectToken:  "tok",
		Kind:          sdk.KindEphemeral,
	}, func(ctx context.Context) error { return nil })

	var deleted bool
	for _, c := range *calls {
		if strings.HasPrefix(c, "DELETE") {
			deleted = true
		}
	}
	if !deleted {
		t.Errorf("expected DELETE call for non-service kind; calls: %v", *calls)
	}
}

func TestSpawnSkipsTerminationForServiceKind(t *testing.T) {
	srv, calls := makeCoordinatorServer(t)
	coord := &sdk.CoordinatorClient{BaseURL: srv.URL}

	_ = sdk.Spawn(context.Background(), sdk.SpawnInput{
		Coordinator:   coord,
		ZoneID:        "z",
		ApplicationID: "app",
		SubjectToken:  "tok",
		Kind:          sdk.KindService,
	}, func(ctx context.Context) error { return nil })

	for _, c := range *calls {
		if strings.HasPrefix(c, "DELETE") {
			t.Errorf("DELETE must not be called for service kind; calls: %v", *calls)
		}
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
		Kind:          sdk.KindEphemeral,
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
		Kind:          sdk.KindEphemeral,
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
		ClientID:       "app",
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

func TestDelegateToSpawnRequiresActiveParent(t *testing.T) {
	srv, _ := makeCoordinatorServer(t)
	coord := &sdk.CoordinatorClient{BaseURL: srv.URL}
	err := sdk.DelegateToSpawn(context.Background(), sdk.DelegateToSpawnInput{
		Coordinator:   coord,
		ZoneID:        "z",
		ApplicationID: "app-child",
		SubjectToken:  "tok",
		Scopes:        []string{"tool:call"},
	}, func(ctx context.Context) error { return nil })
	if err == nil {
		t.Fatal("expected error without active parent")
	}
}

func TestDelegateToSpawnIssuesSpawnThenDelegation(t *testing.T) {
	srv, calls := makeCoordinatorServer(t)
	coord := &sdk.CoordinatorClient{BaseURL: srv.URL}

	var child sdk.CaracalContext
	err := sdk.Spawn(context.Background(), sdk.SpawnInput{
		Coordinator: coord, ZoneID: "z", ApplicationID: "app",
		SubjectToken: "tok", Kind: sdk.KindEphemeral,
	}, func(parentCtx context.Context) error {
		return sdk.DelegateToSpawn(parentCtx, sdk.DelegateToSpawnInput{
			Coordinator: coord, ZoneID: "z", ApplicationID: "app-child",
			SubjectToken: "tok", Scopes: []string{"tool:call"}, Kind: sdk.KindEphemeral,
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
