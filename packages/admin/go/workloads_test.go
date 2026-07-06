// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// WorkloadsService tests covering paths, methods, list unwrapping, and the one-time secret.

package admin_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	admin "github.com/garudex-labs/caracal/packages/admin/go"
)

type recordedRequest struct {
	Method string
	Path   string
	Body   map[string]any
}

func workloadServer(t *testing.T, respond func(r *http.Request) (int, any)) (*admin.AdminClient, *[]recordedRequest) {
	t.Helper()
	requests := &[]recordedRequest{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := recordedRequest{Method: r.Method, Path: r.URL.Path}
		if r.Body != nil {
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err == nil {
				rec.Body = body
			}
		}
		*requests = append(*requests, rec)
		status, payload := respond(r)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		if payload != nil {
			_ = json.NewEncoder(w).Encode(payload)
		}
	}))
	t.Cleanup(server.Close)
	return admin.NewAdminClient(admin.AdminClientOptions{APIURL: server.URL, AdminToken: "t"}), requests
}

func TestWorkloadsListUnwrapsItems(t *testing.T) {
	client, requests := workloadServer(t, func(r *http.Request) (int, any) {
		return http.StatusOK, map[string]any{
			"items":       []any{map[string]any{"id": "wl1", "name": "launcher"}},
			"next_cursor": nil,
		}
	})

	rows, err := client.Workloads.List(context.Background(), "z1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(rows) != 1 || rows[0].ID != "wl1" || rows[0].Name != "launcher" {
		t.Fatalf("unexpected rows: %+v", rows)
	}
	if (*requests)[0].Path != "/v1/zones/z1/workloads" || (*requests)[0].Method != http.MethodGet {
		t.Fatalf("unexpected request: %+v", (*requests)[0])
	}
}

func TestWorkloadsCreateCarriesOneTimeSecret(t *testing.T) {
	client, requests := workloadServer(t, func(r *http.Request) (int, any) {
		return http.StatusOK, map[string]any{"id": "wl1", "name": "launcher", "secret": "ws_one_time"}
	})

	out, err := client.Workloads.Create(context.Background(), "z1", map[string]any{"name": "launcher"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out["secret"] != "ws_one_time" {
		t.Fatalf("expected one-time secret, got %+v", out)
	}
	req := (*requests)[0]
	if req.Method != http.MethodPost || req.Path != "/v1/zones/z1/workloads" {
		t.Fatalf("unexpected request: %+v", req)
	}
	if req.Body["name"] != "launcher" {
		t.Fatalf("unexpected body: %+v", req.Body)
	}
}

func TestWorkloadsUpdateRotateAndDelete(t *testing.T) {
	client, requests := workloadServer(t, func(r *http.Request) (int, any) {
		if r.Method == http.MethodDelete {
			return http.StatusNoContent, nil
		}
		if r.URL.Path == "/v1/zones/z1/workloads/wl1/rotate-secret" {
			return http.StatusOK, map[string]any{"id": "wl1", "secret": "ws_rotated"}
		}
		return http.StatusOK, map[string]any{"id": "wl1", "name": "launcher-2"}
	})

	updated, err := client.Workloads.Update(context.Background(), "z1", "wl1", map[string]any{"name": "launcher-2"})
	if err != nil {
		t.Fatalf("unexpected update error: %v", err)
	}
	if updated.Name != "launcher-2" {
		t.Fatalf("unexpected updated row: %+v", updated)
	}
	rotated, err := client.Workloads.RotateSecret(context.Background(), "z1", "wl1")
	if err != nil {
		t.Fatalf("unexpected rotate error: %v", err)
	}
	if rotated["secret"] != "ws_rotated" {
		t.Fatalf("expected rotated secret, got %+v", rotated)
	}
	if err := client.Workloads.Delete(context.Background(), "z1", "wl1"); err != nil {
		t.Fatalf("unexpected delete error: %v", err)
	}

	reqs := *requests
	if reqs[0].Method != http.MethodPut || reqs[0].Path != "/v1/zones/z1/workloads/wl1" {
		t.Fatalf("unexpected update request: %+v", reqs[0])
	}
	if reqs[1].Method != http.MethodPost || reqs[1].Path != "/v1/zones/z1/workloads/wl1/rotate-secret" {
		t.Fatalf("unexpected rotate request: %+v", reqs[1])
	}
	if reqs[2].Method != http.MethodDelete || reqs[2].Path != "/v1/zones/z1/workloads/wl1" {
		t.Fatalf("unexpected delete request: %+v", reqs[2])
	}
}
