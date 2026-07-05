// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Ensure reconciler unit tests covering application, provider, resource, and policy set convergence plus grant document authoring.

package admin_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"

	admin "github.com/garudex-labs/caracal/packages/admin/go"
)

const policyContent = "package caracal.authz\n"

func contentSHA(content string) string {
	digest := sha256.Sum256([]byte(content))
	return hex.EncodeToString(digest[:])
}

func strPtr(value string) *string {
	return &value
}

func requestSummary(transport *scripted) []string {
	summary := make([]string, 0, len(transport.requests))
	for _, request := range transport.requests {
		summary = append(summary, request.method+" "+request.url)
	}
	return summary
}

func TestEnsureApplicationCreatesManagedIdentity(t *testing.T) {
	transport := &scripted{steps: []any{
		ok(`[]`),
		ok(`{"id":"app-created","name":"Son of Anton","registration_method":"managed"}`),
		ok(`{"id":"app-created"}`),
	}}
	client := newAdmin(transport, -1)

	id, err := admin.EnsureApplication(context.Background(), client, "z1", admin.ApplicationEnsure{
		Name: "Son of Anton", Traits: []string{"ops"}, ClientSecret: "cs_1",
	})
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if id != "app-created" {
		t.Fatalf("unexpected id %s", id)
	}
	assertJSONEqual(t, transport.requests[1].body, map[string]any{
		"name": "Son of Anton", "registration_method": "managed", "traits": []any{"ops"},
	})
	if transport.requests[2].url != "http://api/v1/zones/z1/applications/app-created" {
		t.Fatalf("unexpected patch url %s", transport.requests[2].url)
	}
	assertJSONEqual(t, transport.requests[2].body, map[string]any{"client_secret": "cs_1"})
}

func TestEnsureApplicationRejectsDCRIdentity(t *testing.T) {
	transport := &scripted{steps: []any{
		ok(`[{"id":"app-1","name":"Son of Anton","registration_method":"dcr"}]`),
	}}
	client := newAdmin(transport, -1)

	_, err := admin.EnsureApplication(context.Background(), client, "z1", admin.ApplicationEnsure{
		Name: "Son of Anton", ClientSecret: "cs_1",
	})
	if err == nil || !strings.Contains(err.Error(), "not a usable managed credential") {
		t.Fatalf("expected managed credential error, got %v", err)
	}
	if len(transport.requests) != 1 {
		t.Fatalf("expected fail closed with no writes, got %d requests", len(transport.requests))
	}
}

func TestEnsureApplicationRejectsExpiringIdentity(t *testing.T) {
	transport := &scripted{steps: []any{
		ok(`[{"id":"app-1","name":"Son of Anton","registration_method":"managed","expires_at":"2026-07-01T00:00:00Z"}]`),
	}}
	client := newAdmin(transport, -1)

	_, err := admin.EnsureApplication(context.Background(), client, "z1", admin.ApplicationEnsure{
		Name: "Son of Anton", ClientSecret: "cs_1",
	})
	if err == nil || !strings.Contains(err.Error(), "not a usable managed credential") {
		t.Fatalf("expected managed credential error, got %v", err)
	}
}

func TestEnsureApplicationPatchesDriftedTraitsThenRotates(t *testing.T) {
	transport := &scripted{steps: []any{
		ok(`[{"id":"app-1","name":"Son of Anton","registration_method":"managed","traits":["stale"]}]`),
		ok(`{"id":"app-1"}`),
		ok(`{"id":"app-1"}`),
	}}
	client := newAdmin(transport, -1)

	id, err := admin.EnsureApplication(context.Background(), client, "z1", admin.ApplicationEnsure{
		Name: "Son of Anton", Traits: []string{"ops"}, ClientSecret: "cs_1",
	})
	if err != nil || id != "app-1" {
		t.Fatalf("ensure: id=%s err=%v", id, err)
	}
	assertJSONEqual(t, transport.requests[1].body, map[string]any{"traits": []any{"ops"}})
	assertJSONEqual(t, transport.requests[2].body, map[string]any{"client_secret": "cs_1"})
}

func TestEnsureApplicationSkipsTraitPatchWhenConverged(t *testing.T) {
	transport := &scripted{steps: []any{
		ok(`[{"id":"app-1","name":"Son of Anton","registration_method":"managed","traits":["ops"]}]`),
		ok(`{"id":"app-1"}`),
	}}
	client := newAdmin(transport, -1)

	if _, err := admin.EnsureApplication(context.Background(), client, "z1", admin.ApplicationEnsure{
		Name: "Son of Anton", Traits: []string{"ops"}, ClientSecret: "cs_1",
	}); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if len(transport.requests) != 2 {
		t.Fatalf("expected list and secret patch only, got %v", requestSummary(transport))
	}
	assertJSONEqual(t, transport.requests[1].body, map[string]any{"client_secret": "cs_1"})
}

func TestEnsureAPIKeyProviderAbsentWithoutKeyReturnsEmpty(t *testing.T) {
	transport := &scripted{steps: []any{ok(`[]`)}}
	client := newAdmin(transport, -1)

	id, err := admin.EnsureAPIKeyProvider(context.Background(), client, "z1", admin.APIKeyProviderEnsure{
		Name: "Hooli OIDC", Identifier: "hooli-api-key", PublicConfig: map[string]any{"placement": "header"},
	})
	if err != nil || id != "" {
		t.Fatalf("expected empty id, got id=%q err=%v", id, err)
	}
	if len(transport.requests) != 1 {
		t.Fatalf("expected no writes, got %v", requestSummary(transport))
	}
}

func TestEnsureAPIKeyProviderPatchesPlacementWithoutKey(t *testing.T) {
	transport := &scripted{steps: []any{
		ok(`[{"id":"prov-1","name":"Hooli OIDC","identifier":"hooli-api-key","kind":"api_key"}]`),
		ok(`{"id":"prov-1"}`),
	}}
	client := newAdmin(transport, -1)

	id, err := admin.EnsureAPIKeyProvider(context.Background(), client, "z1", admin.APIKeyProviderEnsure{
		Name: "Hooli OIDC", Identifier: "hooli-api-key", PublicConfig: map[string]any{"placement": "header"},
	})
	if err != nil || id != "prov-1" {
		t.Fatalf("ensure: id=%s err=%v", id, err)
	}
	assertJSONEqual(t, transport.requests[1].body, map[string]any{"config_json": map[string]any{"placement": "header"}})
}

func TestEnsureAPIKeyProviderCreatesSealedProvider(t *testing.T) {
	transport := &scripted{steps: []any{
		ok(`[]`),
		ok(`{"id":"prov-created"}`),
	}}
	client := newAdmin(transport, -1)

	id, err := admin.EnsureAPIKeyProvider(context.Background(), client, "z1", admin.APIKeyProviderEnsure{
		Name: "Hooli OIDC", Identifier: "hooli-api-key",
		PublicConfig: map[string]any{"placement": "header"}, APIKey: "ak_sealed",
	})
	if err != nil || id != "prov-created" {
		t.Fatalf("ensure: id=%s err=%v", id, err)
	}
	assertJSONEqual(t, transport.requests[1].body, map[string]any{
		"name": "Hooli OIDC", "identifier": "hooli-api-key", "kind": "api_key",
		"config_json": map[string]any{"placement": "header", "api_key": "ak_sealed"},
	})
}

func TestEnsureAPIKeyProviderReSealsExistingProvider(t *testing.T) {
	transport := &scripted{steps: []any{
		ok(`[{"id":"prov-1","name":"Hooli OIDC","identifier":"hooli-api-key","kind":"api_key"}]`),
		ok(`{"id":"prov-1"}`),
	}}
	client := newAdmin(transport, -1)

	id, err := admin.EnsureAPIKeyProvider(context.Background(), client, "z1", admin.APIKeyProviderEnsure{
		Name: "Hooli OIDC", Identifier: "hooli-api-key",
		PublicConfig: map[string]any{"placement": "header"}, APIKey: "ak_rotated",
	})
	if err != nil || id != "prov-1" {
		t.Fatalf("ensure: id=%s err=%v", id, err)
	}
	assertJSONEqual(t, transport.requests[1].body, map[string]any{
		"kind": "api_key", "config_json": map[string]any{"placement": "header", "api_key": "ak_rotated"},
	})
}

func TestEnsureResourceCreatesWithManagedFields(t *testing.T) {
	transport := &scripted{steps: []any{
		ok(`[]`),
		ok(`{"id":"res-created","identifier":"resource://pipernet"}`),
	}}
	client := newAdmin(transport, -1)

	resource, err := admin.EnsureResource(context.Background(), client, "z1", admin.ResourceEnsure{
		Name: "PiperNet", Identifier: "resource://pipernet", Scopes: []string{"data:read"},
		UpstreamURL: strPtr("https://api.pipernet.example"), OperationEnforcement: strPtr("enforce"),
	})
	if err != nil || resource.ID != "res-created" {
		t.Fatalf("ensure: %+v err=%v", resource, err)
	}
	assertJSONEqual(t, transport.requests[1].body, map[string]any{
		"name": "PiperNet", "identifier": "resource://pipernet", "scopes": []any{"data:read"},
		"upstream_url": "https://api.pipernet.example", "operation_enforcement": "enforce",
	})
}

func TestEnsureResourceLeavesConvergedResourceAlone(t *testing.T) {
	transport := &scripted{steps: []any{
		ok(`[{"id":"res-1","identifier":"resource://pipernet","scopes":["data:read"],"upstream_url":"https://api.pipernet.example"}]`),
	}}
	client := newAdmin(transport, -1)

	resource, err := admin.EnsureResource(context.Background(), client, "z1", admin.ResourceEnsure{
		Name: "PiperNet", Identifier: "resource://pipernet", Scopes: []string{"data:read"},
		UpstreamURL: strPtr("https://api.pipernet.example"),
	})
	if err != nil || resource.ID != "res-1" {
		t.Fatalf("ensure: %+v err=%v", resource, err)
	}
	if len(transport.requests) != 1 {
		t.Fatalf("expected no patch, got %v", requestSummary(transport))
	}
}

func TestEnsureResourcePatchesOnlyManagedFieldsOnDrift(t *testing.T) {
	transport := &scripted{steps: []any{
		ok(`[{"id":"res-1","identifier":"resource://pipernet","scopes":["data:read"],"upstream_url":"https://stale.pipernet.example","gateway_application_id":"app-unmanaged"}]`),
		ok(`{"id":"res-1"}`),
	}}
	client := newAdmin(transport, -1)

	if _, err := admin.EnsureResource(context.Background(), client, "z1", admin.ResourceEnsure{
		Name: "PiperNet", Identifier: "resource://pipernet", Scopes: []string{"data:read", "data:write"},
		UpstreamURL: strPtr("https://api.pipernet.example"),
	}); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	assertJSONEqual(t, transport.requests[1].body, map[string]any{
		"scopes": []any{"data:read", "data:write"}, "upstream_url": "https://api.pipernet.example",
	})
}

func TestEnsureResourceAddsLifecycleScopeWhenGatewayBound(t *testing.T) {
	transport := &scripted{steps: []any{
		ok(`[]`),
		ok(`{"id":"res-created"}`),
	}}
	client := newAdmin(transport, -1)

	if _, err := admin.EnsureResource(context.Background(), client, "z1", admin.ResourceEnsure{
		Name: "PiperNet", Identifier: "resource://pipernet", Scopes: []string{"data:read"},
		GatewayApplicationID: strPtr("app-1"),
	}); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	body := decodeBody(t, transport.requests[1].body)
	scopes, _ := body["scopes"].([]any)
	if len(scopes) != 2 || scopes[0] != "data:read" || scopes[1] != admin.LifecycleScope {
		t.Fatalf("unexpected scopes %v", scopes)
	}
}

func TestEnsureResourceDoesNotDuplicateDeclaredLifecycleScope(t *testing.T) {
	transport := &scripted{steps: []any{
		ok(`[]`),
		ok(`{"id":"res-created"}`),
	}}
	client := newAdmin(transport, -1)

	if _, err := admin.EnsureResource(context.Background(), client, "z1", admin.ResourceEnsure{
		Name: "PiperNet", Identifier: "resource://pipernet",
		Scopes:               []string{"data:read", admin.LifecycleScope},
		GatewayApplicationID: strPtr("app-1"),
	}); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	body := decodeBody(t, transport.requests[1].body)
	scopes, _ := body["scopes"].([]any)
	if len(scopes) != 2 {
		t.Fatalf("expected two scopes, got %v", scopes)
	}
}

func TestEnsureResourceGatewayBoundConvergedNeedsNoPatch(t *testing.T) {
	transport := &scripted{steps: []any{
		ok(`[{"id":"res-1","identifier":"resource://pipernet","scopes":["data:read","agent:lifecycle"],"gateway_application_id":"app-1"}]`),
	}}
	client := newAdmin(transport, -1)

	if _, err := admin.EnsureResource(context.Background(), client, "z1", admin.ResourceEnsure{
		Name: "PiperNet", Identifier: "resource://pipernet", Scopes: []string{"data:read"},
		GatewayApplicationID: strPtr("app-1"),
	}); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if len(transport.requests) != 1 {
		t.Fatalf("expected no patch, got %v", requestSummary(transport))
	}
}

func TestEnsureResourceWithoutGatewayAddsNoLifecycleScope(t *testing.T) {
	transport := &scripted{steps: []any{
		ok(`[]`),
		ok(`{"id":"res-created"}`),
	}}
	client := newAdmin(transport, -1)

	if _, err := admin.EnsureResource(context.Background(), client, "z1", admin.ResourceEnsure{
		Name: "PiperNet", Identifier: "resource://pipernet", Scopes: []string{"data:read"},
	}); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	body := decodeBody(t, transport.requests[1].body)
	scopes, _ := body["scopes"].([]any)
	if len(scopes) != 1 || scopes[0] != "data:read" {
		t.Fatalf("unexpected scopes %v", scopes)
	}
}

func TestEnsureActivePolicySetSuppressedCreationDoesNothing(t *testing.T) {
	transport := &scripted{steps: []any{ok(`[]`)}}
	client := newAdmin(transport, -1)

	if err := admin.EnsureActivePolicySet(context.Background(), client, "z1", admin.ActivePolicySetEnsure{
		PolicyName: "application-grants", SetName: "PiperNet set", Content: policyContent, SkipCreate: true,
	}); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if len(transport.requests) != 1 {
		t.Fatalf("expected list only, got %v", requestSummary(transport))
	}
}

func TestEnsureActivePolicySetMaterializesFirstVersion(t *testing.T) {
	transport := &scripted{steps: []any{
		ok(`[]`),
		ok(`{"id":"pol-created","version_id":"ver-created"}`),
		ok(`[]`),
		ok(`{"id":"set-created","name":"PiperNet set"}`),
		ok(`{"version_id":"setver-1"}`),
		ok(`{}`),
	}}
	client := newAdmin(transport, -1)

	if err := admin.EnsureActivePolicySet(context.Background(), client, "z1", admin.ActivePolicySetEnsure{
		PolicyName: "application-grants", SetName: "PiperNet set", Content: policyContent,
	}); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	assertJSONEqual(t, transport.requests[1].body, map[string]any{"name": "application-grants", "content": policyContent})
	assertJSONEqual(t, transport.requests[3].body, map[string]any{"name": "PiperNet set"})
	assertJSONEqual(t, transport.requests[4].body, map[string]any{"manifest": []any{map[string]any{"policy_version_id": "ver-created"}}})
	if transport.requests[5].url != "http://api/v1/zones/z1/policy-sets/set-created/activate" {
		t.Fatalf("unexpected activate url %s", transport.requests[5].url)
	}
	assertJSONEqual(t, transport.requests[5].body, map[string]any{"version_id": "setver-1"})
}

func TestEnsureActivePolicySetAddsVersionOnDigestChange(t *testing.T) {
	transport := &scripted{steps: []any{
		ok(`[{"id":"pol-1","name":"application-grants"}]`),
		ok(`{"id":"pol-1","name":"application-grants","versions":[{"id":"ver-1","version":1,"content_sha256":"stale"}]}`),
		ok(`{"version_id":"ver-added"}`),
		ok(`[{"id":"set-1","name":"PiperNet set","active_version_id":"setver-0"}]`),
		ok(`{"version_id":"setver-1"}`),
		ok(`{}`),
	}}
	client := newAdmin(transport, -1)

	if err := admin.EnsureActivePolicySet(context.Background(), client, "z1", admin.ActivePolicySetEnsure{
		PolicyName: "application-grants", SetName: "PiperNet set", Content: policyContent,
	}); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	assertJSONEqual(t, transport.requests[2].body, map[string]any{"content": policyContent, "schema_version": "2026-05-20"})
	assertJSONEqual(t, transport.requests[4].body, map[string]any{"manifest": []any{map[string]any{"policy_version_id": "ver-added"}}})
	assertJSONEqual(t, transport.requests[5].body, map[string]any{"version_id": "setver-1"})
}

func TestEnsureActivePolicySetSteadyStateDoesNothing(t *testing.T) {
	transport := &scripted{steps: []any{
		ok(`[{"id":"pol-1","name":"application-grants"}]`),
		ok(`{"id":"pol-1","name":"application-grants","versions":[{"id":"ver-2","version":2,"content_sha256":"` + contentSHA(policyContent) + `"}]}`),
		ok(`[{"id":"set-1","name":"PiperNet set","active_version_id":"setver-1"}]`),
	}}
	client := newAdmin(transport, -1)

	if err := admin.EnsureActivePolicySet(context.Background(), client, "z1", admin.ActivePolicySetEnsure{
		PolicyName: "application-grants", SetName: "PiperNet set", Content: policyContent,
	}); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if len(transport.requests) != 3 {
		t.Fatalf("expected reads only, got %v", requestSummary(transport))
	}
}

func TestEnsureActivePolicySetSelfHealsInactiveSet(t *testing.T) {
	transport := &scripted{steps: []any{
		ok(`[{"id":"pol-1","name":"application-grants"}]`),
		ok(`{"id":"pol-1","name":"application-grants","versions":[{"id":"ver-2","version":2,"content_sha256":"` + contentSHA(policyContent) + `"}]}`),
		ok(`[{"id":"set-1","name":"PiperNet set","active_version_id":null}]`),
		ok(`{"version_id":"setver-1"}`),
		ok(`{}`),
	}}
	client := newAdmin(transport, -1)

	if err := admin.EnsureActivePolicySet(context.Background(), client, "z1", admin.ActivePolicySetEnsure{
		PolicyName: "application-grants", SetName: "PiperNet set", Content: policyContent,
	}); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	assertJSONEqual(t, transport.requests[3].body, map[string]any{"manifest": []any{map[string]any{"policy_version_id": "ver-2"}}})
	assertJSONEqual(t, transport.requests[4].body, map[string]any{"version_id": "setver-1"})
}

func TestAuthorGrantsDocumentRendersDecisionContractInputs(t *testing.T) {
	document, err := admin.AuthorGrantsDocument([]admin.ResourceGrant{
		{ApplicationID: "app-son-of-anton", ResourceIdentifier: "resource://pipernet", Scopes: []string{"data:read"}, Role: "operator"},
	})
	if err != nil {
		t.Fatalf("author: %v", err)
	}
	for _, fragment := range []string{
		"# caracal:data-document",
		"package caracal.authz",
		"import rego.v1",
		`app_ids := {"operator":"app-son-of-anton"}`,
		`grants := {"resource://pipernet":{"application":"operator","roles":{"operator":["data:read"]}}}`,
	} {
		if !strings.Contains(document, fragment) {
			t.Fatalf("missing fragment %q in:\n%s", fragment, document)
		}
	}
}

func TestAuthorGrantsDocumentDefaultsRoleToApplicationID(t *testing.T) {
	document, err := admin.AuthorGrantsDocument([]admin.ResourceGrant{
		{ApplicationID: "app-son-of-anton", ResourceIdentifier: "resource://pipernet", Scopes: []string{"data:read"}},
	})
	if err != nil {
		t.Fatalf("author: %v", err)
	}
	if !strings.Contains(document, `app_ids := {"app-son-of-anton":"app-son-of-anton"}`) ||
		!strings.Contains(document, `"roles":{"app-son-of-anton":["data:read"]}`) {
		t.Fatalf("unexpected document:\n%s", document)
	}
}

func TestAuthorGrantsDocumentIsDeterministic(t *testing.T) {
	first, err := admin.AuthorGrantsDocument([]admin.ResourceGrant{
		{ApplicationID: "app-fiona", ResourceIdentifier: "resource://not-hotdog", Scopes: []string{"data:write", "data:read"}, Role: "classifier"},
		{ApplicationID: "app-son-of-anton", ResourceIdentifier: "resource://pipernet", Scopes: []string{"data:read"}, Role: "operator"},
	})
	if err != nil {
		t.Fatalf("author: %v", err)
	}
	second, err := admin.AuthorGrantsDocument([]admin.ResourceGrant{
		{ApplicationID: "app-son-of-anton", ResourceIdentifier: "resource://pipernet", Scopes: []string{"data:read"}, Role: "operator"},
		{ApplicationID: "app-fiona", ResourceIdentifier: "resource://not-hotdog", Scopes: []string{"data:read", "data:write", "data:read"}, Role: "classifier"},
	})
	if err != nil {
		t.Fatalf("author: %v", err)
	}
	if first != second {
		t.Fatalf("documents differ:\n%s\n---\n%s", first, second)
	}
}

func TestAuthorGrantsDocumentMergesScopesForOneRole(t *testing.T) {
	document, err := admin.AuthorGrantsDocument([]admin.ResourceGrant{
		{ApplicationID: "app-son-of-anton", ResourceIdentifier: "resource://pipernet", Scopes: []string{"data:read"}, Role: "operator"},
		{ApplicationID: "app-son-of-anton", ResourceIdentifier: "resource://pipernet", Scopes: []string{"data:write"}, Role: "operator"},
	})
	if err != nil {
		t.Fatalf("author: %v", err)
	}
	if !strings.Contains(document, `"roles":{"operator":["data:read","data:write"]}`) {
		t.Fatalf("unexpected document:\n%s", document)
	}
}

func TestAuthorGrantsDocumentRejectsRoleClaimedByTwoApplications(t *testing.T) {
	_, err := admin.AuthorGrantsDocument([]admin.ResourceGrant{
		{ApplicationID: "app-son-of-anton", ResourceIdentifier: "resource://pipernet", Scopes: []string{"data:read"}, Role: "operator"},
		{ApplicationID: "app-fiona", ResourceIdentifier: "resource://not-hotdog", Scopes: []string{"data:read"}, Role: "operator"},
	})
	if err == nil || !strings.Contains(err.Error(), "claimed by two applications") {
		t.Fatalf("expected conflict error, got %v", err)
	}
}

func TestEnsureGrantsConvergesDefaultPolicyAndSet(t *testing.T) {
	transport := &scripted{steps: []any{
		ok(`[]`),
		ok(`{"id":"pol-created","version_id":"ver-created"}`),
		ok(`[]`),
		ok(`{"id":"set-created","name":"application-grant-policy"}`),
		ok(`{"version_id":"setver-1"}`),
		ok(`{}`),
	}}
	client := newAdmin(transport, -1)

	grants := []admin.ResourceGrant{
		{ApplicationID: "app-son-of-anton", ResourceIdentifier: "resource://pipernet", Scopes: []string{"data:read"}, Role: "operator"},
	}
	if err := admin.EnsureGrants(context.Background(), client, "z1", admin.GrantsEnsure{Grants: grants}); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	document, err := admin.AuthorGrantsDocument(grants)
	if err != nil {
		t.Fatalf("author: %v", err)
	}
	assertJSONEqual(t, transport.requests[1].body, map[string]any{"name": "application-grants", "content": document})
	assertJSONEqual(t, transport.requests[3].body, map[string]any{"name": "application-grant-policy"})
	if !strings.HasSuffix(strings.TrimSuffix(transport.requests[5].url, "/"), "/activate") {
		t.Fatalf("expected activation, got %v", requestSummary(transport))
	}
}

func TestEnsureGrantsWithEmptySetCreatesNothing(t *testing.T) {
	transport := &scripted{steps: []any{ok(`[]`)}}
	client := newAdmin(transport, -1)

	if err := admin.EnsureGrants(context.Background(), client, "z1", admin.GrantsEnsure{}); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if len(transport.requests) != 1 {
		t.Fatalf("expected list only, got %v", requestSummary(transport))
	}
}

func TestEnsureGrantsHonoursCallerNames(t *testing.T) {
	transport := &scripted{steps: []any{
		ok(`[]`),
		ok(`{"id":"pol-created","version_id":"ver-created"}`),
		ok(`[]`),
		ok(`{"id":"set-created","name":"custom-set"}`),
		ok(`{"version_id":"setver-1"}`),
		ok(`{}`),
	}}
	client := newAdmin(transport, -1)

	if err := admin.EnsureGrants(context.Background(), client, "z1", admin.GrantsEnsure{
		Grants: []admin.ResourceGrant{
			{ApplicationID: "app-fiona", ResourceIdentifier: "resource://not-hotdog", Scopes: []string{"data:read"}},
		},
		PolicyName: "custom-grants", SetName: "custom-set",
	}); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	body := decodeBody(t, transport.requests[1].body)
	if body["name"] != "custom-grants" {
		t.Fatalf("unexpected policy name %v", body["name"])
	}
	setBody := decodeBody(t, transport.requests[3].body)
	if setBody["name"] != "custom-set" {
		t.Fatalf("unexpected set name %v", setBody["name"])
	}
}

func pipernetUpstream(apiKey string) admin.GovernedUpstream {
	return admin.GovernedUpstream{
		Provider: admin.APIKeyProviderEnsure{
			Name:       "Hooli PiperNet OIDC",
			Identifier: "provider://pipernet",
			PublicConfig: map[string]any{
				"auth_location": "header",
				"header_name":   "Authorization",
				"auth_scheme":   "Bearer",
			},
			APIKey: apiKey,
		},
		Resource: admin.GovernedUpstreamResource{
			Name:                 "PiperNet",
			Identifier:           "resource://pipernet",
			Scopes:               []string{"data:read"},
			UpstreamURL:          "https://api.pipernet.example",
			GatewayApplicationID: "app-son-of-anton",
		},
		Grants: []admin.GovernedUpstreamGrant{
			{ApplicationID: "app-son-of-anton", Scopes: []string{"data:read"}},
		},
	}
}

func TestEnsureGovernedUpstreamsConvergesInDependencyOrder(t *testing.T) {
	transport := &scripted{steps: []any{
		ok(`[]`),
		ok(`{"id":"prov-created"}`),
		ok(`[]`),
		ok(`{"id":"res-created","identifier":"resource://pipernet"}`),
		ok(`[]`),
		ok(`{"id":"pol-created","version_id":"ver-created"}`),
		ok(`[]`),
		ok(`{"id":"set-created","name":"application-grant-policy"}`),
		ok(`{"version_id":"setver-1"}`),
		ok(`{}`),
	}}
	client := newAdmin(transport, -1)

	results, err := admin.EnsureGovernedUpstreams(context.Background(), client, "z1", admin.GovernedUpstreamsEnsure{
		Upstreams: []admin.GovernedUpstream{pipernetUpstream("sk-pipernet")},
	})
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	assertJSONEqual(t, transport.requests[1].body, map[string]any{
		"name": "Hooli PiperNet OIDC", "identifier": "provider://pipernet", "kind": "api_key",
		"config_json": map[string]any{
			"auth_location": "header", "header_name": "Authorization", "auth_scheme": "Bearer", "api_key": "sk-pipernet",
		},
	})
	assertJSONEqual(t, transport.requests[3].body, map[string]any{
		"name": "PiperNet", "identifier": "resource://pipernet",
		"scopes":                 []any{"data:read", "agent:lifecycle"},
		"upstream_url":           "https://api.pipernet.example",
		"credential_provider_id": "prov-created",
		"gateway_application_id": "app-son-of-anton",
	})
	document, err := admin.AuthorGrantsDocument([]admin.ResourceGrant{
		{ApplicationID: "app-son-of-anton", ResourceIdentifier: "resource://pipernet", Scopes: []string{"data:read"}},
	})
	if err != nil {
		t.Fatalf("author: %v", err)
	}
	assertJSONEqual(t, transport.requests[5].body, map[string]any{"name": "application-grants", "content": document})
	if len(results) != 1 || results[0].ProviderID != "prov-created" || results[0].Resource.Identifier != "resource://pipernet" {
		t.Fatalf("unexpected results %+v", results)
	}
}

func TestEnsureGovernedUpstreamsFailsClosedWithoutSealedKey(t *testing.T) {
	transport := &scripted{steps: []any{ok(`[]`)}}
	client := newAdmin(transport, -1)

	_, err := admin.EnsureGovernedUpstreams(context.Background(), client, "z1", admin.GovernedUpstreamsEnsure{
		Upstreams: []admin.GovernedUpstream{pipernetUpstream("")},
	})
	if err == nil || !strings.Contains(err.Error(), "no sealed api key") {
		t.Fatalf("expected fail-closed error, got %v", err)
	}
	if len(transport.requests) != 1 {
		t.Fatalf("expected provider list only, got %v", requestSummary(transport))
	}
}

func TestEnsureGovernedUpstreamsEmptySetCreatesNothing(t *testing.T) {
	transport := &scripted{steps: []any{ok(`[]`)}}
	client := newAdmin(transport, -1)

	results, err := admin.EnsureGovernedUpstreams(context.Background(), client, "z1", admin.GovernedUpstreamsEnsure{})
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("unexpected results %+v", results)
	}
	if len(transport.requests) != 1 {
		t.Fatalf("expected policy list only, got %v", requestSummary(transport))
	}
}

func TestEnsureGovernedUpstreamsThreadsCallerNames(t *testing.T) {
	transport := &scripted{steps: []any{
		ok(`[]`),
		ok(`{"id":"prov-created"}`),
		ok(`[]`),
		ok(`{"id":"res-created","identifier":"resource://pipernet"}`),
		ok(`[]`),
		ok(`{"id":"pol-created","version_id":"ver-created"}`),
		ok(`[]`),
		ok(`{"id":"set-created","name":"pied-piper-grant-policy"}`),
		ok(`{"version_id":"setver-1"}`),
		ok(`{}`),
	}}
	client := newAdmin(transport, -1)

	_, err := admin.EnsureGovernedUpstreams(context.Background(), client, "z1", admin.GovernedUpstreamsEnsure{
		Upstreams:  []admin.GovernedUpstream{pipernetUpstream("sk-pipernet")},
		PolicyName: "pied-piper-grants",
		SetName:    "pied-piper-grant-policy",
	})
	if err != nil {
		t.Fatalf("ensure: %v", err)
	}
	body := decodeBody(t, transport.requests[5].body)
	if body["name"] != "pied-piper-grants" {
		t.Fatalf("unexpected policy name %v", body["name"])
	}
	setBody := decodeBody(t, transport.requests[7].body)
	if setBody["name"] != "pied-piper-grant-policy" {
		t.Fatalf("unexpected set name %v", setBody["name"])
	}
}
