// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"testing"
)

// bulkUserRow answers userFor with a resolvable identity; leaving the
// organizations lookup unstubbed makes ResolvePublishTarget resolve a nil
// (catch-all) project, which keeps the fixture focused on the bulk loop.
func bulkUserStub() stub {
	return stub{match: "username, email FROM users",
		rows: &fakeRows{cols: []string{"username", "email"}, rows: [][]any{{"ada", "ada@example.com"}}}}
}

func TestBulkCreateAgentsDryRunReportsCreated(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		bulkUserStub(),
		// No existing agent with this name.
		{match: "EXISTS (SELECT 1 FROM agents", rows: &fakeRows{cols: []string{"exists"}, rows: [][]any{{false}}}},
	}}
	store := &Store{DB: db}
	out, err := store.BulkCreateAgents(context.Background(),
		[]map[string]any{{"name": "My Agent"}}, true, testViewer("user"))
	if err != nil {
		t.Fatalf("BulkCreateAgents: %v", err)
	}
	if out["created"] != 1 || out["skipped"] != 0 || out["errors"] != 0 {
		t.Errorf("counts = %+v", out)
	}
	if out["dry_run"] != true {
		t.Error("dry_run flag should be echoed")
	}
	results, _ := out["results"].([]any)
	if len(results) != 1 {
		t.Fatalf("results = %+v", results)
	}
	first, _ := results[0].(map[string]any)
	if first["status"] != "created" || first["agent_id"] != nil {
		t.Errorf("dry-run row should be created with a nil id: %+v", first)
	}
}

func TestBulkCreateAgentsSkipsExisting(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		bulkUserStub(),
		{match: "EXISTS (SELECT 1 FROM agents", rows: &fakeRows{cols: []string{"exists"}, rows: [][]any{{true}}}},
	}}
	store := &Store{DB: db}
	out, err := store.BulkCreateAgents(context.Background(),
		[]map[string]any{{"name": "Taken"}}, false, testViewer("user"))
	if err != nil {
		t.Fatalf("BulkCreateAgents: %v", err)
	}
	if out["skipped"] != 1 || out["created"] != 0 {
		t.Errorf("an existing name must be skipped: %+v", out)
	}
}

func TestBulkCreateAgentsRejectsBadName(t *testing.T) {
	db := &fakeDB{stubs: []stub{bulkUserStub()}}
	store := &Store{DB: db}
	// An empty name cannot be slugified, so the resolver rejects it and the
	// item is reported as an error without ever reaching the existence check.
	out, err := store.BulkCreateAgents(context.Background(),
		[]map[string]any{{"name": ""}}, false, testViewer("user"))
	if err != nil {
		t.Fatalf("a per-item rejection must not fail the batch: %v", err)
	}
	if out["errors"] != 1 || out["created"] != 0 {
		t.Errorf("bad name should be an error row: %+v", out)
	}
	results, _ := out["results"].([]any)
	first, _ := results[0].(map[string]any)
	if first["status"] != "error" || first["error"] == nil {
		t.Errorf("error row should carry a detail: %+v", first)
	}
}
