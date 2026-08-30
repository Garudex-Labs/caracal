// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"reflect"
	"testing"
)

func mustDecode(t *testing.T, blob string) any {
	t.Helper()
	value, err := decodeOrderedJSON([]byte(blob))
	if err != nil {
		t.Fatalf("decodeOrderedJSON(%q): %v", blob, err)
	}
	return value
}

func TestDecodeOrderedJSONPreservesKeyOrder(t *testing.T) {
	// Standard maps would iterate these keys randomly; harness config
	// rewrites must keep the user's original ordering.
	src := `{"zeta": 1, "alpha": {"y": true, "x": null}, "mid": [1, "two"]}`
	object := mustDecode(t, src).(*omap)
	if !reflect.DeepEqual(object.keys, []string{"zeta", "alpha", "mid"}) {
		t.Errorf("top-level order = %v", object.keys)
	}
	if inner := object.object("alpha"); !reflect.DeepEqual(inner.keys, []string{"y", "x"}) {
		t.Errorf("nested order = %v", inner.keys)
	}
}

func TestOrderedRoundTripIsLossless(t *testing.T) {
	src := `{"b": {"nested": [1, 2, {"deep": "v"}]}, "a": "text", "n": 9007199254740993}`
	object := mustDecode(t, src)
	compact, err := marshalOrderedCompact(object)
	if err != nil {
		t.Fatalf("marshalOrderedCompact: %v", err)
	}
	want := `{"b":{"nested":[1,2,{"deep":"v"}]},"a":"text","n":9007199254740993}`
	if string(compact) != want {
		t.Errorf("round trip:\ngot  %s\nwant %s", compact, want)
	}
}

func TestOrderedNumbersKeepIntegerPrecision(t *testing.T) {
	// 2^53+1 would be corrupted by a float64 decode path.
	object := mustDecode(t, `{"port": 9007199254740993}`).(*omap)
	num, ok := object.get("port").(json.Number)
	if !ok || num.String() != "9007199254740993" {
		t.Errorf("port = %#v", object.get("port"))
	}
}

func TestDecodeOrderedJSONRejectsTrailingData(t *testing.T) {
	if _, err := decodeOrderedJSON([]byte(`{"a": 1} {"b": 2}`)); err == nil {
		t.Error("trailing JSON value accepted")
	}
	if _, err := decodeOrderedJSON([]byte(`{"a":`)); err == nil {
		t.Error("truncated JSON accepted")
	}
}

func TestOmapSetKeepsPositionOnUpdate(t *testing.T) {
	o := newOmap()
	o.set("first", 1)
	o.set("second", 2)
	o.set("first", 10)
	if !reflect.DeepEqual(o.keys, []string{"first", "second"}) {
		t.Errorf("update moved the key: %v", o.keys)
	}
	if o.get("first") != 10 {
		t.Errorf("value not updated: %v", o.get("first"))
	}
}

func TestOmapRemove(t *testing.T) {
	o := newOmap()
	o.set("a", 1)
	o.set("b", 2)
	o.set("c", 3)
	o.remove("b")
	o.remove("missing")
	if !reflect.DeepEqual(o.keys, []string{"a", "c"}) {
		t.Errorf("keys after remove: %v", o.keys)
	}
	if o.has("b") || o.len() != 2 {
		t.Errorf("remove left state behind: has=%v len=%d", o.has("b"), o.len())
	}
}

func TestOmapTypedAccessors(t *testing.T) {
	object := mustDecode(t, `{"s": "text", "o": {"k": 1}, "l": [1], "wrong": 5}`).(*omap)
	if object.str("s") != "text" || object.str("wrong") != "" || object.str("missing") != "" {
		t.Error("str accessor")
	}
	if object.object("o") == nil || object.object("wrong") != nil {
		t.Error("object accessor")
	}
	if len(object.array("l")) != 1 || object.array("wrong") != nil {
		t.Error("array accessor")
	}
}

func TestPlainConvertsToStandardShapes(t *testing.T) {
	object := mustDecode(t, `{"o": {"k": "v"}, "l": [{"x": 1}], "s": "t", "b": true, "z": null}`)
	got := plain(object)
	want := map[string]any{
		"o": map[string]any{"k": "v"},
		"l": []any{map[string]any{"x": json.Number("1")}},
		"s": "t",
		"b": true,
		"z": nil,
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("plain = %#v, want %#v", got, want)
	}
}

func TestMarshalOrderedEscapesStrings(t *testing.T) {
	o := newOmap()
	o.set(`quote"key`, "line\nbreak")
	blob, err := marshalOrderedCompact(o)
	if err != nil {
		t.Fatalf("marshalOrderedCompact: %v", err)
	}
	var decoded map[string]string
	if err := json.Unmarshal(blob, &decoded); err != nil {
		t.Fatalf("output is not valid JSON: %v (%s)", err, blob)
	}
	if decoded[`quote"key`] != "line\nbreak" {
		t.Errorf("escaping mangled content: %#v", decoded)
	}
}
