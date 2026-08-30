// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package migrate

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeTransport turns the ClickHouse HTTP helpers hermetic: RoundTrip is a
// plain in-memory function call, so no socket is ever opened.
type fakeTransport struct {
	fn func(*http.Request) (*http.Response, error)
}

func (f fakeTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f.fn(r) }

func fakeClient(fn func(*http.Request) (*http.Response, error)) *http.Client {
	return &http.Client{Transport: fakeTransport{fn: fn}}
}

func httpResp(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     make(http.Header),
	}
}

func testConn() chConn {
	return chConn{httpURL: "http://ch.test", db: "caracal", user: "u", password: "p"}
}

func TestChExec(t *testing.T) {
	ctx := context.Background()
	conn := testConn()

	// Success path also asserts the request shape.
	client := fakeClient(func(r *http.Request) (*http.Response, error) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		if user, pass, ok := r.BasicAuth(); !ok || user != "u" || pass != "p" {
			t.Errorf("basic auth = %s/%s/%v", user, pass, ok)
		}
		if !strings.Contains(r.URL.RawQuery, "database=caracal") {
			t.Errorf("query missing database: %s", r.URL.RawQuery)
		}
		return httpResp(200, "OK"), nil
	})
	body, err := chExec(ctx, client, conn, "SELECT 1", nil)
	if err != nil || string(body) != "OK" {
		t.Fatalf("chExec success = %q, %v", body, err)
	}

	// Non-2xx surfaces the status and (truncated) body.
	errClient := fakeClient(func(*http.Request) (*http.Response, error) {
		return httpResp(500, strings.Repeat("x", 600)), nil
	})
	if _, err := chExec(ctx, errClient, conn, "SELECT 1", nil); err == nil ||
		!strings.Contains(AsError(err).Message, "HTTP 500") {
		t.Fatalf("chExec non-2xx error = %v", err)
	}

	// Transport failure maps to a connection error.
	downClient := fakeClient(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("dial refused")
	})
	if _, err := chExec(ctx, downClient, conn, "SELECT 1", nil); err == nil ||
		!strings.Contains(AsError(err).Message, "unreachable") {
		t.Fatalf("chExec transport error = %v", err)
	}
}

func TestChQueryJSON(t *testing.T) {
	ctx := context.Background()
	conn := testConn()

	client := fakeClient(func(*http.Request) (*http.Response, error) {
		return httpResp(200, `{"data":[{"name":"users"}]}`), nil
	})
	resp, err := chQueryJSON(ctx, client, conn, "SELECT 1", nil)
	if err != nil {
		t.Fatalf("chQueryJSON: %v", err)
	}
	if len(resp.Data) != 1 || resp.Data[0]["name"] != "users" {
		t.Fatalf("chQueryJSON data = %v", resp.Data)
	}

	bad := fakeClient(func(*http.Request) (*http.Response, error) {
		return httpResp(200, "not json"), nil
	})
	if _, err := chQueryJSON(ctx, bad, conn, "SELECT 1", nil); err == nil {
		t.Fatal("unparseable response must error")
	}
}

func TestChExistingTablesAndHealth(t *testing.T) {
	ctx := context.Background()
	conn := testConn()

	client := fakeClient(func(*http.Request) (*http.Response, error) {
		return httpResp(200, `{"data":[{"name":"t1"},{"name":"t2"}]}`), nil
	})
	existing, err := chExistingTables(ctx, client, conn)
	if err != nil {
		t.Fatalf("chExistingTables: %v", err)
	}
	if len(existing) != 2 || !existing["t1"] || !existing["t2"] {
		t.Fatalf("existing = %v", existing)
	}

	ok := fakeClient(func(*http.Request) (*http.Response, error) { return httpResp(200, "1"), nil })
	if err := chHealthCheck(ctx, ok, conn); err != nil {
		t.Fatalf("healthy check errored: %v", err)
	}
	down := fakeClient(func(*http.Request) (*http.Response, error) { return httpResp(500, "no"), nil })
	if err := chHealthCheck(ctx, down, conn); err == nil {
		t.Fatal("unhealthy check must error")
	}
}

func TestChStream(t *testing.T) {
	ctx := context.Background()
	conn := testConn()
	dir := t.TempDir()

	dest := filepath.Join(dir, "out.parquet")
	client := fakeClient(func(*http.Request) (*http.Response, error) {
		return httpResp(200, "PARQUETDATA"), nil
	})
	if err := chStream(ctx, client, conn, "SELECT 1", nil, dest); err != nil {
		t.Fatalf("chStream: %v", err)
	}
	raw, err := os.ReadFile(dest)
	if err != nil || string(raw) != "PARQUETDATA" {
		t.Fatalf("streamed file = %q, %v", raw, err)
	}

	failDest := filepath.Join(dir, "fail.parquet")
	errClient := fakeClient(func(*http.Request) (*http.Response, error) {
		return httpResp(500, "boom"), nil
	})
	if err := chStream(ctx, errClient, conn, "SELECT 1", nil, failDest); err == nil {
		t.Fatal("chStream non-2xx must error")
	}
	if _, err := os.Stat(failDest); err == nil {
		t.Fatal("no file should be written on a failed stream")
	}
}

func TestChImportFile(t *testing.T) {
	ctx := context.Background()
	conn := testConn()
	dir := t.TempDir()

	parquet := filepath.Join(dir, "part.parquet")
	if err := os.WriteFile(parquet, []byte("PAR1DATA"), 0o644); err != nil {
		t.Fatal(err)
	}
	client := fakeClient(func(*http.Request) (*http.Response, error) {
		return httpResp(200, ""), nil
	})
	if err := chImportFile(ctx, client, conn, "INSERT INTO t FORMAT Parquet", parquet); err != nil {
		t.Fatalf("chImportFile: %v", err)
	}

	errClient := fakeClient(func(*http.Request) (*http.Response, error) {
		return httpResp(500, "boom"), nil
	})
	if err := chImportFile(ctx, errClient, conn, "INSERT INTO t FORMAT Parquet", parquet); err == nil {
		t.Fatal("chImportFile non-2xx must error")
	}
	if err := chImportFile(ctx, client, conn, "INSERT", filepath.Join(dir, "missing.parquet")); err == nil {
		t.Fatal("a missing parquet file must error")
	}
}

func TestChTableSchema(t *testing.T) {
	ctx := context.Background()
	conn := testConn()

	client := fakeClient(func(*http.Request) (*http.Response, error) {
		return httpResp(200,
			`{"data":[{"name":"id","type":"UUID"},{"name":"","type":"skip"},{"name":"ts","type":"DateTime"}]}`), nil
	})
	schema, err := chTableSchema(ctx, client, conn, "session_events")
	if err != nil {
		t.Fatalf("chTableSchema: %v", err)
	}
	if len(schema) != 2 || schema[0] != [2]string{"id", "UUID"} || schema[1] != [2]string{"ts", "DateTime"} {
		t.Fatalf("schema = %v (rows with empty name/type must be skipped)", schema)
	}
}
