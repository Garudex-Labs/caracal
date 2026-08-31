// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

const (
	coListingID = "11111111-1111-1111-1111-111111111111"
	// coViewerID matches the claims serveRegistry injects.
	coViewerID = "22222222-2222-2222-2222-222222222222"
	coOtherID  = "33333333-3333-3333-3333-333333333333"
	coUserID   = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
	coUser2ID  = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
)

// coListingStub resolves the listing with the given owner and co-authors.
func coListingStub(submittedBy string, coAuthors []any) stub {
	return stub{match: "WHERE l.id = $1", rows: &fakeRows{
		cols: []string{"id", "name", "submitted_by", "co_authors", "is_private"},
		rows: [][]any{{coListingID, "Weather", submittedBy, coAuthors, false}},
	}}
}

func TestListCoAuthorsRendersUsers(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		coListingStub(coOtherID, []any{coUserID, coUser2ID}),
		{match: "FROM users WHERE id = ANY", rows: &fakeRows{
			cols: []string{"id", "email", "username", "auth_provider"},
			rows: [][]any{
				{coUserID, "co1@example.com", "co1", "password"},
				{coUser2ID, "co2@example.com", nil, "deactivated"},
			},
		}},
	}}
	rec := serveRegistry(t, db, http.MethodGet, "/api/v1/mcps/"+coListingID+"/co-authors", "user")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var users []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &users); err != nil {
		t.Fatalf("body: %v\n%s", err, rec.Body.String())
	}
	if len(users) != 2 {
		t.Fatalf("users = %d: %s", len(users), rec.Body.String())
	}
	if users[0]["id"] != coUserID || users[0]["email"] != "co1@example.com" ||
		users[0]["username"] != "co1" || users[0]["is_active"] != true {
		t.Errorf("active co-author: %v", users[0])
	}
	if users[1]["username"] != nil || users[1]["is_active"] != false {
		t.Errorf("deactivated co-author: %v", users[1])
	}
}

func TestListCoAuthors404UsesEntityLabel(t *testing.T) {
	cases := []struct{ prefix, label string }{
		{"mcps", "Mcp not found"},
	}
	for _, tc := range cases {
		rec := serveRegistry(t, &fakeDB{}, http.MethodGet,
			"/api/v1/"+tc.prefix+"/"+coListingID+"/co-authors", "user")
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: status = %d", tc.prefix, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), tc.label) {
			t.Errorf("%s: detail = %s, want %q", tc.prefix, rec.Body.String(), tc.label)
		}
	}
}

func TestListCoAuthorsRejectsMalformedID(t *testing.T) {
	db := &fakeDB{}
	rec := serveRegistry(t, db, http.MethodGet, "/api/v1/mcps/nope/co-authors", "user")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "uuid_parsing") {
		t.Errorf("detail: %s", rec.Body.String())
	}
	if len(db.log) != 0 {
		t.Errorf("invalid id must not reach the database: %v", db.log)
	}
}

func TestAddCoAuthorRequiresOwner(t *testing.T) {
	db := &fakeDB{stubs: []stub{coListingStub(coOtherID, []any{})}}
	rec := serveRegistryReq(t, db, http.MethodPost,
		"/api/v1/mcps/"+coListingID+"/co-authors", "user",
		strings.NewReader(`{"email":"co1@example.com"}`))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "You don't have permission to manage co-authors") {
		t.Errorf("detail: %s", rec.Body.String())
	}
	for _, sql := range db.log {
		if strings.Contains(sql, "FROM users WHERE email") {
			t.Error("denied caller still resolved the target user")
		}
	}
}

func TestAddCoAuthorOwnerIsImplicit(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		coListingStub(coViewerID, []any{}),
		{match: "FROM users WHERE email = $1", rows: &fakeRows{
			cols: []string{"id", "email", "username", "auth_provider"},
			rows: [][]any{{coViewerID, "me@example.com", "me", "password"}},
		}},
	}}
	rec := serveRegistryReq(t, db, http.MethodPost,
		"/api/v1/mcps/"+coListingID+"/co-authors", "user",
		strings.NewReader(`{"email":"me@example.com"}`))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Owner is already implicit") {
		t.Errorf("detail: %s", rec.Body.String())
	}
}

func TestAddCoAuthorDuplicateConflicts(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		coListingStub(coViewerID, []any{coUserID}),
		{match: "FROM users WHERE email = $1", rows: &fakeRows{
			cols: []string{"id", "email", "username", "auth_provider"},
			rows: [][]any{{coUserID, "co1@example.com", "co1", "password"}},
		}},
	}}
	rec := serveRegistryReq(t, db, http.MethodPost,
		"/api/v1/mcps/"+coListingID+"/co-authors", "user",
		strings.NewReader(`{"email":"co1@example.com"}`))
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "User is already a co-author") {
		t.Errorf("detail: %s", rec.Body.String())
	}
}

func TestAddCoAuthorWritesAndEchoesTarget(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		coListingStub(coViewerID, []any{}),
		{match: "FROM users WHERE email = $1", rows: &fakeRows{
			cols: []string{"id", "email", "username", "auth_provider"},
			rows: [][]any{{coUserID, "co1@example.com", "co1", "password"}},
		}},
	}}
	rec := serveRegistryReq(t, db, http.MethodPost,
		"/api/v1/mcps/"+coListingID+"/co-authors", "user",
		strings.NewReader(`{"email":"co1@example.com"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("body: %v\n%s", err, rec.Body.String())
	}
	if out["id"] != coUserID || out["is_active"] != true {
		t.Errorf("echoed target: %v", out)
	}
	updated := false
	for _, sql := range db.log {
		if strings.Contains(sql, "UPDATE mcp_listings SET co_authors") {
			updated = true
		}
	}
	if !updated {
		t.Errorf("grant never persisted: %v", db.log)
	}
}

func TestAddCoAuthorBodyValidation(t *testing.T) {
	t.Run("empty body", func(t *testing.T) {
		rec := serveRegistryReq(t, &fakeDB{}, http.MethodPost,
			"/api/v1/mcps/"+coListingID+"/co-authors", "user", nil)
		if rec.Code != http.StatusUnprocessableEntity ||
			!strings.Contains(rec.Body.String(), "Field required") {
			t.Errorf("status = %d: %s", rec.Code, rec.Body.String())
		}
	})
	t.Run("no identifier", func(t *testing.T) {
		db := &fakeDB{stubs: []stub{coListingStub(coViewerID, []any{})}}
		rec := serveRegistryReq(t, db, http.MethodPost,
			"/api/v1/mcps/"+coListingID+"/co-authors", "user", strings.NewReader(`{}`))
		if rec.Code != http.StatusUnprocessableEntity ||
			!strings.Contains(rec.Body.String(), "Provide a user") {
			t.Errorf("status = %d: %s", rec.Code, rec.Body.String())
		}
	})
	t.Run("malformed user_id", func(t *testing.T) {
		db := &fakeDB{stubs: []stub{coListingStub(coViewerID, []any{})}}
		rec := serveRegistryReq(t, db, http.MethodPost,
			"/api/v1/mcps/"+coListingID+"/co-authors", "user",
			strings.NewReader(`{"user_id":"nope"}`))
		if rec.Code != http.StatusUnprocessableEntity ||
			!strings.Contains(rec.Body.String(), "Invalid user ID") {
			t.Errorf("status = %d: %s", rec.Code, rec.Body.String())
		}
	})
}

func TestRemoveCoAuthorPaths(t *testing.T) {
	t.Run("not a co-author", func(t *testing.T) {
		db := &fakeDB{stubs: []stub{coListingStub(coViewerID, []any{})}}
		rec := serveRegistryReq(t, db, http.MethodDelete,
			"/api/v1/mcps/"+coListingID+"/co-authors/"+coUserID, "user", nil)
		if rec.Code != http.StatusNotFound ||
			!strings.Contains(rec.Body.String(), "User is not a co-author") {
			t.Errorf("status = %d: %s", rec.Code, rec.Body.String())
		}
	})
	t.Run("removes and persists", func(t *testing.T) {
		db := &fakeDB{stubs: []stub{coListingStub(coViewerID, []any{coUserID, coUser2ID})}}
		rec := serveRegistryReq(t, db, http.MethodDelete,
			"/api/v1/mcps/"+coListingID+"/co-authors/"+coUserID, "user", nil)
		if rec.Code != http.StatusOK ||
			!strings.Contains(rec.Body.String(), "Co-author removed") {
			t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
		}
		updated := false
		for _, sql := range db.log {
			if strings.Contains(sql, "UPDATE mcp_listings SET co_authors") {
				updated = true
			}
		}
		if !updated {
			t.Errorf("revocation never persisted: %v", db.log)
		}
	})
}

func TestListEditorsResolvesReleasers(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "SELECT DISTINCT released_by::text AS id FROM mcp_versions", rows: &fakeRows{
			cols: []string{"id"},
			rows: [][]any{{coUserID}},
		}},
		{match: "FROM users WHERE id = ANY", rows: &fakeRows{
			cols: []string{"id", "email", "username", "auth_provider"},
			rows: [][]any{{coUserID, "co1@example.com", "co1", "password"}},
		}},
	}}
	rec := serveRegistry(t, db, http.MethodGet, "/api/v1/mcps/"+coListingID+"/editors", "user")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var users []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &users); err != nil {
		t.Fatalf("body: %v", err)
	}
	if len(users) != 1 || users[0]["email"] != "co1@example.com" {
		t.Errorf("editors = %s", rec.Body.String())
	}
}
