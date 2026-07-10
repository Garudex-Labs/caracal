// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// ControlClient unit tests covering scoped token minting, invoke dispatch, retry classification, and secret hygiene.

package admin_test

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"testing"

	admin "github.com/garudex-labs/caracal/packages/admin/go"
)

func newControl(rt http.RoundTripper, mutate func(*admin.ControlClientOptions)) *admin.ControlClient {
	opts := admin.ControlClientOptions{
		STSURL:        "https://sts.example.com",
		ControlURL:    "https://api.example.com",
		Audience:      "caracal-control",
		ApplicationID: "app-operator",
		ClientSecret:  "cs_super_secret",
		HTTPClient:    &http.Client{Transport: rt},
	}
	if mutate != nil {
		mutate(&opts)
	}
	return admin.NewControlClient(opts)
}

func tokenResponse() *http.Response {
	return ok(`{"access_token":"tok-123","expires_in":300}`)
}

func invokeResponse() *http.Response {
	return ok(`{"ok":true,"result":{"id":"grant-1"}}`)
}

func parseForm(t *testing.T, raw string) url.Values {
	t.Helper()
	form, err := url.ParseQuery(raw)
	if err != nil {
		t.Fatalf("form parse: %v", err)
	}
	return form
}

func controlError(t *testing.T, err error) *admin.ControlClientError {
	t.Helper()
	var controlErr *admin.ControlClientError
	if !errors.As(err, &controlErr) {
		t.Fatalf("expected ControlClientError, got %v", err)
	}
	return controlErr
}

func TestInvokeMintsScopedTokenThenInvokes(t *testing.T) {
	transport := &scripted{steps: []any{tokenResponse(), invokeResponse()}}
	client := newControl(transport, nil)

	result, err := client.Invoke(context.Background(), "grant", "create", map[string]any{"zone": "z1"}, []string{"control:grant:write"})
	if err != nil {
		t.Fatalf("invoke: %v", err)
	}
	envelope, isMap := result.(map[string]any)
	if !isMap || envelope["id"] != "grant-1" {
		t.Fatalf("unexpected result %+v", result)
	}

	tokenCall := transport.requests[0]
	if tokenCall.url != "https://sts.example.com/oauth/2/token" {
		t.Fatalf("unexpected token url %s", tokenCall.url)
	}
	form := parseForm(t, tokenCall.body)
	if form.Get("grant_type") != "client_credentials" || form.Get("application_id") != "app-operator" ||
		form.Get("resource") != "caracal-control" || form.Get("scope") != "control:grant:write" {
		t.Fatalf("unexpected token form %v", form)
	}

	invokeCall := transport.requests[1]
	if invokeCall.url != "https://api.example.com/v1/control/invoke" {
		t.Fatalf("unexpected invoke url %s", invokeCall.url)
	}
	if invokeCall.header.Get("Authorization") != "Bearer tok-123" {
		t.Fatalf("unexpected authorization header")
	}
	assertJSONEqual(t, invokeCall.body, map[string]any{
		"command":    "grant",
		"subcommand": "create",
		"flags":      map[string]any{"zone": "z1"},
	})
}

func TestJoinsScopesAndForwardsTTL(t *testing.T) {
	transport := &scripted{steps: []any{tokenResponse(), invokeResponse()}}
	client := newControl(transport, func(opts *admin.ControlClientOptions) {
		opts.TTLSeconds = 60
	})

	if _, err := client.Invoke(context.Background(), "grant", "list", nil, []string{"control:grant:write", "control:grant:read"}); err != nil {
		t.Fatalf("invoke: %v", err)
	}
	form := parseForm(t, transport.requests[0].body)
	if form.Get("scope") != "control:grant:write control:grant:read" {
		t.Fatalf("unexpected scope %q", form.Get("scope"))
	}
	if form.Get("ttl_seconds") != "60" {
		t.Fatalf("unexpected ttl %q", form.Get("ttl_seconds"))
	}
}

func TestForwardsAuthorizedByAndZoneScope(t *testing.T) {
	transport := &scripted{steps: []any{tokenResponse(), invokeResponse()}}
	client := newControl(transport, func(opts *admin.ControlClientOptions) {
		opts.AuthorizedBy = "account-7"
		opts.ZoneScope = "z1"
	})

	if _, err := client.Invoke(context.Background(), "grant", "create", nil, []string{"control:grant:write"}); err != nil {
		t.Fatalf("invoke: %v", err)
	}
	invokeCall := transport.requests[1]
	body := decodeBody(t, invokeCall.body)
	if body["authorized_by"] != "account-7" {
		t.Fatalf("missing authorized_by in %v", body)
	}
	if invokeCall.header.Get("X-Caracal-Zone-Scope") != "z1" {
		t.Fatalf("missing zone scope header")
	}
}

func TestTrimsTrailingSlashes(t *testing.T) {
	transport := &scripted{steps: []any{tokenResponse(), invokeResponse()}}
	client := newControl(transport, func(opts *admin.ControlClientOptions) {
		opts.STSURL = "https://sts.example.com/"
		opts.ControlURL = "https://api.example.com/"
	})

	if _, err := client.Invoke(context.Background(), "grant", "list", nil, []string{"control:grant:read"}); err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if transport.requests[0].url != "https://sts.example.com/oauth/2/token" {
		t.Fatalf("unexpected token url %s", transport.requests[0].url)
	}
	if transport.requests[1].url != "https://api.example.com/v1/control/invoke" {
		t.Fatalf("unexpected invoke url %s", transport.requests[1].url)
	}
}

func TestTokenStageErrorNeverInvokes(t *testing.T) {
	transport := &scripted{steps: []any{
		respond(http.StatusForbidden, `{"error":{"code":"denied","reason":"application suspended"}}`, nil),
	}}
	client := newControl(transport, nil)

	_, err := client.Invoke(context.Background(), "grant", "create", nil, []string{"control:grant:write"})
	controlErr := controlError(t, err)
	if controlErr.Stage != "token" || controlErr.Status != http.StatusForbidden || controlErr.Reason != "application suspended" {
		t.Fatalf("unexpected error %+v", controlErr)
	}
	if len(transport.requests) != 1 {
		t.Fatalf("expected no invoke call, got %d requests", len(transport.requests))
	}
}

func TestInvokeStageErrorCarriesStructuredDenial(t *testing.T) {
	transport := &scripted{steps: []any{
		tokenResponse(),
		respond(http.StatusForbidden, `{"ok":false,"error":{"code":"denied","reason":"missing scope control:zone:write","remediation":"grant the scope"}}`, nil),
	}}
	client := newControl(transport, nil)

	_, err := client.Invoke(context.Background(), "zone", "create", nil, []string{"control:zone:read"})
	controlErr := controlError(t, err)
	if controlErr.Stage != "invoke" || controlErr.Code != "denied" ||
		controlErr.Reason != "missing scope control:zone:write" || controlErr.Remediation != "grant the scope" {
		t.Fatalf("unexpected error %+v", controlErr)
	}
}

func TestEmptyAccessTokenIsTokenFailure(t *testing.T) {
	transport := &scripted{steps: []any{ok(`{"access_token":""}`)}}
	client := newControl(transport, nil)

	_, err := client.Invoke(context.Background(), "grant", "list", nil, []string{"control:grant:read"})
	controlErr := controlError(t, err)
	if controlErr.Stage != "token" || controlErr.Reason != "token exchange returned no access_token" {
		t.Fatalf("unexpected error %+v", controlErr)
	}
}

func TestRetriesTransientTokenFailureOnce(t *testing.T) {
	transport := &scripted{steps: []any{
		respond(http.StatusBadGateway, `{"error":"bad gateway"}`, nil),
		tokenResponse(),
		invokeResponse(),
	}}
	client := newControl(transport, nil)

	if _, err := client.Invoke(context.Background(), "grant", "list", nil, []string{"control:grant:read"}); err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if len(transport.requests) != 3 {
		t.Fatalf("expected one token retry, got %d requests", len(transport.requests))
	}
}

func TestRetriesThrownTokenNetworkFailureOnce(t *testing.T) {
	transport := &scripted{steps: []any{
		errors.New("socket hang up"),
		tokenResponse(),
		invokeResponse(),
	}}
	client := newControl(transport, nil)

	if _, err := client.Invoke(context.Background(), "grant", "list", nil, []string{"control:grant:read"}); err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if len(transport.requests) != 3 {
		t.Fatalf("expected one token retry, got %d requests", len(transport.requests))
	}
}

func TestDoesNotRetryDeniedTokenExchange(t *testing.T) {
	transport := &scripted{steps: []any{
		respond(http.StatusForbidden, `{"error":{"code":"denied","reason":"denied"}}`, nil),
	}}
	client := newControl(transport, nil)

	if _, err := client.Invoke(context.Background(), "grant", "list", nil, []string{"control:grant:read"}); err == nil {
		t.Fatalf("expected error")
	}
	if len(transport.requests) != 1 {
		t.Fatalf("expected no retry, got %d requests", len(transport.requests))
	}
}

func TestNeverRetriesInvokeFailure(t *testing.T) {
	transport := &scripted{steps: []any{
		tokenResponse(),
		respond(http.StatusGatewayTimeout, `{"error":"timeout"}`, nil),
	}}
	client := newControl(transport, nil)

	_, err := client.Invoke(context.Background(), "grant", "create", nil, []string{"control:grant:write"})
	controlErr := controlError(t, err)
	if controlErr.Stage != "invoke" || controlErr.Status != http.StatusGatewayTimeout {
		t.Fatalf("unexpected error %+v", controlErr)
	}
	if len(transport.requests) != 2 {
		t.Fatalf("expected no invoke retry, got %d requests", len(transport.requests))
	}
}

func TestNormalizesThrownInvokeFailureToStatusZero(t *testing.T) {
	transport := &scripted{steps: []any{
		tokenResponse(),
		errors.New("socket hang up"),
	}}
	client := newControl(transport, nil)

	_, err := client.Invoke(context.Background(), "grant", "create", nil, []string{"control:grant:write"})
	controlErr := controlError(t, err)
	if controlErr.Stage != "invoke" || controlErr.Status != 0 || !strings.Contains(controlErr.Reason, "socket hang up") {
		t.Fatalf("unexpected error %+v", controlErr)
	}
}

func TestDefinitiveClassification(t *testing.T) {
	cases := []struct {
		stage      string
		status     int
		definitive bool
	}{
		{"token", http.StatusServiceUnavailable, true},
		{"token", 0, true},
		{"invoke", http.StatusForbidden, true},
		{"invoke", http.StatusGatewayTimeout, false},
		{"invoke", 0, false},
	}
	for _, tc := range cases {
		err := &admin.ControlClientError{Stage: tc.stage, Status: tc.status, Reason: "x"}
		if err.Definitive() != tc.definitive {
			t.Fatalf("stage %s status %d: expected definitive=%v", tc.stage, tc.status, tc.definitive)
		}
	}
}

func TestKeepsClientSecretOutOfErrorSurfaces(t *testing.T) {
	transport := &scripted{steps: []any{
		respond(http.StatusBadGateway, `{"error":{"code":"unavailable","reason":"sts unavailable"}}`, nil),
		respond(http.StatusBadGateway, `{"error":{"code":"unavailable","reason":"sts unavailable"}}`, nil),
	}}
	client := newControl(transport, nil)

	_, err := client.Invoke(context.Background(), "grant", "list", nil, []string{"control:grant:read"})
	controlErr := controlError(t, err)
	if strings.Contains(controlErr.Error(), "cs_super_secret") || strings.Contains(controlErr.Reason, "cs_super_secret") {
		t.Fatalf("client secret leaked into error surface")
	}
}
