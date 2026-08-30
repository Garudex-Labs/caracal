// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package adminops

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestOverallStatus(t *testing.T) {
	comps := func(statuses ...string) []componentStatus {
		out := make([]componentStatus, len(statuses))
		for i, s := range statuses {
			out[i] = componentStatus{Status: s}
		}
		return out
	}
	cases := []struct {
		name     string
		statuses []string
		want     string
	}{
		{"all healthy", []string{"healthy", "healthy", "healthy"}, "healthy"},
		{"empty", nil, "healthy"},
		{"one degraded", []string{"healthy", "degraded"}, "degraded"},
		{"unknown never healthy", []string{"healthy", "unknown"}, "degraded"},
		{"critical dominates", []string{"degraded", "critical", "healthy"}, "critical"},
		{"unrecognized counts as unknown", []string{"healthy", "bogus"}, "degraded"},
	}
	for _, tc := range cases {
		if got := overallStatus(comps(tc.statuses...)); got != tc.want {
			t.Errorf("%s: overall = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestBuildStatusDocument(t *testing.T) {
	doc := buildStatusDocument([]componentStatus{
		{ID: "database", Status: "healthy"},
		{ID: "identity", Status: "critical"},
		{ID: "runtime_config", Status: "unknown"},
		{ID: "clickhouse", Status: "degraded"},
	}, "1.2.3")
	if doc.Overall != "critical" {
		t.Errorf("overall = %q", doc.Overall)
	}
	if strings.Join(doc.DegradedComponents, ",") != "runtime_config,clickhouse" {
		t.Errorf("degraded = %v", doc.DegradedComponents)
	}
	if strings.Join(doc.FailingComponents, ",") != "identity" {
		t.Errorf("failing = %v", doc.FailingComponents)
	}
	if doc.Version != "1.2.3" || doc.UptimeSeconds < 0 {
		t.Errorf("version/uptime = %q/%d", doc.Version, doc.UptimeSeconds)
	}

	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	body := string(raw)
	if !strings.Contains(body, `"cache_ttl_seconds":5.0`) {
		t.Errorf("cache_ttl_seconds must render with a fraction: %s", body)
	}

	empty, _ := json.Marshal(buildStatusDocument([]componentStatus{{ID: "database", Status: "healthy"}}, "v"))
	if !strings.Contains(string(empty), `"degraded_components":[]`) ||
		!strings.Contains(string(empty), `"failing_components":[]`) {
		t.Errorf("healthy document must carry empty lists: %s", empty)
	}
}

func TestStatusFloatRendering(t *testing.T) {
	cases := map[float64]string{5: "5.0", 12.3: "12.3", 0: "0.0", 1001.5: "1001.5"}
	for in, want := range cases {
		raw, err := json.Marshal(statusFloat(in))
		if err != nil {
			t.Fatal(err)
		}
		if string(raw) != want {
			t.Errorf("statusFloat(%v) = %s, want %s", in, raw, want)
		}
	}
}

func TestComponentWireShape(t *testing.T) {
	latency := statusFloat(3.4)
	raw, err := json.Marshal(componentStatus{
		ID: "database", Name: "PostgreSQL", Purpose: "p",
		Status: "healthy", LatencyMS: &latency,
		Metrics: map[string]any{"users": int64(4)}, CheckedAt: "c",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"id":"database","name":"PostgreSQL","purpose":"p","status":"healthy",` +
		`"latency_ms":3.4,"detail":null,"metrics":{"users":4},"checked_at":"c"}`
	if string(raw) != want {
		t.Errorf("component wire = %s\nwant %s", raw, want)
	}
}

func TestRunCheckTimeout(t *testing.T) {
	meta := probeMeta{id: "runtime_config", name: "Background jobs", purpose: "p", failureStatus: "unknown"}
	timedOut := func(context.Context, probeMeta) (componentStatus, error) {
		return componentStatus{}, context.DeadlineExceeded
	}
	got := runCheck(context.Background(), timedOut, meta)
	if got.Status != "degraded" {
		t.Errorf("unknown-floor timeout status = %q, want degraded", got.Status)
	}
	if got.Detail == nil || *got.Detail != "Health probe timed out after 2.5s" {
		t.Errorf("detail = %v", got.Detail)
	}

	meta.failureStatus = "critical"
	got = runCheck(context.Background(), timedOut, meta)
	if got.Status != "critical" {
		t.Errorf("critical-floor timeout status = %q", got.Status)
	}
	if got.CheckedAt == "" || got.LatencyMS == nil {
		t.Error("timeout result must carry checked_at and latency")
	}
}

func TestRunCheckFailure(t *testing.T) {
	meta := probeMeta{id: "identity", name: "Identity service", purpose: "p", failureStatus: "critical"}
	failing := func(context.Context, probeMeta) (componentStatus, error) {
		return componentStatus{}, probeError{"HTTPStatusError"}
	}
	got := runCheck(context.Background(), failing, meta)
	if got.Status != "critical" {
		t.Errorf("status = %q", got.Status)
	}
	if got.Detail == nil || *got.Detail != "HTTPStatusError during health probe" {
		t.Errorf("detail = %v", got.Detail)
	}
	if len(got.Metrics) != 0 || got.Metrics == nil {
		t.Errorf("metrics = %v, want empty object", got.Metrics)
	}
}

func TestSafeErrorDetail(t *testing.T) {
	if got := safeErrorDetail(&url.Error{Op: "Get", URL: "http://secret-host/creds", Err: errors.New("x")}); got != "url.Error during health probe" {
		t.Errorf("url error detail = %q", got)
	}
	if strings.Contains(safeErrorDetail(errors.New("password=hunter2")), "hunter2") {
		t.Error("error text leaked into the detail line")
	}
}

func TestRunCheckSuccessStampsCheckedAt(t *testing.T) {
	meta := probeMeta{id: "database", failureStatus: "critical"}
	ok := func(context.Context, probeMeta) (componentStatus, error) {
		return componentStatus{ID: "database", Status: "healthy", Metrics: map[string]any{}}, nil
	}
	got := runCheck(context.Background(), ok, meta)
	if got.CheckedAt == "" {
		t.Error("success result missing checked_at")
	}
	if !strings.Contains(got.CheckedAt, "+00:00") {
		t.Errorf("checked_at = %q, want UTC offset form", got.CheckedAt)
	}
}

func TestStatusBoolParam(t *testing.T) {
	parse := func(query string) (bool, bool, int) {
		w := httptest.NewRecorder()
		q, _ := url.ParseQuery(query)
		value, ok := statusBoolParam(w, q, "force")
		return value, ok, w.Code
	}
	if v, ok, _ := parse(""); v || !ok {
		t.Error("absent parameter must default to false")
	}
	if v, ok, _ := parse("force=true"); !v || !ok {
		t.Error("force=true rejected")
	}
	if v, ok, _ := parse("force=0"); v || !ok {
		t.Error("force=0 must parse false")
	}
	if _, ok, code := parse("force=maybe"); ok || code != 422 {
		t.Errorf("garbage bool accepted (code %d)", code)
	}
}
