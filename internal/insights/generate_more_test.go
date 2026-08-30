// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insights

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/garudex-labs/caracal/internal/insightsgen"
)

func TestPreviousApprovedVersionChoosesNewestOlderSemver(t *testing.T) {
	db := &insDB{stubs: []insStub{
		{match: "id::text <>", rows: &insRows{rows: [][]any{
			{"old", "1.2.0"},
			{"newer-than-current", "2.0.0"},
			{"newest-older", "1.4.9"},
			{"malformed", "not-semver"},
		}}},
	}}
	id, version, err := (&Store{DB: db}).previousApprovedVersion(context.Background(), insAgentA, "current", "1.5.0")
	if err != nil {
		t.Fatalf("previousApprovedVersion: %v", err)
	}
	if id != "newest-older" || version != "1.4.9" {
		t.Fatalf("got %s %s, want newest older approved version", id, version)
	}
}

func TestPreviousApprovedVersionNoOlder(t *testing.T) {
	db := &insDB{stubs: []insStub{
		{match: "id::text <>", rows: &insRows{rows: [][]any{{"same", "1.5.0"}, {"newer", "1.6.0"}}}},
	}}
	id, version, err := (&Store{DB: db}).previousApprovedVersion(context.Background(), insAgentA, "current", "1.5.0")
	if err != nil || id != "" || version != "" {
		t.Fatalf("got id=%q version=%q err=%v, want empty", id, version, err)
	}
}

func TestPreviousCompletedReport(t *testing.T) {
	db := &insDB{stubs: []insStub{
		{match: "status = 'completed'", rows: &insRows{rows: [][]any{{insReportID}}}},
	}}
	id, err := (&Store{DB: db}).previousCompletedReport(context.Background(), insAgentA, "1.2.0")
	if err != nil || id != insReportID {
		t.Fatalf("id=%q err=%v", id, err)
	}
}

func TestPreviousCompletedReportMissing(t *testing.T) {
	id, err := (&Store{DB: &insDB{}}).previousCompletedReport(context.Background(), insAgentA, "1.2.0")
	if err != nil || id != "" {
		t.Fatalf("id=%q err=%v, want empty", id, err)
	}
}

func TestCreateReportReturnsQueuedWireRow(t *testing.T) {
	queued := reportRowValues(insAgentA)
	queued[8] = "pending"
	queued[12] = nil
	queued[13] = 0
	db := &insDB{stubs: []insStub{
		{match: "INSERT INTO insight_reports", rows: &insRows{rows: [][]any{queued}}},
	}}
	report, err := (&Store{DB: db}).createReport(context.Background(), reportParams{
		agentID: insAgentA, triggeredBy: insViewerID.String(),
		periodStart: insTime, periodEnd: insTime, now: insTime,
		versionID: "version-id", version: "1.2.0", versionScope: "all",
	})
	if err != nil {
		t.Fatalf("createReport: %v", err)
	}
	if report.Status != "pending" || report.AgentID != insAgentA || report.SessionsAnalyzed != 0 {
		t.Fatalf("report = %+v", report)
	}
}

func TestApplySelectionParsesIndices(t *testing.T) {
	h := &Handler{}
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"config_indices":[0,2],"feature_indices":[1],"pattern_indices":[]}`))
	rec := httptest.NewRecorder()
	selection, ok := h.applySelection(req, rec)
	if !ok {
		t.Fatalf("applySelection rejected valid body: %s", rec.Body.String())
	}
	if selection == nil || len(selection.ConfigIndices) != 2 || selection.FeatureIndices[0] != 1 || selection.PatternIndices == nil {
		t.Fatalf("selection = %+v", selection)
	}
}

func TestApplySelectionEmptyBodyMeansAll(t *testing.T) {
	h := &Handler{}
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	rec := httptest.NewRecorder()
	selection, ok := h.applySelection(req, rec)
	if !ok || selection != nil {
		t.Fatalf("empty body should select all, got selection=%+v ok=%v", selection, ok)
	}
}

func TestApplySelectionRejectsMalformedBody(t *testing.T) {
	h := &Handler{}
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"config_indices":`))
	rec := httptest.NewRecorder()
	selection, ok := h.applySelection(req, rec)
	if ok || selection != nil || rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("selection=%+v ok=%v status=%d body=%s", selection, ok, rec.Code, rec.Body.String())
	}
}

type insightsSettings map[string]bool

func (s insightsSettings) String(_ context.Context, _ string, fallback string) string {
	return fallback
}
func (s insightsSettings) Bool(_ context.Context, key string, fallback bool) bool {
	if value, ok := s[key]; ok {
		return value
	}
	return fallback
}
func (s insightsSettings) Int(_ context.Context, _ string, fallback int) int { return fallback }

func TestSelfLearnEnabledHonorsSetting(t *testing.T) {
	h := &Handler{Config: &insightsgen.Config{Settings: insightsSettings{"insights.self_learn_enabled": false}}}
	rec := httptest.NewRecorder()
	if h.selfLearnEnabled(rec, httptest.NewRequest(http.MethodPost, "/", nil)) {
		t.Fatal("self-learning should be disabled")
	}
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "Self-learning is disabled") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestSelfLearnEnabledDefaultsTrue(t *testing.T) {
	h := &Handler{}
	rec := httptest.NewRecorder()
	if !h.selfLearnEnabled(rec, httptest.NewRequest(http.MethodPost, "/", nil)) {
		t.Fatal("nil config should default to enabled")
	}
}

func TestPreviousApprovedVersionQueryError(t *testing.T) {
	boom := pgx.ErrTxClosed
	db := &insDB{stubs: []insStub{
		{match: "id::text <>", rows: &insRows{err: boom}},
	}}
	_, _, err := (&Store{DB: db}).previousApprovedVersion(context.Background(), insAgentA, "current", "1.5.0")
	if err == nil {
		t.Fatal("expected query scan error")
	}
}
