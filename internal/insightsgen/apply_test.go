// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/google/uuid"
)

func TestResolveIndexSelection(t *testing.T) {
	if got, want := resolveIndexSelection(nil, 3), []int{0, 1, 2}; !reflect.DeepEqual(got, want) {
		t.Errorf("nil selects everything: %v", got)
	}
	if got, want := resolveIndexSelection([]int{2, 0}, 3), []int{2, 0}; !reflect.DeepEqual(got, want) {
		t.Errorf("caller order must be kept: %v", got)
	}
	if got, want := resolveIndexSelection([]int{-1, 1, 5}, 3), []int{1}; !reflect.DeepEqual(got, want) {
		t.Errorf("out-of-range indices must be dropped: %v", got)
	}
	if got := resolveIndexSelection([]int{}, 3); len(got) != 0 {
		t.Errorf("explicit empty selection selects nothing: %v", got)
	}
}

func TestTruthyAny(t *testing.T) {
	falsy := []any{nil, false, "", float64(0), json.Number("0"), []any{}, map[string]any{}}
	for _, v := range falsy {
		if truthyAny(v) {
			t.Errorf("truthyAny(%#v) = true, want false", v)
		}
	}
	truthy := []any{true, "x", float64(0.5), json.Number("2"), []any{1}, map[string]any{"k": 1}, 3}
	for _, v := range truthy {
		if !truthyAny(v) {
			t.Errorf("truthyAny(%#v) = false, want true", v)
		}
	}
}

func TestCoerceUUID(t *testing.T) {
	id := uuid.New()
	if got, ok := coerceUUID(id.String()); !ok || got != id {
		t.Errorf("canonical string: (%v, %v)", got, ok)
	}
	if got, ok := coerceUUID("  " + id.String() + "  "); !ok || got != id {
		t.Errorf("surrounding whitespace must be trimmed: (%v, %v)", got, ok)
	}
	for _, bad := range []any{nil, "", "   ", "not-a-uuid", 42} {
		if _, ok := coerceUUID(bad); ok {
			t.Errorf("coerceUUID(%#v) accepted", bad)
		}
	}
}

func TestLooksLikeSkill(t *testing.T) {
	if !looksLikeSkill(map[string]any{"feature": "Package this as a reusable SKILL"}) {
		t.Error("case-insensitive skill mention not detected")
	}
	if looksLikeSkill(map[string]any{"feature": "add a new hook"}) {
		t.Error("non-skill feature misdetected")
	}
	if looksLikeSkill(map[string]any{}) {
		t.Error("empty feature misdetected")
	}
}

func TestCountReused(t *testing.T) {
	if got := countReused(map[string]any{}); got != 0 {
		t.Errorf("no suggestions block: %d", got)
	}
	narrative := map[string]any{
		"suggestions": map[string]any{
			"features_to_try": []any{
				map[string]any{"component_ref": map[string]any{"id": "x"}},
				map[string]any{"component_ref": nil},
				map[string]any{},
				"not-a-map",
			},
		},
	}
	if got := countReused(narrative); got != 1 {
		t.Errorf("countReused = %d, want 1", got)
	}
}
