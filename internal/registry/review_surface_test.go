// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/httpapi"
)

// serveRegistryReq is serveRegistry with a request body for the write routes.
func serveRegistryReq(t *testing.T, db *fakeDB, method, target, role string, body io.Reader) *httptest.ResponseRecorder {
	t.Helper()
	h := &Handler{Store: &Store{DB: db}}
	mux := http.NewServeMux()
	withClaims := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := httpapi.ContextWithClaims(r.Context(), auth.Claims{
				UserID: uuid.MustParse("22222222-2222-2222-2222-222222222222"),
				Role:   role,
			})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
	h.Register(mux, withClaims)
	req := httptest.NewRequest(method, target, body)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

const reviewListingID = "11111111-1111-1111-1111-111111111111"

// mcpReviewFetchMatch pins findReviewListing's uuid fetch to the mcp family.
const mcpReviewFetchMatch = "FROM mcp_listings l LEFT JOIN mcp_versions v ON l.latest_version_id = v.id WHERE l.id = $1"

func TestReviewQueueDeniesNonReviewers(t *testing.T) {
	db := &fakeDB{}
	rec := serveRegistry(t, db, http.MethodGet, "/api/v1/review", "user")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Insufficient permissions") {
		t.Errorf("detail: %s", rec.Body.String())
	}
	// The denial comes from an empty membership scope, not a guessed role.
	found := false
	for _, sql := range db.log {
		if strings.Contains(sql, "FROM project_memberships") {
			found = true
		}
	}
	if !found {
		t.Error("scope resolution never consulted project memberships")
	}
}

func TestReviewQueueProjectFilterValidation(t *testing.T) {
	rec := serveRegistry(t, &fakeDB{}, http.MethodGet, "/api/v1/review?project_id=not-a-uuid", "operator")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("malformed project_id: status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "uuid_parsing") {
		t.Errorf("detail: %s", rec.Body.String())
	}
}

func TestReviewQueueProjectFilterOutsideScope(t *testing.T) {
	projectA := "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
	projectB := "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
	db := &fakeDB{stubs: []stub{
		{match: "FROM project_memberships", rows: &fakeRows{
			cols: []string{"project_id"},
			rows: [][]any{{projectA}},
		}},
	}}
	rec := serveRegistry(t, db, http.MethodGet, "/api/v1/review?project_id="+projectB, "user")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "You do not review for this project") {
		t.Errorf("detail: %s", rec.Body.String())
	}
}

func TestReviewQueueListsPendingComponentsForAdmin(t *testing.T) {
	submitter := "33333333-3333-3333-3333-333333333333"
	db := &fakeDB{stubs: []stub{
		{match: "FROM mcp_versions WHERE status = 'pending'", rows: &fakeRows{
			cols: []string{"id", "listing_id", "version", "description", "status", "created_at"},
			rows: [][]any{{"99999999-9999-9999-9999-999999999999", reviewListingID,
				"2.0.0", "adds radar", "pending", testNow}},
		}},
		{match: "WHERE l.id = ANY", rows: &fakeRows{
			cols: []string{"id", "name", "description", "owner", "submitted_by",
				"is_private", "project_id", "created_at", "mcp_validated", "bundle_id"},
			rows: [][]any{{reviewListingID, "Weather", "", "acme", submitter,
				false, nil, testNow, true, nil}},
		}},
		{match: "FROM users WHERE id = ANY", rows: &fakeRows{
			cols: []string{"id", "name"},
			rows: [][]any{{submitter, "ryan"}},
		}},
	}}
	rec := serveRegistry(t, db, http.MethodGet, "/api/v1/review?tab=components", "operator")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var items []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &items); err != nil {
		t.Fatalf("body: %v\n%s", err, rec.Body.String())
	}
	if len(items) != 1 {
		t.Fatalf("items = %d: %s", len(items), rec.Body.String())
	}
	item := items[0]
	if item["type"] != "mcp" || item["id"] != reviewListingID || item["name"] != "Weather" {
		t.Errorf("identity fields: %v", item)
	}
	if item["version"] != "2.0.0" || item["status"] != "pending" {
		t.Errorf("the pending version drives version/status: %v", item)
	}
	if item["submitted_by"] != "ryan" {
		t.Errorf("submitted_by = %v, want resolved handle", item["submitted_by"])
	}
	if item["created_at"] != "2026-08-30T08:00:00+00:00" {
		t.Errorf("created_at = %v", item["created_at"])
	}
	if item["mcp_validated"] != true {
		t.Errorf("mcp_validated = %v", item["mcp_validated"])
	}
	if results, ok := item["validation_results"].([]any); !ok || len(results) != 0 {
		t.Errorf("validation_results = %v", item["validation_results"])
	}
	if item["bundle_id"] != nil {
		t.Errorf("bundle_id = %v", item["bundle_id"])
	}
}

func TestReviewQueueListsPendingAgents(t *testing.T) {
	agentID := "44444444-4444-4444-4444-444444444444"
	submitter := "33333333-3333-3333-3333-333333333333"
	db := &fakeDB{stubs: []stub{
		{match: "FROM agent_versions WHERE status = 'pending'", rows: &fakeRows{
			cols: []string{"id", "agent_id", "released_by", "version", "description",
				"status", "created_at", "prompt"},
			rows: [][]any{{"99999999-9999-9999-9999-999999999999", agentID, submitter,
				"1.0.0", "", "pending", testNow, "deploy the app"}},
		}},
		{match: "FROM agents WHERE id = ANY", rows: &fakeRows{
			cols: []string{"id", "name", "description", "owner", "created_by", "is_private", "project_id"},
			rows: [][]any{{agentID, "Deployer", "deploys", "acme", submitter, false, nil}},
		}},
		{match: "FROM users WHERE id = ANY", rows: &fakeRows{
			cols: []string{"id", "name"},
			rows: [][]any{{submitter, "ryan"}},
		}},
	}}
	rec := serveRegistry(t, db, http.MethodGet, "/api/v1/review?tab=agents", "operator")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var items []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &items); err != nil {
		t.Fatalf("body: %v\n%s", err, rec.Body.String())
	}
	if len(items) != 1 {
		t.Fatalf("items = %d: %s", len(items), rec.Body.String())
	}
	item := items[0]
	if item["type"] != "agent" || item["id"] != agentID || item["name"] != "Deployer" {
		t.Errorf("identity fields: %v", item)
	}
	if item["description"] != "deploys" {
		t.Errorf("empty version description falls back to the agent's: %v", item["description"])
	}
	if item["submitted_by"] != "ryan" || item["prompt"] != "deploy the app" {
		t.Errorf("submission fields: %v", item)
	}
	if item["component_count"] != float64(0) || item["components_ready"] != true {
		t.Errorf("component readiness: %v", item)
	}
	if blockers, ok := item["blocking_components"].([]any); !ok || len(blockers) != 0 {
		t.Errorf("blocking_components = %v", item["blocking_components"])
	}
}

func TestReviewApproveDeniedForNonReviewer(t *testing.T) {
	rec := serveRegistry(t, &fakeDB{}, http.MethodPost,
		"/api/v1/review/"+reviewListingID+"/approve", "user")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Insufficient permissions") {
		t.Errorf("detail: %s", rec.Body.String())
	}
}

func TestReviewApproveUnknownListing404(t *testing.T) {
	rec := serveRegistry(t, &fakeDB{}, http.MethodPost,
		"/api/v1/review/"+reviewListingID+"/approve", "operator")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Listing not found") {
		t.Errorf("detail: %s", rec.Body.String())
	}
}

func TestReviewRejectRequiresBody(t *testing.T) {
	db := &fakeDB{}
	rec := serveRegistry(t, db, http.MethodPost,
		"/api/v1/review/"+reviewListingID+"/reject", "operator")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Field required") {
		t.Errorf("detail: %s", rec.Body.String())
	}
	if len(db.log) != 0 {
		t.Errorf("body validation must precede storage: %v", db.log)
	}
}

func TestReviewDetailHidesPrivateItemOutsideScope(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: mcpReviewFetchMatch, rows: &fakeRows{
			cols: []string{"id", "name", "is_private", "project_id"},
			rows: [][]any{{reviewListingID, "Secret", true, "55555555-5555-5555-5555-555555555555"}},
		}},
	}}
	// A global reviewer holds no team scope, so team-private items 404.
	rec := serveRegistry(t, db, http.MethodGet, "/api/v1/review/"+reviewListingID, "reviewer")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "Secret") {
		t.Errorf("hidden item leaked its name: %s", rec.Body.String())
	}
}

func TestReviewApprovePublicItemOutsideScope403(t *testing.T) {
	teamA := "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
	db := &fakeDB{stubs: []stub{
		{match: "FROM project_memberships", rows: &fakeRows{
			cols: []string{"project_id"},
			rows: [][]any{{teamA}},
		}},
		{match: mcpReviewFetchMatch, rows: &fakeRows{
			cols: []string{"id", "name", "is_private", "project_id"},
			rows: [][]any{{reviewListingID, "Weather", false, nil}},
		}},
	}}
	rec := serveRegistry(t, db, http.MethodPost,
		"/api/v1/review/"+reviewListingID+"/approve", "user")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Public item is outside your review scope") {
		t.Errorf("detail: %s", rec.Body.String())
	}
}

func TestReviewApproveConflictsWhileOwnerEditing(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: mcpReviewFetchMatch, rows: &fakeRows{
			cols: []string{"id", "name", "is_private", "project_id"},
			rows: [][]any{{reviewListingID, "Weather", false, nil}},
		}},
		{match: "WHERE listing_id = $1 AND status = 'pending'", rows: &fakeRows{
			cols: []string{"id", "listing_id", "version", "is_editing", "editing_by", "editing_since"},
			rows: [][]any{{"99999999-9999-9999-9999-999999999999", reviewListingID,
				"2.0.0", true, "44444444-4444-4444-4444-444444444444", time.Now()}},
		}},
	}}
	rec := serveRegistry(t, db, http.MethodPost,
		"/api/v1/review/"+reviewListingID+"/approve", "operator")
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "currently editing") {
		t.Errorf("detail: %s", rec.Body.String())
	}
}

func TestReviewApproveTransactionFailureIs500(t *testing.T) {
	db := &fakeDB{stubs: []stub{
		{match: mcpReviewFetchMatch, rows: &fakeRows{
			cols: []string{"id", "name", "is_private", "project_id"},
			rows: [][]any{{reviewListingID, "Weather", false, nil}},
		}},
		{match: "WHERE listing_id = $1 AND status = 'pending'", rows: &fakeRows{
			cols: []string{"id", "listing_id", "version"},
			rows: [][]any{{"99999999-9999-9999-9999-999999999999", reviewListingID, "2.0.0"}},
		}},
	}}
	rec := serveRegistry(t, db, http.MethodPost,
		"/api/v1/review/"+reviewListingID+"/approve", "operator")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "transactions not supported") {
		t.Errorf("internal error detail leaked: %s", rec.Body.String())
	}
}
