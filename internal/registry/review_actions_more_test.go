// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestSafeSerializeCoercions(t *testing.T) {
	ts := time.Date(2026, 8, 30, 8, 0, 0, 0, time.UTC)
	if got := safeSerialize(ts); got != "2026-08-30T08:00:00+00:00" {
		t.Errorf("time coercion = %v", got)
	}
	id := uuid.MustParse(listingUUID)
	var raw [16]byte = id
	if got := safeSerialize(raw); got != listingUUID {
		t.Errorf("uuid coercion = %v, want %s", got, listingUUID)
	}
	if got := safeSerialize("plain"); got != "plain" {
		t.Errorf("passthrough = %v", got)
	}
	if got := safeSerialize(nil); got != nil {
		t.Errorf("nil passthrough = %v", got)
	}
}

func TestDerefContract(t *testing.T) {
	if deref(nil) != "" {
		t.Error("nil deref must be empty")
	}
	s := "value"
	if deref(&s) != "value" {
		t.Error("deref must return pointee")
	}
}

func TestRequiredReason(t *testing.T) {
	// Present string reason passes without writing a response.
	rec := httptest.NewRecorder()
	if reason, ok := requiredReason(rec, map[string]any{"reason": "spam"}); !ok || reason != "spam" {
		t.Errorf("valid reason: %q ok=%v", reason, ok)
	}
	if rec.Code != 200 {
		t.Errorf("valid reason must not write error, got %d", rec.Code)
	}

	// Absent field is a 422 missing error.
	rec = httptest.NewRecorder()
	if _, ok := requiredReason(rec, map[string]any{}); ok {
		t.Error("absent reason must fail")
	}
	if rec.Code != 422 {
		t.Errorf("absent reason status = %d, want 422", rec.Code)
	}

	// Wrong type is a 422 string_type error.
	rec = httptest.NewRecorder()
	if _, ok := requiredReason(rec, map[string]any{"reason": 7}); ok {
		t.Error("non-string reason must fail")
	}
	if rec.Code != 422 {
		t.Errorf("typed reason status = %d, want 422", rec.Code)
	}
}

func TestDisplayName(t *testing.T) {
	store := &Store{DB: &fakeDB{}}
	if name, err := store.displayName(context.Background(), ""); err != nil || name != "" {
		t.Errorf("empty id short-circuits: %q %v", name, err)
	}

	db := &fakeDB{stubs: []stub{
		{match: "FROM users WHERE id = $1", rows: &fakeRows{cols: []string{"name"}, rows: [][]any{{"alice"}}}},
	}}
	store = &Store{DB: db}
	if name, err := store.displayName(context.Background(), testViewerID); err != nil || name != "alice" {
		t.Errorf("resolved name: %q %v", name, err)
	}
}

func TestReviewDetailFavoursPendingContent(t *testing.T) {
	f := Families["prompts"]
	listing := map[string]any{
		"id": listingUUID, "name": "Greeter", "description": "old blurb",
		"version": "1.0.0", "status": "approved", "owner": "acme",
		"submitted_by": testViewerID, "created_at": testNow, "updated_at": testNow,
		"category": "chat", "template": "Hi {{name}}",
	}
	db := &fakeDB{stubs: []stub{
		{match: "status = 'pending'", rows: &fakeRows{
			cols: []string{"id", "description", "version", "status", "template"},
			rows: [][]any{{"pv1", "new blurb", "1.1.0", "pending", "Hello {{name}}"}},
		}},
		{match: "FROM users WHERE id = $1", rows: &fakeRows{cols: []string{"name"}, rows: [][]any{{"alice"}}}},
	}}
	store := &Store{DB: db}
	out, err := store.ReviewDetail(context.Background(), f, listing)
	if err != nil {
		t.Fatalf("ReviewDetail: %v", err)
	}
	// The pending version's content wins over the incumbent listing.
	if out["description"] != "new blurb" || out["version"] != "1.1.0" {
		t.Errorf("pending content not favoured: %v", out)
	}
	if out["template"] != "Hello {{name}}" {
		t.Errorf("per-type field from pending: %v", out["template"])
	}
	if out["submitted_by"] != "alice" {
		t.Errorf("submitted_by should hydrate to display name: %v", out["submitted_by"])
	}
	if out["type"] != "prompt" {
		t.Errorf("family name: %v", out["type"])
	}
}

func TestReviewDetailNoPendingUsesListing(t *testing.T) {
	f := Families["prompts"]
	listing := map[string]any{
		"id": listingUUID, "name": "Greeter", "description": "blurb",
		"version": "1.0.0", "status": "approved",
		"template": "Hi {{name}}", "created_at": testNow, "updated_at": testNow,
	}
	store := &Store{DB: &fakeDB{}}
	out, err := store.ReviewDetail(context.Background(), f, listing)
	if err != nil {
		t.Fatalf("ReviewDetail: %v", err)
	}
	if out["description"] != "blurb" || out["template"] != "Hi {{name}}" {
		t.Errorf("listing content: %v", out)
	}
}
