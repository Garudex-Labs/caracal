// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for long-lived Session lifecycle: heartbeat token refresh, close failure surfacing, and authority constructors.

package sdk_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	sdk "github.com/garudex-labs/caracal/packages/sdk/go"
)

func TestHeartbeatRefreshesRejectedTokenOnce(t *testing.T) {
	var mu sync.Mutex
	var beats []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/heartbeat"):
			bearer := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			mu.Lock()
			beats = append(beats, bearer)
			mu.Unlock()
			if bearer == "stale" {
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = w.Write([]byte(`{"error":"revoked"}`))
				return
			}
			_, _ = w.Write([]byte(`{"agent":{"status":"active","heartbeat_deadline_at":"2026-07-05T00:00:00Z","lease_generation":1}}`))
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/agents"):
			_, _ = w.Write([]byte(`{"agent_session_id":"svc-1","lease_generation":1}`))
		case r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	t.Cleanup(srv.Close)

	var tokenMu sync.Mutex
	token := "stale"
	invalidated := false
	svc, err := sdk.StartSession(context.Background(), sdk.StartSessionInput{
		Coordinator:   &sdk.CoordinatorClient{BaseURL: srv.URL},
		ZoneID:        "z",
		ApplicationID: "app",
		TokenSource: func(context.Context) (string, error) {
			tokenMu.Lock()
			defer tokenMu.Unlock()
			return token, nil
		},
		Invalidate: func() {
			tokenMu.Lock()
			invalidated = true
			token = "fresh"
			tokenMu.Unlock()
		},
		HeartbeatInterval: -1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Heartbeat(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !invalidated {
		t.Fatal("401 heartbeat must invalidate the cached token")
	}
	mu.Lock()
	got := strings.Join(beats, ",")
	mu.Unlock()
	if got != "stale,fresh" {
		t.Fatalf("unexpected heartbeat bearers: %s", got)
	}
	if err := svc.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestHeartbeatWithoutInvalidateSurfaces401(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/heartbeat"):
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"revoked"}`))
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/agents"):
			_, _ = w.Write([]byte(`{"agent_session_id":"svc-1","lease_generation":1}`))
		case r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	t.Cleanup(srv.Close)
	svc, err := sdk.StartSession(context.Background(), sdk.StartSessionInput{
		Coordinator:       &sdk.CoordinatorClient{BaseURL: srv.URL},
		ZoneID:            "z",
		ApplicationID:     "app",
		SubjectToken:      "tok",
		HeartbeatInterval: -1,
	})
	if err != nil {
		t.Fatal(err)
	}
	var coordErr *sdk.CoordinatorError
	if err := svc.Heartbeat(context.Background()); !errors.As(err, &coordErr) || coordErr.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 to surface, got %v", err)
	}
	if err := svc.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestServiceCloseSurfacesBearerAndEndHookErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/agents") {
			_, _ = w.Write([]byte(`{"agent_session_id":"svc-1","lease_generation":1}`))
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(srv.Close)

	bearerErr := errors.New("sts down")
	hookErr := errors.New("end hook failed")
	svc, err := sdk.StartSession(context.Background(), sdk.StartSessionInput{
		Coordinator:       &sdk.CoordinatorClient{BaseURL: srv.URL},
		ZoneID:            "z",
		ApplicationID:     "app",
		SubjectToken:      "tok",
		TokenSource:       func(context.Context) (string, error) { return "", bearerErr },
		HeartbeatInterval: -1,
		OnSessionEnd:      func(context.Context, sdk.CaracalContext) error { return hookErr },
	})
	if err != nil {
		t.Fatal(err)
	}
	err = svc.Close(context.Background())
	if !errors.Is(err, bearerErr) || !errors.Is(err, hookErr) {
		t.Fatalf("close must join hook and bearer failures, got %v", err)
	}
	if again := svc.Close(context.Background()); !errors.Is(again, bearerErr) {
		t.Fatalf("close must be idempotent, got %v", again)
	}
}

func TestSessionRetireBearerFailureSurfacesAfterSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/agents") {
			_, _ = w.Write([]byte(`{"agent_session_id":"agent-1"}`))
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(srv.Close)

	err := sdk.Session(context.Background(), sdk.SessionInput{
		Coordinator:   &sdk.CoordinatorClient{BaseURL: srv.URL},
		ZoneID:        "z",
		ApplicationID: "app",
		SubjectToken:  "tok",
		TokenSource:   func(context.Context) (string, error) { return "", errors.New("sts down") },
	}, func(context.Context) error { return nil })
	if err == nil || err.Error() != "sts down" {
		t.Fatalf("cleanup bearer failure must be returned after callback success: %v", err)
	}
}

func TestSessionTreatsRetired409AsSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/agents") {
			_, _ = w.Write([]byte(`{"agent_session_id":"agent-1"}`))
			return
		}
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":"already_terminated"}`))
	}))
	t.Cleanup(srv.Close)
	err := sdk.Session(context.Background(), sdk.SessionInput{
		Coordinator:   &sdk.CoordinatorClient{BaseURL: srv.URL},
		ZoneID:        "z",
		ApplicationID: "app",
		SubjectToken:  "tok",
	}, func(context.Context) error { return nil })
	if err != nil {
		t.Fatalf("already-retired session must count as success: %v", err)
	}
}

func TestGrantConstructors(t *testing.T) {
	if got := sdk.AuthorityInherit(); got.Mode != sdk.AuthorityModeInherit {
		t.Fatalf("inherit: %+v", got)
	}
	if got := sdk.AuthorityNone(); got.Mode != sdk.AuthorityModeNone {
		t.Fatalf("none: %+v", got)
	}
	constraints := &sdk.DelegationConstraints{MaxHops: 2}
	got := sdk.AuthorityNarrow([]string{"tool:call"}, sdk.NarrowOptions{
		ResourceID:  "resource://pipernet",
		Constraints: constraints,
		TTLSeconds:  30,
	})
	if got.Mode != sdk.AuthorityModeNarrow || got.ResourceID != "resource://pipernet" || got.Constraints != constraints || got.TTLSeconds != 30 {
		t.Fatalf("narrow: %+v", got)
	}
	if len(got.Scopes) != 1 || got.Scopes[0] != "tool:call" {
		t.Fatalf("narrow scopes: %+v", got.Scopes)
	}
}
