// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package audit

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/httpapi"
)

func newCLIEvents(t *testing.T, capture *captureServer) (*CLIEvents, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(capture.handler))
	t.Cleanup(server.Close)
	client, err := clickhouse.New("clickhouse://default:pw@"+strings.TrimPrefix(server.URL, "http://")+"/caracal", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	return &CLIEvents{CH: client}, server
}

func postCLIEvent(t *testing.T, h *CLIEvents, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/audit/cli-event", strings.NewReader(body))
	req.Header.Set("User-Agent", "caracal-cli/1.0.0")
	req = req.WithContext(httpapi.ContextWithClaims(req.Context(), auth.Claims{
		UserID: uuid.MustParse("11111111-1111-1111-1111-111111111111"),
		Email:  "cli@example.com",
		Role:   "user",
	}))
	rec := httptest.NewRecorder()
	rec.Header().Set("X-Request-ID", "req-123") // normally set by Middleware
	h.Routes().ServeHTTP(rec, req)
	return rec
}

func TestCLIEventStored(t *testing.T) {
	capture := &captureServer{}
	h, _ := newCLIEvents(t, capture)

	rec := postCLIEvent(t, h, `{"action":"agent.pull","resource_type":"agent","resource_id":"a1","detail":"kiro","sensitivity":"low"}`)
	if rec.Code != http.StatusOK || rec.Body.String() != "{\"status\":\"ok\"}\n" {
		t.Fatalf("response: %d %s", rec.Code, rec.Body.String())
	}
	if len(capture.rows) != 1 {
		t.Fatalf("rows = %d", len(capture.rows))
	}
	row := capture.rows[0]
	checks := map[string]any{
		"action": "agent.pull", "resource_type": "agent", "resource_id": "a1",
		"detail": "kiro", "sensitivity": "low", "source": "cli",
		"actor_id": "11111111-1111-1111-1111-111111111111", "actor_email": "cli@example.com",
		"actor_role": "user", "http_method": "POST", "http_path": "/api/v1/audit/cli-event",
		"outcome": "success", "chain_hash": "", "user_agent": "caracal-cli/1.0.0",
		"request_id": "req-123",
	}
	for key, want := range checks {
		if row[key] != want {
			t.Errorf("%s = %v, want %v", key, row[key], want)
		}
	}
	if row["event_id"] == "" || row["timestamp"] == "" {
		t.Fatalf("defaults not applied: %v", row)
	}
	if _, err := uuid.Parse(row["event_id"].(string)); err != nil {
		t.Fatalf("event_id not generated: %v", row["event_id"])
	}
}

func TestCLIEventClientValuesKept(t *testing.T) {
	capture := &captureServer{}
	h, _ := newCLIEvents(t, capture)

	rec := postCLIEvent(t, h, `{"action":"scan","event_id":"custom-id","timestamp":"2026-05-01 09:00:00.000"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("response: %d", rec.Code)
	}
	row := capture.rows[0]
	if row["event_id"] != "custom-id" || row["timestamp"] != "2026-05-01 09:00:00.000" {
		t.Fatalf("client values overridden: %v", row)
	}
	if row["sensitivity"] != "standard" {
		t.Fatalf("sensitivity default: %v", row["sensitivity"])
	}
}

func TestCLIEventValidation(t *testing.T) {
	capture := &captureServer{}
	h, _ := newCLIEvents(t, capture)

	rec := postCLIEvent(t, h, `{"resource_type":"agent"}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("missing action: %d", rec.Code)
	}
	rec = postCLIEvent(t, h, `not-json`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad body: %d", rec.Code)
	}
	if len(capture.rows) != 0 {
		t.Fatal("invalid events must not be stored")
	}
}
