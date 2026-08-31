// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package tenancy

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestNamespaceValidation(t *testing.T) {
	valid := []string{"acme", "a1c", "my-team", "my.team", "  ACME  ", "abc"}
	for _, v := range valid {
		if got, err := ValidateNamespace(v, false); err != nil {
			t.Errorf("ValidateNamespace(%q) = %v", v, err)
		} else if got != strings.ToLower(strings.TrimSpace(v)) {
			t.Errorf("ValidateNamespace(%q) = %q", v, got)
		}
	}
	invalid := []string{"", "ab", "-abc", "abc-", ".abc", "a..b", strings.Repeat("x", 33), "UPPER SPACE"}
	for _, v := range invalid {
		if _, err := ValidateNamespace(v, false); err == nil {
			t.Errorf("ValidateNamespace(%q) accepted", v)
		}
	}
	// Reserved handles reject unless explicitly allowed.
	if _, err := ValidateNamespace("registry", false); err == nil || !strings.Contains(err.Error(), "reserved") {
		t.Errorf("reserved namespace not rejected: %v", err)
	}
	if got, err := ValidateNamespace("registry", true); err != nil || got != "registry" {
		t.Errorf("allowReserved failed: %q %v", got, err)
	}
}

func TestSlugify(t *testing.T) {
	cases := map[string]string{
		"Weather Fetcher":  "weather-fetcher",
		"  My Cool_Tool  ": "my-cool_tool",
		"a!!b":             "a-b",
		"Data (v2)":        "data-v2",
	}
	for in, want := range cases {
		if got, err := Slugify(in); err != nil || got != want {
			t.Errorf("Slugify(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	if _, err := Slugify("!!!"); err == nil {
		t.Error("Slugify of pure symbols accepted")
	}
	// Reserved slugs reject: the action sub-routes cannot be listing slugs.
	if _, err := Slugify("Draft"); err == nil || !strings.Contains(err.Error(), "reserved") {
		t.Errorf("reserved slug not rejected: %v", err)
	}
	// 64-char cap with trailing separator trim.
	long, err := Slugify(strings.Repeat("ab-", 40))
	if err != nil || len(long) > 64 || strings.HasSuffix(long, "-") {
		t.Errorf("long slug = %q (%v)", long, err)
	}
}

func TestSlugifyHandle(t *testing.T) {
	cases := map[string]string{
		"Registry Diff Team": "registry-diff-team",
		"A":                  "a-team",
		"":                   "team",
		"Ops!!":              "ops",
	}
	for in, want := range cases {
		if got, err := SlugifyHandle(in, "team"); err != nil || got != want {
			t.Errorf("SlugifyHandle(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	long, err := SlugifyHandle(strings.Repeat("xy-", 20), "team")
	if err != nil || len(long) > 32 {
		t.Errorf("long handle = %q (%v)", long, err)
	}
}

func TestNamespaceForUser(t *testing.T) {
	if ns, err := NamespaceForUser(User{Username: "acme"}); err != nil || ns != "acme" {
		t.Errorf("valid username: %q %v", ns, err)
	}
	// A now-reserved username on an existing deployment stays usable.
	if ns, err := NamespaceForUser(User{Username: "registry"}); err != nil || ns != "registry" {
		t.Errorf("reserved username: %q %v", ns, err)
	}
	if _, err := NamespaceForUser(User{}); err == nil ||
		!strings.Contains(err.Error(), "username is required") {
		t.Errorf("missing username: %v", err)
	}
	if _, err := NamespaceForUser(User{Username: "Bad Name"}); err == nil ||
		!strings.Contains(err.Error(), "set-username") {
		t.Errorf("invalid username must name the way out: %v", err)
	}
}

func TestRoleHelpers(t *testing.T) {
	if !IsOperator("operator") || IsOperator("admin") || IsOperator("super_admin") || IsOperator("reviewer") || IsOperator("user") {
		t.Error("IsOperator wrong")
	}
	if !IsGlobalReviewer("reviewer") || !IsGlobalReviewer("operator") || IsGlobalReviewer("user") {
		t.Error("IsGlobalReviewer wrong")
	}
	if !HasMinOrgRole("owner", "admin") || !HasMinOrgRole("admin", "admin") || HasMinOrgRole("member", "admin") {
		t.Error("HasMinOrgRole wrong")
	}
	if HasMinOrgRole("", "member") || HasMinOrgRole("bogus", "member") {
		t.Error("absent org role must fail the floor")
	}
	if !CanAdministerProject("member", "lead") || !CanAdministerProject("admin", "") || CanAdministerProject("member", "user") {
		t.Error("CanAdministerProject wrong")
	}
	if !CanAccessProject("member", "user") || !CanAccessProject("owner", "") || CanAccessProject("member", "") {
		t.Error("CanAccessProject wrong: plain org membership must not be enough")
	}
}

func TestEffectivePermissions(t *testing.T) {
	owner := EffectiveOrgPermissions("owner")
	if !owner.Has(PermissionOrgMembersManage) || !owner.Has(PermissionOrgProjectsManage) || !owner.Has(PermissionOrgDelete) || !owner.Has(PermissionOrgOwnershipTransfer) {
		t.Error("owner must have full organization administration permissions")
	}
	admin := EffectiveOrgPermissions("admin")
	if !admin.Has(PermissionOrgMembersManage) || admin.Has(PermissionOrgDelete) || admin.Has(PermissionOrgOwnershipTransfer) {
		t.Error("admin must manage organization without delete-owner authority")
	}
	member := EffectiveOrgPermissions("member")
	if !member.Has(PermissionOrgView) || member.Has(PermissionOrgMembersManage) {
		t.Error("member must be view-only at organization scope")
	}
	operator := EffectiveOrgPermissions("operator")
	if operator.Has(PermissionOrgView) || operator.Has(PermissionOrgMembersManage) {
		t.Error("operator must not imply customer organization permissions")
	}
	lead := EffectiveProjectPermissions("member", "lead")
	if !lead.Has(PermissionProjectMembersManage) || !lead.Has(PermissionProjectSecurityRead) {
		t.Error("project lead must have project administration and security permissions")
	}
	user := EffectiveProjectPermissions("member", "user")
	if !user.Has(PermissionProjectView) || user.Has(PermissionProjectMembersManage) || user.Has(PermissionProjectAuditRead) {
		t.Error("project user must have project access without project administration")
	}
	inherited := EffectiveProjectPermissions("admin", "")
	if !inherited.Has(PermissionProjectMembersManage) || !inherited.Has(PermissionProjectAuditRead) {
		t.Error("org admin must inherit project administration permissions")
	}
	custom := EffectiveProjectPermissions("member", "", PermissionProjectAuditRead)
	if !custom.Has(PermissionProjectAuditRead) || custom.Has(PermissionProjectView) {
		t.Error("custom project permissions must not grant the base project role implicitly")
	}
	if got := EffectiveProjectPermissions("lead", "").Strings(); len(got) != 0 {
		t.Errorf("deployment or unknown roles must not grant project permissions, got %v", got)
	}
}

func TestPublishTargetScope(t *testing.T) {
	if (PublishTarget{Visibility: "private"}).Scope() != "private" ||
		(PublishTarget{Visibility: "project"}).Scope() != "project" {
		t.Error("Scope mapping wrong")
	}
	// Every supported scope is restricted; there is no public state.
	if !(PublishTarget{Visibility: "project"}).IsPrivate() || !(PublishTarget{Visibility: "private"}).IsPrivate() {
		t.Error("IsPrivate mapping wrong")
	}
}

// The validation rejections fire before any database access.
func TestResolvePublishTargetValidation(t *testing.T) {
	r := &Resolver{}
	cases := []struct {
		name   string
		user   User
		opts   PublishOptions
		status int
		detail string
	}{
		{"bad visibility", User{Username: "acme"}, PublishOptions{Visibility: "org"},
			422, "visibility must be 'project' or 'private'"},
		{"public is rejected", User{Username: "acme"}, PublishOptions{Visibility: "public"},
			422, "visibility must be 'project' or 'private'"},
	}
	for _, tc := range cases {
		_, err := r.ResolvePublishTarget(context.Background(), tc.user, "Thing", tc.opts)
		var te *Error
		if !errors.As(err, &te) || te.Status != tc.status || te.Detail != tc.detail {
			t.Errorf("%s: got %v", tc.name, err)
		}
	}
}

func TestCanReview(t *testing.T) {
	project := uuid.New()
	other := uuid.New()
	scope := ReviewScope{
		IsGlobalReviewer: true,
		ProjectIDs:       map[uuid.UUID]bool{project: true},
	}
	// Project-shared item: only its project's leads.
	if !scope.CanReview(&project, true) || scope.CanReview(&other, true) {
		t.Error("project-shared review gate wrong")
	}
	// Personal private item (no reviewable project): operator-only.
	if scope.CanReview(nil, true) {
		t.Error("personal private item must not be reviewable by non-operators")
	}
	if !(ReviewScope{IsOperator: true}).CanReview(nil, true) {
		t.Error("operator must review everything")
	}
	// Public item: global reviewers only.
	if !scope.CanReview(nil, false) {
		t.Error("global reviewer must clear public items")
	}
	local := ReviewScope{ProjectIDs: map[uuid.UUID]bool{project: true}}
	if local.CanReview(&project, false) || local.CanReview(&other, false) {
		t.Error("project leads must not clear public items")
	}
	if local.IsEmpty() {
		t.Error("scope with project ids is not empty")
	}
	if !(ReviewScope{}).IsEmpty() {
		t.Error("empty scope must be empty")
	}
}
