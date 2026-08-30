// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package dbinit

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/garudex-labs/caracal/internal/clickhouse"
)

func TestQuoteCHIdentifier(t *testing.T) {
	cases := map[string]string{
		"caracal":    "`caracal`",
		"my_db":      "`my_db`",
		"":           "``",
		"a`b":        "`ab`", // embedded backticks are stripped, never escaped
		"`; DROP ``": "`; DROP `",
	}
	for in, want := range cases {
		if got := quoteCHIdentifier(in); got != want {
			t.Errorf("quoteCHIdentifier(%q) = %q, want %q", in, got, want)
		}
	}
}

// chVersionsServer replays a ClickHouse JSON response for the versions query.
func chVersionsServer(t *testing.T, status int, rows []map[string]any) *clickhouse.Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if status != 0 && status != http.StatusOK {
			w.WriteHeader(status)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": rows})
	}))
	t.Cleanup(srv.Close)
	client, err := clickhouse.New(srv.URL, srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func TestAppliedCHVersionsReadsRecordedVersions(t *testing.T) {
	client := chVersionsServer(t, http.StatusOK, []map[string]any{
		{"version": "001"}, {"version": "002"},
		{"version": 3}, // non-string rows are skipped, never panic
	})
	applied, err := appliedCHVersions(context.Background(), client)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(applied, map[string]bool{"001": true, "002": true}) {
		t.Errorf("applied = %v", applied)
	}
}

func TestAppliedCHVersionsEmpty(t *testing.T) {
	client := chVersionsServer(t, http.StatusOK, []map[string]any{})
	applied, err := appliedCHVersions(context.Background(), client)
	if err != nil || len(applied) != 0 {
		t.Errorf("empty ledger: applied=%v err=%v", applied, err)
	}
}

func TestAppliedCHVersionsQueryFailureWraps(t *testing.T) {
	client := chVersionsServer(t, http.StatusInternalServerError, nil)
	_, err := appliedCHVersions(context.Background(), client)
	if err == nil {
		t.Fatal("expected an error on a failed lookup")
	}
	if got := err.Error(); got == "" || !contains(got, "migration lookup") {
		t.Errorf("error not wrapped with context: %q", got)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
