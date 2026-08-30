// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
)

func TestReconcileItemsValidation(t *testing.T) {
	body := `{"items":[{"type":"widget","id":"` + listingUUID + `"},{"type":"mcp","id":"nope"}]}`
	rec := serveRegistryReq(t, &fakeDB{}, http.MethodPost, "/api/v1/registry/reconcile", "user",
		strings.NewReader(body))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	out := rec.Body.String()
	if !strings.Contains(out, "literal_error") || !strings.Contains(out, "uuid_parsing") {
		t.Errorf("both invalid items must be reported: %s", out)
	}
}

func TestReconcileItemsAnswersFoundAndMissing(t *testing.T) {
	missing := "44444444-4444-4444-4444-444444444444"
	db := &fakeDB{stubs: []stub{
		{match: "FROM mcp_listings", rows: &fakeRows{
			cols: []string{"id", "name", "namespace", "slug", "status", "version", "deleted"},
			rows: [][]any{{listingUUID, "Weather", "acme", "weather", "approved", "1.2.0", false}},
		}},
	}}
	body := `{"items":[{"type":"mcp","id":"` + listingUUID + `"},{"type":"mcp","id":"` + missing + `"}]}`
	rec := serveRegistryReq(t, db, http.MethodPost, "/api/v1/registry/reconcile", "user",
		strings.NewReader(body))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var items []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &items); err != nil || len(items) != 2 {
		t.Fatalf("items: %v / %s", err, rec.Body.String())
	}
	first, second := items[0], items[1]
	if first["found"] != true || first["qualified_name"] != "acme/weather" ||
		first["status"] != "approved" || first["latest_version"] != "1.2.0" {
		t.Errorf("found item: %v", first)
	}
	if second["found"] != false || second["name"] != nil || second["status"] != nil {
		t.Errorf("missing item: %v", second)
	}
}

func TestTransferOwnershipInvalidEntityType(t *testing.T) {
	s := &Store{DB: &fakeDB{}}
	_, err := s.TransferOwnership(context.Background(), "widgets", listingUUID,
		map[string]any{"user_id": otherUserID}, testViewer("user"))
	api := asAPIError(t, err)
	if api.Status != 400 || !strings.Contains(api.Detail, "Invalid entity type") {
		t.Errorf("err = %d %q", api.Status, api.Detail)
	}
}

func TestTransferOwnershipUnknownEntity404(t *testing.T) {
	rec := serveRegistryReq(t, &fakeDB{}, http.MethodPost,
		"/api/v1/mcps/"+listingUUID+"/transfer-ownership", "user",
		strings.NewReader(`{"user_id":"`+otherUserID+`"}`))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Mcp not found") {
		t.Errorf("detail: %s", rec.Body.String())
	}
}

// transferListingStub answers the transfer lookup with one personal listing.
func transferListingStub(ownerID string) stub {
	cols := []string{"id", "name", "namespace", "slug", "owner", "is_private",
		"owner_id", "co_authors", "latest_version_id", "version", "status"}
	return stub{match: "FROM mcp_listings", rows: &fakeRows{cols: cols, rows: [][]any{
		{listingUUID, "Weather", "acme", "weather", "acme@example.com", false,
			ownerID, []any{}, versionUUID, "1.2.0", "approved"},
	}}}
}

func usersStub(id, username, email, provider string) stub {
	return stub{match: "FROM users WHERE", rows: &fakeRows{
		cols: []string{"id", "username", "email", "auth_provider"},
		rows: [][]any{{id, username, email, provider}},
	}}
}

func TestTransferOwnershipRequiresCurrentOwner(t *testing.T) {
	db := &fakeDB{stubs: []stub{transferListingStub(otherUserID)}}
	rec := serveRegistryReq(t, db, http.MethodPost,
		"/api/v1/mcps/"+listingUUID+"/transfer-ownership", "user",
		strings.NewReader(`{"user_id":"`+otherUserID+`"}`))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Only the current owner can transfer ownership") {
		t.Errorf("detail: %s", rec.Body.String())
	}
}

func TestTransferOwnershipRejectsDeactivatedTarget(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		transferListingStub(testViewerID),
		usersStub(otherUserID, "ghost", "ghost@example.com", "deactivated"),
	}}
	rec := serveRegistryReq(t, db, http.MethodPost,
		"/api/v1/mcps/"+listingUUID+"/transfer-ownership", "user",
		strings.NewReader(`{"user_id":"`+otherUserID+`"}`))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "deactivated user") {
		t.Errorf("detail: %s", rec.Body.String())
	}
}

func TestTransferOwnershipRejectsSelfTransfer(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		transferListingStub(testViewerID),
		usersStub(testViewerID, "me", "me@example.com", "password"),
	}}
	rec := serveRegistryReq(t, db, http.MethodPost,
		"/api/v1/mcps/"+listingUUID+"/transfer-ownership", "user",
		strings.NewReader(`{"user_id":"`+testViewerID+`"}`))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "You already own this item") {
		t.Errorf("detail: %s", rec.Body.String())
	}
}

func TestTransferOwnershipNamespaceConflict(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "SELECT EXISTS", rows: &fakeRows{cols: []string{"exists"}, rows: [][]any{{true}}}},
		transferListingStub(testViewerID),
		usersStub(otherUserID, "taken", "taken@example.com", "password"),
	}}
	rec := serveRegistryReq(t, db, http.MethodPost,
		"/api/v1/mcps/"+listingUUID+"/transfer-ownership", "user",
		strings.NewReader(`{"user_id":"`+otherUserID+`"}`))
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "taken/weather already exists") {
		t.Errorf("detail: %s", rec.Body.String())
	}
}

func TestTransferTargetSelection(t *testing.T) {
	s := &Store{DB: &fakeDB{stubs: []stub{
		usersStub(otherUserID, "target", "target@example.com", "password"),
	}}}
	ctx := context.Background()

	if _, aerr, _ := s.transferTarget(ctx, map[string]any{}); aerr == nil || aerr.Detail != "Provide a user" {
		t.Errorf("empty target: %v", aerr)
	}
	if _, aerr, _ := s.transferTarget(ctx, map[string]any{"user_id": "nope"}); aerr == nil || aerr.Detail != "Invalid user ID" {
		t.Errorf("bad id: %v", aerr)
	}
	row, aerr, err := s.transferTarget(ctx, map[string]any{"username": "@Target "})
	if err != nil || aerr != nil || rowStr(row, "username", "") != "target" {
		t.Errorf("username lookup: %v %v %v", row, aerr, err)
	}
	// A miss answers 404.
	missing := &Store{DB: &fakeDB{}}
	if _, aerr, _ = missing.transferTarget(ctx, map[string]any{"email": "X@Y.dev"}); aerr == nil || aerr.Status != 404 {
		t.Errorf("missing user: %v", aerr)
	}
}

func TestIsGlobalReviewerRole(t *testing.T) {
	for role, want := range map[string]bool{
		"reviewer": true, "operator": true, "admin": false, "super_admin": false, "user": false, "": false,
	} {
		if got := isGlobalReviewerRole(role); got != want {
			t.Errorf("isGlobalReviewerRole(%q) = %v", role, got)
		}
	}
}

func TestFirstErrPrecedence(t *testing.T) {
	api := &apiError{Status: 404, Detail: "x"}
	plain := errors.New("boom")
	if got := firstErr(api, plain); got != plain {
		t.Errorf("plain error wins: %v", got)
	}
	if got := firstErr(api, nil); got != error(api) {
		t.Errorf("api error fallback: %v", got)
	}
}

func TestIssueActorRef(t *testing.T) {
	actors := map[string]map[string]any{"a": {"id": "a"}}
	if got := issueActorRef(actors, nil); got != nil {
		t.Errorf("nil id: %v", got)
	}
	empty := ""
	if got := issueActorRef(actors, &empty); got != nil {
		t.Errorf("empty id: %v", got)
	}
	known := "a"
	if got := issueActorRef(actors, &known); got == nil {
		t.Errorf("known actor: %v", got)
	}
	unknown := "z"
	ref, ok := issueActorRef(actors, &unknown).(map[string]any)
	if !ok || ref["id"] != "z" || ref["username"] != nil {
		t.Errorf("unknown actor: %v", ref)
	}
}

func TestListIssuesQueryValidation(t *testing.T) {
	rec := serveRegistry(t, &fakeDB{}, http.MethodGet,
		"/api/v1/review/"+listingUUID+"/issues?version_id=nope", "user")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("bad version_id: status = %d", rec.Code)
	}
	rec = serveRegistry(t, &fakeDB{}, http.MethodGet,
		"/api/v1/review/"+listingUUID+"/issues?status=stale", "user")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("bad status: status = %d", rec.Code)
	}
}

func TestListIssuesUnknownSubject404(t *testing.T) {
	rec := serveRegistry(t, &fakeDB{}, http.MethodGet,
		"/api/v1/review/"+listingUUID+"/issues", "user")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Subject not found") {
		t.Errorf("detail: %s", rec.Body.String())
	}
}

func TestCreateIssueBodyValidation(t *testing.T) {
	target := "/api/v1/review/" + listingUUID + "/issues"
	cases := []struct {
		name, body, frag string
	}{
		{"missing title", `{"body":"x"}`, `"missing"`},
		{"empty title", `{"title":""}`, "string_too_short"},
		{"long title", `{"title":"` + strings.Repeat("t", 256) + `"}`, "string_too_long"},
		{"bad version id", `{"title":"t","version_id":"nope"}`, "uuid_parsing"},
		{"long context", `{"title":"t","context":"` + strings.Repeat("c", 256) + `"}`, "string_too_long"},
	}
	for _, c := range cases {
		rec := serveRegistryReq(t, &fakeDB{}, http.MethodPost, target, "user", strings.NewReader(c.body))
		if rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s: status = %d: %s", c.name, rec.Code, rec.Body.String())
			continue
		}
		if !strings.Contains(rec.Body.String(), c.frag) {
			t.Errorf("%s: body: %s", c.name, rec.Body.String())
		}
	}
}

func TestPatchIssueValidation(t *testing.T) {
	target := "/api/v1/review/issues/" + listingUUID
	rec := serveRegistryReq(t, &fakeDB{}, http.MethodPatch, target, "user", strings.NewReader(`{}`))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("missing status: %d", rec.Code)
	}
	rec = serveRegistryReq(t, &fakeDB{}, http.MethodPatch, target, "user", strings.NewReader(`{"status":"stale"}`))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("bad status: %d", rec.Code)
	}
	rec = serveRegistryReq(t, &fakeDB{}, http.MethodPatch, target, "user", strings.NewReader(`{"status":"resolved"}`))
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), "Issue not found") {
		t.Errorf("unknown issue: %d %s", rec.Code, rec.Body.String())
	}
}

func TestAddIssueCommentValidation(t *testing.T) {
	target := "/api/v1/review/issues/" + listingUUID + "/comments"
	rec := serveRegistryReq(t, &fakeDB{}, http.MethodPost, target, "user", strings.NewReader(`{}`))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("missing body: %d", rec.Code)
	}
	rec = serveRegistryReq(t, &fakeDB{}, http.MethodPost, target, "user", strings.NewReader(`{"body":""}`))
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "string_too_short") {
		t.Errorf("empty body: %d %s", rec.Code, rec.Body.String())
	}
}

func TestListIssuesRendersWire(t *testing.T) {
	issueID := "eeee1111-1111-1111-1111-111111111111"
	db := &fakeDB{stubs: []stub{
		// The subject resolves as an mcp listing after the agent probe misses.
		{match: "FROM agents WHERE id", rows: &fakeRows{}},
		{match: "FROM review_issue_comments", rows: &fakeRows{
			cols: []string{"id", "author_id", "body", "created_at"},
			rows: [][]any{{"cccc1111-1111-1111-1111-111111111111", otherUserID, "looks off", testNow}},
		}},
		{match: "FROM review_issues WHERE", rows: &fakeRows{
			cols: []string{"id", "subject_type", "subject_id", "version_id", "context",
				"title", "body", "status", "author_id", "resolved_by", "resolved_at", "created_at"},
			rows: [][]any{{issueID, "mcp", listingUUID, nil, nil,
				"Broken env", "details", "open", testViewerID, nil, nil, testNow}},
		}},
		{match: "FROM users WHERE id = ANY", rows: &fakeRows{
			cols: []string{"id", "username", "name"},
			rows: [][]any{{testViewerID, "author", "Author"}, {otherUserID, "critic", "Critic"}},
		}},
		mcpShowStub(nil),
	}}
	rec := serveRegistry(t, db, http.MethodGet, "/api/v1/review/"+listingUUID+"/issues", "user")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var doc struct {
		SubjectType string           `json:"subject_type"`
		OpenCount   int              `json:"open_count"`
		Issues      []map[string]any `json:"issues"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatalf("body: %v", err)
	}
	if doc.SubjectType != "mcp" || doc.OpenCount != 1 || len(doc.Issues) != 1 {
		t.Fatalf("envelope: %+v", doc)
	}
	issue := doc.Issues[0]
	if issue["title"] != "Broken env" || issue["status"] != "open" {
		t.Errorf("issue: %v", issue)
	}
	author, _ := issue["author"].(map[string]any)
	if author["username"] != "author" {
		t.Errorf("author: %v", author)
	}
	comments, _ := issue["comments"].([]any)
	if len(comments) != 1 {
		t.Fatalf("comments: %v", comments)
	}
	comment, _ := comments[0].(map[string]any)
	if comment["body"] != "looks off" {
		t.Errorf("comment: %v", comment)
	}
}
