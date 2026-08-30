// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package traceview

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/garudex-labs/caracal/internal/harness"
)

// goldenHarnesses maps fixture directories to harness names.
var goldenHarnesses = map[string]string{
	"antigravity":      "antigravity",
	"antigravity_edge": "antigravity",
	"claude_code":      "claude-code",
	"claude_code_edge": "claude-code",
	"codex":            "codex",
	"codex_edge":       "codex",
	"copilot_cli":      "copilot-cli",
	"copilot_cli_edge": "copilot-cli",
	"cursor":           "cursor",
	"cursor_edge":      "cursor",
	"goose":            "goose",
	"goose_edge":       "goose",
	"kiro":             "kiro",
	"kiro_edge":        "kiro",
	"opencode":         "opencode",
	"pi":               "pi",
	"pi_edge":          "pi",
	"malformed":        "claude-code",
	"secrets":          "claude-code",
}

func goldensDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.Abs(filepath.Join("..", "..", "contracts", "session-goldens"))
	if err != nil {
		t.Fatalf("resolve goldens dir: %v", err)
	}
	return dir
}

// TestGoldenEventParity checks every fixture set: stored rows must expand to
// exactly the recorded frontend events.
func TestGoldenEventParity(t *testing.T) {
	registry := harness.MustLoad()
	dir := goldensDir(t)
	fixtures, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read goldens dir: %v", err)
	}
	if len(fixtures) == 0 {
		t.Fatal("no golden fixtures found")
	}

	for _, fixture := range fixtures {
		if !fixture.IsDir() {
			continue
		}
		name := fixture.Name()
		t.Run(name, func(t *testing.T) {
			if _, ok := goldenHarnesses[name]; !ok {
				t.Fatalf("fixture %q missing from goldenHarnesses", name)
			}

			rowsRaw, err := os.ReadFile(filepath.Join(dir, name, "rows.json"))
			if err != nil {
				t.Fatalf("read rows.json: %v", err)
			}
			var rowsDoc struct {
				Harness string `json:"harness"`
				Rows    []Row  `json:"rows"`
			}
			if err := json.Unmarshal(rowsRaw, &rowsDoc); err != nil {
				t.Fatalf("decode rows.json: %v", err)
			}

			eventsRaw, err := os.ReadFile(filepath.Join(dir, name, "events.json"))
			if err != nil {
				t.Fatalf("read events.json: %v", err)
			}
			var eventsDoc struct {
				Harness string `json:"harness"`
				Events  []any  `json:"events"`
			}
			if err := json.Unmarshal(eventsRaw, &eventsDoc); err != nil {
				t.Fatalf("decode events.json: %v", err)
			}

			got, err := Parse(registry, rowsDoc.Rows)
			if err != nil {
				t.Fatalf("Parse: %v", err)
			}

			// Compare through a JSON round-trip so attribute value types
			// (numbers, nested objects) are judged by their wire form.
			gotJSON, err := json.Marshal(got)
			if err != nil {
				t.Fatalf("marshal parsed events: %v", err)
			}
			var gotGeneric []any
			if err := json.Unmarshal(gotJSON, &gotGeneric); err != nil {
				t.Fatalf("round-trip parsed events: %v", err)
			}
			if gotGeneric == nil {
				gotGeneric = []any{}
			}
			wantGeneric := eventsDoc.Events
			if wantGeneric == nil {
				wantGeneric = []any{}
			}

			if len(gotGeneric) != len(wantGeneric) {
				t.Fatalf("event count = %d, want %d", len(gotGeneric), len(wantGeneric))
			}
			for i := range wantGeneric {
				if !reflect.DeepEqual(gotGeneric[i], wantGeneric[i]) {
					gotPretty, _ := json.MarshalIndent(gotGeneric[i], "", " ")
					wantPretty, _ := json.MarshalIndent(wantGeneric[i], "", " ")
					t.Errorf("event %d mismatch\n got: %s\nwant: %s", i, gotPretty, wantPretty)
				}
			}
		})
	}
}
