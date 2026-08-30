// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package orgs

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/httpapi"
)

var (
	projID   = uuid.MustParse("66666666-6666-6666-6666-666666666666")
	targetID = uuid.MustParse("77777777-7777-7777-7777-777777777777")
)

type orgFakeEvents struct{ rows []any }

func (e *orgFakeEvents) InsertJSONEachRow(_ context.Context, _ string, rows []any) error {
	e.rows = append(e.rows, rows...)
	return nil
}

func newOrgsHandler(db *fakeDB) *Handler {
	return &Handler{Store: &Store{DB: db}, Settings: fakeSetting{}, Pool: db}
}

// serveOrgsFull drives any method with an optional JSON body.
func serveOrgsFull(t *testing.T, h *Handler, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	mux := http.NewServeMux()
	withClaims := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := httpapi.ContextWithClaims(r.Context(), auth.Claims{UserID: callerID, Role: "user"})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
	h.Register(mux, withClaims)
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, target, rd)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func orgStub(role string) stub {
	return stub{match: "WHERE o.slug = $1", rows: &fakeRows{rows: [][]any{
		orgRowValues("acme", "Acme", role),
	}}}
}

// projectRowValues matches the ResolveProject scan order.
func projectRowValues(slug string, isDefault bool, role any) []any {
	return []any{projID, orgID, slug, "App", nil, orgTime, isDefault, role}
}

func projectStub(vals []any) stub {
	return stub{match: "WHERE p.organization_id = $1 AND p.slug = $2", rows: &fakeRows{rows: [][]any{vals}}}
}

// ── read plane ──────────────────────────────────────────────────────────────

func TestOrgMembersListsRoster(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		orgStub("admin"),
		{match: "SELECT count(*) FROM users u JOIN organization_memberships", rows: &fakeRows{rows: [][]any{{1}}}},
		{match: "JOIN organization_memberships m ON m.user_id", rows: &fakeRows{rows: [][]any{
			{callerID.String(), "a@x.io", "richard", "Richard", "owner", orgTime, 2},
		}}},
	}}
	rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodGet, "/api/v1/orgs/acme/members", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Members  []map[string]any `json:"members"`
		Total    int              `json:"total"`
		Page     int              `json:"page"`
		PageSize int              `json:"page_size"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || len(out.Members) != 1 {
		t.Fatalf("body: %v\n%s", err, rec.Body.String())
	}
	if out.Total != 1 || out.Page != 1 || out.PageSize != 50 {
		t.Errorf("envelope: total=%d page=%d page_size=%d", out.Total, out.Page, out.PageSize)
	}
	m := out.Members[0]
	if m["email"] != "a@x.io" || m["role"] != "owner" || m["created_at"] != "2026-08-30T08:00:00Z" ||
		m["project_count"] != float64(2) {
		t.Errorf("member wire: %v", m)
	}
	// Deterministic default ordering with a stable tiebreak.
	listSQL := db.log[len(db.log)-1]
	if !strings.Contains(listSQL, "ORDER BY u.email ASC, u.id ASC") || !strings.Contains(listSQL, "LIMIT") {
		t.Errorf("list ordering/bounding missing:\n%s", listSQL)
	}
}

func TestOrgMembersSearchAndFiltersShapeTheQuery(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		orgStub("admin"),
		{match: "SELECT count(*) FROM users u JOIN organization_memberships", rows: &fakeRows{rows: [][]any{{0}}}},
	}}
	rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodGet,
		"/api/v1/orgs/acme/members?q=ri%25ch&role=admin&sort=joined&dir=desc&page=3&page_size=10", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	listSQL := db.log[len(db.log)-1]
	for _, want := range []string{"u.email ILIKE", "m.role = $", "ORDER BY m.created_at DESC, u.id ASC"} {
		if !strings.Contains(listSQL, want) {
			t.Errorf("missing %q in:\n%s", want, listSQL)
		}
	}
	// LIKE metacharacters in the search term must be escaped.
	if got := likePattern("ri%ch_"); got != `%ri\%ch\_%` {
		t.Errorf("likePattern = %q", got)
	}
}

func TestOrgMembersRejectsInvalidListControls(t *testing.T) {
	for _, target := range []string{
		"/api/v1/orgs/acme/members?sort=password",
		"/api/v1/orgs/acme/members?dir=sideways",
		"/api/v1/orgs/acme/members?role=root",
		"/api/v1/orgs/acme/members?page=0",
		"/api/v1/orgs/acme/members?page_size=100000",
	} {
		db := &fakeDB{stubs: []stub{orgStub("admin")}}
		rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodGet, target, "")
		if rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s: status = %d: %s", target, rec.Code, rec.Body.String())
		}
		// The org resolve may run, but no roster query may reach storage.
		for _, sql := range db.log {
			if strings.Contains(sql, "JOIN organization_memberships m ON m.user_id") {
				t.Errorf("%s: invalid controls reached storage", target)
			}
		}
	}
}

func TestOrgMembersRequiresManagePermission(t *testing.T) {
	db := &fakeDB{stubs: []stub{orgStub("member")}}
	rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodGet, "/api/v1/orgs/acme/members", "")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	for _, sql := range db.log {
		if strings.Contains(sql, "JOIN organization_memberships m ON m.user_id") {
			t.Errorf("denied roster read reached listing storage")
		}
	}
}

func TestMemberProjectsRequiresManagePermission(t *testing.T) {
	db := &fakeDB{stubs: []stub{orgStub("member")}}
	rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodGet,
		"/api/v1/orgs/acme/members/"+targetID.String()+"/projects", "")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("member: status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestMemberProjectsListsAccess(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		orgStub("admin"),
		{match: "SELECT role FROM organization_memberships", rows: &fakeRows{rows: [][]any{{"member"}}}},
		{match: "FROM project_memberships pm JOIN projects p", rows: &fakeRows{rows: [][]any{
			{projID.String(), "app", "App", false, "lead", orgTime},
		}}},
	}}
	rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodGet,
		"/api/v1/orgs/acme/members/"+targetID.String()+"/projects", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || len(out) != 1 {
		t.Fatalf("body: %v\n%s", err, rec.Body.String())
	}
	if out[0]["slug"] != "app" || out[0]["role"] != "lead" {
		t.Errorf("member project wire: %v", out[0])
	}
}

func TestMemberProjectsUnknownTargetIs404(t *testing.T) {
	db := &fakeDB{stubs: []stub{orgStub("owner")}}
	rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodGet,
		"/api/v1/orgs/acme/members/"+targetID.String()+"/projects", "")
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "Member not found") {
		t.Errorf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestProjectsListingScopesByRole(t *testing.T) {
	rows := &fakeRows{rows: [][]any{
		{projID, orgID, "app", "App", "docs", orgTime, true, 3, "lead"},
	}}
	member := &fakeDB{stubs: []stub{
		orgStub("member"),
		{match: "SELECT count(*) FROM projects p", rows: &fakeRows{rows: [][]any{{1}}}},
		{match: "LEFT JOIN (SELECT project_id, count(*)", rows: rows},
	}}
	rec := serveOrgsFull(t, newOrgsHandler(member), http.MethodGet, "/api/v1/orgs/acme/projects", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Projects []map[string]any `json:"projects"`
		Total    int              `json:"total"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || len(out.Projects) != 1 {
		t.Fatalf("body: %v\n%s", err, rec.Body.String())
	}
	if out.Projects[0]["slug"] != "app" || out.Projects[0]["is_default"] != true ||
		out.Projects[0]["member_count"] != float64(3) || out.Total != 1 {
		t.Errorf("project wire: %v total=%d", out.Projects[0], out.Total)
	}
	// A plain member's query filters to their memberships; an org admin's must not.
	if !strings.Contains(member.log[len(member.log)-1], "my.role IS NOT NULL") {
		t.Errorf("member query is unscoped:\n%s", member.log[len(member.log)-1])
	}
	admin := &fakeDB{stubs: []stub{
		orgStub("admin"),
		{match: "SELECT count(*) FROM projects p", rows: &fakeRows{rows: [][]any{{1}}}},
		{match: "LEFT JOIN (SELECT project_id, count(*)", rows: rows},
	}}
	serveOrgsFull(t, newOrgsHandler(admin), http.MethodGet, "/api/v1/orgs/acme/projects?sort=members&dir=desc", "")
	last := admin.log[len(admin.log)-1]
	if strings.Contains(last, "my.role IS NOT NULL") {
		t.Errorf("admin query is wrongly scoped:\n%s", last)
	}
	if !strings.Contains(last, "ORDER BY COALESCE(mc.count, 0) DESC, p.slug ASC") {
		t.Errorf("sort not applied:\n%s", last)
	}
}

func TestProjectDetailFillsMemberCount(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		orgStub("member"),
		projectStub(projectRowValues("app", false, "user")),
		{match: "count(*) FROM project_memberships WHERE project_id", rows: &fakeRows{rows: [][]any{{4}}}},
	}}
	rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodGet, "/api/v1/orgs/acme/projects/app", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["slug"] != "app" || out["member_count"] != float64(4) || out["role"] != "user" {
		t.Errorf("project wire: %v", out)
	}
}

func TestProjectHiddenFromNonMembers(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		orgStub("member"),
		projectStub(projectRowValues("app", false, nil)),
	}}
	rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodGet, "/api/v1/orgs/acme/projects/app", "")
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "Project not found") {
		t.Errorf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestProjectMembersListsRoster(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		orgStub("member"),
		projectStub(projectRowValues("app", false, "user")),
		{match: "JOIN project_memberships m ON m.user_id", rows: &fakeRows{rows: [][]any{
			{targetID.String(), "b@x.io", nil, nil, "lead", orgTime},
		}}},
	}}
	rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodGet, "/api/v1/orgs/acme/projects/app/members", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || len(out) != 1 || out[0]["role"] != "lead" {
		t.Errorf("body: %v\n%s", err, rec.Body.String())
	}
}

func TestProjectResourcesListsAllTypes(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		orgStub("member"),
		projectStub(projectRowValues("app", false, "user")),
		{match: "ORDER BY slug", rows: &fakeRows{rows: [][]any{
			{"id-1", "Helper", "acme/helper", "public"},
		}}},
		{match: "FROM component_sources WHERE project_id", rows: &fakeRows{rows: [][]any{
			{"id-2", "https://example.com/src", "public"},
		}}},
	}}
	rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodGet, "/api/v1/orgs/acme/projects/app/resources", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	items, _ := out["items"].([]any)
	// One row per registry table plus the component source.
	if out["total"] != float64(7) || len(items) != 7 {
		t.Fatalf("resources wire: %v", out)
	}
	first, _ := items[0].(map[string]any)
	last, _ := items[6].(map[string]any)
	if first["type"] != "agent" || first["qualified_name"] != "acme/helper" {
		t.Errorf("first item: %v", first)
	}
	if last["type"] != "component_source" || last["name"] != "https://example.com/src" {
		t.Errorf("source item: %v", last)
	}
}

// ── org write plane ─────────────────────────────────────────────────────────

func TestCreateOrgValidation(t *testing.T) {
	rec := serveOrgsFull(t, newOrgsHandler(&fakeDB{}), http.MethodPost, "/api/v1/orgs", "")
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "Field required") {
		t.Errorf("missing body: status = %d: %s", rec.Code, rec.Body.String())
	}

	rec = serveOrgsFull(t, newOrgsHandler(&fakeDB{}), http.MethodPost, "/api/v1/orgs",
		`{"name":"","slug":"ab"}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("short fields: status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "at least 1 character") ||
		!strings.Contains(rec.Body.String(), "at least 3 characters") {
		t.Errorf("length errors: %s", rec.Body.String())
	}

	rec = serveOrgsFull(t, newOrgsHandler(&fakeDB{}), http.MethodPost, "/api/v1/orgs",
		`{"name":"Acme","slug":"`+strings.Repeat("x", 40)+`"}`)
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "at most 32 characters") {
		t.Errorf("long slug: status = %d: %s", rec.Code, rec.Body.String())
	}

	rec = serveOrgsFull(t, newOrgsHandler(&fakeDB{}), http.MethodPost, "/api/v1/orgs",
		`{"name":"Acme","slug":"admin"}`)
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "reserved") {
		t.Errorf("reserved slug: status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestCreateOrgTakenSlugIs409(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "FROM organizations WHERE slug = $1", rows: &fakeRows{rows: [][]any{{orgID}}}},
	}}
	rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodPost, "/api/v1/orgs",
		`{"name":"Acme","slug":"acme"}`)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "already taken") {
		t.Errorf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestCreateOrgMapsStoreFailureTo500(t *testing.T) {
	rec := serveOrgsFull(t, newOrgsHandler(&fakeDB{}), http.MethodPost, "/api/v1/orgs",
		`{"name":"Acme","slug":"acme"}`)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestUpdateOrgRequiresAdmin(t *testing.T) {
	db := &fakeDB{stubs: []stub{orgStub("member")}}
	rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodPatch, "/api/v1/orgs/acme", `{"name":"X"}`)
	if rec.Code != http.StatusForbidden ||
		!strings.Contains(rec.Body.String(), "Insufficient organization permissions") {
		t.Errorf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestUpdateOrgSlugChangeIsOwnerOnly(t *testing.T) {
	db := &fakeDB{stubs: []stub{orgStub("admin")}}
	rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodPatch, "/api/v1/orgs/acme", `{"slug":"newco"}`)
	if rec.Code != http.StatusForbidden ||
		!strings.Contains(rec.Body.String(), "Only the organization owner can change the organization id") {
		t.Errorf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestUpdateOrgValidation(t *testing.T) {
	db := &fakeDB{stubs: []stub{orgStub("owner")}}
	rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodPatch, "/api/v1/orgs/acme", "")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("missing body: status = %d: %s", rec.Code, rec.Body.String())
	}

	db = &fakeDB{stubs: []stub{orgStub("owner")}}
	rec = serveOrgsFull(t, newOrgsHandler(db), http.MethodPatch, "/api/v1/orgs/acme",
		`{"name":"`+strings.Repeat("x", 300)+`"}`)
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "at most 255 characters") {
		t.Errorf("long name: status = %d: %s", rec.Code, rec.Body.String())
	}

	db = &fakeDB{stubs: []stub{orgStub("owner")}}
	rec = serveOrgsFull(t, newOrgsHandler(db), http.MethodPatch, "/api/v1/orgs/acme", `{"slug":"Bad Slug"}`)
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "Organization ids must be") {
		t.Errorf("bad slug: status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestUpdateOrgRenameTakenIs409(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		orgStub("owner"),
		{match: "WHERE slug = $1 AND id != $2", rows: &fakeRows{rows: [][]any{{targetID}}}},
	}}
	rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodPatch, "/api/v1/orgs/acme", `{"slug":"newco"}`)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "already taken") {
		t.Errorf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestUpdateOrgRenamesAndEmitsEvent(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		orgStub("owner"),
		{match: "UPDATE organizations SET", rows: &fakeRows{rows: [][]any{{orgID}}}},
	}}
	events := &orgFakeEvents{}
	h := newOrgsHandler(db)
	h.Events = events
	rec := serveOrgsFull(t, h, http.MethodPatch, "/api/v1/orgs/acme", `{"slug":"newco","name":" New Co "}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["slug"] != "newco" || out["name"] != "New Co" || out["role"] != "owner" {
		t.Errorf("org wire: %v", out)
	}
	if len(events.rows) != 1 {
		t.Errorf("rename events emitted: %d", len(events.rows))
	}
}

func TestDeleteOrgRequiresOwner(t *testing.T) {
	db := &fakeDB{stubs: []stub{orgStub("admin")}}
	rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodDelete, "/api/v1/orgs/acme", "")
	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestDeleteOrgRefusesWhileProjectsRemain(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		orgStub("owner"),
		{match: "AND NOT is_default", rows: &fakeRows{rows: [][]any{{2}}}},
	}}
	rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodDelete, "/api/v1/orgs/acme", "")
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "still contains 2 project(s)") {
		t.Errorf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestUpsertOrgMemberValidation(t *testing.T) {
	adminDB := func() *fakeDB { return &fakeDB{stubs: []stub{orgStub("admin")}} }
	target := "/api/v1/orgs/acme/members"

	rec := serveOrgsFull(t, newOrgsHandler(&fakeDB{stubs: []stub{orgStub("member")}}), http.MethodPost, target,
		`{"email":"b@x.io"}`)
	if rec.Code != http.StatusForbidden {
		t.Errorf("member: status = %d: %s", rec.Code, rec.Body.String())
	}

	rec = serveOrgsFull(t, newOrgsHandler(adminDB()), http.MethodPost, target, `{"role":"boss","email":"b@x.io"}`)
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "'admin' or 'member'") {
		t.Errorf("bad role: status = %d: %s", rec.Code, rec.Body.String())
	}

	rec = serveOrgsFull(t, newOrgsHandler(adminDB()), http.MethodPost, target, `{"role":"member"}`)
	if rec.Code != http.StatusUnprocessableEntity ||
		!strings.Contains(rec.Body.String(), "Provide email, username, or user_id") {
		t.Errorf("no identifier: status = %d: %s", rec.Code, rec.Body.String())
	}

	rec = serveOrgsFull(t, newOrgsHandler(adminDB()), http.MethodPost, target, `{"email":"ghost@x.io"}`)
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "User not found") {
		t.Errorf("unknown user: status = %d: %s", rec.Code, rec.Body.String())
	}
}

func userStub() stub {
	return stub{match: "FROM users WHERE email = $1", rows: &fakeRows{rows: [][]any{
		{targetID, "b@x.io", "jared", "Jared"},
	}}}
}

func TestUpsertOrgMemberProtectsOwnerRow(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		orgStub("admin"), userStub(),
		{match: "FROM organization_memberships WHERE organization_id = $1 AND user_id = $2",
			rows: &fakeRows{rows: [][]any{{"owner"}}}},
	}}
	rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodPost, "/api/v1/orgs/acme/members",
		`{"email":"b@x.io","role":"admin"}`)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "ownership transfer") {
		t.Errorf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestUpsertOrgMemberAddsAndPromotes(t *testing.T) {
	added := &fakeDB{stubs: []stub{
		orgStub("admin"), userStub(),
		{match: "INSERT INTO organization_memberships", rows: &fakeRows{rows: [][]any{{targetID}}}},
	}}
	rec := serveOrgsFull(t, newOrgsHandler(added), http.MethodPost, "/api/v1/orgs/acme/members",
		`{"email":"b@x.io"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("add: status = %d: %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["email"] != "b@x.io" || out["role"] != "member" || out["id"] != targetID.String() {
		t.Errorf("member wire: %v", out)
	}

	promoted := &fakeDB{stubs: []stub{
		orgStub("admin"), userStub(),
		{match: "FROM organization_memberships WHERE organization_id = $1 AND user_id = $2",
			rows: &fakeRows{rows: [][]any{{"member"}}}},
		{match: "UPDATE organization_memberships SET role", rows: &fakeRows{rows: [][]any{{targetID}}}},
	}}
	rec = serveOrgsFull(t, newOrgsHandler(promoted), http.MethodPost, "/api/v1/orgs/acme/members",
		`{"email":"b@x.io","role":"admin"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("promote: status = %d: %s", rec.Code, rec.Body.String())
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["role"] != "admin" {
		t.Errorf("promoted wire: %v", out)
	}
}

func TestRemoveOrgMemberRules(t *testing.T) {
	base := "/api/v1/orgs/acme/members/"

	db := &fakeDB{stubs: []stub{orgStub("admin")}}
	rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodDelete, base+"nope", "")
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "uuid_parsing") {
		t.Errorf("bad uuid: status = %d: %s", rec.Code, rec.Body.String())
	}

	// A plain member may only remove themselves.
	db = &fakeDB{stubs: []stub{orgStub("member")}}
	rec = serveOrgsFull(t, newOrgsHandler(db), http.MethodDelete, base+targetID.String(), "")
	if rec.Code != http.StatusForbidden {
		t.Errorf("member removing other: status = %d: %s", rec.Code, rec.Body.String())
	}

	db = &fakeDB{stubs: []stub{orgStub("member")}}
	rec = serveOrgsFull(t, newOrgsHandler(db), http.MethodDelete, base+callerID.String(), "")
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "Membership not found") {
		t.Errorf("self without membership row: status = %d: %s", rec.Code, rec.Body.String())
	}

	db = &fakeDB{stubs: []stub{
		orgStub("admin"),
		{match: "FROM organization_memberships WHERE organization_id = $1 AND user_id = $2",
			rows: &fakeRows{rows: [][]any{{"owner"}}}},
	}}
	rec = serveOrgsFull(t, newOrgsHandler(db), http.MethodDelete, base+targetID.String(), "")
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "transfer ownership first") {
		t.Errorf("owner target: status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestTransferOwnershipGate(t *testing.T) {
	target := "/api/v1/orgs/acme/transfer-ownership"

	rec := serveOrgsFull(t, newOrgsHandler(&fakeDB{stubs: []stub{orgStub("admin")}}), http.MethodPost, target,
		`{"user_id":"`+targetID.String()+`"}`)
	if rec.Code != http.StatusForbidden {
		t.Errorf("admin: status = %d: %s", rec.Code, rec.Body.String())
	}

	rec = serveOrgsFull(t, newOrgsHandler(&fakeDB{stubs: []stub{orgStub("owner")}}), http.MethodPost, target, `{}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("missing user_id: status = %d: %s", rec.Code, rec.Body.String())
	}

	rec = serveOrgsFull(t, newOrgsHandler(&fakeDB{stubs: []stub{orgStub("owner")}}), http.MethodPost, target,
		`{"user_id":"`+callerID.String()+`"}`)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "already own") {
		t.Errorf("self transfer: status = %d: %s", rec.Code, rec.Body.String())
	}

	rec = serveOrgsFull(t, newOrgsHandler(&fakeDB{stubs: []stub{orgStub("owner")}}), http.MethodPost, target,
		`{"user_id":"`+targetID.String()+`"}`)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("store failure: status = %d: %s", rec.Code, rec.Body.String())
	}
}

// ── project write plane ─────────────────────────────────────────────────────

func TestCreateProjectValidation(t *testing.T) {
	target := "/api/v1/orgs/acme/projects"

	rec := serveOrgsFull(t, newOrgsHandler(&fakeDB{stubs: []stub{orgStub("member")}}), http.MethodPost, target,
		`{"name":"App"}`)
	if rec.Code != http.StatusForbidden {
		t.Errorf("member: status = %d: %s", rec.Code, rec.Body.String())
	}

	rec = serveOrgsFull(t, newOrgsHandler(&fakeDB{stubs: []stub{orgStub("admin")}}), http.MethodPost, target, "")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("missing body: status = %d: %s", rec.Code, rec.Body.String())
	}

	rec = serveOrgsFull(t, newOrgsHandler(&fakeDB{stubs: []stub{orgStub("admin")}}), http.MethodPost, target,
		`{"name":""}`)
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "at least 1 character") {
		t.Errorf("empty name: status = %d: %s", rec.Code, rec.Body.String())
	}

	rec = serveOrgsFull(t, newOrgsHandler(&fakeDB{stubs: []stub{orgStub("admin")}}), http.MethodPost, target,
		`{"name":"App"}`)
	if rec.Code != http.StatusInternalServerError {
		t.Errorf("store failure: status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestUpdateProjectRequiresLead(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		orgStub("member"),
		projectStub(projectRowValues("app", false, "user")),
	}}
	rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodPatch, "/api/v1/orgs/acme/projects/app",
		`{"name":"X"}`)
	if rec.Code != http.StatusForbidden ||
		!strings.Contains(rec.Body.String(), "Project administration requires a lead role") {
		t.Errorf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestUpdateProjectAppliesChanges(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		orgStub("member"),
		projectStub(projectRowValues("app", false, "lead")),
		{match: "UPDATE projects SET", rows: &fakeRows{rows: [][]any{{projID}}}},
	}}
	rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodPatch, "/api/v1/orgs/acme/projects/app",
		`{"name":" Renamed ","description":"fresh"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["name"] != "Renamed" || out["description"] != "fresh" {
		t.Errorf("project wire: %v", out)
	}
}

func TestDeleteProjectGuards(t *testing.T) {
	def := &fakeDB{stubs: []stub{
		orgStub("admin"),
		projectStub(projectRowValues("app", true, nil)),
	}}
	rec := serveOrgsFull(t, newOrgsHandler(def), http.MethodDelete, "/api/v1/orgs/acme/projects/app", "")
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "default project cannot be deleted") {
		t.Errorf("default: status = %d: %s", rec.Code, rec.Body.String())
	}

	occupied := &fakeDB{stubs: []stub{
		orgStub("admin"),
		projectStub(projectRowValues("app", false, nil)),
		{match: "count(*)", rows: &fakeRows{rows: [][]any{{1}}}},
	}}
	rec = serveOrgsFull(t, newOrgsHandler(occupied), http.MethodDelete, "/api/v1/orgs/acme/projects/app", "")
	if rec.Code != http.StatusConflict {
		t.Errorf("occupied: status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestUpsertProjectMemberRules(t *testing.T) {
	target := "/api/v1/orgs/acme/projects/app/members"
	leadProject := func() stub { return projectStub(projectRowValues("app", false, "lead")) }

	db := &fakeDB{stubs: []stub{orgStub("member"), leadProject()}}
	rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodPost, target, `{"email":"b@x.io","role":"boss"}`)
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "'lead' or 'user'") {
		t.Errorf("bad role: status = %d: %s", rec.Code, rec.Body.String())
	}

	db = &fakeDB{stubs: []stub{orgStub("member"), leadProject(), userStub()}}
	rec = serveOrgsFull(t, newOrgsHandler(db), http.MethodPost, target, `{"email":"b@x.io"}`)
	if rec.Code != http.StatusConflict ||
		!strings.Contains(rec.Body.String(), "member of the organization first") {
		t.Errorf("non-org-member: status = %d: %s", rec.Code, rec.Body.String())
	}

	db = &fakeDB{stubs: []stub{
		orgStub("member"), leadProject(), userStub(),
		{match: "FROM organization_memberships WHERE organization_id = $1 AND user_id = $2",
			rows: &fakeRows{rows: [][]any{{"member"}}}},
		{match: "INSERT INTO project_memberships", rows: &fakeRows{rows: [][]any{{targetID}}}},
	}}
	rec = serveOrgsFull(t, newOrgsHandler(db), http.MethodPost, target, `{"email":"b@x.io"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("add: status = %d: %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["role"] != "user" || out["email"] != "b@x.io" {
		t.Errorf("member wire: %v", out)
	}
}

func TestRemoveProjectMemberRules(t *testing.T) {
	base := "/api/v1/orgs/acme/projects/app/members/"

	db := &fakeDB{stubs: []stub{
		orgStub("member"),
		projectStub(projectRowValues("app", false, "lead")),
	}}
	rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodDelete, base+"nope", "")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("bad uuid: status = %d: %s", rec.Code, rec.Body.String())
	}

	// A plain project user may only remove themselves.
	db = &fakeDB{stubs: []stub{
		orgStub("member"),
		projectStub(projectRowValues("app", false, "user")),
	}}
	rec = serveOrgsFull(t, newOrgsHandler(db), http.MethodDelete, base+targetID.String(), "")
	if rec.Code != http.StatusForbidden {
		t.Errorf("user removing other: status = %d: %s", rec.Code, rec.Body.String())
	}

	db = &fakeDB{stubs: []stub{
		orgStub("member"),
		projectStub(projectRowValues("app", false, "lead")),
		{match: "DELETE FROM project_memberships", rows: &fakeRows{rows: [][]any{{targetID}}}},
	}}
	rec = serveOrgsFull(t, newOrgsHandler(db), http.MethodDelete, base+targetID.String(), "")
	if rec.Code != http.StatusNoContent {
		t.Errorf("remove: status = %d: %s", rec.Code, rec.Body.String())
	}

	// Missing membership rows answer 404 from the RETURNING id probe.
	db = &fakeDB{stubs: []stub{
		orgStub("member"),
		projectStub(projectRowValues("app", false, "lead")),
	}}
	rec = serveOrgsFull(t, newOrgsHandler(db), http.MethodDelete, base+targetID.String(), "")
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "Membership not found") {
		t.Errorf("missing membership: status = %d: %s", rec.Code, rec.Body.String())
	}
}
