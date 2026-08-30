// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// derefName reads a users roster username, which scans as a *string.
func derefName(v any) string {
	switch s := v.(type) {
	case string:
		return s
	case *string:
		if s != nil {
			return *s
		}
	}
	return ""
}

func TestAgentVisibilitySQL(t *testing.T) {
	// Operators bypass row visibility entirely, but the soft-delete guard stays.
	args := []any{}
	if got := agentVisibilitySQL(testViewer("operator"), &args); got != "(l.deleted_at IS NULL AND TRUE)" {
		t.Errorf("operator visibility = %q", got)
	}
	// A plain user gets the public-or-owned-or-member disjunction.
	args = []any{}
	got := agentVisibilitySQL(testViewer("user"), &args)
	if !strings.HasPrefix(got, "(l.deleted_at IS NULL AND (") || !strings.Contains(got, "l.created_by") {
		t.Errorf("user visibility = %q", got)
	}
	if len(args) != 1 {
		t.Errorf("user visibility must bind the viewer id once, got %d args", len(args))
	}
}

func TestSubjectAuthorReleaserThenOwner(t *testing.T) {
	// Latest version's releaser wins when present.
	db := &fakeDB{stubs: []stub{
		{match: "released_by FROM agent_versions WHERE id = $1", rows: &fakeRows{
			cols: []string{"released_by"}, rows: [][]any{{otherUserID}},
		}},
	}}
	store := &Store{DB: db}
	subject := map[string]any{"latest_version_id": versionUUID, "created_by": testViewerID}
	if got := store.subjectAuthor(context.Background(), "agent", subject); got == nil || got.String() != otherUserID {
		t.Errorf("releaser author = %v, want %s", got, otherUserID)
	}

	// No latest version falls back to the listing's own owner.
	store = &Store{DB: &fakeDB{}}
	subject = map[string]any{"created_by": testViewerID}
	if got := store.subjectAuthor(context.Background(), "agent", subject); got == nil || got.String() != testViewerID {
		t.Errorf("fallback author = %v, want %s", got, testViewerID)
	}
}

// issueByID hydrates one issue with its comment trail and participant roster.
func issueReadDB() *fakeDB {
	return &fakeDB{stubs: []stub{
		{match: "FROM review_issues WHERE id = $1", rows: &fakeRows{
			cols: []string{
				"id", "subject_type", "subject_id", "version_id", "context", "title",
				"body", "status", "author_id", "resolved_by", "resolved_at", "created_at",
			},
			rows: [][]any{{
				"issue-1", "agent", listingUUID, nil, "ctx", "broken link",
				"details", "open", testViewerID, nil, nil, testNow,
			}},
		}},
		{match: "FROM review_issue_comments WHERE issue_id = $1", rows: &fakeRows{
			cols: []string{"id", "author_id", "body", "created_at"},
			rows: [][]any{{"c-1", otherUserID, "on it", testNow}},
		}},
		{match: "FROM users WHERE id = ANY", rows: &fakeRows{
			cols: []string{"id", "username", "name"},
			rows: [][]any{
				{testViewerID, "alice", "Alice"},
				{otherUserID, "bob", "Bob"},
			},
		}},
	}}
}

func TestIssueByID(t *testing.T) {
	store := &Store{DB: issueReadDB()}
	out, err := store.issueByID(context.Background(), "issue-1")
	if err != nil {
		t.Fatalf("issueByID: %v", err)
	}
	if out["title"] != "broken link" || out["status"] != "open" {
		t.Errorf("issue fields: %v", out)
	}
	author, ok := out["author"].(map[string]any)
	if !ok || derefName(author["username"]) != "alice" {
		t.Errorf("author hydration: %v", out["author"])
	}
	comments, ok := out["comments"].([]any)
	if !ok || len(comments) != 1 {
		t.Fatalf("comments shape: %T", out["comments"])
	}
	comment := comments[0].(map[string]any)
	if ca := comment["author"].(map[string]any); derefName(ca["username"]) != "bob" {
		t.Errorf("comment author: %v", comment["author"])
	}
}

func TestIssueByIDMissing(t *testing.T) {
	store := &Store{DB: &fakeDB{}}
	_, err := store.issueByID(context.Background(), "ghost")
	status, _, ok := APIErrorOf(err)
	if !ok || status != 404 {
		t.Fatalf("missing issue: err=%v status=%d", err, status)
	}
}

// agentIssueSubjectDB resolves an agent subject and its issue list.
func agentIssueSubjectDB(isPrivate bool) *fakeDB {
	return &fakeDB{stubs: []stub{
		{match: "FROM agents WHERE id = $1", rows: &fakeRows{
			cols: []string{"id", "created_by", "project_id", "latest_version_id", "is_private", "name", "namespace", "slug"},
			rows: [][]any{{listingUUID, testViewerID, nil, versionUUID, isPrivate, "Router", "acme", "router"}},
		}},
		{match: "FROM review_issues WHERE", rows: &fakeRows{
			cols: []string{
				"id", "subject_type", "subject_id", "version_id", "context", "title",
				"body", "status", "author_id", "resolved_by", "resolved_at", "created_at",
			},
			rows: [][]any{{
				"issue-1", "agent", listingUUID, nil, "ctx", "typo",
				"body", "open", testViewerID, nil, nil, testNow,
			}},
		}},
		{match: "FROM users WHERE id = ANY", rows: &fakeRows{
			cols: []string{"id", "username", "name"},
			rows: [][]any{{testViewerID, "alice", "Alice"}},
		}},
	}}
}

func TestListIssuesForAgent(t *testing.T) {
	store := &Store{DB: agentIssueSubjectDB(false)}
	out, err := store.ListIssues(context.Background(), listingUUID, nil, "", testViewer("user"))
	if err != nil {
		t.Fatalf("ListIssues: %v", err)
	}
	if out["subject_type"] != "agent" || out["open_count"] != 1 {
		t.Errorf("summary: %v", out)
	}
	issues := out["issues"].([]any)
	if len(issues) != 1 {
		t.Fatalf("issues len = %d", len(issues))
	}
}

// A stranger cannot see a private subject's issue list.
func TestListIssuesPrivateHidden(t *testing.T) {
	store := &Store{DB: agentIssueSubjectDB(true)}
	stranger := &Viewer{ID: uuid.MustParse(otherUserID), Role: "user"}
	_, err := store.ListIssues(context.Background(), listingUUID, nil, "", stranger)
	status, _, ok := APIErrorOf(err)
	if !ok || status != 404 {
		t.Fatalf("private issue list: err=%v status=%d", err, status)
	}
}

// CreateIssue rejects an invisible subject before any write is attempted.
func TestCreateIssuePrivateHidden(t *testing.T) {
	store := &Store{DB: agentIssueSubjectDB(true)}
	stranger := &Viewer{ID: uuid.MustParse(otherUserID), Role: "user"}
	_, err := store.CreateIssue(context.Background(), listingUUID, "title", "", "", nil, stranger)
	status, _, ok := APIErrorOf(err)
	if !ok || status != 404 {
		t.Fatalf("hidden subject: err=%v status=%d", err, status)
	}
}

// An owner clears visibility and scope, then the fake's transaction seam
// surfaces the Begin failure.
func TestCreateIssueReachesTransaction(t *testing.T) {
	store := &Store{DB: agentIssueSubjectDB(false)}
	_, err := store.CreateIssue(context.Background(), listingUUID, "title", "", "", nil, testViewer("user"))
	if err == nil || !strings.Contains(err.Error(), "transactions not supported") {
		t.Fatalf("owner path must reach Begin, got %v", err)
	}
}
