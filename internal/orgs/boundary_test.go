// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package orgs

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/httpapi"
)

// serveOrgsAs is serveOrgs with an explicit deployment role on the claims, so
// the tests can prove the org boundary never consults the deployment role.
func serveOrgsAs(t *testing.T, db *fakeDB, deployRole, target string) *httptest.ResponseRecorder {
	t.Helper()
	h := &Handler{Store: &Store{DB: db}, Settings: fakeSetting{}}
	mux := http.NewServeMux()
	withClaims := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := httpapi.ContextWithClaims(r.Context(), auth.Claims{UserID: callerID, Role: deployRole})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
	h.Register(mux, withClaims)
	req := httptest.NewRequest(http.MethodGet, target, nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

// An organization owner administers their org with deployment role "user":
// org authority never requires operator privileges.
func TestOrgOwnerNeedsNoDeploymentRole(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "WHERE o.slug = $1", rows: &fakeRows{rows: [][]any{
			orgRowValues("acme", "Acme", "owner"),
		}}},
		{match: "FROM organization_memberships WHERE organization_id", rows: &fakeRows{rows: [][]any{{5}}}},
		{match: "FROM projects WHERE organization_id", rows: &fakeRows{rows: [][]any{{2}}}},
	}}
	rec := serveOrgsAs(t, db, "user", "/api/v1/orgs/acme")
	if rec.Code != http.StatusOK {
		t.Fatalf("org owner (deployment role user) must reach org routes: %d %s", rec.Code, rec.Body.String())
	}
}

// The deployment operator is not a member of this tenant, so every org route
// answers 404: operator authority never implies org membership.
func TestOperatorIsNotImplicitOrgMember(t *testing.T) {
	for _, target := range []string{
		"/api/v1/orgs/acme",
		"/api/v1/orgs/acme/members",
		"/api/v1/orgs/acme/projects",
	} {
		// No membership stub: ResolveOrg's JOIN returns no rows for this user.
		rec := serveOrgsAs(t, &fakeDB{}, "operator", target)
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s as operator non-member: status = %d, want 404", target, rec.Code)
		}
		if strings.Contains(rec.Body.String(), "permission") {
			t.Errorf("%s must existence-hide, not hint at permissions: %s", target, rec.Body.String())
		}
	}
}

// The membership resolution query is keyed on the user id alone; the caller's
// deployment role must never appear in the org access decision.
func TestOrgResolutionQueryIgnoresDeploymentRole(t *testing.T) {
	for _, role := range []string{"user", "reviewer", "operator"} {
		db := &fakeDB{stubs: []stub{
			{match: "WHERE o.slug = $1", rows: &fakeRows{rows: [][]any{
				orgRowValues("acme", "Acme", "member"),
			}}},
			{match: "FROM organization_memberships WHERE organization_id", rows: &fakeRows{rows: [][]any{{1}}}},
			{match: "FROM projects WHERE organization_id", rows: &fakeRows{rows: [][]any{{0}}}},
		}}
		rec := serveOrgsAs(t, db, role, "/api/v1/orgs/acme")
		if rec.Code != http.StatusOK {
			t.Fatalf("role %q member: status = %d", role, rec.Code)
		}
		for _, sql := range db.log {
			if strings.Contains(sql, "o.slug = $1") &&
				(strings.Contains(sql, "role = 'operator'") || strings.Contains(sql, "u.role")) {
				t.Errorf("org resolution consulted deployment role: %s", sql)
			}
		}
	}
}
