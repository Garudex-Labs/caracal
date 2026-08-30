// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package ingest

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/internal/harness"
)

// Pinned values the golden fixtures were recorded with.
const (
	fixedNow        = "2026-01-01 00:00:00.000"
	fixedIngestedAt = "2026-01-01 00:00:01.000"
)

// golden fixture directory -> harness ("malformed" exercises parse-error
// handling, "secrets" exercises redaction).
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
	dir := filepath.Join("..", "..", "contracts", "session-goldens")
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("golden fixtures not found: %v", err)
	}
	return dir
}

// TestGoldenRowParity replays every recorded transcript through the row
// builder and requires field-level agreement with the fixtures in
// contracts/session-goldens. This gate must stay green: services that
// ingest transcripts may never disagree on stored rows.
func TestGoldenRowParity(t *testing.T) {
	root := goldensDir(t)
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) == 0 {
		t.Fatal("no golden fixture sets found")
	}

	reg := harness.MustLoad()
	covered := 0
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		fixture := entry.Name()
		harnessName, ok := goldenHarnesses[fixture]
		if !ok {
			t.Errorf("fixture %q has no harness mapping; update goldenHarnesses", fixture)
			continue
		}
		covered++

		t.Run(fixture, func(t *testing.T) {
			inputRaw, err := os.ReadFile(filepath.Join(root, fixture, "input.jsonl"))
			if err != nil {
				t.Fatal(err)
			}
			var lines []string
			for _, line := range strings.Split(string(inputRaw), "\n") {
				if strings.TrimSpace(line) != "" {
					lines = append(lines, line)
				}
			}

			goldenRaw, err := os.ReadFile(filepath.Join(root, fixture, "rows.json"))
			if err != nil {
				t.Fatal(err)
			}
			var golden struct {
				Harness string           `json:"harness"`
				Rows    []map[string]any `json:"rows"`
			}
			if err := json.Unmarshal(goldenRaw, &golden); err != nil {
				t.Fatal(err)
			}
			if golden.Harness != harnessName {
				t.Fatalf("fixture harness %q != mapping %q", golden.Harness, harnessName)
			}

			builder, err := NewBuilder(reg, harnessName)
			if err != nil {
				t.Fatal(err)
			}
			builder.Now = func() string { return fixedNow }
			builder.IngestedAt = fixedIngestedAt

			rows, _ := builder.BuildRows(lines, 0)
			if len(rows) != len(golden.Rows) {
				t.Fatalf("built %d rows, golden has %d", len(rows), len(golden.Rows))
			}

			for i, row := range rows {
				got := roundTrip(t, row)
				want := golden.Rows[i]
				if reflect.DeepEqual(got, want) {
					continue
				}
				for key, wantVal := range want {
					if gotVal, ok := got[key]; !ok || !reflect.DeepEqual(gotVal, wantVal) {
						t.Errorf("row %d field %q:\n  got:  %s\n  want: %s",
							i, key, renderJSON(gotVal), renderJSON(wantVal))
					}
				}
				for key := range got {
					if _, ok := want[key]; !ok {
						t.Errorf("row %d has extra field %q", i, key)
					}
				}
			}
		})
	}
	if covered != len(goldenHarnesses) {
		t.Errorf("covered %d fixture sets, expected %d", covered, len(goldenHarnesses))
	}
}

func roundTrip(t *testing.T, row Row) map[string]any {
	t.Helper()
	data, err := json.Marshal(row)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func renderJSON(v any) string {
	data, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprintf("%v", v)
	}
	return string(data)
}
