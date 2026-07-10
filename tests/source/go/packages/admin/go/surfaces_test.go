// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// AdminClient unit tests covering the remaining service surfaces, query encoding, and error propagation across every method.

package admin_test

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	admin "github.com/garudex-labs/caracal/packages/admin/go"
)

func TestAdminAPIErrorString(t *testing.T) {
	err := &admin.AdminAPIError{Status: http.StatusNotFound, Code: "zone_not_found"}
	if got := err.Error(); got != "zone_not_found (HTTP 404)" {
		t.Fatalf("error string: %q", got)
	}
}

func TestProvisioningReadAndDeletePaths(t *testing.T) {
	steps := make([]any, 0, 10)
	for range 10 {
		steps = append(steps, ok(`{}`))
	}
	transport := &scripted{steps: steps}
	client := newAdmin(transport, -1)
	ctx := context.Background()

	client.Zones.Get(ctx, "z1")
	client.Applications.Get(ctx, "z1", "app-1")
	client.Applications.Delete(ctx, "z1", "app-1")
	client.Resources.Get(ctx, "z1", "res-1")
	client.Resources.Delete(ctx, "z1", "res-1")
	client.Providers.Get(ctx, "z1", "prov-1")
	client.Providers.Delete(ctx, "z1", "prov-1")
	client.Policies.Get(ctx, "z1", "pol-1")
	client.Policies.Delete(ctx, "z1", "pol-1")
	client.PolicySets.Get(ctx, "z1", "set-1")

	expected := []struct {
		url    string
		method string
	}{
		{"http://api/v1/zones/z1", http.MethodGet},
		{"http://api/v1/zones/z1/applications/app-1", http.MethodGet},
		{"http://api/v1/zones/z1/applications/app-1", http.MethodDelete},
		{"http://api/v1/zones/z1/resources/res-1", http.MethodGet},
		{"http://api/v1/zones/z1/resources/res-1", http.MethodDelete},
		{"http://api/v1/zones/z1/providers/prov-1", http.MethodGet},
		{"http://api/v1/zones/z1/providers/prov-1", http.MethodDelete},
		{"http://api/v1/zones/z1/policies/pol-1", http.MethodGet},
		{"http://api/v1/zones/z1/policies/pol-1", http.MethodDelete},
		{"http://api/v1/zones/z1/policy-sets/set-1", http.MethodGet},
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
}

func TestServiceMethodsPropagateAPIErrors(t *testing.T) {
	calls := []func(client *admin.AdminClient, ctx context.Context) error{
		func(c *admin.AdminClient, ctx context.Context) error { _, err := c.Zones.Get(ctx, "z1"); return err },
		func(c *admin.AdminClient, ctx context.Context) error {
			_, err := c.Zones.Patch(ctx, "z1", map[string]any{})
			return err
		},
		func(c *admin.AdminClient, ctx context.Context) error {
			_, err := c.Applications.Get(ctx, "z1", "a")
			return err
		},
		func(c *admin.AdminClient, ctx context.Context) error {
			_, err := c.Applications.Create(ctx, "z1", map[string]any{})
			return err
		},
		func(c *admin.AdminClient, ctx context.Context) error {
			_, err := c.Applications.Patch(ctx, "z1", "a", map[string]any{})
			return err
		},
		func(c *admin.AdminClient, ctx context.Context) error {
			_, err := c.Resources.Get(ctx, "z1", "r")
			return err
		},
		func(c *admin.AdminClient, ctx context.Context) error {
			_, err := c.Resources.Create(ctx, "z1", map[string]any{})
			return err
		},
		func(c *admin.AdminClient, ctx context.Context) error {
			_, err := c.Resources.Patch(ctx, "z1", "r", map[string]any{})
			return err
		},
		func(c *admin.AdminClient, ctx context.Context) error {
			_, err := c.Providers.Get(ctx, "z1", "p")
			return err
		},
		func(c *admin.AdminClient, ctx context.Context) error {
			_, err := c.Providers.Create(ctx, "z1", map[string]any{})
			return err
		},
		func(c *admin.AdminClient, ctx context.Context) error {
			_, err := c.Providers.Patch(ctx, "z1", "p", map[string]any{})
			return err
		},
		func(c *admin.AdminClient, ctx context.Context) error {
			_, err := c.Policies.Get(ctx, "z1", "p")
			return err
		},
		func(c *admin.AdminClient, ctx context.Context) error {
			_, err := c.Policies.Create(ctx, "z1", map[string]any{})
			return err
		},
		func(c *admin.AdminClient, ctx context.Context) error {
			_, err := c.Policies.AddVersion(ctx, "z1", "p", "content")
			return err
		},
		func(c *admin.AdminClient, ctx context.Context) error {
			_, err := c.PolicySets.Get(ctx, "z1", "s")
			return err
		},
		func(c *admin.AdminClient, ctx context.Context) error {
			_, err := c.PolicySets.Create(ctx, "z1", "name", "")
			return err
		},
		func(c *admin.AdminClient, ctx context.Context) error {
			_, err := c.PolicySets.AddVersion(ctx, "z1", "s", nil)
			return err
		},
		func(c *admin.AdminClient, ctx context.Context) error {
			_, err := c.PolicySets.Activate(ctx, "z1", "s", "v")
			return err
		},
		func(c *admin.AdminClient, ctx context.Context) error {
			_, err := c.PolicySets.ActivationStatus(ctx, "z1", "s", "v", "")
			return err
		},
		func(c *admin.AdminClient, ctx context.Context) error {
			_, err := c.Policies.Validate(ctx, "content")
			return err
		},
		func(c *admin.AdminClient, ctx context.Context) error {
			_, err := c.Grants.Get(ctx, "z1", "g")
			return err
		},
		func(c *admin.AdminClient, ctx context.Context) error {
			_, err := c.Grants.Create(ctx, "z1", map[string]any{})
			return err
		},
		func(c *admin.AdminClient, ctx context.Context) error {
			_, err := c.ProviderConnections.Create(ctx, "z1", map[string]any{})
			return err
		},
		func(c *admin.AdminClient, ctx context.Context) error {
			_, err := c.ProviderConnections.AuthorizeOAuth(ctx, "z1", map[string]any{})
			return err
		},
		func(c *admin.AdminClient, ctx context.Context) error {
			_, err := c.ProviderConnections.Revoke(ctx, "z1", map[string]any{})
			return err
		},
		func(c *admin.AdminClient, ctx context.Context) error {
			_, err := c.StepUpChallenges.Get(ctx, "z1", "ch")
			return err
		},
		func(c *admin.AdminClient, ctx context.Context) error {
			_, err := c.StepUpChallenges.Approve(ctx, "z1", "ch", "")
			return err
		},
		func(c *admin.AdminClient, ctx context.Context) error {
			_, err := c.Audit.Explain(ctx, "z1", "req")
			return err
		},
	}
	for index, call := range calls {
		transport := &scripted{steps: []any{respond(http.StatusInternalServerError, `{"error":"boom"}`, nil)}}
		client := newAdmin(transport, -1)
		err := call(client, context.Background())
		var apiErr *admin.AdminAPIError
		if !errors.As(err, &apiErr) || apiErr.Code != "boom" {
			t.Fatalf("call %d must surface the API error, got %v", index, err)
		}
	}
}

func TestGrantsCRUDPaths(t *testing.T) {
	transport := &scripted{steps: []any{
		ok(`{"id":"g-1","zone_id":"z1"}`),
		ok(`{"id":"g-1","zone_id":"z1"}`),
		respond(http.StatusNoContent, "", nil),
	}}
	client := newAdmin(transport, -1)

	grant, err := client.Grants.Get(context.Background(), "z1", "g-1")
	if err != nil || grant.ID != "g-1" {
		t.Fatalf("get: %+v %v", grant, err)
	}
	if _, err := client.Grants.Create(context.Background(), "z1", map[string]any{"user_id": "user:richard"}); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := client.Grants.Revoke(context.Background(), "z1", "g-1"); err != nil {
		t.Fatalf("revoke: %v", err)
	}

	expected := []struct {
		url    string
		method string
	}{
		{"http://api/v1/zones/z1/grants/g-1", http.MethodGet},
		{"http://api/v1/zones/z1/grants", http.MethodPost},
		{"http://api/v1/zones/z1/grants/g-1", http.MethodDelete},
	}
	for index, want := range expected {
		got := transport.requests[index]
		if got.url != want.url || got.method != want.method {
			t.Fatalf("request %d: %s %s", index, got.method, got.url)
		}
	}
}

func TestStepUpChallengesListAndGet(t *testing.T) {
	transport := &scripted{steps: []any{
		ok(`{"items":[{"id":"ch-1","state":"pending"}],"next_cursor":null}`),
		ok(`{"id":"ch-1","state":"pending"}`),
	}}
	client := newAdmin(transport, -1)

	challenges, err := client.StepUpChallenges.List(context.Background(), "z1")
	if err != nil || len(challenges) != 1 || challenges[0].ID != "ch-1" {
		t.Fatalf("list: %+v %v", challenges, err)
	}
	challenge, err := client.StepUpChallenges.Get(context.Background(), "z1", "ch-1")
	if err != nil || challenge.State != "pending" {
		t.Fatalf("get: %+v %v", challenge, err)
	}
	if got := transport.requests[0].url; got != "http://api/v1/zones/z1/step-up-challenges" {
		t.Fatalf("url: %s", got)
	}
	if got := transport.requests[1].url; got != "http://api/v1/zones/z1/step-up-challenges/ch-1" {
		t.Fatalf("url: %s", got)
	}
}

func TestCoordinatorGraphSurfacePaths(t *testing.T) {
	transport := &scripted{steps: []any{
		ok(`{"resumed":true}`),
		ok(`[]`),
		ok(`[]`),
		ok(`[{"id":"edge-1","depth":1}]`),
		ok(`{"edge_id":"edge-1","affected_edges":[],"affected_sessions":["s1"],"affected_authority_records":["record-1"]}`),
	}}
	client := newCoordinatorAdmin(transport, -1)
	ctx := context.Background()

	if _, err := client.Sessions.Resume(ctx, "z1", "a1"); err != nil {
		t.Fatalf("resume: %v", err)
	}
	if _, err := client.Delegations.Inbound(ctx, "z1", "a1"); err != nil {
		t.Fatalf("inbound: %v", err)
	}
	if _, err := client.Delegations.Outbound(ctx, "z1", "a1"); err != nil {
		t.Fatalf("outbound: %v", err)
	}
	if _, err := client.Delegations.Traverse(ctx, "z1", "edge-1"); err != nil {
		t.Fatalf("traverse: %v", err)
	}
	impact, err := client.Delegations.Impact(ctx, "z1", "edge-1")
	if err != nil {
		t.Fatalf("impact: %v", err)
	}
	if len(impact.AffectedSessions) != 1 || impact.AffectedSessions[0] != "s1" {
		t.Fatalf("impact: %+v", impact)
	}
	if len(impact.AffectedAuthorityRecords) != 1 || impact.AffectedAuthorityRecords[0] != "record-1" {
		t.Fatalf("impact authority records: %+v", impact)
	}

	expected := []struct {
		url    string
		method string
	}{
		{"http://coord/zones/z1/agents/a1/resume", http.MethodPatch},
		{"http://coord/zones/z1/delegations/inbound/a1", http.MethodGet},
		{"http://coord/zones/z1/delegations/outbound/a1", http.MethodGet},
		{"http://coord/zones/z1/delegations/edge-1/traverse", http.MethodGet},
		{"http://coord/zones/z1/delegations/edge-1/impact", http.MethodGet},
	}
	for index, want := range expected {
		got := transport.requests[index]
		if got.url != want.url || got.method != want.method {
			t.Fatalf("request %d: %s %s", index, got.method, got.url)
		}
	}
}

func TestQueryValuesEncodeAllFilters(t *testing.T) {
	transport := &scripted{steps: []any{ok(`{"items":[]}`), ok(`{"items":[]}`), ok(`{"items":[]}`), ok(`{"items":[]}`), ok(`{"items":[]}`)}}
	client := newCoordinatorAdmin(transport, -1)
	ctx := context.Background()

	client.Audit.List(ctx, "z1", &admin.AuditQuery{
		Since:     "2026-07-01T00:00:00Z",
		Until:     "2026-07-05T00:00:00Z",
		RequestID: "req-1",
		Decision:  "deny",
		EventType: "token_exchange",
		SessionID: "a1",
		Label:     "worker",
		Cursor:    "c1",
		Limit:     10,
	})
	client.Sessions.List(ctx, "z1", &admin.SessionQuery{
		Status:        "active",
		Lifecycle:     "service",
		ApplicationID: "app-1",
		Label:         "worker",
		Cursor:        "c2",
		Limit:         5,
	})
	client.Grants.List(ctx, "z1", &admin.GrantQuery{
		ApplicationID: "app-1",
		ResourceID:    "res-1",
		ProviderID:    "prov-1",
		Status:        "active",
		Cursor:        "c3",
		Limit:         7,
	})
	client.Sessions.List(ctx, "z1", &admin.SessionQuery{
		Status:          "active",
		Lifecycle:       "task",
		ApplicationID:   "app-1",
		ParentSessionID: "parent-1",
		Label:           "worker",
		Cursor:          "c4",
		Limit:           3,
	})
	client.AdminAudit.List(ctx, "z1", &admin.AdminAuditQuery{
		Since:      "2026-07-01T00:00:00Z",
		Until:      "2026-07-05T00:00:00Z",
		ActorID:    "actor-1",
		EntityType: "zone",
		EntityID:   "z1",
		Method:     "POST",
		Cursor:     "c5",
		Limit:      2,
	})

	expected := []string{
		"http://api/v1/zones/z1/audit?cursor=c1&decision=deny&event_type=token_exchange&label=worker&limit=10&request_id=req-1&session_id=a1&since=2026-07-01T00%3A00%3A00Z&until=2026-07-05T00%3A00%3A00Z",
		"http://api/v1/zones/z1/sessions?application_id=app-1&cursor=c2&label=worker&lifecycle=service&limit=5&status=active",
		"http://api/v1/zones/z1/grants?application_id=app-1&cursor=c3&limit=7&provider_id=prov-1&resource_id=res-1&status=active",
		"http://api/v1/zones/z1/sessions?application_id=app-1&cursor=c4&label=worker&lifecycle=task&limit=3&parent_session_id=parent-1&status=active",
		"http://api/v1/zones/z1/admin-audit?actor_id=actor-1&cursor=c5&entity_id=z1&entity_type=zone&limit=2&method=POST&since=2026-07-01T00%3A00%3A00Z&until=2026-07-05T00%3A00%3A00Z",
	}
	for index, want := range expected {
		if got := transport.requests[index].url; got != want {
			t.Fatalf("url[%d]:\n got %s\nwant %s", index, got, want)
		}
	}
}

func TestListingsRejectMissingItems(t *testing.T) {
	transport := &scripted{steps: []any{ok(`{}`), ok(`{}`), ok(`{}`), ok(`{}`)}}
	client := newCoordinatorAdmin(transport, -1)
	ctx := context.Background()

	if _, err := client.AuthorityRecords.List(ctx, "z1", nil); err == nil || !strings.Contains(err.Error(), "missing items") {
		t.Fatalf("sessions: %v", err)
	}
	if _, err := client.Audit.List(ctx, "z1", nil); err == nil || !strings.Contains(err.Error(), "missing items") {
		t.Fatalf("audit: %v", err)
	}
	if _, err := client.AdminAudit.List(ctx, "z1", nil); err == nil || !strings.Contains(err.Error(), "missing items") {
		t.Fatalf("admin audit: %v", err)
	}
	if _, err := client.Sessions.Children(ctx, "z1", "a1", nil); err == nil || !strings.Contains(err.Error(), "missing items") {
		t.Fatalf("children: %v", err)
	}
}

func TestInvalidRetryAfterFallsBackToBackoff(t *testing.T) {
	transport := &scripted{steps: []any{
		respond(http.StatusServiceUnavailable, `{"error":"unavailable"}`, map[string]string{"Retry-After": "soon"}),
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

func TestRetryStopsWhenContextExpiresDuringBackoff(t *testing.T) {
	transport := &scripted{steps: []any{
		respond(http.StatusTooManyRequests, `{}`, map[string]string{"Retry-After": "5"}),
	}}
	client := newAdmin(transport, 3)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := client.Zones.List(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected deadline error, got %v", err)
	}
	if len(transport.requests) != 1 {
		t.Fatalf("expected no retry after expiry, got %d requests", len(transport.requests))
	}
}

func TestAPIErrorHandlesEmptyAndArrayBodies(t *testing.T) {
	transport := &scripted{steps: []any{
		respond(http.StatusNotFound, "", nil),
		respond(http.StatusBadRequest, `[1,2]`, nil),
	}}
	client := newAdmin(transport, -1)

	_, err := client.Zones.List(context.Background())
	var apiErr *admin.AdminAPIError
	if !errors.As(err, &apiErr) || apiErr.Code != "Not Found" {
		t.Fatalf("empty body error: %+v", err)
	}
	body, ok := apiErr.Body.(map[string]any)
	if !ok || len(body) != 0 {
		t.Fatalf("empty body must parse as an empty object: %#v", apiErr.Body)
	}

	_, err = client.Zones.List(context.Background())
	if !errors.As(err, &apiErr) || apiErr.Code != "Bad Request" {
		t.Fatalf("array body error: %+v", err)
	}
	if _, ok := apiErr.Body.([]any); !ok {
		t.Fatalf("array body must stay structured: %#v", apiErr.Body)
	}
}
