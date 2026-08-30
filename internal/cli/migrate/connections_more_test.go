// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package migrate

import (
	"encoding/json"
	"testing"
)

func TestParseClickHouseURLIPv6(t *testing.T) {
	cases := []struct {
		raw     string
		httpURL string
		db      string
	}{
		{"clickhouse://[::1]:9000/db", "http://::1:9000", "db"},
		{"clickhouses://[2001:db8::1]/db", "https://2001:db8::1:8443", "db"},
	}
	for _, tc := range cases {
		httpURL, db, _, _, err := ParseClickHouseURL(tc.raw)
		if err != nil {
			t.Fatalf("ParseClickHouseURL(%q): %v", tc.raw, err)
		}
		if httpURL != tc.httpURL || db != tc.db {
			t.Fatalf("ParseClickHouseURL(%q) = (%q, %q), want (%q, %q)",
				tc.raw, httpURL, db, tc.httpURL, tc.db)
		}
	}
}

func TestStripDialect(t *testing.T) {
	cases := map[string]string{
		"postgresql+asyncpg://u:p@h/db": "postgresql://u:p@h/db",
		"postgresql+psycopg://h/db":     "postgresql://h/db",
		"postgres://h/db":               "postgres://h/db",
		"postgresql+asyncpg":            "postgresql+asyncpg", // no scheme separator: unchanged
	}
	for in, want := range cases {
		if got := stripDialect(in); got != want {
			t.Fatalf("stripDialect(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestResolveCH(t *testing.T) {
	conn, err := resolveCH("clickhouse://u:p@host:9000/tele")
	if err != nil {
		t.Fatalf("resolveCH: %v", err)
	}
	if conn.httpURL != "http://host:9000" || conn.db != "tele" || conn.user != "u" || conn.password != "p" {
		t.Fatalf("resolveCH = %+v", conn)
	}
	if _, err := resolveCH("clickhouse://"); err == nil {
		t.Fatal("resolveCH must reject a hostless URL")
	}
}

func TestChConnQueryURL(t *testing.T) {
	c := chConn{httpURL: "http://h:8123", db: "caracal"}
	if got := c.queryURL(nil); got != "http://h:8123/?database=caracal" {
		t.Fatalf("queryURL(nil) = %s", got)
	}
	if got := c.queryURL(map[string]string{"param_x": "1"}); got !=
		"http://h:8123/?database=caracal&param_x=1" {
		t.Fatalf("queryURL(extra) = %s", got)
	}
	// An explicit database override in extra wins over the connection default.
	if got := c.queryURL(map[string]string{"database": "other"}); got !=
		"http://h:8123/?database=other" {
		t.Fatalf("queryURL(override) = %s", got)
	}
}

func TestChHTTPClient(t *testing.T) {
	c := chHTTPClient()
	if c == nil || c.Transport == nil {
		t.Fatal("chHTTPClient must return a configured client")
	}
}

func TestProgressFuncUpdate(t *testing.T) {
	calls := 0
	var phase, msg string
	var pct int
	var pf ProgressFunc = func(p string, c int, m string) {
		calls++
		phase, pct, msg = p, c, m
	}
	pf.update("pg_export", 42, "working")
	if calls != 1 || phase != "pg_export" || pct != 42 || msg != "working" {
		t.Fatalf("update forwarded %d call(s): %s/%d/%s", calls, phase, pct, msg)
	}
	// A nil ProgressFunc is a silent no-op.
	var nilPF ProgressFunc
	nilPF.update("x", 1, "y")
}

func TestReadCount(t *testing.T) {
	cases := []struct {
		name string
		resp *chResponse
		want int64
	}{
		{"quoted int", &chResponse{Data: []map[string]any{{"cnt": "42"}}}, 42},
		{"json number", &chResponse{Data: []map[string]any{{"cnt": json.Number("7")}}}, 7},
		{"empty", &chResponse{}, 0},
		{"wrong type", &chResponse{Data: []map[string]any{{"cnt": true}}}, 0},
		{"non-numeric string", &chResponse{Data: []map[string]any{{"cnt": "abc"}}}, 0},
		{"missing key", &chResponse{Data: []map[string]any{{"other": "1"}}}, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := readCount(tc.resp); got != tc.want {
				t.Fatalf("readCount = %d, want %d", got, tc.want)
			}
		})
	}
}
