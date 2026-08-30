// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package orgs

import (
	"errors"
	"net/http/httptest"
	"testing"

	"github.com/garudex-labs/caracal/internal/tenancy"
)

func TestHostOrgSlug(t *testing.T) {
	cases := []struct {
		host, base, want string
	}{
		{"acme.caracal.run", "caracal.run", "acme"},
		{"acme.caracal.run:443", "caracal.run", "acme"},
		{"caracal.run", "caracal.run", ""},     // apex carries no org
		{"a.b.caracal.run", "caracal.run", ""}, // deeper nesting is infrastructure
		{"acme.other.io", "caracal.run", ""},   // host outside the base domain
		{"acme.caracal.run", "", ""},           // no base domain configured
		{"ACME.Caracal.RUN", " caracal.run. ", "acme"},
	}
	for _, tc := range cases {
		r := httptest.NewRequest("GET", "http://example/", nil)
		r.Host = tc.host
		if got := HostOrgSlug(r, tc.base); got != tc.want {
			t.Errorf("HostOrgSlug(%q, %q) = %q, want %q", tc.host, tc.base, got, tc.want)
		}
	}
}

func TestRequestedOrgSlugMismatch(t *testing.T) {
	r := httptest.NewRequest("GET", "http://example/", nil)
	r.Host = "acme.caracal.run"
	r.Header.Set("X-Caracal-Org", "other")
	_, err := RequestedOrgSlug(r, "caracal.run")
	var te *tenancy.Error
	if !errors.As(err, &te) || te.Status != 409 || te.Detail != "Organization scope mismatch between host and header" {
		t.Fatalf("mismatch = %v", err)
	}

	r.Header.Set("X-Caracal-Org", "acme")
	slug, err := RequestedOrgSlug(r, "caracal.run")
	if err != nil || slug != "acme" {
		t.Fatalf("agreement = %q, %v", slug, err)
	}

	// Header-only scope still resolves without subdomain routing.
	r2 := httptest.NewRequest("GET", "http://example/", nil)
	r2.Header.Set("X-Caracal-Org", " Acme ")
	slug, err = RequestedOrgSlug(r2, "")
	if err != nil || slug != "acme" {
		t.Fatalf("header only = %q, %v", slug, err)
	}
}

func TestSlugShapeGuards(t *testing.T) {
	for _, bad := range []string{"", "ab", "-abc", "abc-", "a_b", "UPPER!", "a..b"} {
		if orgSlugRe.MatchString(bad) {
			t.Errorf("org slug %q must be rejected", bad)
		}
	}
	if !orgSlugRe.MatchString("reg-diff-org") || !projectSlugRe.MatchString("reg-diff") {
		t.Error("canonical slugs must pass")
	}
	if projectSlugRe.MatchString("bad slug") || projectSlugRe.MatchString("-x") {
		t.Error("malformed project slugs must be rejected")
	}
}
