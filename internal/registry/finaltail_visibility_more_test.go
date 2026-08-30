// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestViewerLeadsProject(t *testing.T) {
	uid := uuid.MustParse(testViewerID)

	if (&Store{DB: &fakeDB{}}).viewerLeadsProject(context.Background(), nil, uid) {
		t.Error("nil project id must not lead")
	}
	bad := "not-a-uuid"
	if (&Store{DB: &fakeDB{}}).viewerLeadsProject(context.Background(), &bad, uid) {
		t.Error("unparseable project id must not lead")
	}

	pid := listingUUID
	lead := &Store{DB: &fakeDB{stubs: []stub{
		{match: "role FROM project_memberships", rows: &fakeRows{cols: []string{"role"}, rows: [][]any{{"lead"}}}},
	}}}
	if !lead.viewerLeadsProject(context.Background(), &pid, uid) {
		t.Error("lead membership must return true")
	}

	member := &Store{DB: &fakeDB{stubs: []stub{
		{match: "role FROM project_memberships", rows: &fakeRows{cols: []string{"role"}, rows: [][]any{{"member"}}}},
	}}}
	if member.viewerLeadsProject(context.Background(), &pid, uid) {
		t.Error("non-lead membership must return false")
	}

	// No membership row: the query yields ErrNoRows and the answer is false.
	if (&Store{DB: &fakeDB{}}).viewerLeadsProject(context.Background(), &pid, uid) {
		t.Error("absent membership must return false")
	}
}

func TestUpdateVisibilityInvalidType(t *testing.T) {
	store := &Store{DB: &fakeDB{}}
	_, err := store.UpdateVisibility(context.Background(), "widget", listingUUID, "project", testViewer("user"))
	status, _, ok := APIErrorOf(err)
	if !ok || status != 422 {
		t.Fatalf("invalid type: err=%v status=%d", err, status)
	}
}

func TestUpdateVisibilityNotFound(t *testing.T) {
	store := &Store{DB: &fakeDB{}}
	_, err := store.UpdateVisibility(context.Background(), "mcp", listingUUID, "project", testViewer("user"))
	status, _, ok := APIErrorOf(err)
	if !ok || status != 404 {
		t.Fatalf("missing listing: err=%v status=%d", err, status)
	}
}

// visibilityListingDB answers the ownership lookup with a single row.
func visibilityListingDB(ownerID string, isPrivate bool) *fakeDB {
	return &fakeDB{stubs: []stub{
		{match: "FROM mcp_listings l LEFT JOIN", rows: &fakeRows{
			cols: []string{"id", "name", "namespace", "slug", "is_private", "project_id", "owner_id", "latest_version_id", "version", "status"},
			rows: [][]any{{listingUUID, "Weather", "acme", "weather", isPrivate, nil, ownerID, versionUUID, "1.0.0", "approved"}},
		}},
	}}
}

// A stranger sees a private listing's not-found face before any write.
func TestUpdateVisibilityPrivateStranger404(t *testing.T) {
	store := &Store{DB: visibilityListingDB(otherUserID, true)}
	_, err := store.UpdateVisibility(context.Background(), "mcp", listingUUID, "public", testViewer("user"))
	status, _, ok := APIErrorOf(err)
	if !ok || status != 404 {
		t.Fatalf("private stranger: err=%v status=%d", err, status)
	}
}

// A stranger on a public listing is refused with 403.
func TestUpdateVisibilityPublicStranger403(t *testing.T) {
	store := &Store{DB: visibilityListingDB(otherUserID, false)}
	_, err := store.UpdateVisibility(context.Background(), "mcp", listingUUID, "project", testViewer("user"))
	status, _, ok := APIErrorOf(err)
	if !ok || status != 403 {
		t.Fatalf("public stranger: err=%v status=%d", err, status)
	}
}

// The owner clears authority and reaches the transaction seam.
func TestUpdateVisibilityOwnerReachesTransaction(t *testing.T) {
	store := &Store{DB: visibilityListingDB(testViewerID, false)}
	_, err := store.UpdateVisibility(context.Background(), "mcp", listingUUID, "public", testViewer("user"))
	if err == nil || !strings.Contains(err.Error(), "transactions not supported") {
		t.Fatalf("owner path must reach Begin, got %v", err)
	}
}
