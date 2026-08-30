// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package orgs

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestResourceRetentionPolicyReadDefaults(t *testing.T) {
	db := &fakeDB{stubs: []stub{orgStub("admin"), projectStub(projectRowValues("app", false, "lead"))}}
	rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodGet,
		"/api/v1/orgs/acme/projects/app/retention-policy", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out["private_retention_days"] != float64(30) || out["project_retention_days"] != float64(30) || out["can_update"] != true {
		t.Fatalf("policy = %v", out)
	}
}

func TestResourceRetentionPolicyRejectsProjectBelowMinimum(t *testing.T) {
	db := &fakeDB{stubs: []stub{orgStub("admin"), projectStub(projectRowValues("app", false, "lead"))}}
	rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodPut,
		"/api/v1/orgs/acme/projects/app/retention-policy", `{"private_retention_days":10,"project_retention_days":6}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
}

func TestResourceRetentionPolicyConflictRequiresConfirmation(t *testing.T) {
	deleted := time.Now().UTC().AddDate(0, 0, -20)
	current := deleted.AddDate(0, 0, 30)
	db := &fakeDB{stubs: []stub{
		orgStub("admin"),
		projectStub(projectRowValues("app", false, "lead")),
		{match: "FROM agents", rows: &fakeRows{rows: [][]any{{
			"a1", "Review Bot", "acme", "review-bot", "private", true, deleted, current,
		}}}},
	}}
	rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodPut,
		"/api/v1/orgs/acme/projects/app/retention-policy", `{"private_retention_days":7,"project_retention_days":30}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(strings.Join(db.log, "\n"), "INSERT INTO project_resource_retention_policies") {
		t.Fatalf("conflict write should not apply: %v", db.log)
	}
	if !strings.Contains(rec.Body.String(), "eligible_at_apply") {
		t.Fatalf("conflict response missing impact: %s", rec.Body.String())
	}
}

func TestResourceRetentionPolicyAppliesWhenConfirmed(t *testing.T) {
	deleted := time.Now().UTC().AddDate(0, 0, -20)
	current := deleted.AddDate(0, 0, 30)
	db := &fakeDB{stubs: []stub{
		orgStub("admin"),
		projectStub(projectRowValues("app", false, "lead")),
		{match: "FROM agents", rows: &fakeRows{rows: [][]any{{
			"a1", "Review Bot", "acme", "review-bot", "private", true, deleted, current,
		}}}},
	}}
	rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodPut,
		"/api/v1/orgs/acme/projects/app/retention-policy",
		`{"private_retention_days":7,"project_retention_days":30,"confirm":true,"confirmed_conflict_ids":["a1"]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(strings.Join(db.log, "\n"), "INSERT INTO project_resource_retention_policies") ||
		!strings.Contains(strings.Join(db.log, "\n"), "UPDATE agents") {
		t.Fatalf("policy write/reschedule missing: %v", db.log)
	}
}

func TestResourceRetentionPolicyIncreaseAppliesWithoutConflict(t *testing.T) {
	deleted := time.Now().UTC().AddDate(0, 0, -2)
	current := deleted.AddDate(0, 0, 7)
	db := &fakeDB{stubs: []stub{
		orgStub("admin"),
		projectStub(projectRowValues("app", false, "lead")),
		{match: "FROM agents", rows: &fakeRows{rows: [][]any{{
			"a1", "Review Bot", "acme", "review-bot", "project", false, deleted, current,
		}}}},
	}}
	rec := serveOrgsFull(t, newOrgsHandler(db), http.MethodPut,
		"/api/v1/orgs/acme/projects/app/retention-policy", `{"private_retention_days":30,"project_retention_days":90}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
}
