// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func recentTime() time.Time { return time.Now().Add(-time.Minute) }

func TestUpdateDraftGates(t *testing.T) {
	target := "/api/v1/mcps/" + listingUUID + "/draft"
	cases := []struct {
		name string
		over map[string]any
		body string
		code int
		frag string
	}{
		{"unknown listing", nil, `{"description":"x"}`, http.StatusNotFound, "Listing not found"},
		{"not the owner", map[string]any{"submitted_by": otherUserID}, `{"description":"x"}`,
			http.StatusForbidden, "Not the listing owner"},
		{"released status", map[string]any{"status": "approved"}, `{"description":"x"}`,
			http.StatusBadRequest, "Only draft, rejected, or pending listings can be edited"},
		{"no version", map[string]any{"status": "draft", "latest_version_id": nil}, `{"description":"x"}`,
			http.StatusBadRequest, "Listing has no version to update"},
		{"visibility is immutable here", map[string]any{"status": "draft"}, `{"visibility":"project"}`,
			http.StatusBadRequest, "visibility cannot be changed here"},
		{"field type validation", map[string]any{"status": "draft"}, `{"description":42}`,
			http.StatusUnprocessableEntity, "string_type"},
	}
	for _, c := range cases {
		db := &fakeDB{}
		if c.over != nil {
			db.stubs = []stub{mcpShowStub(c.over)}
		}
		rec := serveRegistryReq(t, db, http.MethodPut, target, "user", strings.NewReader(c.body))
		if rec.Code != c.code {
			t.Errorf("%s: status = %d, want %d: %s", c.name, rec.Code, c.code, rec.Body.String())
			continue
		}
		if !strings.Contains(rec.Body.String(), c.frag) {
			t.Errorf("%s: body: %s", c.name, rec.Body.String())
		}
	}
}

func TestUpdateDraftRefusesForeignFreshLock(t *testing.T) {
	db := &fakeDB{stubs: []stub{mcpShowStub(map[string]any{
		"status": "draft", "is_editing": true, "editing_by": otherUserID,
		"editing_since": recentTime(),
	})}}
	rec := serveRegistryReq(t, db, http.MethodPut, "/api/v1/mcps/"+listingUUID+"/draft",
		"user", strings.NewReader(`{"description":"x"}`))
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "currently being edited by another user") {
		t.Errorf("detail: %s", rec.Body.String())
	}
}

func TestUpdateDraftWritesVersionAndListing(t *testing.T) {
	db := &fakeDB{stubs: []stub{mcpShowStub(map[string]any{"status": "draft"})}}
	rec := serveRegistryReq(t, db, http.MethodPut, "/api/v1/mcps/"+listingUUID+"/draft",
		"user", strings.NewReader(`{"description":"fresh","name":"Weather 2","category":"tools"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var doc map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatalf("body: %v", err)
	}
	if doc["id"] != listingUUID {
		t.Errorf("readback detail: %v", doc["id"])
	}
	var versionUpdate, listingUpdate bool
	for _, sql := range db.log {
		if strings.Contains(sql, "UPDATE mcp_versions SET") && strings.Contains(sql, "description = $") {
			versionUpdate = true
			// The save always releases the edit lock.
			if !strings.Contains(sql, "is_editing = FALSE") {
				t.Errorf("save must release the lock: %s", sql)
			}
		}
		if strings.Contains(sql, "UPDATE mcp_listings SET") && strings.Contains(sql, "updated_at = now()") {
			listingUpdate = true
		}
	}
	if !versionUpdate || !listingUpdate {
		t.Errorf("updates missing: version=%v listing=%v\n%v", versionUpdate, listingUpdate, db.log)
	}
}

func TestUpdateDraftListingConflictIs409(t *testing.T) {
	inner := &fakeDB{stubs: []stub{mcpShowStub(map[string]any{"status": "draft"})}}
	db := &execCapableDB{fakeDB: inner, exec: func(sql string) (pgconn.CommandTag, error) {
		if strings.Contains(sql, "UPDATE mcp_listings SET") {
			return pgconn.CommandTag{}, &pgconn.PgError{Code: "23505"}
		}
		return pgconn.NewCommandTag("UPDATE 1"), nil
	}}
	// serveRegistryReq wants *fakeDB, so drive the store directly.
	s := &Store{DB: db}
	_, err := s.UpdateDraft(context.Background(), Families["mcps"], listingUUID, testViewer("user"),
		&draftBody{raw: map[string]any{"name": "Taken Name"}}, nil)
	api := asAPIError(t, err)
	if api.Status != 409 || !strings.Contains(api.Detail, "already exists") {
		t.Errorf("conflict: %d %q", api.Status, api.Detail)
	}
}

func TestUpdateVersionFieldsCollectsPresentColumns(t *testing.T) {
	b := &draftBody{raw: map[string]any{
		"version":     "2.0.0",
		"description": "d",
		"command":     "npx",
		"args":        []any{"-y"},
		"changelog":   nil, // explicit null is skipped
	}}
	u := &updateSpec{}
	updateVersionFields(Families["mcps"], b, nil, u)
	joined := strings.Join(u.sets, ", ")
	for _, want := range []string{"version = $", "description = $", "command = $", "args = $"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %q in %q", want, joined)
		}
	}
	if strings.Contains(joined, "changelog") {
		t.Errorf("null field must be skipped: %q", joined)
	}
	if len(b.errs) != 0 {
		t.Errorf("errs = %+v", b.errs)
	}
}

func TestSkillSlashUpdateReplaysAnalyzer(t *testing.T) {
	s := &Store{}
	t.Run("explicit null clears", func(t *testing.T) {
		b := &draftBody{raw: map[string]any{"slash_command": nil}}
		u := &updateSpec{}
		if err := s.skillSlashUpdate(b, "", u); err != nil {
			t.Fatalf("clear: %v", err)
		}
		if len(u.sets) != 1 || !strings.Contains(u.sets[0], "slash_command = $1") || u.vals[0] != nil {
			t.Errorf("sets = %v vals = %v", u.sets, u.vals)
		}
	})
	t.Run("frontmatter command wins over content", func(t *testing.T) {
		b := &draftBody{raw: map[string]any{
			"skill_md_content": "---\ncommand: sift\n---\nbody",
		}}
		u := &updateSpec{}
		if err := s.skillSlashUpdate(b, "", u); err != nil {
			t.Fatalf("analyze: %v", err)
		}
		if len(u.vals) != 1 || u.vals[0] != "sift" {
			t.Errorf("vals = %v", u.vals)
		}
	})
	t.Run("mismatched command is rejected", func(t *testing.T) {
		b := &draftBody{raw: map[string]any{
			"slash_command":    "other",
			"skill_md_content": "---\ncommand: sift\n---\nbody",
		}}
		if err := s.skillSlashUpdate(b, "", &updateSpec{}); err == nil ||
			!strings.Contains(err.Detail, "does not match SKILL.md frontmatter") {
			t.Errorf("err = %v", err)
		}
	})
	t.Run("bare command validates against stored content", func(t *testing.T) {
		b := &draftBody{raw: map[string]any{"slash_command": "sift"}}
		u := &updateSpec{}
		if err := s.skillSlashUpdate(b, "---\ncommand: sift\n---\nbody", u); err != nil {
			t.Fatalf("stored: %v", err)
		}
		if len(u.vals) != 1 || u.vals[0] != "sift" {
			t.Errorf("vals = %v", u.vals)
		}
	})
	t.Run("absent key is a no-op", func(t *testing.T) {
		u := &updateSpec{}
		if err := s.skillSlashUpdate(&draftBody{raw: map[string]any{}}, "", u); err != nil || len(u.sets) != 0 {
			t.Errorf("no-op: %v %v", err, u.sets)
		}
	})
}
