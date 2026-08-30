// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// resourceFilterSQL is the shared WHERE builder for every type arm; these
// cases pin the visibility, status, and facet clauses plus arg growth.
func TestResourceFilterSQLClauses(t *testing.T) {
	agent := resourceSpecs[0] // agents / created_by
	viewer := testViewer("user")

	// Default read: only approved rows, no unpublished exposure.
	args := []any{}
	where := resourceFilterSQL(agent, &resourceListQuery{}, viewer, nil, &args)
	if !strings.Contains(where, "l.deleted_at IS NULL") {
		t.Errorf("agent arm must exclude soft-deleted rows: %s", where)
	}
	if !strings.Contains(where, "v.status = 'approved'") {
		t.Errorf("default must gate on approved: %s", where)
	}

	// Full facet set: every optional predicate appears and binds an arg.
	pid := uuid.MustParse(listingUUID)
	after := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	q := &resourceListQuery{
		Status: "pending", Search: "map", Owner: "Bob", Mine: true,
		Scope: "private", UpdatedAfter: &after, CreatedAfter: &after,
		IncludeUnpublished: true,
	}
	args = []any{}
	where = resourceFilterSQL(agent, q, viewer, &pid, &args)
	for _, frag := range []string{
		"v.status::text = $", "l.project_id = $", "l.name ILIKE $",
		"l.created_by = $", "l.ownership_scope = 'private'", "LOWER(l.owner) = $",
		"l.updated_at >= $", "l.created_at >= $",
	} {
		if !strings.Contains(where, frag) {
			t.Errorf("missing clause %q in %s", frag, where)
		}
	}
	if len(args) == 0 {
		t.Fatal("faceted filter must bind arguments")
	}

	// Operator sees everything: visibility collapses to TRUE.
	args = []any{}
	where = resourceFilterSQL(agent, &resourceListQuery{}, testViewer("operator"), nil, &args)
	if !strings.Contains(where, "TRUE") {
		t.Errorf("operator visibility must be TRUE: %s", where)
	}

	// Anonymous with Mine set can never match its own rows.
	args = []any{}
	where = resourceFilterSQL(agent, &resourceListQuery{Mine: true}, nil, nil, &args)
	if !strings.Contains(where, "FALSE") {
		t.Errorf("anonymous Mine must be FALSE: %s", where)
	}
}

// agentSubjectDB wires the read chain (subject, versions, issues, comments,
// users) that the lifecycle handlers walk for an agent subject.
func agentSubjectDB(creator string, isPrivate bool) *fakeDB {
	t1 := time.Date(2026, 8, 10, 8, 0, 0, 0, time.UTC)
	t2 := time.Date(2026, 8, 11, 8, 0, 0, 0, time.UTC)
	t3 := time.Date(2026, 8, 12, 8, 0, 0, 0, time.UTC)
	t4 := time.Date(2026, 8, 13, 8, 0, 0, 0, time.UTC)
	t5 := time.Date(2026, 8, 14, 8, 0, 0, 0, time.UTC)

	subjectCols := []string{"id", "name", "is_private", "ownership_scope", "project_id", "co_authors", "created_at", "creator"}
	subjectRow := []any{listingUUID, "Router", isPrivate, "project", nil, []any{}, t1, creator}

	versionCols := []string{
		"id", "version", "status", "description", "rejection_reason",
		"released_by", "reviewed_by", "created_at", "released_at", "reviewed_at", "promoted_from",
	}
	versionRows := [][]any{
		{"v1", "1.0.0", "approved", "first", "", creator, otherUserID, t1, t2, t3, nil},
		{"v2", "1.1.0", "rejected", "second", "nope", creator, otherUserID, t4, nil, t5, nil},
		{"v3", "1.2.0", "approved", "restored", "", creator, otherUserID, t4, t5, t5, "old-version-id"},
	}

	issueCols := []string{"id", "title", "status", "author_id", "resolved_by", "created_at", "resolved_at"}
	issueRows := [][]any{
		{"i1", "broken link", "resolved", creator, otherUserID, t1, t3},
	}

	commentCols := []string{"issue_id", "author_id", "created_at"}
	commentRows := [][]any{{"i1", otherUserID, t2}}

	userCols := []string{"id", "username", "name"}
	userRows := [][]any{
		{creator, "alice", "Alice"},
		{otherUserID, "bob", "Bob"},
	}

	return &fakeDB{stubs: []stub{
		{match: "FROM agents l WHERE", rows: &fakeRows{cols: subjectCols, rows: [][]any{subjectRow}}},
		{match: "FROM agent_versions WHERE", rows: &fakeRows{cols: versionCols, rows: versionRows}},
		{match: "review_issue_comments", rows: &fakeRows{cols: commentCols, rows: commentRows}},
		{match: "review_issues WHERE", rows: &fakeRows{cols: issueCols, rows: issueRows}},
		{match: "FROM users WHERE id = ANY", rows: &fakeRows{cols: userCols, rows: userRows}},
	}}
}

func TestResourceActivityTimeline(t *testing.T) {
	db := agentSubjectDB(testViewerID, false)
	store := &Store{DB: db}
	out, err := store.ResourceActivity(context.Background(), listingUUID, 50, testViewer("user"))
	if err != nil {
		t.Fatalf("ResourceActivity: %v", err)
	}
	if out["subject_type"] != "agent" || out["subject_id"] != listingUUID {
		t.Errorf("subject identity: %v", out)
	}
	events, ok := out["events"].([]map[string]any)
	if !ok || len(events) == 0 {
		t.Fatalf("events shape: %T len=%d", out["events"], len(events))
	}
	kinds := map[string]bool{}
	for _, e := range events {
		kinds[e["type"].(string)] = true
	}
	for _, want := range []string{
		"resource_created", "change_opened", "version_published",
		"change_rejected", "version_restored", "issue_opened",
		"issue_comment", "issue_resolved",
	} {
		if !kinds[want] {
			t.Errorf("timeline missing %q event; got %v", want, kinds)
		}
	}
	// Actors hydrate to the user roster, newest event first.
	first := events[0]
	if actor, ok := first["actor"].(map[string]any); !ok || actor["username"] == nil {
		t.Errorf("first actor not hydrated: %v", first["actor"])
	}
}

func TestResourceActivityLimitAndCount(t *testing.T) {
	db := agentSubjectDB(testViewerID, false)
	store := &Store{DB: db}
	out, err := store.ResourceActivity(context.Background(), listingUUID, 2, testViewer("user"))
	if err != nil {
		t.Fatalf("ResourceActivity: %v", err)
	}
	events := out["events"].([]map[string]any)
	if len(events) != 2 {
		t.Errorf("limit not applied: got %d events", len(events))
	}
	if total, _ := out["total"].(int); total <= 2 {
		t.Errorf("total must count all derived events, got %v", out["total"])
	}
}

func TestResourceContributorsRoster(t *testing.T) {
	db := agentSubjectDB(testViewerID, false)
	store := &Store{DB: db}
	out, err := store.ResourceContributors(context.Background(), listingUUID, testViewer("user"))
	if err != nil {
		t.Fatalf("ResourceContributors: %v", err)
	}
	roster, ok := out["contributors"].([]map[string]any)
	if !ok || len(roster) != 2 {
		t.Fatalf("roster shape: %T len=%d", out["contributors"], len(roster))
	}
	var creatorEntry map[string]any
	for _, c := range roster {
		user := c["user"].(map[string]any)
		if user["id"] == testViewerID {
			creatorEntry = c
		}
	}
	if creatorEntry == nil {
		t.Fatal("creator absent from roster")
	}
	if creatorEntry["is_creator"] != true {
		t.Errorf("creator flag: %v", creatorEntry["is_creator"])
	}
	if creatorEntry["versions_published"].(int) != 2 {
		t.Errorf("published count = %v, want 2", creatorEntry["versions_published"])
	}
}

// A private subject hides from a stranger: the lifecycle read 404s before any
// version query runs.
func TestResourceActivityPrivateHidden(t *testing.T) {
	db := agentSubjectDB(testViewerID, true)
	store := &Store{DB: db}
	stranger := &Viewer{ID: uuid.MustParse(otherUserID), Role: "user"}
	_, err := store.ResourceActivity(context.Background(), listingUUID, 50, stranger)
	status, _, ok := APIErrorOf(err)
	if !ok || status != 404 {
		t.Fatalf("stranger on private subject: err=%v status=%d", err, status)
	}
}

func TestResolveResourceSubjectShortPrefix(t *testing.T) {
	store := &Store{DB: &fakeDB{}}
	sub, err := store.resolveResourceSubject(context.Background(), "ab")
	if err != nil || sub != nil {
		t.Fatalf("short non-uuid prefix must resolve to nothing: sub=%v err=%v", sub, err)
	}
}

func TestSubjectPermissionOwnerAndView(t *testing.T) {
	owner := &resourceSubject{creator: testViewerID, coAuthors: nil}
	if got := subjectPermission(owner, testViewer("user")); got != "owner" {
		t.Errorf("creator permission = %q, want owner", got)
	}
	stranger := &resourceSubject{creator: otherUserID, coAuthors: []string{}}
	if got := subjectPermission(stranger, testViewer("user")); got != "view" {
		t.Errorf("non-owner permission = %q, want view", got)
	}
	coAuthor := &resourceSubject{creator: otherUserID, coAuthors: []string{testViewerID}}
	if got := subjectPermission(coAuthor, testViewer("user")); got != "owner" {
		t.Errorf("co-author permission = %q, want owner", got)
	}
}

func TestLifecycleActorFallback(t *testing.T) {
	users := map[string]map[string]any{
		testViewerID: {"id": testViewerID, "username": "alice"},
	}
	if lifecycleActor(users, nil) != nil {
		t.Error("nil actor id must render nil")
	}
	id := testViewerID
	if got := lifecycleActor(users, &id).(map[string]any); got["username"] != "alice" {
		t.Errorf("known actor: %v", got)
	}
	missing := otherUserID
	got := lifecycleActor(users, &missing).(map[string]any)
	if got["id"] != otherUserID || got["username"] != nil {
		t.Errorf("unknown actor fallback: %v", got)
	}
}

func TestListResourcesSingleType(t *testing.T) {
	mcpCols := []string{
		"id", "name", "namespace", "slug", "owner", "is_private", "ownership_scope",
		"project_id", "created_at", "updated_at", "v_description", "v_status", "v_version", "v_downloads",
	}
	mcpRow := []any{
		listingUUID, "Weather", "acme", "weather", "acme", false, "project",
		nil, testNow, testNow, "fetches weather", "approved", "1.0.0", int64(7),
	}
	db := &fakeDB{stubs: []stub{
		{match: "v_downloads", rows: &fakeRows{cols: mcpCols, rows: [][]any{mcpRow}}},
		{match: "COUNT(*)", rows: &fakeRows{cols: []string{"count"}, rows: [][]any{{int64(1)}}}},
	}}
	store := &Store{DB: db}
	out, err := store.ListResources(context.Background(), &resourceListQuery{
		Type: "mcps", Page: 1, PageSize: 20,
	}, testViewer("user"), nil)
	if err != nil {
		t.Fatalf("ListResources: %v", err)
	}
	items := out["items"].([]map[string]any)
	if len(items) != 1 || items[0]["qualified_name"] != "acme/weather" {
		t.Errorf("items: %v", items)
	}
	if out["total"].(int) != 1 {
		t.Errorf("total = %v, want 1", out["total"])
	}
	counts := out["counts"].(map[string]any)
	if counts["mcps"] != 1 {
		t.Errorf("mcps count = %v, want 1", counts["mcps"])
	}
}

func TestResolveAgentIdentityByUUID(t *testing.T) {
	agentCols := []string{
		"id", "namespace", "slug", "name", "is_private", "ownership_scope",
		"project_id", "co_authors", "creator", "created_at", "v_status",
	}
	agentRow := []any{
		listingUUID, "acme", "router", "Router", false, "project",
		nil, []any{}, testViewerID, testNow, "approved",
	}
	db := &fakeDB{stubs: []stub{
		{match: "WHERE l.id = $1 AND l.deleted_at IS NULL", rows: &fakeRows{cols: agentCols, rows: [][]any{agentRow}}},
	}}
	store := &Store{DB: db}
	row, err := store.ResolveAgentIdentity(context.Background(), listingUUID, testViewer("user"))
	if err != nil {
		t.Fatalf("ResolveAgentIdentity: %v", err)
	}
	if row == nil || rowStr(row, "slug", "") != "router" {
		t.Errorf("resolved row: %v", row)
	}
}

func TestResolveAgentIdentityMissing(t *testing.T) {
	store := &Store{DB: &fakeDB{}}
	row, err := store.ResolveAgentIdentity(context.Background(), uuid.NewString(), testViewer("user"))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if row != nil {
		t.Errorf("missing agent must resolve nil, got %v", row)
	}
}
