// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestSubjectFromRow(t *testing.T) {
	row := map[string]any{
		"id":         listingUUID,
		"name":       "Weather",
		"namespace":  "acme",
		"slug":       "weather",
		"is_private": true,
		"project_id": "99999999-9999-9999-9999-999999999999",
		"version":    "1.2.0",
	}
	subj := subjectFromRow(row, "mcp")
	if subj.Type != "mcp" || subj.Name != "Weather" || !subj.IsPrivate {
		t.Fatalf("subject = %+v", subj)
	}
	if subj.ID == nil || subj.ID.String() != listingUUID {
		t.Errorf("id = %v", subj.ID)
	}
	if subj.ProjectID == nil || subj.ProjectID.String() != "99999999-9999-9999-9999-999999999999" {
		t.Errorf("project id = %v", subj.ProjectID)
	}
	if subj.Namespace == nil || *subj.Namespace != "acme" {
		t.Errorf("namespace = %v", subj.Namespace)
	}
	if subj.Version == nil || *subj.Version != "1.2.0" {
		t.Errorf("version = %v", subj.Version)
	}

	// A row without id/project/version leaves the optional fields nil.
	bare := subjectFromRow(map[string]any{"name": "X"}, "skill")
	if bare.ID != nil || bare.ProjectID != nil || bare.Version != nil {
		t.Errorf("bare subject retained optional fields: %+v", bare)
	}
}

func TestFamilySubmitGate(t *testing.T) {
	mcps := Families["mcps"]
	if err := familySubmitGate(mcps, map[string]any{}); err == nil || err.Status != 400 {
		t.Errorf("missing description should reject: %v", err)
	}
	if err := familySubmitGate(mcps, map[string]any{"description": "d"}); err == nil {
		t.Errorf("mcp without transport should reject")
	}
	if err := familySubmitGate(mcps, map[string]any{"description": "d", "command": "npx x"}); err != nil {
		t.Errorf("mcp with command should pass: %v", err)
	}

	prompts := Families["prompts"]
	if err := familySubmitGate(prompts, map[string]any{"description": "d"}); err == nil {
		t.Errorf("prompt without template should reject")
	}
	if err := familySubmitGate(prompts, map[string]any{"description": "d", "template": "hi {{x}}"}); err != nil {
		t.Errorf("prompt with template should pass: %v", err)
	}

	// Families with no extra gate pass on description alone.
	if err := familySubmitGate(Families["hooks"], map[string]any{"description": "d"}); err != nil {
		t.Errorf("hook with description should pass: %v", err)
	}
}

func TestReviewersForBranches(t *testing.T) {
	opID := "aaaaaaaa-0000-0000-0000-000000000001"
	leadID := "aaaaaaaa-0000-0000-0000-000000000002"
	globalID := "aaaaaaaa-0000-0000-0000-000000000003"
	pid := uuid.MustParse("99999999-9999-9999-9999-999999999999")
	ctx := context.Background()

	// Private with no project: deployment operators.
	priv := &Store{DB: &fakeDB{stubs: []stub{
		{match: "role = 'operator'", rows: &fakeRows{cols: []string{"id"}, rows: [][]any{{opID}}}},
	}}}
	got, err := priv.reviewersFor(ctx, nil, true)
	if err != nil || len(got) != 1 || got[0].String() != opID {
		t.Fatalf("private/no-project reviewers = %v (%v)", got, err)
	}

	// Private with a project: that project's leads.
	privProj := &Store{DB: &fakeDB{stubs: []stub{
		{match: "role = 'lead'", rows: &fakeRows{cols: []string{"user_id"}, rows: [][]any{{leadID}}}},
	}}}
	got, err = privProj.reviewersFor(ctx, &pid, true)
	if err != nil || len(got) != 1 || got[0].String() != leadID {
		t.Fatalf("private/project reviewers = %v (%v)", got, err)
	}

	// Public with no project: global reviewers only.
	pub := &Store{DB: &fakeDB{stubs: []stub{
		{match: "role IN", rows: &fakeRows{cols: []string{"id"}, rows: [][]any{{globalID}}}},
	}}}
	got, err = pub.reviewersFor(ctx, nil, false)
	if err != nil || len(got) != 1 || got[0].String() != globalID {
		t.Fatalf("public/no-project reviewers = %v (%v)", got, err)
	}

	// Public with a project: global reviewers plus leads, deduplicated.
	pubProj := &Store{DB: &fakeDB{stubs: []stub{
		{match: "role IN", rows: &fakeRows{cols: []string{"id"}, rows: [][]any{{globalID}, {leadID}}}},
		{match: "role = 'lead'", rows: &fakeRows{cols: []string{"user_id"}, rows: [][]any{{leadID}}}},
	}}}
	got, err = pubProj.reviewersFor(ctx, &pid, false)
	if err != nil {
		t.Fatalf("public/project reviewers err = %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("public/project reviewers should dedup to 2: %v", got)
	}
}

func TestSubmitForReviewDenialPaths(t *testing.T) {
	target := "/api/v1/mcps/" + listingUUID + "/submit"

	// Unknown listing: 404.
	rec := serveRegistryReq(t, &fakeDB{}, http.MethodPost, target, "user", nil)
	if rec.Code != http.StatusNotFound {
		t.Errorf("missing listing: status = %d, want 404", rec.Code)
	}

	// Not the owner: 403.
	foreign := &fakeDB{stubs: []stub{mcpShowStub(map[string]any{
		"submitted_by": "33333333-3333-3333-3333-333333333333", "status": "draft",
	})}}
	rec = serveRegistryReq(t, foreign, http.MethodPost, target, "user", nil)
	if rec.Code != http.StatusForbidden {
		t.Errorf("non-owner: status = %d, want 403", rec.Code)
	}

	// Owner but the listing is already approved: 400.
	approved := &fakeDB{stubs: []stub{mcpShowStub(map[string]any{"status": "approved"})}}
	rec = serveRegistryReq(t, approved, http.MethodPost, target, "user", nil)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("approved listing: status = %d, want 400", rec.Code)
	}

	// Owner, draft, but the family gate is unmet (no transport): 400.
	gateFail := &fakeDB{stubs: []stub{mcpShowStub(map[string]any{"status": "draft"})}}
	rec = serveRegistryReq(t, gateFail, http.MethodPost, target, "user", nil)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("gate failure: status = %d, want 400", rec.Code)
	}
}

func TestSubmitForReviewBeginFailureIs500(t *testing.T) {
	target := "/api/v1/mcps/" + listingUUID + "/submit"
	// Owner, draft, gate satisfied by a command: reaches Begin, which the
	// fake rejects. The transaction-open failure maps to a leak-free 500.
	db := &fakeDB{stubs: []stub{mcpShowStub(map[string]any{
		"status": "draft", "command": "npx server",
	})}}
	rec := serveRegistryReq(t, db, http.MethodPost, target, "user", nil)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("begin failure: status = %d, want 500: %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "transactions not supported") {
		t.Errorf("internal detail leaked: %s", rec.Body.String())
	}
}
