// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package adminops

import (
	"encoding/json"
	"testing"
)

func TestResourceOverrides(t *testing.T) {
	overrides := resourceOverrides(map[string]string{
		"resource.max_query_memory_mb": "512",
		"resource.group_by_spill_mb":   "0",
		"resource.sort_spill_mb":       "-3",
		"resource.join_memory_mb":      "not-a-number",
		"resource.db_pool_size":        "10",
	})
	if len(overrides) != 1 {
		t.Fatalf("overrides = %v", overrides)
	}
	if overrides["max_memory_usage"] != "512000000" {
		t.Errorf("max_memory_usage = %q", overrides["max_memory_usage"])
	}

	full := resourceOverrides(map[string]string{
		"resource.max_query_memory_mb": "1",
		"resource.group_by_spill_mb":   "2",
		"resource.sort_spill_mb":       "3",
		"resource.join_memory_mb":      "4",
	})
	want := map[string]string{
		"max_memory_usage":                   "1000000",
		"max_bytes_before_external_group_by": "2000000",
		"max_bytes_before_external_sort":     "3000000",
		"max_bytes_in_join":                  "4000000",
	}
	for setting, value := range want {
		if full[setting] != value {
			t.Errorf("%s = %q, want %q", setting, full[setting], value)
		}
	}
}

func TestIsResourceSetting(t *testing.T) {
	if !isResourceSetting("resource.sort_spill_mb") {
		t.Error("mapped key rejected")
	}
	if isResourceSetting("resource.db_pool_size") {
		t.Error("unmapped resource key accepted")
	}
}

func TestAppliedKeysDetail(t *testing.T) {
	if got := appliedKeysDetail(nil); got != "Applied resource settings: []" {
		t.Errorf("empty detail = %q", got)
	}
	got := appliedKeysDetail([]string{"resource.max_query_memory_mb", "resource.join_memory_mb"})
	want := "Applied resource settings: ['resource.max_query_memory_mb', 'resource.join_memory_mb']"
	if got != want {
		t.Errorf("detail = %q, want %q", got, want)
	}
}

func TestOrderedPairsMarshal(t *testing.T) {
	pairs := orderedPairs{
		{"resource.sort_spill_mb", "3"},
		{"resource.max_query_memory_mb", "512"},
	}
	raw, err := json.Marshal(pairs)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"resource.sort_spill_mb":"3","resource.max_query_memory_mb":"512"}`
	if string(raw) != want {
		t.Errorf("marshal = %s, want %s", raw, want)
	}
	if empty, _ := json.Marshal(orderedPairs{}); string(empty) != "{}" {
		t.Errorf("empty marshal = %s", empty)
	}
}
