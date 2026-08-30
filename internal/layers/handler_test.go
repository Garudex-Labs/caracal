// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package layers

import (
	"encoding/json"
	"testing"
)

func TestJSONObjectKeysPreservesDocumentOrder(t *testing.T) {
	raw := json.RawMessage(`{"kiro": [], "claude-code": [{"path": "a"}], "cursor": []}`)
	keys := jsonObjectKeys(raw)
	want := []string{"kiro", "claude-code", "cursor"}
	if len(keys) != len(want) {
		t.Fatalf("keys = %v, want %v", keys, want)
	}
	for i := range want {
		if keys[i] != want[i] {
			t.Fatalf("keys = %v, want %v", keys, want)
		}
	}
	if got := jsonObjectKeys(json.RawMessage(`[]`)); got != nil {
		t.Fatalf("non-object keys = %v, want nil", got)
	}
}

func strPtr(s string) *string { return &s }

func int64Ptr(n int64) *int64 { return &n }

func TestUploadFieldErrors(t *testing.T) {
	size := int64Ptr(-1)
	body := &uploadBody{
		Hash: strPtr("short"),
		Harnesses: map[string][]layerFile{
			"kiro": {{Path: strPtr("a"), Hash: strPtr("h"), Size: size}, {Hash: strPtr("h"), Size: int64Ptr(1)}},
		},
	}
	errs := body.fieldErrors([]string{"kiro"}, map[string]any{}, nil)
	types := map[string]int{}
	for _, e := range errs {
		types[e["type"].(string)]++
	}
	if types["string_too_short"] != 1 || types["greater_than_equal"] != 1 || types["missing"] != 1 {
		t.Fatalf("unexpected error mix: %v", errs)
	}

	// Missing hash reports the submitted object.
	noHash := &uploadBody{}
	errs = noHash.fieldErrors(nil, map[string]any{"harnesses": map[string]any{}}, nil)
	if len(errs) != 1 || errs[0]["type"] != "missing" || errs[0]["input"] == nil {
		t.Fatalf("missing-hash error = %v", errs)
	}
}

func TestJoinKeysAndSortedKeys(t *testing.T) {
	if got := joinKeys([]string{"kiro", "cursor"}); got != "kiro,cursor" {
		t.Fatalf("joinKeys = %q", got)
	}
	m := map[string]map[string]any{"b/x": nil, "a/y": nil}
	keys := sortedKeys(m)
	if keys[0] != "a/y" || keys[1] != "b/x" {
		t.Fatalf("sortedKeys = %v", keys)
	}
}

func TestChScalars(t *testing.T) {
	if chInt("42") != 42 || chInt(float64(7)) != 7 || chInt(nil) != 0 {
		t.Fatal("chInt conversions wrong")
	}
	if chStr("x") != "x" || chStr(nil) != "" {
		t.Fatal("chStr conversions wrong")
	}
}
