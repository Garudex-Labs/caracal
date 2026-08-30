// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package execdash

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/google/uuid"
)

func TestChRowCoercions(t *testing.T) {
	row := map[string]any{
		"quoted": "42.5", "native": 7.25, "text": "hello",
		"bad": []any{}, "int_str": "9",
	}
	if got := chStr(row, "text"); got != "hello" {
		t.Errorf("chStr = %q", got)
	}
	if got := chStr(row, "native"); got != "" {
		t.Errorf("chStr on non-string = %q", got)
	}
	if got := chFloat(row, "quoted"); got != 42.5 {
		t.Errorf("chFloat quoted = %v", got)
	}
	if got := chFloat(row, "native"); got != 7.25 {
		t.Errorf("chFloat native = %v", got)
	}
	if got := chFloat(row, "bad"); got != 0 {
		t.Errorf("chFloat unsupported type = %v", got)
	}
	if got := chFloat(row, "missing"); got != 0 {
		t.Errorf("chFloat missing = %v", got)
	}
	if got := chFloatInt(row, "quoted"); got != 42 {
		t.Errorf("chFloatInt truncates toward zero: %v", got)
	}
}

func TestChUserCounts(t *testing.T) {
	rows := []map[string]any{
		{"user_id": "u1", "sessions": "5"},
		{"user_id": "u2", "sessions": 3.0},
	}
	got := chUserCounts(rows, "sessions")
	if !reflect.DeepEqual(got, map[string]int64{"u1": 5, "u2": 3}) {
		t.Errorf("chUserCounts = %v", got)
	}
}

func TestSortedKeysAndItoa(t *testing.T) {
	keys := sortedKeys(map[string][]string{"b": nil, "a": nil, "c": nil})
	if !reflect.DeepEqual(keys, []string{"a", "b", "c"}) {
		t.Errorf("sortedKeys = %v", keys)
	}
	for n, want := range map[int]string{0: "0", 7: "7", 42: "42", 1024: "1024"} {
		if got := itoa(n); got != want {
			t.Errorf("itoa(%d) = %q", n, got)
		}
	}
}

func TestJSONBlock(t *testing.T) {
	if got := jsonBlock(map[string]any{"k": 1}); got != "{\n  \"k\": 1\n}" {
		t.Errorf("jsonBlock = %q", got)
	}
	// Unmarshalable values degrade to an empty object, never a panic.
	if got := jsonBlock(func() {}); got != "{}" {
		t.Errorf("jsonBlock on func = %q", got)
	}
}

func TestAnyMapHelpers(t *testing.T) {
	if got := anyMap(map[string]any{"a": 1}); got["a"] != 1 {
		t.Errorf("anyMap = %v", got)
	}
	// Mismatched shapes yield empty containers, never nil.
	if got := anyMap("nope"); got == nil || len(got) != 0 {
		t.Errorf("anyMap on non-map = %v", got)
	}
	slice := anyMapSlice([]any{map[string]any{"a": 1}, "junk", map[string]any{"b": 2}})
	if len(slice) != 2 {
		t.Errorf("anyMapSlice must drop non-map items: %v", slice)
	}
	if got := anyMapSlice(42); got == nil || len(got) != 0 {
		t.Errorf("anyMapSlice on non-slice = %v", got)
	}
}

func TestConfigToWire(t *testing.T) {
	id := uuid.MustParse("0656308f-8bba-472e-ab77-f96a7ac69fd2")
	wire := configToWire(&Config{ID: id, HourlyDevCost: 85, TargetAdoptionPct: 60})
	if wire.ID != id.String() || wire.TargetAdoptionPct != 60 {
		t.Errorf("wire = %+v", wire)
	}
	// Integral costs keep an explicit fraction on the wire.
	if wire.HourlyDevCost != json.Number("85.0") {
		t.Errorf("HourlyDevCost = %q", wire.HourlyDevCost)
	}
	// Nil maps become empty objects, not null.
	blob, _ := json.Marshal(wire)
	for _, frag := range []string{`"pre_ai_baselines":{}`, `"department_budgets":{}`} {
		if !contains(string(blob), frag) {
			t.Errorf("wire JSON missing %q: %s", frag, blob)
		}
	}
}

func contains(s, sub string) bool { return indexOf(s, sub) >= 0 }
