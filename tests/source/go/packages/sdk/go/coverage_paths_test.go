// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs

package sdk

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRevokeDelegationPreservesBoundAuthorityAndErrors(t *testing.T) {
	requests := 0
	wantBearer := "bound-token"
	status := http.StatusNoContent
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Method != http.MethodPatch || r.URL.Path != "/zones/zone-1/delegations/edge-1/revoke" || r.Header.Get("Authorization") != "Bearer "+wantBearer {
			t.Errorf("revocation escaped its bound authority: %s %s %#v", r.Method, r.URL, r.Header)
		}
		w.WriteHeader(status)
	}))
	defer server.Close()
	client := &Caracal{Coordinator: &CoordinatorClient{BaseURL: server.URL}, ZoneID: "zone-1", ApplicationID: "app-1", SubjectToken: "root-token"}
	ctx := Bind(context.Background(), CaracalContext{SubjectToken: "bound-token", SessionID: "session-1", ZoneID: "zone-1", ApplicationID: "app-1"})
	if err := client.RevokeDelegation(ctx, "edge-1"); err != nil || requests != 1 {
		t.Fatalf("bound revocation failed: %v (%d requests)", err, requests)
	}
	wantBearer = "root-token"
	status = http.StatusForbidden
	if err := client.RevokeDelegation(context.Background(), "edge-1"); err == nil || !strings.Contains(err.Error(), "403") {
		t.Fatalf("coordinator denial must propagate: %v", err)
	}
	status = http.StatusNoContent
	if err := client.RevokeDelegation(context.Background(), "edge-1"); err != nil {
		t.Fatalf("root authority must be usable without a bound session: %v", err)
	}
	ctxWithBadSource := Bind(context.Background(), CaracalContext{OwnToken: true, TokenSource: func(context.Context) (string, error) {
		return "", errors.New("bound token unavailable")
	}})
	if err := client.RevokeDelegation(ctxWithBadSource, "edge-1"); err == nil || !strings.Contains(err.Error(), "bound token unavailable") {
		t.Fatalf("failed bound token must never fall back to root authority: %v", err)
	}
	missingIdentity := &Caracal{SubjectToken: "root-token"}
	if err := missingIdentity.RevokeDelegation(context.Background(), "edge-1"); err == nil || !strings.Contains(err.Error(), "Identity requires") {
		t.Fatalf("missing application identity must fail before network: %v", err)
	}
	client.SubjectToken = ""
	client.TokenSource = func(context.Context) (string, error) { return "", errors.New("token source down") }
	if err := client.RevokeDelegation(context.Background(), "edge-1"); err == nil || !strings.Contains(err.Error(), "token source down") {
		t.Fatalf("root token failure must propagate: %v", err)
	}
	if requests != 3 {
		t.Fatalf("failed authorization contacted coordinator: %d requests", requests)
	}
	client.TokenSource = nil
	if err := client.RevokeDelegation(context.Background(), "edge-1"); err == nil || !strings.Contains(err.Error(), "no subject token") {
		t.Fatalf("missing root authorization must fail: %v", err)
	}
}

func TestResourceBindingsFileRejectsMalformedEntries(t *testing.T) {
	if _, err := resourceBindingsFromFile(filepath.Join(t.TempDir(), "missing.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing resource bindings file should propagate read error: %v", err)
	}
	for _, tc := range []struct{ name, data, want string }{
		{"bad json", `{`, "unexpected end"},
		{"nonobject", `[42]`, "entry must be an object"},
		{"extra field", `[{"resource_id":"r","upstream_prefix":"https://example.com","extra":true}]`, "expected exactly"},
		{"missing resource", `[{"resource_id":"","upstream_prefix":"https://example.com"}]`, "resource_id must be"},
		{"invalid prefix", `[{"resource_id":"r","upstream_prefix":"/relative"}]`, "absolute URL"},
		{"non-string resource", `[{"resource_id":12,"upstream_prefix":"https://example.com"}]`, "resource_id must be"},
		{"non-string prefix", `[{"resource_id":"r","upstream_prefix":12}]`, "upstream_prefix must be"},
		{"unexpected shape", `42`, "CARACAL_RESOURCES_FILE"},
		{"empty object key", `{"":"https://example.com"}`, "key must be a non-empty string"},
		{"non-string object prefix", `{"r":42}`, "upstream_prefix must be a non-empty string"},
		{"relative object prefix", `{"r":"/relative"}`, "absolute URL"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "resources.json")
			if err := os.WriteFile(path, []byte(tc.data), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := resourceBindingsFromFile(path); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("malformed resource binding must fail (%s): %v", tc.want, err)
			}
		})
	}
	for _, tc := range []struct{ data, resource, prefix string }{
		{`[{"resource_id":"r1","upstream_prefix":"https://one.example"}]`, "r1", "https://one.example"},
		{`{"r2":"https://two.example"}`, "r2", "https://two.example"},
	} {
		path := filepath.Join(t.TempDir(), "resources.json")
		if err := os.WriteFile(path, []byte(tc.data), 0o600); err != nil {
			t.Fatal(err)
		}
		bindings, err := resourceBindingsFromFile(path)
		if err != nil || len(bindings) != 1 || bindings[0].ResourceID != tc.resource || bindings[0].UpstreamPrefix != tc.prefix {
			t.Fatalf("valid resource binding %s = %#v, %v", tc.data, bindings, err)
		}
	}
}
