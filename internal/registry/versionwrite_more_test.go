// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestVersionWriteBody(t *testing.T) {
	// Valid JSON object decodes.
	req := httptest.NewRequest("POST", "/x", strings.NewReader(`{"version":"1.0.0"}`))
	rec := httptest.NewRecorder()
	if body := versionWriteBody(rec, req); body == nil || body["version"] != "1.0.0" {
		t.Errorf("valid body: %v", body)
	}

	// Empty body is a 422 missing error.
	req = httptest.NewRequest("POST", "/x", strings.NewReader("   "))
	rec = httptest.NewRecorder()
	if versionWriteBody(rec, req) != nil || rec.Code != 422 {
		t.Errorf("empty body status = %d", rec.Code)
	}

	// Malformed JSON is a 422 decode error.
	req = httptest.NewRequest("POST", "/x", strings.NewReader("{not json"))
	rec = httptest.NewRecorder()
	if versionWriteBody(rec, req) != nil || rec.Code != 422 {
		t.Errorf("bad JSON status = %d", rec.Code)
	}
}

// renderVersion re-reads the freshly written version row; a missing readback
// is a hard error, a present one renders onto the wire.
func TestRenderVersion(t *testing.T) {
	f := Families["prompts"]

	missing := &Store{DB: &fakeDB{}}
	if _, err := missing.renderVersion(context.Background(), f, versionUUID, nil); err == nil {
		t.Error("absent version readback must error")
	}

	db := &fakeDB{stubs: []stub{
		{match: "FROM prompt_versions WHERE id = $1", rows: &fakeRows{
			cols: []string{"id", "listing_id", "version", "description", "status", "released_by"},
			rows: [][]any{{versionUUID, listingUUID, "1.0.0", "blurb", "approved", testViewerID}},
		}},
	}}
	store := &Store{DB: db}
	raw, err := store.renderVersion(context.Background(), f, versionUUID, nil)
	if err != nil {
		t.Fatalf("renderVersion: %v", err)
	}
	if !strings.Contains(string(raw), `"1.0.0"`) {
		t.Errorf("rendered payload: %s", raw)
	}
}

func TestSuggestVersionsBumps(t *testing.T) {
	f := Families["mcps"]
	db := &fakeDB{stubs: []stub{
		{match: "FROM mcp_listings l", rows: &fakeRows{
			cols: []string{"id", "version", "latest_version_id"},
			rows: [][]any{{listingUUID, "1.0.0", versionUUID}},
		}},
		{match: "FROM mcp_versions v WHERE v.listing_id", rows: &fakeRows{
			cols: []string{"version"},
			rows: [][]any{{"1.0.0"}, {"1.2.0"}, {"2.0.0"}},
		}},
	}}
	store := &Store{DB: db}
	out, err := store.SuggestVersions(context.Background(), f, listingUUID, testViewer("user"))
	if err != nil {
		t.Fatalf("SuggestVersions: %v", err)
	}
	// The highest on record (2.0.0) anchors the suggestions.
	if out.Current != "2.0.0" {
		t.Errorf("current = %q, want 2.0.0", out.Current)
	}
	if out.Suggestions.Patch != "2.0.1" || out.Suggestions.Minor != "2.1.0" || out.Suggestions.Major != "3.0.0" {
		t.Errorf("bumps: %+v", out.Suggestions)
	}
}

func TestRenderPromptSubstitutes(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: "v.status = 'approved'", rows: &fakeRows{
			cols: []string{"id", "template", "status", "is_private"},
			rows: [][]any{{listingUUID, "Hello {{ name }}, welcome to {{place}}!", "approved", false}},
		}},
	}}
	store := &Store{DB: db}
	out, err := store.RenderPrompt(context.Background(), listingUUID,
		map[string]string{"name": "Ada", "place": "Caracal"}, testViewer("user"))
	if err != nil {
		t.Fatalf("RenderPrompt: %v", err)
	}
	if out.Rendered != "Hello Ada, welcome to Caracal!" {
		t.Errorf("rendered = %q", out.Rendered)
	}
	if out.ListingID != listingUUID {
		t.Errorf("listing id = %q", out.ListingID)
	}
}

func TestRenderPromptMissing404(t *testing.T) {
	store := &Store{DB: &fakeDB{}}
	_, err := store.RenderPrompt(context.Background(), uuid.NewString(), nil, testViewer("user"))
	status, _, ok := APIErrorOf(err)
	if !ok || status != 404 {
		t.Fatalf("missing prompt: err=%v status=%d", err, status)
	}
}

func TestSnapshotVersionRowStripsManaged(t *testing.T) {
	f := Families["prompts"]
	db := &fakeDB{stubs: []stub{
		{match: "SELECT * FROM prompt_versions WHERE id = $1", rows: &fakeRows{
			cols: []string{"id", "status", "download_count", "template", "category"},
			rows: [][]any{{versionUUID, "approved", int64(9), "Hi {{name}}", "chat"}},
		}},
	}}
	store := &Store{DB: db}
	snap, err := store.snapshotVersionRow(context.Background(), f, versionUUID)
	if err != nil {
		t.Fatalf("snapshotVersionRow: %v", err)
	}
	// Managed workflow columns are dropped; content columns survive.
	for _, managed := range []string{"id", "status", "download_count"} {
		if _, present := snap[managed]; present {
			t.Errorf("managed field %q leaked into snapshot", managed)
		}
	}
	if snap["template"] != "Hi {{name}}" || snap["category"] != "chat" {
		t.Errorf("content fields: %v", snap)
	}
}

func TestSnapshotVersionRowMissing(t *testing.T) {
	store := &Store{DB: &fakeDB{}}
	snap, err := store.snapshotVersionRow(context.Background(), Families["prompts"], versionUUID)
	if err != nil || len(snap) != 0 {
		t.Fatalf("absent version snapshot: snap=%v err=%v", snap, err)
	}
}

// promptListingDB answers Resolve with a single owned prompt listing.
func promptListingDB(ownerID string, versionExists bool) *fakeDB {
	return &fakeDB{stubs: []stub{
		{match: "FROM prompt_listings l LEFT JOIN", rows: &fakeRows{
			cols: []string{"id", "submitted_by", "co_authors", "latest_version_id", "status"},
			rows: [][]any{{listingUUID, ownerID, []any{}, nil, "approved"}},
		}},
		{match: "SELECT 1 FROM prompt_versions WHERE listing_id", rows: &fakeRows{
			cols: []string{"exists"}, rows: [][]any{{versionExists}},
		}},
	}}
}

func TestPublishVersionValidation(t *testing.T) {
	store := &Store{DB: &fakeDB{}}
	_, err := store.PublishVersion(context.Background(), Families["prompts"], listingUUID, map[string]any{}, testViewer("user"))
	if _, ok := err.(*validationError); !ok {
		t.Fatalf("empty body must be a validation error, got %T: %v", err, err)
	}
}

func TestPublishVersionBadSemver(t *testing.T) {
	store := &Store{DB: &fakeDB{}}
	body := map[string]any{"version": "not-semver", "description": "d"}
	_, err := store.PublishVersion(context.Background(), Families["prompts"], listingUUID, body, testViewer("user"))
	status, _, ok := APIErrorOf(err)
	if !ok || status != 422 {
		t.Fatalf("bad semver: err=%v status=%d", err, status)
	}
}

func TestPublishVersionNotFound(t *testing.T) {
	store := &Store{DB: &fakeDB{}}
	body := map[string]any{"version": "1.0.0", "description": "d"}
	_, err := store.PublishVersion(context.Background(), Families["prompts"], listingUUID, body, testViewer("user"))
	status, _, ok := APIErrorOf(err)
	if !ok || status != 404 {
		t.Fatalf("missing listing: err=%v status=%d", err, status)
	}
}

func TestPublishVersionNotOwner(t *testing.T) {
	store := &Store{DB: promptListingDB(otherUserID, false)}
	body := map[string]any{"version": "1.0.0", "description": "d"}
	_, err := store.PublishVersion(context.Background(), Families["prompts"], listingUUID, body, testViewer("user"))
	status, _, ok := APIErrorOf(err)
	if !ok || status != 403 {
		t.Fatalf("non-owner: err=%v status=%d", err, status)
	}
}

func TestPublishVersionDuplicate(t *testing.T) {
	store := &Store{DB: promptListingDB(testViewerID, true)}
	body := map[string]any{"version": "1.0.0", "description": "d"}
	_, err := store.PublishVersion(context.Background(), Families["prompts"], listingUUID, body, testViewer("user"))
	status, _, ok := APIErrorOf(err)
	if !ok || status != 409 {
		t.Fatalf("duplicate version: err=%v status=%d", err, status)
	}
}

func TestPublishVersionOwnerReachesTransaction(t *testing.T) {
	store := &Store{DB: promptListingDB(testViewerID, false)}
	body := map[string]any{
		"version": "1.0.0", "description": "d",
		"extra": map[string]any{"category": "chat", "template": "Hi {{name}}"},
	}
	_, err := store.PublishVersion(context.Background(), Families["prompts"], listingUUID, body, testViewer("user"))
	if err == nil || !strings.Contains(err.Error(), "transactions not supported") {
		t.Fatalf("owner path must reach Begin, got %v", err)
	}
}
