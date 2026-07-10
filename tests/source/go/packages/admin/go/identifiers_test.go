// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for provider and resource identifier helpers.

package admin_test

import (
	"testing"

	admin "github.com/garudex-labs/caracal/packages/admin/go"
)

func TestProviderIdentifierSlugsDisplayNames(t *testing.T) {
	cases := map[string]string{
		"Hooli OIDC":               "provider://hooli-oidc",
		"  Raviga Capital OAuth  ": "provider://raviga-capital-oauth",
		"provider://hooli-oidc":    "provider://hooli-oidc",
		"!!!":                      "provider://provider",
	}
	for input, want := range cases {
		if got := admin.ProviderIdentifier(input); got != want {
			t.Fatalf("ProviderIdentifier(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestIsProviderIdentifier(t *testing.T) {
	if !admin.IsProviderIdentifier("provider://hooli-oidc") {
		t.Fatal("canonical slug rejected")
	}
	for _, value := range []string{"provider://Hooli", "resource://pipernet", "provider://-bad"} {
		if admin.IsProviderIdentifier(value) {
			t.Fatalf("accepted %q", value)
		}
	}
}

func TestResourceIdentifierPreservesAbsoluteURIs(t *testing.T) {
	cases := map[string]string{
		"resource://pipernet":          "resource://pipernet",
		"https://api.pipernet.example": "https://api.pipernet.example",
		"Not Hotdog":                   "resource://not-hotdog",
		"!!!":                          "resource://resource",
	}
	for input, want := range cases {
		if got := admin.ResourceIdentifier(input); got != want {
			t.Fatalf("ResourceIdentifier(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestIsResourceIdentifier(t *testing.T) {
	for _, value := range []string{"resource://pipernet", "https://api.pipernet.example"} {
		if !admin.IsResourceIdentifier(value, "") {
			t.Fatalf("rejected %q", value)
		}
	}
	for _, value := range []string{"provider://hooli-oidc", "plain name", "https://richard:secret@api.pipernet.example"} {
		if admin.IsResourceIdentifier(value, "") {
			t.Fatalf("accepted %q", value)
		}
	}
	if !admin.IsResourceIdentifier("caracal-control", "caracal-control") {
		t.Fatal("control audience rejected")
	}
	if admin.IsResourceIdentifier("caracal-control", "other") {
		t.Fatal("mismatched control audience accepted")
	}
}
