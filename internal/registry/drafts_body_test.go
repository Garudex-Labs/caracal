// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"reflect"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// draftBodyOf builds a draftBody over a literal decoded-JSON map.
func draftBodyOf(raw map[string]any) *draftBody {
	return &draftBody{raw: raw}
}

func firstErrType(t *testing.T, b *draftBody) string {
	t.Helper()
	if len(b.errs) == 0 {
		t.Fatal("expected a validation error")
	}
	return b.errs[0].Type
}

func TestDraftBodyStrList(t *testing.T) {
	def := []string{"fallback"}

	b := draftBodyOf(map[string]any{})
	if got := b.strList("tags", def); !reflect.DeepEqual(got, def) || len(b.errs) != 0 {
		t.Errorf("absent = %v errs %v", got, b.errs)
	}

	b = draftBodyOf(map[string]any{"tags": nil})
	if got := b.strList("tags", def); !reflect.DeepEqual(got, def) || len(b.errs) != 0 {
		t.Errorf("null = %v errs %v", got, b.errs)
	}

	b = draftBodyOf(map[string]any{"tags": []any{"a", "b"}})
	if got := b.strList("tags", def); !reflect.DeepEqual(got, []string{"a", "b"}) || len(b.errs) != 0 {
		t.Errorf("valid = %v errs %v", got, b.errs)
	}

	b = draftBodyOf(map[string]any{"tags": "not-a-list"})
	if got := b.strList("tags", def); !reflect.DeepEqual(got, def) || firstErrType(t, b) != "list_type" {
		t.Errorf("scalar = %v errs %v", got, b.errs)
	}

	b = draftBodyOf(map[string]any{"tags": []any{"a", 7}})
	if got := b.strList("tags", def); !reflect.DeepEqual(got, def) || firstErrType(t, b) != "string_type" {
		t.Errorf("mixed = %v errs %v", got, b.errs)
	}
}

func TestDraftBodyNStrList(t *testing.T) {
	b := draftBodyOf(map[string]any{})
	if got := b.nStrList("tags"); got != nil || len(b.errs) != 0 {
		t.Errorf("absent = %v", got)
	}

	b = draftBodyOf(map[string]any{"tags": nil})
	if got := b.nStrList("tags"); got != nil || len(b.errs) != 0 {
		t.Errorf("null = %v", got)
	}

	b = draftBodyOf(map[string]any{"tags": []any{"a"}})
	if got := b.nStrList("tags"); !reflect.DeepEqual(got, []string{"a"}) {
		t.Errorf("valid = %v", got)
	}

	b = draftBodyOf(map[string]any{"tags": 5.0})
	if got := b.nStrList("tags"); got != nil || firstErrType(t, b) != "list_type" {
		t.Errorf("scalar = %v errs %v", got, b.errs)
	}
}

func TestDraftBodyDictAndNDict(t *testing.T) {
	def := map[string]any{"d": true}

	b := draftBodyOf(map[string]any{})
	if got := b.dict("cfg", def); !reflect.DeepEqual(got, def) {
		t.Errorf("absent = %v", got)
	}
	if got := b.ndict("cfg"); got != nil {
		t.Errorf("ndict absent = %v", got)
	}

	valid := map[string]any{"k": "v"}
	b = draftBodyOf(map[string]any{"cfg": valid})
	if got := b.dict("cfg", def); !reflect.DeepEqual(got, valid) || len(b.errs) != 0 {
		t.Errorf("valid = %v", got)
	}

	b = draftBodyOf(map[string]any{"cfg": []any{"nope"}})
	if got := b.dict("cfg", def); !reflect.DeepEqual(got, def) || firstErrType(t, b) != "dict_type" {
		t.Errorf("list = %v errs %v", got, b.errs)
	}

	b = draftBodyOf(map[string]any{"cfg": "nope"})
	if got := b.ndict("cfg"); got != nil || firstErrType(t, b) != "dict_type" {
		t.Errorf("ndict scalar = %v errs %v", got, b.errs)
	}
}

func TestDraftBodyIntVal(t *testing.T) {
	cases := []struct {
		name    string
		value   any
		want    int
		errType string
	}{
		{"whole float", 5.0, 5, ""},
		{"fractional float", 5.5, 9, "int_from_float"},
		{"numeric string", "42", 42, ""},
		{"padded numeric string", " 42", 42, ""},
		{"garbage string", "4x", 9, "int_parsing"},
		{"wrong type", true, 9, "int_type"},
	}
	for _, tc := range cases {
		b := draftBodyOf(map[string]any{"n": tc.value})
		got := b.intVal("n", 9)
		if got != tc.want {
			t.Errorf("%s: intVal = %d, want %d", tc.name, got, tc.want)
		}
		if tc.errType == "" && len(b.errs) != 0 {
			t.Errorf("%s: unexpected errs %v", tc.name, b.errs)
		}
		if tc.errType != "" && (len(b.errs) == 0 || b.errs[0].Type != tc.errType) {
			t.Errorf("%s: errs = %v, want %s", tc.name, b.errs, tc.errType)
		}
	}

	b := draftBodyOf(map[string]any{})
	if got := b.intVal("n", 9); got != 9 || len(b.errs) != 0 {
		t.Errorf("absent = %d errs %v", got, b.errs)
	}
}

func TestDraftBodyUUIDNull(t *testing.T) {
	b := draftBodyOf(map[string]any{})
	if got := b.uuidNull("project_id"); got != nil || len(b.errs) != 0 {
		t.Errorf("absent = %v", got)
	}

	id := uuid.MustParse("11111111-1111-1111-1111-111111111111")
	b = draftBodyOf(map[string]any{"project_id": id.String()})
	if got := b.uuidNull("project_id"); got == nil || *got != id {
		t.Errorf("valid = %v", got)
	}

	b = draftBodyOf(map[string]any{"project_id": 42.0})
	if got := b.uuidNull("project_id"); got != nil || firstErrType(t, b) != "uuid_type" {
		t.Errorf("number = %v errs %v", got, b.errs)
	}

	b = draftBodyOf(map[string]any{"project_id": "nope"})
	if got := b.uuidNull("project_id"); got != nil || firstErrType(t, b) != "uuid_parsing" {
		t.Errorf("garbage = %v errs %v", got, b.errs)
	}
}

func TestDraftBodyVisibility(t *testing.T) {
	b := draftBodyOf(map[string]any{})
	if got := b.visibility(); got != "public" || len(b.errs) != 0 {
		t.Errorf("default = %q errs %v", got, b.errs)
	}

	for _, valid := range []string{"public", "project", "private"} {
		b = draftBodyOf(map[string]any{"visibility": valid})
		if got := b.visibility(); got != valid || len(b.errs) != 0 {
			t.Errorf("%s = %q errs %v", valid, got, b.errs)
		}
	}

	b = draftBodyOf(map[string]any{"visibility": "internal"})
	if got := b.visibility(); got != "public" || firstErrType(t, b) != "literal_error" {
		t.Errorf("invalid = %q errs %v", got, b.errs)
	}
}

func TestDraftBodyOption(t *testing.T) {
	valid := []string{"stdio", "http"}

	b := draftBodyOf(map[string]any{"transport": "http"})
	if got := b.option("transport", "stdio", valid); got != "http" || len(b.errs) != 0 {
		t.Errorf("valid = %q errs %v", got, b.errs)
	}

	b = draftBodyOf(map[string]any{"transport": "carrier-pigeon"})
	if got := b.option("transport", "stdio", valid); got != "stdio" || firstErrType(t, b) != "value_error" {
		t.Errorf("invalid = %q errs %v", got, b.errs)
	}
	if !strings.Contains(b.errs[0].Msg, "Invalid transport 'carrier-pigeon'") {
		t.Errorf("msg = %s", b.errs[0].Msg)
	}
}

func TestDraftBodyHarnessList(t *testing.T) {
	valid := []string{"kiro", "claude-code"}

	// Underscores normalize to hyphens before validation.
	b := draftBodyOf(map[string]any{"supported_harnesses": []any{"claude_code"}})
	if got := b.harnessList(valid); !reflect.DeepEqual(got, []string{"claude-code"}) || len(b.errs) != 0 {
		t.Errorf("normalized = %v errs %v", got, b.errs)
	}

	b = draftBodyOf(map[string]any{"supported_harnesses": []any{"kiro", "bogus"}})
	got := b.harnessList(valid)
	if !reflect.DeepEqual(got, []string{"kiro", "bogus"}) {
		t.Errorf("tokens = %v", got)
	}
	if firstErrType(t, b) != "value_error" || !strings.Contains(b.errs[0].Msg, "Invalid harness(s): bogus") {
		t.Errorf("errs = %v", b.errs)
	}

	b = draftBodyOf(map[string]any{})
	if got := b.harnessList(valid); !reflect.DeepEqual(got, []string{}) || len(b.errs) != 0 {
		t.Errorf("absent = %v", got)
	}
}
