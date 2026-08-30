// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package clickhouse

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMaintainerCycle(t *testing.T) {
	var statements []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		statements = append(statements, string(body))
		if strings.Contains(string(body), "system.parts") {
			_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{
				{"table": "session_events", "parts": "412", "total_rows": "9"},
				{"table": "session_stats_agg", "parts": float64(3), "total_rows": float64(9)},
			}})
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client, err := New(server.URL, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	m := &Maintainer{Client: client}
	m.Cycle(context.Background())

	joined := strings.Join(statements, "\n")
	for _, want := range []string{"OPTIMIZE TABLE session_events", "OPTIMIZE TABLE session_stats_agg", "system.parts"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing statement %q in %s", want, joined)
		}
	}
	if len(statements) != 3 {
		t.Fatalf("statements = %d", len(statements))
	}
}

func TestAsIntQuotedCounts(t *testing.T) {
	if asInt("412") != 412 || asInt(float64(7)) != 7 || asInt(nil) != 0 || asInt("x2") != 0 {
		t.Fatal("asInt conversions wrong")
	}
}
