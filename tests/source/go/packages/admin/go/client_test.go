// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// AdminClient unit tests covering request shape, retry behavior, and error mapping, plus the scripted transport shared by the admin test files.

package admin_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	admin "github.com/garudex-labs/caracal/packages/admin/go"
)

type captured struct {
	url    string
	method string
	header http.Header
	body   string
}

type scripted struct {
	mu       sync.Mutex
	steps    []any
	requests []captured
}

func (s *scripted) RoundTrip(req *http.Request) (*http.Response, error) {
	var body []byte
	if req.Body != nil {
		body, _ = io.ReadAll(req.Body)
	}
	s.mu.Lock()
	s.requests = append(s.requests, captured{url: req.URL.String(), method: req.Method, header: req.Header.Clone(), body: string(body)})
	if len(s.steps) == 0 {
		s.mu.Unlock()
		return nil, fmt.Errorf("unexpected request %s %s", req.Method, req.URL)
	}
	step := s.steps[0]
	s.steps = s.steps[1:]
	s.mu.Unlock()
	switch value := step.(type) {
	case *http.Response:
		value.Request = req
		return value, nil
	case error:
		return nil, value
	}
	return nil, fmt.Errorf("invalid scripted step")
}

func respond(status int, body string, headers map[string]string) *http.Response {
	header := http.Header{"Content-Type": []string{"application/json"}}
	for key, value := range headers {
		header.Set(key, value)
	}
	return &http.Response{
		StatusCode: status,
		Status:     http.StatusText(status),
		Header:     header,
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

func ok(body string) *http.Response {
	return respond(http.StatusOK, body, nil)
}

func newAdmin(rt http.RoundTripper, retries int) *admin.AdminClient {
	return admin.NewAdminClient(admin.AdminClientOptions{
		APIURL:     "http://api",
		AdminToken: "t",
		HTTPClient: &http.Client{Transport: rt},
		Retries:    retries,
	})
}

func decodeBody(t *testing.T, raw string) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("body decode: %v (%q)", err, raw)
	}
	return out
}

func assertJSONEqual(t *testing.T, raw string, expected map[string]any) {
	t.Helper()
	got := decodeBody(t, raw)
	expectedJSON, _ := json.Marshal(expected)
	gotJSON, _ := json.Marshal(got)
	if string(gotJSON) != string(expectedJSON) {
		t.Fatalf("body mismatch:\n got %s\nwant %s", gotJSON, expectedJSON)
	}
}

func TestSendsBearerTokenAndParsesJSON(t *testing.T) {
	transport := &scripted{steps: []any{ok(`{"items":[{"id":"z1","slug":"demo"}],"next_cursor":null}`)}}
	client := newAdmin(transport, -1)

	zones, err := client.Zones.List(context.Background())
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(zones) != 1 || zones[0].ID != "z1" || zones[0].Slug != "demo" {
		t.Fatalf("unexpected zones %+v", zones)
	}
	if transport.requests[0].url != "http://api/v1/zones" {
		t.Fatalf("unexpected url %s", transport.requests[0].url)
	}
	if transport.requests[0].header.Get("Authorization") != "Bearer t" {
		t.Fatalf("missing bearer header")
	}
}

func TestListDrainsCursorsToTheCompleteCollection(t *testing.T) {
	transport := &scripted{steps: []any{
		ok(`{"items":[{"id":"app-1"}],"next_cursor":"c1"}`),
		ok(`{"items":[{"id":"app-2"}],"next_cursor":"c2"}`),
		ok(`{"items":[{"id":"app-3"}],"next_cursor":null}`),
	}}
	client := newAdmin(transport, -1)

	apps, err := client.Applications.List(context.Background(), "z1")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(apps) != 3 || apps[0].ID != "app-1" || apps[2].ID != "app-3" {
		t.Fatalf("unexpected applications %+v", apps)
	}
	wantURLs := []string{
		"http://api/v1/zones/z1/applications",
		"http://api/v1/zones/z1/applications?cursor=c1",
		"http://api/v1/zones/z1/applications?cursor=c2",
	}
	for i, want := range wantURLs {
		if transport.requests[i].url != want {
			t.Fatalf("request %d url %s, want %s", i, transport.requests[i].url, want)
		}
	}
}

func TestListRefusesACursorChainThatNeverTerminates(t *testing.T) {
	steps := make([]any, 0, 50)
	for i := 0; i < 50; i++ {
		steps = append(steps, ok(`{"items":[{"id":"app-1"}],"next_cursor":"again"}`))
	}
	transport := &scripted{steps: steps}
	client := newAdmin(transport, -1)

	_, err := client.Applications.List(context.Background(), "z1")
	if err == nil || !strings.Contains(err.Error(), "pagination did not terminate") {
		t.Fatalf("expected non-termination error, got %v", err)
	}
}

func TestSerializesJSONBodyWithContentType(t *testing.T) {
	transport := &scripted{steps: []any{ok(`{"id":"z2","slug":"new"}`)}}
	client := newAdmin(transport, -1)

	if _, err := client.Zones.Create(context.Background(), map[string]any{"slug": "new", "display_name": "New Zone"}); err != nil {
		t.Fatalf("create: %v", err)
	}
	request := transport.requests[0]
	if request.method != http.MethodPost {
		t.Fatalf("unexpected method %s", request.method)
	}
	if request.header.Get("Content-Type") != "application/json" {
		t.Fatalf("missing content type")
	}
	assertJSONEqual(t, request.body, map[string]any{"slug": "new", "display_name": "New Zone"})
}

func TestDCRStatusAndZoneShutdownPatch(t *testing.T) {
	transport := &scripted{steps: []any{
		ok(`{"id":"z1","dcr_enabled":false,"live_dcr_applications":2}`),
		ok(`{"id":"z1"}`),
	}}
	client := newAdmin(transport, -1)

	if _, err := client.Zones.DCRStatus(context.Background(), "z1"); err != nil {
		t.Fatalf("dcr status: %v", err)
	}
	if _, err := client.Zones.Patch(context.Background(), "z1", map[string]any{"dcr_enabled": false, "dcr_shutdown": "revoke_live"}); err != nil {
		t.Fatalf("patch: %v", err)
	}
	if transport.requests[0].url != "http://api/v1/zones/z1/dcr-status" {
		t.Fatalf("unexpected url %s", transport.requests[0].url)
	}
	if transport.requests[1].method != http.MethodPatch {
		t.Fatalf("unexpected method %s", transport.requests[1].method)
	}
	assertJSONEqual(t, transport.requests[1].body, map[string]any{"dcr_enabled": false, "dcr_shutdown": "revoke_live"})
}

func TestDeleteExpectsEmptyBody(t *testing.T) {
	transport := &scripted{steps: []any{respond(http.StatusNoContent, "", nil)}}
	client := newAdmin(transport, -1)

	if err := client.Zones.Delete(context.Background(), "z1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if transport.requests[0].method != http.MethodDelete {
		t.Fatalf("unexpected method %s", transport.requests[0].method)
	}
}

func TestAdminAPIErrorCarriesParsedBodyAndCode(t *testing.T) {
	transport := &scripted{steps: []any{respond(http.StatusBadRequest, `{"error":"invalid_input","error_description":"bad slug"}`, nil)}}
	client := newAdmin(transport, -1)

	_, err := client.Zones.Create(context.Background(), map[string]any{"slug": "!!"})
	var apiErr *admin.AdminAPIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected AdminAPIError, got %v", err)
	}
	if apiErr.Status != http.StatusBadRequest || apiErr.Code != "invalid_input" {
		t.Fatalf("unexpected error %+v", apiErr)
	}
	body, ok := apiErr.Body.(map[string]any)
	if !ok || body["error_description"] != "bad slug" {
		t.Fatalf("unexpected body %+v", apiErr.Body)
	}
}

func TestFallsBackToStatusTextWhenNotJSON(t *testing.T) {
	transport := &scripted{steps: []any{respond(http.StatusInternalServerError, "<html>nope</html>", nil)}}
	client := newAdmin(transport, -1)

	_, err := client.Zones.List(context.Background())
	var apiErr *admin.AdminAPIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected AdminAPIError, got %v", err)
	}
	if apiErr.Status != http.StatusInternalServerError || apiErr.Code != "Internal Server Error" {
		t.Fatalf("unexpected error %+v", apiErr)
	}
}

func TestRetriesTransientGETFailures(t *testing.T) {
	transport := &scripted{steps: []any{
		respond(http.StatusServiceUnavailable, `{"error":"unavailable"}`, map[string]string{"Retry-After": "0"}),
		ok(`{"items":[{"id":"z1"}],"next_cursor":null}`),
	}}
	client := newAdmin(transport, 1)

	zones, err := client.Zones.List(context.Background())
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(zones) != 1 || len(transport.requests) != 2 {
		t.Fatalf("expected one retry, got %d requests", len(transport.requests))
	}
}

func TestRetriesThrownGETNetworkFailure(t *testing.T) {
	transport := &scripted{steps: []any{
		errors.New("connection reset"),
		ok(`{"items":[],"next_cursor":null}`),
	}}
	client := newAdmin(transport, 1)

	if _, err := client.Zones.List(context.Background()); err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(transport.requests) != 2 {
		t.Fatalf("expected one retry, got %d requests", len(transport.requests))
	}
}

func TestDoesNotRetryMutatingRequests(t *testing.T) {
	transport := &scripted{steps: []any{respond(http.StatusServiceUnavailable, `{"error":"unavailable"}`, nil)}}
	client := newAdmin(transport, 3)

	_, err := client.Zones.Create(context.Background(), map[string]any{"name": "Demo"})
	var apiErr *admin.AdminAPIError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %v", err)
	}
	if len(transport.requests) != 1 {
		t.Fatalf("expected no retries, got %d requests", len(transport.requests))
	}
}

func TestHonoursDateBasedRetryAfter(t *testing.T) {
	when := time.Now().Add(10 * time.Millisecond).UTC().Format(http.TimeFormat)
	transport := &scripted{steps: []any{
		respond(http.StatusTooManyRequests, `{}`, map[string]string{"Retry-After": when}),
		ok(`{"items":[],"next_cursor":null}`),
	}}
	client := newAdmin(transport, 1)

	if _, err := client.Zones.List(context.Background()); err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(transport.requests) != 2 {
		t.Fatalf("expected one retry, got %d requests", len(transport.requests))
	}
}

func TestProvisioningSurfacePathsAndMethods(t *testing.T) {
	steps := make([]any, 0, 16)
	for range 16 {
		steps = append(steps, ok(`{"items":[],"next_cursor":null}`))
	}
	transport := &scripted{steps: steps}
	client := newAdmin(transport, -1)
	ctx := context.Background()

	client.Applications.List(ctx, "z1")
	client.Applications.RotateSecret(ctx, "z1", "app-1")
	client.Applications.DCR(ctx, "z1", map[string]any{"name": "ephemeral"})
	client.Resources.Create(ctx, "z1", map[string]any{"name": "PiperNet", "identifier": "resource://pipernet"})
	client.Providers.Patch(ctx, "z1", "prov-1", map[string]any{"config_json": map[string]any{}})
	client.Policies.Validate(ctx, "package caracal.authz\n")
	client.Policies.AddVersion(ctx, "z1", "pol-1", "content")
	client.PolicySets.List(ctx, "z1")
	client.PolicySets.Create(ctx, "z1", "PiperNet set", "")
	client.PolicySets.Create(ctx, "z1", "PiperNet set", "baseline")
	client.PolicySets.AddVersion(ctx, "z1", "set-1", []map[string]any{{"policy_version_id": "ver-1"}})
	client.PolicySets.ListVersions(ctx, "z1", "set-1")
	client.PolicySets.Simulate(ctx, "z1", "set-1", "setver-1", map[string]any{"subject": "richard"})
	client.PolicySets.Activate(ctx, "z1", "set-1", "setver-1")
	client.PolicySets.ActivationStatus(ctx, "z1", "set-1", "setver-1", "outbox-1")
	client.PolicySets.Delete(ctx, "z1", "set-1")

	expected := []struct {
		url    string
		method string
	}{
		{"http://api/v1/zones/z1/applications", http.MethodGet},
		{"http://api/v1/zones/z1/applications/app-1/rotate-secret", http.MethodPost},
		{"http://api/v1/zones/z1/applications/dcr", http.MethodPost},
		{"http://api/v1/zones/z1/resources", http.MethodPost},
		{"http://api/v1/zones/z1/providers/prov-1", http.MethodPatch},
		{"http://api/v1/policies/validate", http.MethodPost},
		{"http://api/v1/zones/z1/policies/pol-1/versions", http.MethodPost},
		{"http://api/v1/zones/z1/policy-sets", http.MethodGet},
		{"http://api/v1/zones/z1/policy-sets", http.MethodPost},
		{"http://api/v1/zones/z1/policy-sets", http.MethodPost},
		{"http://api/v1/zones/z1/policy-sets/set-1/versions", http.MethodPost},
		{"http://api/v1/zones/z1/policy-sets/set-1/versions", http.MethodGet},
		{"http://api/v1/zones/z1/policy-sets/set-1/simulate", http.MethodPost},
		{"http://api/v1/zones/z1/policy-sets/set-1/activate", http.MethodPost},
		{"http://api/v1/zones/z1/policy-sets/set-1/activation-status?outbox_id=outbox-1&version_id=setver-1", http.MethodGet},
		{"http://api/v1/zones/z1/policy-sets/set-1", http.MethodDelete},
	}
	if len(transport.requests) != len(expected) {
		t.Fatalf("expected %d requests, got %d", len(expected), len(transport.requests))
	}
	for index, want := range expected {
		got := transport.requests[index]
		if got.url != want.url || got.method != want.method {
			t.Fatalf("request %d: got %s %s, want %s %s", index, got.method, got.url, want.method, want.url)
		}
	}
	assertJSONEqual(t, transport.requests[5].body, map[string]any{"content": "package caracal.authz\n"})
	assertJSONEqual(t, transport.requests[6].body, map[string]any{"content": "content"})
	assertJSONEqual(t, transport.requests[8].body, map[string]any{"name": "PiperNet set"})
	assertJSONEqual(t, transport.requests[9].body, map[string]any{"name": "PiperNet set", "description": "baseline"})
	assertJSONEqual(t, transport.requests[10].body, map[string]any{"manifest": []any{map[string]any{"policy_version_id": "ver-1"}}})
	assertJSONEqual(t, transport.requests[12].body, map[string]any{"version_id": "setver-1", "input": map[string]any{"subject": "richard"}})
	assertJSONEqual(t, transport.requests[13].body, map[string]any{"version_id": "setver-1"})
}
