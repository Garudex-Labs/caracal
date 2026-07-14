// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// AdminClient unit tests covering grants, authority records, sessions, approvals, audit, and delegations.

package admin_test

import (
	"context"
	"errors"
	"net/http"
	"testing"

	admin "github.com/garudex-labs/caracal/packages/admin/go"
)

func newCoordinatorAdmin(rt http.RoundTripper, retries int) *admin.AdminClient {
	return admin.NewAdminClient(admin.AdminClientOptions{
		APIURL:           "http://api",
		AdminToken:       "t",
		CoordinatorURL:   "http://coord",
		CoordinatorToken: "ct",
		HTTPClient:       &http.Client{Transport: rt},
		Retries:          retries,
	})
}

func TestGrantListQueryMapsScopesAndSubjectID(t *testing.T) {
	transport := &scripted{steps: []any{ok(`{"items":[],"next_cursor":null}`), ok(`{"items":[],"next_cursor":null}`)}}
	client := newAdmin(transport, -1)

	if _, err := client.Grants.List(context.Background(), "z1", &admin.GrantQuery{
		SubjectID: "user:richard",
		Scopes:    []string{"read", "write"},
	}); err != nil {
		t.Fatalf("list: %v", err)
	}
	if _, err := client.Grants.List(context.Background(), "z1", &admin.GrantQuery{
		UserID:    "user:monica",
		SubjectID: "ignored",
	}); err != nil {
		t.Fatalf("list: %v", err)
	}

	if got := transport.requests[0].url; got != "http://api/v1/zones/z1/grants?scopes=read%2Cwrite&user_id=user%3Arichard" {
		t.Fatalf("url: %s", got)
	}
	if got := transport.requests[1].url; got != "http://api/v1/zones/z1/grants?user_id=user%3Amonica" {
		t.Fatalf("url: %s", got)
	}
}

func TestPolicyTemplateGetFindsAndRaisesNotFound(t *testing.T) {
	templates := `[{"id":"tpl-1","name":"PiperNet baseline","description":"","content":"package caracal.authz"}]`
	transport := &scripted{steps: []any{ok(templates), ok(templates)}}
	client := newAdmin(transport, -1)

	found, err := client.PolicyTemplates.Get(context.Background(), "tpl-1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if found.Name != "PiperNet baseline" {
		t.Fatalf("template: %+v", found)
	}

	_, err = client.PolicyTemplates.Get(context.Background(), "tpl-missing")
	var apiErr *admin.AdminAPIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("error type: %v", err)
	}
	if apiErr.Status != http.StatusNotFound || apiErr.Code != "policy_template_not_found" || apiErr.Target != "api" {
		t.Fatalf("error: %+v", apiErr)
	}
}

func TestListingUnwrapsAndValidatesItems(t *testing.T) {
	transport := &scripted{steps: []any{
		ok(`{"items":[{"authority_record_id":"s1","subject_id":"user:richard"}],"next_cursor":null}`),
		ok(`{"next_cursor":null}`),
	}}
	client := newAdmin(transport, -1)

	sessions, err := client.AuthorityRecords.List(context.Background(), "z1", &admin.AuthorityRecordQuery{Status: "active"})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(sessions) != 1 || sessions[0].AuthorityRecordID != "s1" {
		t.Fatalf("sessions: %+v", sessions)
	}
	if got := transport.requests[0].url; got != "http://api/v1/zones/z1/authority-records?status=active" {
		t.Fatalf("url: %s", got)
	}

	_, err = client.Sessions.List(context.Background(), "z1", nil)
	if err == nil || err.Error() != "sessions response missing items" {
		t.Fatalf("error: %v", err)
	}
}

func TestAuditSurfacePaths(t *testing.T) {
	transport := &scripted{steps: []any{
		ok(`{"items":[]}`),
		ok(`{"items":[]}`),
		ok(`[]`),
		ok(`{"request_id":"req-1","zone_id":"z1","final_decision":"deny","denied":[],"events":[]}`),
	}}
	client := newAdmin(transport, -1)

	if _, err := client.Audit.List(context.Background(), "z1", &admin.AuditQuery{Decision: "deny"}); err != nil {
		t.Fatalf("audit list: %v", err)
	}
	if _, err := client.AdminAudit.List(context.Background(), "z1", nil); err != nil {
		t.Fatalf("admin audit list: %v", err)
	}
	if _, err := client.Audit.ByRequest(context.Background(), "z1", "req-1"); err != nil {
		t.Fatalf("by request: %v", err)
	}
	trace, err := client.Audit.Explain(context.Background(), "z1", "req-1")
	if err != nil {
		t.Fatalf("explain: %v", err)
	}
	if trace.FinalDecision != "deny" {
		t.Fatalf("trace: %+v", trace)
	}

	expected := []string{
		"http://api/v1/zones/z1/audit?decision=deny",
		"http://api/v1/zones/z1/admin-audit",
		"http://api/v1/zones/z1/audit/by-request/req-1",
		"http://api/v1/zones/z1/audit/by-request/req-1/explain",
	}
	for index, want := range expected {
		if got := transport.requests[index].url; got != want {
			t.Fatalf("url[%d]: %s", index, got)
		}
	}
}

func TestStepUpDecisionsSendReasonOnlyWhenPresent(t *testing.T) {
	transport := &scripted{steps: []any{
		ok(`{"id":"ch-1","state":"satisfied","approver_subject_id":"user:monica"}`),
		ok(`{"id":"ch-1","state":"rejected","approver_subject_id":"user:monica"}`),
	}}
	client := newAdmin(transport, -1)

	if _, err := client.Approvals.Approve(context.Background(), "z1", "ch-1", ""); err != nil {
		t.Fatalf("approve: %v", err)
	}
	if _, err := client.Approvals.Reject(context.Background(), "z1", "ch-1", "policy violation"); err != nil {
		t.Fatalf("reject: %v", err)
	}

	if got := transport.requests[0].url; got != "http://api/v1/zones/z1/approvals/ch-1/approve" {
		t.Fatalf("url: %s", got)
	}
	assertJSONEqual(t, transport.requests[0].body, map[string]any{})
	if got := transport.requests[1].url; got != "http://api/v1/zones/z1/approvals/ch-1/reject" {
		t.Fatalf("url: %s", got)
	}
	assertJSONEqual(t, transport.requests[1].body, map[string]any{"reason": "policy violation"})
}

func TestProviderGrantsPaths(t *testing.T) {
	transport := &scripted{steps: []any{
		ok(`{"id":"pg-1"}`),
		ok(`{"authorization_url":"https://login.hooli.example/oauth/authorize","state":"st","expires_at":"2026-07-05T00:00:00Z"}`),
		ok(`{"id":"pg-1"}`),
	}}
	client := newAdmin(transport, -1)

	body := map[string]any{"user_id": "user:richard"}
	if _, err := client.ProviderConnections.Create(context.Background(), "z1", body); err != nil {
		t.Fatalf("create: %v", err)
	}
	handshake, err := client.ProviderConnections.AuthorizeOAuth(context.Background(), "z1", body)
	if err != nil {
		t.Fatalf("authorize: %v", err)
	}
	if handshake.State != "st" {
		t.Fatalf("handshake: %+v", handshake)
	}
	if _, err := client.ProviderConnections.Revoke(context.Background(), "z1", body); err != nil {
		t.Fatalf("revoke: %v", err)
	}

	expected := []string{
		"http://api/v1/zones/z1/provider-connections",
		"http://api/v1/zones/z1/provider-connections/oauth/authorize",
		"http://api/v1/zones/z1/provider-connections/revoke",
	}
	for index, want := range expected {
		if got := transport.requests[index]; got.url != want || got.method != http.MethodPost {
			t.Fatalf("request[%d]: %s %s", index, got.method, got.url)
		}
	}
}

func TestSessionListingAndManagementUseTheirOwnTransports(t *testing.T) {
	transport := &scripted{steps: []any{
		ok(`{"items":[{"session_id":"a1"}]}`),
		ok(`{"items":[{"agent_session_id":"a2","parent_id":"a1","subject_authority_record_id":"record-1"}]}`),
		ok(`{"suspended":true}`),
		respond(http.StatusNoContent, "", nil),
		ok(`{"agent_session_id":"a1","inbound_edges":[],"effective_scopes":[],"effective_resources":[]}`),
		ok(`{"items":[],"next_cursor":null}`),
		ok(`{"revoked_edges":1,"affected_sessions":2}`),
	}}
	client := newCoordinatorAdmin(transport, -1)

	sessions, err := client.Sessions.List(context.Background(), "z1", &admin.SessionQuery{Status: "active"})
	if err != nil {
		t.Fatalf("sessions list: %v", err)
	}
	if len(sessions) != 1 || sessions[0].SessionID != "a1" {
		t.Fatalf("sessions: %+v", sessions)
	}
	children, err := client.Sessions.Children(context.Background(), "z1", "a1", nil)
	if err != nil {
		t.Fatalf("children: %v", err)
	}
	if len(children) != 1 || children[0].SessionID != "a2" || children[0].ParentSessionID == nil || *children[0].ParentSessionID != "a1" || children[0].AuthorityRecordID != "record-1" {
		t.Fatalf("children: %+v", children)
	}
	if _, err := client.Sessions.Suspend(context.Background(), "z1", "a1"); err != nil {
		t.Fatalf("suspend: %v", err)
	}
	if err := client.Sessions.Terminate(context.Background(), "z1", "a1"); err != nil {
		t.Fatalf("terminate: %v", err)
	}
	if _, err := client.Sessions.EffectiveAuthority(context.Background(), "z1", "a1"); err != nil {
		t.Fatalf("effective authority: %v", err)
	}
	if _, err := client.Delegations.Active(context.Background(), "z1"); err != nil {
		t.Fatalf("active: %v", err)
	}
	revocation, err := client.Delegations.Revoke(context.Background(), "z1", "edge-1")
	if err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if revocation.RevokedDelegations != 1 || revocation.AffectedSessions != 2 {
		t.Fatalf("revocation: %+v", revocation)
	}

	if got := transport.requests[0].url; got != "http://api/v1/zones/z1/sessions?status=active" {
		t.Fatalf("url: %s", got)
	}
	if got := transport.requests[0].header.Get("Authorization"); got != "Bearer t" {
		t.Fatalf("authorization: %s", got)
	}
	if got := transport.requests[2]; got.url != "http://coord/zones/z1/agents/a1/suspend" || got.method != http.MethodPatch {
		t.Fatalf("suspend request: %s %s", got.method, got.url)
	}
	if got := transport.requests[3]; got.url != "http://coord/zones/z1/agents/a1" || got.method != http.MethodDelete {
		t.Fatalf("terminate request: %s %s", got.method, got.url)
	}
	if got := transport.requests[6]; got.url != "http://coord/zones/z1/delegations/edge-1/revoke" || got.method != http.MethodPatch {
		t.Fatalf("revoke request: %s %s", got.method, got.url)
	}
}

func TestCoordinatorSurfacesRequireConfiguration(t *testing.T) {
	client := newAdmin(&scripted{}, -1)

	if _, err := client.Sessions.Get(context.Background(), "z1", "session-1"); !errors.Is(err, admin.ErrCoordinatorURLNotConfigured) {
		t.Fatalf("error: %v", err)
	}

	tokenless := admin.NewAdminClient(admin.AdminClientOptions{
		APIURL:         "http://api",
		AdminToken:     "t",
		CoordinatorURL: "http://coord",
		HTTPClient:     &http.Client{Transport: &scripted{}},
	})
	if _, err := tokenless.Delegations.Active(context.Background(), "z1"); !errors.Is(err, admin.ErrCoordinatorTokenNotConfigured) {
		t.Fatalf("error: %v", err)
	}
}

func TestSessionsListValidatesItems(t *testing.T) {
	transport := &scripted{steps: []any{ok(`{"next_cursor":null}`)}}
	client := newCoordinatorAdmin(transport, -1)

	_, err := client.Sessions.List(context.Background(), "z1", nil)
	if err == nil || err.Error() != "sessions response missing items" {
		t.Fatalf("error: %v", err)
	}
}

func TestCoordinatorErrorsCarryTarget(t *testing.T) {
	transport := &scripted{steps: []any{respond(http.StatusNotFound, `{"error":"agent_not_found"}`, nil)}}
	client := newCoordinatorAdmin(transport, -1)

	_, err := client.Sessions.Get(context.Background(), "z1", "a1")
	var apiErr *admin.AdminAPIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("error type: %v", err)
	}
	if apiErr.Target != "coordinator" || apiErr.Code != "agent_not_found" {
		t.Fatalf("error: %+v", apiErr)
	}
}

func TestWithDefaultHeadersMergesOverDefaults(t *testing.T) {
	transport := &scripted{steps: []any{ok(`{"items":[],"next_cursor":null}`)}}
	client := admin.NewAdminClient(admin.AdminClientOptions{
		APIURL:     "http://api",
		AdminToken: "t",
		HTTPClient: &http.Client{Transport: transport},
		Retries:    -1,
		Headers:    map[string]string{"X-Request-Id": "base", "X-Tenant": "piedpiper"},
	})

	derived := client.WithDefaultHeaders(map[string]string{"X-Request-Id": "override"})
	if _, err := derived.Zones.List(context.Background()); err != nil {
		t.Fatalf("list: %v", err)
	}

	header := transport.requests[0].header
	if got := header.Get("X-Request-Id"); got != "override" {
		t.Fatalf("x-request-id: %s", got)
	}
	if got := header.Get("X-Tenant"); got != "piedpiper" {
		t.Fatalf("x-tenant: %s", got)
	}
	if got := header.Get("Authorization"); got != "Bearer t" {
		t.Fatalf("authorization: %s", got)
	}
}
