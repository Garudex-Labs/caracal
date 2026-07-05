// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Reconciler failure-path tests: every ensure step must surface upstream errors instead of converging partially.

package admin_test

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	admin "github.com/garudex-labs/caracal/packages/admin/go"
)

func failStep() *http.Response {
	return respond(http.StatusInternalServerError, `{"error":"boom"}`, nil)
}

func expectBoom(t *testing.T, err error, label string) {
	t.Helper()
	var apiErr *admin.AdminAPIError
	if !errors.As(err, &apiErr) || apiErr.Code != "boom" {
		t.Fatalf("%s must surface the API error, got %v", label, err)
	}
}

func TestEnsureApplicationSurfacesEachStepFailure(t *testing.T) {
	input := admin.ApplicationEnsure{Name: "Son of Anton", Traits: []string{"agent"}, ClientSecret: "secret"}
	steps := map[string][]any{
		"list":              {failStep()},
		"create":            {ok(`[]`), failStep()},
		"seal after create": {ok(`[]`), ok(`{"id":"app-1"}`), failStep()},
		"trait patch":       {ok(`[{"id":"app-1","name":"Son of Anton","registration_method":"managed","traits":[]}]`), failStep()},
		"rotate existing":   {ok(`[{"id":"app-1","name":"Son of Anton","registration_method":"managed","traits":["agent"]}]`), failStep()},
	}
	for label, script := range steps {
		client := newAdmin(&scripted{steps: script}, -1)
		_, err := admin.EnsureApplication(context.Background(), client, "z1", input)
		expectBoom(t, err, label)
	}
}

func TestEnsureAPIKeyProviderSurfacesEachStepFailure(t *testing.T) {
	input := admin.APIKeyProviderEnsure{
		Name:         "Hooli OIDC",
		Identifier:   "provider://hooli",
		PublicConfig: map[string]any{"header": "X-Api-Key"},
		APIKey:       "sealed",
	}
	steps := map[string][]any{
		"list":   {failStep()},
		"create": {ok(`[]`), failStep()},
		"reseal": {ok(`[{"id":"prov-1","identifier":"provider://hooli"}]`), failStep()},
	}
	for label, script := range steps {
		client := newAdmin(&scripted{steps: script}, -1)
		_, err := admin.EnsureAPIKeyProvider(context.Background(), client, "z1", input)
		expectBoom(t, err, label)
	}

	keyless := input
	keyless.APIKey = ""
	client := newAdmin(&scripted{steps: []any{
		ok(`[{"id":"prov-1","identifier":"provider://hooli"}]`), failStep(),
	}}, -1)
	_, err := admin.EnsureAPIKeyProvider(context.Background(), client, "z1", keyless)
	expectBoom(t, err, "placement patch")
}

func TestEnsureResourceSurfacesListFailure(t *testing.T) {
	client := newAdmin(&scripted{steps: []any{failStep()}}, -1)
	_, err := admin.EnsureResource(context.Background(), client, "z1", admin.ResourceEnsure{
		Name:       "PiperNet",
		Identifier: "resource://pipernet",
		Scopes:     []string{"data:read"},
	})
	expectBoom(t, err, "list")
}

func TestEnsureActivePolicySetSurfacesEachStepFailure(t *testing.T) {
	input := admin.ActivePolicySetEnsure{
		PolicyName: "pipernet-baseline",
		SetName:    "pipernet-set",
		Content:    "package caracal.authz\n",
	}
	policyRow := `[{"id":"pol-1","name":"pipernet-baseline"}]`
	staleDetail := `{"id":"pol-1","name":"pipernet-baseline","versions":[{"id":"ver-1","version":1,"content_sha256":"stale"}]}`
	steps := map[string][]any{
		"policies list": {failStep()},
		"policy create": {ok(`[]`), failStep()},
		"policy get":    {ok(policyRow), failStep()},
		"add version":   {ok(policyRow), ok(staleDetail), failStep()},
		"sets list":     {ok(policyRow), ok(staleDetail), ok(`{"version_id":"ver-2"}`), failStep()},
		"set create":    {ok(policyRow), ok(staleDetail), ok(`{"version_id":"ver-2"}`), ok(`[]`), failStep()},
		"set version":   {ok(policyRow), ok(staleDetail), ok(`{"version_id":"ver-2"}`), ok(`[]`), ok(`{"id":"set-1","name":"pipernet-set"}`), failStep()},
		"activate":      {ok(policyRow), ok(staleDetail), ok(`{"version_id":"ver-2"}`), ok(`[]`), ok(`{"id":"set-1","name":"pipernet-set"}`), ok(`{"version_id":"sv-1"}`), failStep()},
	}
	for label, script := range steps {
		client := newAdmin(&scripted{steps: script}, -1)
		err := admin.EnsureActivePolicySet(context.Background(), client, "z1", input)
		expectBoom(t, err, label)
	}
}

func TestEnsureActivePolicySetRejectsVersionlessPolicy(t *testing.T) {
	client := newAdmin(&scripted{steps: []any{
		ok(`[{"id":"pol-1","name":"pipernet-baseline"}]`),
		ok(`{"id":"pol-1","name":"pipernet-baseline","versions":[]}`),
	}}, -1)
	err := admin.EnsureActivePolicySet(context.Background(), client, "z1", admin.ActivePolicySetEnsure{
		PolicyName: "pipernet-baseline",
		SetName:    "pipernet-set",
		Content:    "package caracal.authz\n",
	})
	if err == nil || !strings.Contains(err.Error(), "no versions") {
		t.Fatalf("expected versionless policy error, got %v", err)
	}
}

func TestEnsureActivePolicySetPicksHighestVersion(t *testing.T) {
	content := "package caracal.authz\n"
	detail := `{"id":"pol-1","name":"pipernet-baseline","versions":[
		{"id":"ver-1","version":1,"content_sha256":"stale"},
		{"id":"ver-3","version":3,"content_sha256":"` + contentSHA(content) + `"},
		{"id":"ver-2","version":2,"content_sha256":"other"}
	]}`
	transport := &scripted{steps: []any{
		ok(`[{"id":"pol-1","name":"pipernet-baseline"}]`),
		ok(detail),
		ok(`[{"id":"set-1","name":"pipernet-set","active_version_id":"sv-live"}]`),
	}}
	client := newAdmin(transport, -1)
	if err := admin.EnsureActivePolicySet(context.Background(), client, "z1", admin.ActivePolicySetEnsure{
		PolicyName: "pipernet-baseline",
		SetName:    "pipernet-set",
		Content:    content,
	}); err != nil {
		t.Fatal(err)
	}
	if len(transport.requests) != 3 {
		t.Fatalf("converged policy must not add versions: %d requests", len(transport.requests))
	}
}

func TestEnsureGrantsSurfacesDocumentAuthoringError(t *testing.T) {
	client := newAdmin(&scripted{}, -1)
	err := admin.EnsureGrants(context.Background(), client, "z1", admin.GrantsEnsure{
		Grants: []admin.ResourceGrant{
			{ApplicationID: "app-1", ResourceIdentifier: "resource://pipernet", Scopes: []string{"data:read"}, Role: "worker"},
			{ApplicationID: "app-2", ResourceIdentifier: "resource://pipernet", Scopes: []string{"data:read"}, Role: "worker"},
		},
	})
	if err == nil || !strings.Contains(err.Error(), "claimed by two applications") {
		t.Fatalf("expected role conflict error, got %v", err)
	}
}

func TestEnsureGovernedUpstreamsSurfacesStepFailures(t *testing.T) {
	upstream := pipernetUpstream("sealed")

	providerFail := newAdmin(&scripted{steps: []any{failStep()}}, -1)
	_, err := admin.EnsureGovernedUpstreams(context.Background(), providerFail, "z1", admin.GovernedUpstreamsEnsure{
		Upstreams: []admin.GovernedUpstream{upstream},
	})
	expectBoom(t, err, "provider")

	resourceFail := newAdmin(&scripted{steps: []any{
		ok(`[]`),
		ok(`{"id":"prov-1","identifier":"provider://hooli"}`),
		failStep(),
	}}, -1)
	_, err = admin.EnsureGovernedUpstreams(context.Background(), resourceFail, "z1", admin.GovernedUpstreamsEnsure{
		Upstreams: []admin.GovernedUpstream{upstream},
	})
	expectBoom(t, err, "resource")
}
