// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package orgs

import (
	"context"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/tenancy"
)

type isolationSetting string

func (s isolationSetting) String(context.Context, string, string) string { return string(s) }

// A project is only ever resolved inside its organization: the lookup is scoped
// by organization_id, so a slug that names a project of another organization
// cannot be returned. This is the server-side half of the org/project URL
// isolation contract - a manipulated `orgA/projectB` URL is rejected when
// projectB does not belong to orgA.
func TestResolveProjectIsOrgScopedAndRejectsForeignProjects(t *testing.T) {
	org := &Org{ID: orgID, Slug: "acme", Role: "owner"}
	projectID := uuid.MustParse("33333333-3333-3333-3333-333333333333")

	// A project that belongs to THIS org resolves for an authorized caller.
	ok := &fakeDB{stubs: []stub{{
		match: "WHERE p.organization_id = $1 AND p.slug = $2",
		rows:  &fakeRows{rows: [][]any{{projectID, orgID, "platform", "Platform", nil, orgTime, false, "lead"}}},
	}}}
	project, err := (&Store{DB: ok}).ResolveProject(context.Background(), org, "platform", callerID)
	if err != nil || project == nil || project.Slug != "platform" {
		t.Fatalf("valid project: project=%v err=%v", project, err)
	}
	if last := ok.log[len(ok.log)-1]; !strings.Contains(last, "p.organization_id = $1 AND p.slug = $2") {
		t.Errorf("project lookup is not organization-scoped: %q", last)
	}

	// A slug that is not a project of THIS org (e.g. one owned by another org)
	// matches no rows under the org-scoped query, so it is a 404 - never another
	// organization's project row.
	var te *tenancy.Error
	if _, err := (&Store{DB: &fakeDB{}}).ResolveProject(context.Background(), org, "foreign-project", callerID); !errors.As(err, &te) || te.Status != 404 {
		t.Fatalf("cross-org project error = %v (want 404 Project not found)", err)
	}
}

// Plain organization membership is not project access: the roster is the access
// mechanism, so a non-member of the project (with only org `member` standing)
// is rejected even for a project that exists in the org.
func TestResolveProjectRejectsNonMemberWithoutOrgAdmin(t *testing.T) {
	org := &Org{ID: orgID, Slug: "acme", Role: "member"}
	projectID := uuid.MustParse("44444444-4444-4444-4444-444444444444")
	db := &fakeDB{stubs: []stub{{
		match: "WHERE p.organization_id = $1 AND p.slug = $2",
		rows:  &fakeRows{rows: [][]any{{projectID, orgID, "platform", "Platform", nil, orgTime, false, nil}}},
	}}}
	var te *tenancy.Error
	if _, err := (&Store{DB: db}).ResolveProject(context.Background(), org, "platform", callerID); !errors.As(err, &te) || te.Status != 404 {
		t.Fatalf("non-member access error = %v (want 404)", err)
	}
}

func TestAmbientProjectResolverValidatesHostOrgAndProjectPair(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		orgStub("owner"),
		projectStub(projectRowValues("platform", false, "lead")),
	}}
	resolver := &AmbientProjectResolver{Store: &Store{DB: db}, Settings: isolationSetting("caracal.run")}
	req := httptest.NewRequest("GET", "https://acme.caracal.run/api/v1/sessions", nil)
	req.Host = "acme.caracal.run"
	req.Header.Set("X-Caracal-Org", "acme")
	req.Header.Set("X-Caracal-Project", "platform")

	projectID, err := resolver.ResolveProjectID(context.Background(), req, callerID)
	if err != nil || projectID != projID.String() {
		t.Fatalf("resolved project = %q, err = %v", projectID, err)
	}

	foreign := httptest.NewRequest("GET", "https://acme.caracal.run/api/v1/sessions", nil)
	foreign.Host = "acme.caracal.run"
	foreign.Header.Set("X-Caracal-Org", "acme")
	foreign.Header.Set("X-Caracal-Project", "foreign-project")
	var scopeErr *tenancy.Error
	if _, err := (&AmbientProjectResolver{
		Store:    &Store{DB: &fakeDB{stubs: []stub{orgStub("owner")}}},
		Settings: isolationSetting("caracal.run"),
	}).ResolveProjectID(context.Background(), foreign, callerID); !errors.As(err, &scopeErr) || scopeErr.Status != 404 {
		t.Fatalf("foreign project error = %v, want 404", err)
	}
}

func TestAmbientProjectResolverRejectsTransportMismatchAndMissingScope(t *testing.T) {
	resolver := &AmbientProjectResolver{Store: &Store{DB: &fakeDB{}}, Settings: isolationSetting("caracal.run")}

	mismatch := httptest.NewRequest("GET", "https://acme.caracal.run/api/v1/sessions", nil)
	mismatch.Host = "acme.caracal.run"
	mismatch.Header.Set("X-Caracal-Org", "other")
	mismatch.Header.Set("X-Caracal-Project", "platform")
	var scopeErr *tenancy.Error
	if _, err := resolver.ResolveProjectID(context.Background(), mismatch, callerID); !errors.As(err, &scopeErr) || scopeErr.Status != 409 {
		t.Fatalf("transport mismatch = %v, want 409", err)
	}

	missing := httptest.NewRequest("GET", "https://caracal.run/api/v1/sessions", nil)
	if _, err := resolver.ResolveProjectID(context.Background(), missing, callerID); !errors.As(err, &scopeErr) || scopeErr.Status != 422 {
		t.Fatalf("missing scope = %v, want 422", err)
	}
}

func TestResolveRequestProjectRequiresHeaderPathAgreement(t *testing.T) {
	org := &Org{ID: orgID, Slug: "acme", Role: "owner"}
	store := &Store{DB: &fakeDB{stubs: []stub{
		projectStub(projectRowValues("platform", false, "lead")),
	}}}

	mismatch := httptest.NewRequest("GET", "https://acme.caracal.run/api/v1/orgs/acme/projects/platform", nil)
	mismatch.Header.Set("X-Caracal-Project", "payments")
	var scopeErr *tenancy.Error
	if _, err := store.ResolveRequestProject(context.Background(), mismatch, org, "platform", callerID); !errors.As(err, &scopeErr) || scopeErr.Status != 409 {
		t.Fatalf("project mismatch = %v, want 409", err)
	}

	matching := httptest.NewRequest("GET", "https://acme.caracal.run/api/v1/orgs/acme/projects/platform", nil)
	matching.Header.Set("X-Caracal-Project", "platform")
	project, err := store.ResolveRequestProject(context.Background(), matching, org, "platform", callerID)
	if err != nil || project == nil || project.Slug != "platform" {
		t.Fatalf("matching project = %v, err = %v", project, err)
	}
}
