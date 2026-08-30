// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package clickhouse

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type capturedRequest struct {
	query  map[string]string
	header http.Header
	body   string
}

func capture(t *testing.T, status int, respond string) (*Client, *[]capturedRequest) {
	t.Helper()
	var seen []capturedRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		query := map[string]string{}
		for k, v := range r.URL.Query() {
			query[k] = v[0]
		}
		seen = append(seen, capturedRequest{query: query, header: r.Header.Clone(), body: string(body)})
		w.WriteHeader(status)
		_, _ = w.Write([]byte(respond))
	}))
	t.Cleanup(srv.Close)

	client, err := New(strings.Replace(srv.URL, "http://", "clickhouse://writer:pw@", 1)+"/caracal", srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	return client, &seen
}

func TestNewParsesURL(t *testing.T) {
	client, err := New("clickhouse://user:secret@ch.internal:9000/telemetry", nil)
	if err != nil {
		t.Fatal(err)
	}
	if client.endpoint != "http://ch.internal:9000" || client.database != "telemetry" ||
		client.username != "user" || client.password != "secret" {
		t.Errorf("parsed = %+v", client)
	}

	defaults, err := New("clickhouse://localhost", nil)
	if err != nil {
		t.Fatal(err)
	}
	if defaults.endpoint != "http://localhost:8123" || defaults.database != "default" || defaults.username != "default" {
		t.Errorf("defaults = %+v", defaults)
	}

	if _, err := New("clickhouse://", nil); err == nil {
		t.Error("hostless URL must be rejected")
	}
}

func TestExecSendsCredentialsAndSettings(t *testing.T) {
	client, seen := capture(t, http.StatusOK, "")
	err := client.Exec(context.Background(), "SELECT 1", Settings{"param_x": "y"})
	if err != nil {
		t.Fatal(err)
	}
	req := (*seen)[0]
	for key, want := range map[string]string{
		"database": "caracal", "max_execution_time": "300", "param_x": "y",
	} {
		if req.query[key] != want {
			t.Errorf("query[%s] = %q, want %q", key, req.query[key], want)
		}
	}
	// Credentials must travel as headers, never in the URL.
	if got := req.header.Get("X-ClickHouse-User"); got != "writer" {
		t.Errorf("X-ClickHouse-User = %q, want %q", got, "writer")
	}
	if got := req.header.Get("X-ClickHouse-Key"); got != "pw" {
		t.Errorf("X-ClickHouse-Key = %q, want %q", got, "pw")
	}
	if _, ok := req.query["password"]; ok {
		t.Error("password must not appear in the URL query")
	}
	if req.body != "SELECT 1" {
		t.Errorf("body = %q", req.body)
	}
}

func TestInsertJSONEachRowAppendsRows(t *testing.T) {
	client, seen := capture(t, http.StatusOK, "")
	rows := []any{map[string]any{"a": 1}, map[string]any{"b": "x"}}
	if err := client.InsertJSONEachRow(context.Background(), "INSERT INTO t FORMAT JSONEachRow", rows); err != nil {
		t.Fatal(err)
	}
	req := (*seen)[0]
	want := "INSERT INTO t FORMAT JSONEachRow\n{\"a\":1}\n{\"b\":\"x\"}\n"
	if req.body != want {
		t.Errorf("body = %q, want %q", req.body, want)
	}
	if req.query["wait_for_async_insert"] != "1" {
		t.Error("inserts must wait for durability")
	}
}

func TestQueryOverridesApplyToEveryStatement(t *testing.T) {
	client, seen := capture(t, http.StatusOK, "")
	client.SetQueryOverrides(map[string]string{"max_memory_usage": "512000000"})
	if err := client.Exec(context.Background(), "SELECT 1", nil); err != nil {
		t.Fatal(err)
	}
	if (*seen)[0].query["max_memory_usage"] != "512000000" {
		t.Errorf("override missing: %v", (*seen)[0].query)
	}
	// Per-call settings still win over overrides.
	if err := client.Exec(context.Background(), "SELECT 1", Settings{"max_memory_usage": "1"}); err != nil {
		t.Fatal(err)
	}
	if (*seen)[1].query["max_memory_usage"] != "1" {
		t.Errorf("per-call setting overridden: %v", (*seen)[1].query)
	}
	// Re-applying replaces the previous set wholesale.
	client.SetQueryOverrides(map[string]string{"max_bytes_in_join": "2000000"})
	if err := client.Exec(context.Background(), "SELECT 1", nil); err != nil {
		t.Fatal(err)
	}
	if q := (*seen)[2].query; q["max_bytes_in_join"] != "2000000" || q["max_memory_usage"] != "" {
		t.Errorf("stale override survived: %v", q)
	}
}

func TestInsertJSONEachRowNoRowsIsNoOp(t *testing.T) {
	client, seen := capture(t, http.StatusOK, "")
	if err := client.InsertJSONEachRow(context.Background(), "INSERT", nil); err != nil {
		t.Fatal(err)
	}
	if len(*seen) != 0 {
		t.Error("empty insert must not touch the server")
	}
}

func TestQueryJSONParsesData(t *testing.T) {
	client, _ := capture(t, http.StatusOK, `{"data":[{"n":"1"},{"n":"2"}]}`)
	rows, err := client.QueryJSON(context.Background(), "SELECT n FROM t FORMAT JSON", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0]["n"] != "1" {
		t.Errorf("rows = %v", rows)
	}
}

func TestErrorStatusSurfacesBodyPreview(t *testing.T) {
	client, _ := capture(t, http.StatusBadRequest, "Code: 62. DB::Exception: syntax error")
	err := client.Exec(context.Background(), "SELEC", nil)
	if err == nil || !strings.Contains(err.Error(), "syntax error") {
		t.Errorf("err = %v", err)
	}
}

func TestConnectionFailureRetriesThenFails(t *testing.T) {
	// A closed port fails at connect time; all three attempts must burn.
	client, err := New("clickhouse://127.0.0.1:1", &http.Client{Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	client.retryWait = func(int) time.Duration { return time.Millisecond }

	start := time.Now()
	execErr := client.Exec(context.Background(), "SELECT 1", nil)
	if execErr == nil {
		t.Fatal("expected connection failure")
	}
	if !strings.Contains(execErr.Error(), "3 attempts") {
		t.Errorf("err = %v", execErr)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("retries took %v", elapsed)
	}
}

func TestRetryHonorsContextCancellation(t *testing.T) {
	client, err := New("clickhouse://127.0.0.1:1", &http.Client{Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	client.retryWait = func(int) time.Duration { return time.Hour }

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()
	if err := client.Exec(ctx, "SELECT 1", nil); err == nil || !strings.Contains(err.Error(), "context canceled") {
		t.Errorf("err = %v, want context cancellation", err)
	}
}
