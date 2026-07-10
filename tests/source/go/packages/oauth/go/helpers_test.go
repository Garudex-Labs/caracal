// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for OAuth client pure helpers covering scopes, resources, and responses.

package oauth

import (
	"testing"
	"time"
)

func TestApprovalRequiredErrorMessage(t *testing.T) {
	if got := (&ApprovalRequiredError{}).Error(); got != "approval required" {
		t.Fatalf("empty message must yield default, got %q", got)
	}
	if got := (&ApprovalRequiredError{Message: "step up"}).Error(); got != "approval required: step up" {
		t.Fatalf("message must be appended, got %q", got)
	}
}

func TestNormalizedScopes(t *testing.T) {
	if got := normalizedScopes(nil); got != "" {
		t.Fatalf("nil scopes must produce empty string, got %q", got)
	}
	got := normalizedScopes([]string{"read", "admin", "read", "write"})
	if got != "admin read write" {
		t.Fatalf("scopes must be deduped and sorted, got %q", got)
	}
}

func TestFirstResource(t *testing.T) {
	if got := firstResource(nil); got != "" {
		t.Fatalf("empty list must return empty string, got %q", got)
	}
	if got := firstResource([]string{"a", "b"}); got != "a" {
		t.Fatalf("must return first element, got %q", got)
	}
}

func TestResourceList(t *testing.T) {
	got := resourceList([]string{" b ", "", "  ", "a", "b"})
	if len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Fatalf("must trim and drop empties, got %v", got)
	}
}

func TestJSONResponse(t *testing.T) {
	cases := map[string]bool{
		"":                                true,
		"application/json":                true,
		"application/json; charset=utf-8": true,
		"application/scim+json":           true,
		"text/html":                       false,
	}
	for ct, want := range cases {
		if got := jsonResponse(ct); got != want {
			t.Fatalf("jsonResponse(%q) = %v, want %v", ct, got, want)
		}
	}
}

func TestTimeoutFromOptions(t *testing.T) {
	if got := timeoutFromOptions(ExchangeOptions{}); got != defaultTimeout {
		t.Fatalf("zero timeout must fall back to default, got %s", got)
	}
	if got := timeoutFromOptions(ExchangeOptions{TimeoutMillis: 1500}); got != 1500*time.Millisecond {
		t.Fatalf("explicit timeout must be honored, got %s", got)
	}
}

func TestTTLString(t *testing.T) {
	if got := ttlString(0); got != "" {
		t.Fatalf("non-positive ttl must be empty, got %q", got)
	}
	if got := ttlString(300); got != "300" {
		t.Fatalf("positive ttl must stringify, got %q", got)
	}
}

func TestHashSecret(t *testing.T) {
	if hashSecret("") != "" {
		t.Fatal("empty secret hash must stay empty")
	}
	if hashSecret("secret") == "" || hashSecret("secret") == "secret" {
		t.Fatal("non-empty secret must hash")
	}
}

func TestValidateSuccess(t *testing.T) {
	ok, err := validateSuccess(stsSuccessResponse{AccessToken: "t", ExpiresIn: 60, TargetResources: []string{"resource://api"}})
	if err != nil {
		t.Fatalf("valid response must pass: %v", err)
	}
	if ok.TokenType != "Bearer" || ok.AccessToken != "t" || ok.ExpiresIn != 60 || ok.IssuedAt == 0 {
		t.Fatalf("normalized response wrong: %+v", ok)
	}
	if len(ok.TargetResources) != 1 || ok.TargetResources[0] != "resource://api" {
		t.Fatalf("target resources were not preserved: %+v", ok)
	}

	if _, err := validateSuccess(stsSuccessResponse{ExpiresIn: 60}); err == nil {
		t.Fatal("missing access_token must error")
	}
	if _, err := validateSuccess(stsSuccessResponse{AccessToken: "t", TokenType: "MAC", ExpiresIn: 60}); err == nil {
		t.Fatal("non-Bearer token_type must error")
	}
	if _, err := validateSuccess(stsSuccessResponse{AccessToken: "t", ExpiresIn: 0}); err == nil {
		t.Fatal("non-positive expires_in must error")
	}
}
