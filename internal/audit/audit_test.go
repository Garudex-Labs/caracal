// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package audit

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/httpapi"
)

// captureServer stands in for the analytics store and collects inserted rows.
type captureServer struct {
	mu   sync.Mutex
	rows []map[string]any
}

func (c *captureServer) handler(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	// Body is "INSERT ...\nFORMAT JSONEachRow"-style: SQL line then rows.
	scanner := bufio.NewScanner(strings.NewReader(string(body)))
	c.mu.Lock()
	defer c.mu.Unlock()
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "{") {
			continue
		}
		var row map[string]any
		if err := json.Unmarshal([]byte(line), &row); err == nil {
			c.rows = append(c.rows, row)
		}
	}
	w.WriteHeader(http.StatusOK)
}

func newTestLogger(t *testing.T) (*Logger, *captureServer) {
	t.Helper()
	capture := &captureServer{}
	srv := httptest.NewServer(http.HandlerFunc(capture.handler))
	t.Cleanup(srv.Close)
	client, err := clickhouse.New(srv.URL, srv.Client())
	if err != nil {
		t.Fatalf("clickhouse.New: %v", err)
	}
	return NewLogger(client), capture
}

func drain(t *testing.T, l *Logger, capture *captureServer) []map[string]any {
	t.Helper()
	l.Close()
	capture.mu.Lock()
	defer capture.mu.Unlock()
	return capture.rows
}

func TestMiddlewareRecordsAuthenticatedRequest(t *testing.T) {
	logger, capture := newTestLogger(t)
	userID := uuid.New()
	claims := auth.Claims{UserID: userID, Role: "user", Email: "dev@example.com"}

	// Simulate the auth chain placing claims before CaptureActor runs.
	withClaims := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := httpapi.ContextWithClaims(r.Context(), claims)
		CaptureActor(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
		})).ServeHTTP(w, r.WithContext(ctx))
	})

	handler := Middleware(logger, "phi_adjacent", withClaims)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/ingest/session", nil)
	req.Header.Set("User-Agent", "caracal-cli/1.0")
	req.Header.Set("X-Real-IP", "203.0.113.9")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	rows := drain(t, logger, capture)
	if len(rows) != 1 {
		t.Fatalf("expected 1 audit row, got %d", len(rows))
	}
	row := rows[0]
	checks := map[string]any{
		"actor_id":    userID.String(),
		"actor_email": "dev@example.com",
		"actor_role":  "user",
		"action":      "post./api/v1/ingest/session",
		"http_method": "POST",
		"http_path":   "/api/v1/ingest/session",
		"ip_address":  "203.0.113.9",
		"user_agent":  "caracal-cli/1.0",
		"sensitivity": "phi_adjacent",
		"outcome":     "success",
		"source":      "server",
	}
	for key, want := range checks {
		if row[key] != want {
			t.Errorf("%s = %v, want %v", key, row[key], want)
		}
	}
	if row["status_code"] != float64(200) {
		t.Errorf("status_code = %v, want 200", row["status_code"])
	}
	if _, err := uuid.Parse(row["event_id"].(string)); err != nil {
		t.Errorf("event_id is not a uuid: %v", row["event_id"])
	}
	if len(row["chain_hash"].(string)) != 64 {
		t.Errorf("chain_hash length = %d, want 64", len(row["chain_hash"].(string)))
	}
}

func TestMiddlewareRecordsAnonymousDenied(t *testing.T) {
	logger, capture := newTestLogger(t)
	handler := Middleware(logger, "phi_adjacent", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		httpapi.WriteError(w, http.StatusUnauthorized, "Missing credentials")
	}))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/ingest/session", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	rows := drain(t, logger, capture)
	if len(rows) != 1 {
		t.Fatalf("expected 1 audit row, got %d", len(rows))
	}
	row := rows[0]
	if row["actor_id"] != "anonymous" || row["actor_role"] != "anonymous" || row["actor_email"] != "" {
		t.Errorf("anonymous actor not recorded: %v / %v / %v", row["actor_id"], row["actor_role"], row["actor_email"])
	}
	if row["outcome"] != "denied" || row["status_code"] != float64(401) {
		t.Errorf("outcome/status = %v/%v, want denied/401", row["outcome"], row["status_code"])
	}
}

func TestMiddlewareRequestID(t *testing.T) {
	logger, capture := newTestLogger(t)
	handler := Middleware(logger, "standard", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	// Valid incoming id is reused.
	incoming := uuid.NewString()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/ingest/checkpoint", nil)
	req.Header.Set("X-Request-ID", incoming)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if got := rec.Header().Get("X-Request-ID"); got != incoming {
		t.Errorf("response X-Request-ID = %q, want %q", got, incoming)
	}

	// Invalid incoming id is replaced with a fresh uuid.
	req = httptest.NewRequest(http.MethodGet, "/api/v1/ingest/checkpoint", nil)
	req.Header.Set("X-Request-ID", "not-a-uuid\r\ninjection")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	replaced := rec.Header().Get("X-Request-ID")
	if _, err := uuid.Parse(replaced); err != nil {
		t.Errorf("replaced X-Request-ID %q is not a uuid", replaced)
	}

	rows := drain(t, logger, capture)
	if len(rows) != 2 {
		t.Fatalf("expected 2 audit rows, got %d", len(rows))
	}
	if rows[0]["request_id"] != incoming {
		t.Errorf("request_id = %v, want %v", rows[0]["request_id"], incoming)
	}
	if rows[1]["request_id"] != replaced {
		t.Errorf("request_id = %v, want %v", rows[1]["request_id"], replaced)
	}
}

func TestOutcomeMapping(t *testing.T) {
	cases := map[int]string{
		200: "success", 201: "success", 401: "denied", 403: "denied",
		404: "not_found", 409: "client_error", 422: "client_error", 500: "error", 503: "error",
	}
	for status, want := range cases {
		if got := outcomeFor(status); got != want {
			t.Errorf("outcomeFor(%d) = %q, want %q", status, got, want)
		}
	}
}

func TestChainHashLinksRecords(t *testing.T) {
	logger, capture := newTestLogger(t)
	logger.Log(Record{EventID: "a"})
	logger.Log(Record{EventID: "b"})
	rows := drain(t, logger, capture)
	if len(rows) != 2 {
		t.Fatalf("expected 2 rows, got %d", len(rows))
	}
	first := rows[0]["chain_hash"].(string)
	second := rows[1]["chain_hash"].(string)
	if first == second {
		t.Error("chain hashes must differ between records")
	}
	if len(first) != 64 || len(second) != 64 {
		t.Errorf("chain hash lengths = %d, %d, want 64", len(first), len(second))
	}
}

func TestUserAgentTruncated(t *testing.T) {
	logger, capture := newTestLogger(t)
	logger.Log(Record{EventID: "x", UserAgent: strings.Repeat("a", 300)})
	rows := drain(t, logger, capture)
	if len(rows) != 1 {
		t.Fatalf("expected 1 row, got %d", len(rows))
	}
	if got := len(rows[0]["user_agent"].(string)); got != 256 {
		t.Errorf("user_agent length = %d, want 256", got)
	}
}
