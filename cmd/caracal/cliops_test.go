// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
)

const insightAgentID = "3f8f3f61-3b19-4b6c-a6a1-24dfb8a7c001"

func TestOpsInsightsListResolvesAgentAndRendersRows(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"GET /api/v1/agents/" + insightAgentID:                       {body: `{"id": "` + insightAgentID + `", "name": "helper"}`},
		"GET /api/v1/agents/" + insightAgentID + "/insights/reports": {body: `[{"id": "r-111", "status": "completed", "period_days": 14}]`},
	})
	recEnv(t, rec)
	out, err := captureCLI(t, "ops", "insights", "list", insightAgentID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, `"id":"r-111"`) || !strings.Contains(out, `"status":"completed"`) {
		t.Errorf("report row missing:\n%s", out)
	}
	if _, ok := rec.find("GET", "/api/v1/agents/"+insightAgentID+"/insights/reports"); !ok {
		t.Errorf("reports endpoint not called: %v", rec.lines())
	}
}

func TestOpsInsightsShowLatestSkipsQueuedReports(t *testing.T) {
	srv := fakeAPI(t, map[string]apiResponse{
		"GET /api/v1/agents/" + insightAgentID: {body: `{"id": "` + insightAgentID + `"}`},
		"GET /api/v1/agents/" + insightAgentID + "/insights/reports": {
			body: `[{"id": "r-222", "status": "queued"}, {"id": "r-111", "status": "completed"}]`},
		"GET /api/v1/agents/" + insightAgentID + "/insights/reports/r-111": {
			body: `{"id": "r-111", "status": "completed", "narrative": {"summary": "all good"}}`},
	})
	out, err := runCLI(t, srv, "ops", "insights", "show", insightAgentID, "latest", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		ID string `json:"id"`
	}
	if json.Unmarshal([]byte(out), &doc) != nil || doc.ID != "r-111" {
		t.Errorf("latest must resolve to the completed report:\n%s", out)
	}
}

func TestOpsInsightsShowSectionExtractsNarrative(t *testing.T) {
	srv := fakeAPI(t, map[string]apiResponse{
		"GET /api/v1/agents/" + insightAgentID:                       {body: `{"id": "` + insightAgentID + `"}`},
		"GET /api/v1/agents/" + insightAgentID + "/insights/reports": {body: `[{"id": "r-111", "status": "completed"}]`},
		"GET /api/v1/agents/" + insightAgentID + "/insights/reports/r-111": {
			body: `{"id": "r-111", "narrative": {"summary": "all good", "regressions": []}}`},
	})
	out, err := runCLI(t, srv, "ops", "insights", "show", insightAgentID, "--section", "summary", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		ReportID string `json:"report_id"`
		Section  string `json:"section"`
		Data     string `json:"data"`
	}
	if json.Unmarshal([]byte(out), &doc) != nil || doc.Section != "summary" || doc.Data != "all good" {
		t.Errorf("section extraction: %+v\n%s", doc, out)
	}
}

func TestOpsInsightsShowUnknownSectionListsChoices(t *testing.T) {
	srv := fakeAPI(t, map[string]apiResponse{
		"GET /api/v1/agents/" + insightAgentID:                       {body: `{"id": "` + insightAgentID + `"}`},
		"GET /api/v1/agents/" + insightAgentID + "/insights/reports": {body: `[{"id": "r-111", "status": "completed"}]`},
		"GET /api/v1/agents/" + insightAgentID + "/insights/reports/r-111": {
			body: `{"id": "r-111", "narrative": {"summary": "s", "regressions": []}}`},
	})
	_, err := runCLI(t, srv, "ops", "insights", "show", insightAgentID, "--section", "vibes")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation {
		t.Errorf("category = %s", cerr.Category)
	}
	if !strings.Contains(cerr.Remediation, "summary") || !strings.Contains(cerr.Remediation, "regressions") {
		t.Errorf("remediation must list sections: %s", cerr.Remediation)
	}
}

func TestOpsInsightsShowNoReportsIsNotFound(t *testing.T) {
	srv := fakeAPI(t, map[string]apiResponse{
		"GET /api/v1/agents/" + insightAgentID:                       {body: `{"id": "` + insightAgentID + `"}`},
		"GET /api/v1/agents/" + insightAgentID + "/insights/reports": {body: `[]`},
	})
	_, err := runCLI(t, srv, "ops", "insights", "show", insightAgentID)
	if asCLIError(t, err).Category != clierr.NotFound {
		t.Errorf("category = %s", asCLIError(t, err).Category)
	}
}

func TestOpsInsightsShowRowOutOfRange(t *testing.T) {
	srv := fakeAPI(t, map[string]apiResponse{
		"GET /api/v1/agents/" + insightAgentID:                       {body: `{"id": "` + insightAgentID + `"}`},
		"GET /api/v1/agents/" + insightAgentID + "/insights/reports": {body: `[{"id": "r-111", "status": "completed"}]`},
	})
	_, err := runCLI(t, srv, "ops", "insights", "show", insightAgentID, "5")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation || !strings.Contains(cerr.Message, "out of range") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
}

func TestOpsInsightsShowAmbiguousPrefixIsConflict(t *testing.T) {
	srv := fakeAPI(t, map[string]apiResponse{
		"GET /api/v1/agents/" + insightAgentID: {body: `{"id": "` + insightAgentID + `"}`},
		"GET /api/v1/agents/" + insightAgentID + "/insights/reports": {
			body: `[{"id": "r-111", "status": "completed"}, {"id": "r-112", "status": "completed"}]`},
	})
	_, err := runCLI(t, srv, "ops", "insights", "show", insightAgentID, "r-11")
	if asCLIError(t, err).Category != clierr.Conflict {
		t.Errorf("category = %s", asCLIError(t, err).Category)
	}
}

func TestOpsInsightsGeneratePostsPeriodAndVersions(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"GET /api/v1/insights/status":                                 {body: `{"available": true}`},
		"GET /api/v1/agents/" + insightAgentID:                        {body: `{"id": "` + insightAgentID + `"}`},
		"POST /api/v1/agents/" + insightAgentID + "/insights/reports": {status: 202, body: `{"id": "r-333", "status": "queued"}`},
	})
	recEnv(t, rec)
	out, err := captureCLI(t, "ops", "insights", "generate", insightAgentID,
		"--period", "7", "--version", "1.2.0", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	post, ok := rec.find("POST", "/api/v1/agents/"+insightAgentID+"/insights/reports")
	if !ok {
		t.Fatalf("generate never posted: %v", rec.lines())
	}
	var body struct {
		PeriodDays   int    `json:"period_days"`
		AgentVersion string `json:"agent_version"`
	}
	if json.Unmarshal([]byte(post.Body), &body) != nil || body.PeriodDays != 7 || body.AgentVersion != "1.2.0" {
		t.Errorf("POST body = %s", post.Body)
	}
	if !strings.Contains(out, `"status": "queued"`) {
		t.Errorf("queued report must pass through:\n%s", out)
	}
}

func TestOpsInsightsGenerateChecksStatusFirst(t *testing.T) {
	srv := fakeAPI(t, map[string]apiResponse{
		"GET /api/v1/insights/status": {body: `{"available": false, "reason": "no api key"}`},
	})
	_, err := runCLI(t, srv, "ops", "insights", "generate", insightAgentID)
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Unavailable || !strings.Contains(cerr.Message, "no api key") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
}

func TestOpsInsightsGenerateRejectsBadPeriodLocally(t *testing.T) {
	_, err := runCLI(t, nil, "ops", "insights", "generate", insightAgentID, "--period", "0")
	if asCLIError(t, err).Category != clierr.Usage {
		t.Errorf("category = %s", asCLIError(t, err).Category)
	}
}

func TestOpsInsightsGenerateRejectsBadVersionLocally(t *testing.T) {
	_, err := runCLI(t, nil, "ops", "insights", "generate", insightAgentID, "--version", "not-a-version")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation || !strings.Contains(cerr.Message, "not-a-version") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
}

func TestOpsLogsLocalTailFiltersByLevel(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	seedFile(t, filepath.Join(home, ".caracal", "logs", "dev.log"),
		"2026-08-30 10:00:00 | INFO | boot ok\n"+
			"2026-08-30 10:00:01 | ERROR | db down\n"+
			"2026-08-30 10:00:02 | DEBUG | noisy detail\n")
	out, err := captureCLI(t, "ops", "logs", "--no-follow", "--level", "ERROR", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, `"level":"ERROR"`) || !strings.Contains(out, "db down") {
		t.Errorf("error line missing:\n%s", out)
	}
	if strings.Contains(out, "boot ok") || strings.Contains(out, "noisy detail") {
		t.Errorf("lower levels must be filtered:\n%s", out)
	}
}

func TestOpsLogsLocalTextFilter(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	seedFile(t, filepath.Join(home, ".caracal", "logs", "dev.log"),
		"2026-08-30 10:00:00 | INFO | boot ok\n2026-08-30 10:00:01 | INFO | cache warm\n")
	out, err := captureCLI(t, "ops", "logs", "--no-follow", "--filter", "cache", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "cache warm") || strings.Contains(out, "boot ok") {
		t.Errorf("filter must keep only matching lines:\n%s", out)
	}
}

func TestOpsLogsMissingFileIsNotFound(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	_, err := captureCLI(t, "ops", "logs", "--no-follow")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.NotFound {
		t.Errorf("category = %s", cerr.Category)
	}
	if !strings.Contains(cerr.Remediation, "--remote") {
		t.Errorf("remediation must point at --remote: %s", cerr.Remediation)
	}
}

func TestOpsLogsRejectsUnknownLevelLocally(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	_, err := captureCLI(t, "ops", "logs", "--level", "LOUD")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation || !strings.Contains(cerr.Message, "LOUD") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
}

func TestOpsLogsRemoteRecentRendersEntries(t *testing.T) {
	rec := newRecordingAPI(t, map[string]apiResponse{
		"GET /api/v1/operator/logs": {body: `{"entries": [{"timestamp": "2026-08-30T10:00:00.000Z", "level": "INFO", "logger_name": "boot", "function": "main", "line": 1, "event": "started"}]}`},
	})
	recEnv(t, rec)
	out, err := captureCLI(t, "ops", "logs", "--remote", "--no-follow", "--lines", "5", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, `"source":"remote"`) || !strings.Contains(out, `"event":"started"`) {
		t.Errorf("remote entry missing:\n%s", out)
	}
	req, ok := rec.find("GET", "/api/v1/operator/logs")
	if !ok || !strings.Contains(req.Query, "limit=5") {
		t.Errorf("limit must be forwarded: %+v", req)
	}
}
