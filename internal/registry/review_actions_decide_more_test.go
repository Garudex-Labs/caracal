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

func TestAgentSubjectRow(t *testing.T) {
	agent := map[string]any{
		"id": listingUUID, "name": "Router", "namespace": "acme", "slug": "router",
		"project_id": nil, "is_private": false, "created_by": testViewerID,
	}
	got := agentSubjectRow(agent)
	if got["id"] != listingUUID || got["name"] != "Router" || got["slug"] != "router" {
		t.Errorf("subject row: %v", got)
	}
	// Only the audience-relevant keys carry over; authorship is dropped.
	if _, leaked := got["created_by"]; leaked {
		t.Error("agentSubjectRow must not expose created_by")
	}
}

func TestPendingAgentVersions(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "FROM agent_versions", rows: &fakeRows{
			cols: []string{"id", "version", "status", "released_by"},
			rows: [][]any{{"v2", "1.1.0", "pending", testViewerID}, {"v1", "1.0.0", "pending", testViewerID}},
		}},
	}}
	store := &Store{DB: db}
	out, err := store.pendingAgentVersions(context.Background(), listingUUID)
	if err != nil {
		t.Fatalf("pendingAgentVersions: %v", err)
	}
	if len(out) != 2 || rowStr(out[0], "version", "") != "1.1.0" {
		t.Errorf("pending versions: %v", out)
	}
}

// decideAgentDB wires the agent lookup and its pending-version list.
func decideAgentDB(pending [][]any) *fakeDB {
	agentCols := []string{"id", "name", "namespace", "slug", "project_id", "is_private", "latest_version_id", "created_by"}
	agentRow := []any{listingUUID, "Router", "acme", "router", nil, false, versionUUID, testViewerID}
	versionCols := []string{"id", "version", "status", "is_editing", "editing_by", "editing_since", "released_by"}
	return &fakeDB{stubs: []stub{
		{match: "FROM agents WHERE id = $1", rows: &fakeRows{cols: agentCols, rows: [][]any{agentRow}}},
		{match: "status = 'pending'", rows: &fakeRows{cols: versionCols, rows: pending}},
	}}
}

func TestDecideAgentNotFound(t *testing.T) {
	store := &Store{DB: &fakeDB{}}
	_, err := store.DecideAgent(context.Background(), uuid.MustParse(listingUUID), true, "", "", testViewer("operator"))
	status, _, ok := APIErrorOf(err)
	if !ok || status != 404 {
		t.Fatalf("missing agent: err=%v status=%d", err, status)
	}
}

func TestDecideAgentNoPending(t *testing.T) {
	store := &Store{DB: decideAgentDB(nil)}
	_, err := store.DecideAgent(context.Background(), uuid.MustParse(listingUUID), true, "", "", testViewer("operator"))
	status, detail, ok := APIErrorOf(err)
	if !ok || status != 400 || !strings.Contains(detail, "no pending versions") {
		t.Fatalf("no pending: err=%v status=%d", err, status)
	}
}

func TestDecideAgentActivelyEditing(t *testing.T) {
	pending := [][]any{
		{"v2", "1.1.0", "pending", true, testViewerID, time.Now(), testViewerID},
	}
	store := &Store{DB: decideAgentDB(pending)}
	_, err := store.DecideAgent(context.Background(), uuid.MustParse(listingUUID), false, "spam", "", testViewer("operator"))
	status, detail, ok := APIErrorOf(err)
	if !ok || status != 409 || !strings.Contains(detail, "currently editing") {
		t.Fatalf("editing lock: err=%v status=%d", err, status)
	}
}

func TestDecideAgentRejectReachesTransaction(t *testing.T) {
	pending := [][]any{
		{"v2", "1.1.0", "pending", false, nil, nil, testViewerID},
	}
	store := &Store{DB: decideAgentDB(pending)}
	_, err := store.DecideAgent(context.Background(), uuid.MustParse(listingUUID), false, "spam", "", testViewer("operator"))
	if err == nil || !strings.Contains(err.Error(), "transactions not supported") {
		t.Fatalf("reject path must reach Begin, got %v", err)
	}
}
