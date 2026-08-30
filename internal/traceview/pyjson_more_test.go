// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package traceview

import (
	"encoding/json"
	"testing"
)

func TestDecodeValueShapes(t *testing.T) {
	// Object key order and number literals must survive decoding.
	v, err := DecodeValue([]byte(`{"b":1,"a":"x","c":[true,null,2.50]}`))
	if err != nil {
		t.Fatalf("DecodeValue: %v", err)
	}
	obj, ok := v.(*Obj)
	if !ok {
		t.Fatalf("top-level is %T, want *Obj", v)
	}
	if keys := obj.Keys(); len(keys) != 3 || keys[0] != "b" || keys[1] != "a" || keys[2] != "c" {
		t.Errorf("key order = %v, want [b a c]", keys)
	}
	if n, ok := obj.Get("b").(json.Number); !ok || n.String() != "1" {
		t.Errorf("number literal not preserved: %#v", obj.Get("b"))
	}
	arr, ok := obj.Get("c").([]any)
	if !ok || len(arr) != 3 {
		t.Fatalf("nested array = %#v", obj.Get("c"))
	}
	if n, ok := arr[2].(json.Number); !ok || n.String() != "2.50" {
		t.Errorf("nested number literal = %#v, want 2.50", arr[2])
	}
}

func TestDecodeValueEmptyArray(t *testing.T) {
	v, err := DecodeValue([]byte(`[]`))
	if err != nil {
		t.Fatalf("DecodeValue: %v", err)
	}
	arr, ok := v.([]any)
	if !ok || arr == nil || len(arr) != 0 {
		t.Errorf("empty array = %#v, want non-nil empty []any", v)
	}
}

func TestDecodeValueErrors(t *testing.T) {
	tests := []struct {
		name string
		in   string
	}{
		{"empty input", ""},
		{"unterminated object", "{"},
		{"unterminated array", "[1,"},
		{"trailing data", "1 2"},
		{"bare garbage", "not-json"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := DecodeValue([]byte(tc.in)); err == nil {
				t.Errorf("DecodeValue(%q) succeeded, want error", tc.in)
			}
		})
	}
}

func TestLoadLine(t *testing.T) {
	if obj := loadLine(`{"k":"v"}`); obj == nil || obj.Get("k") != "v" {
		t.Errorf("loadLine object = %#v", obj)
	}
	if obj := loadLine(`"just a string"`); obj != nil {
		t.Errorf("loadLine non-object should be nil, got %#v", obj)
	}
	if obj := loadLine(`{ malformed`); obj != nil {
		t.Errorf("loadLine malformed should be nil, got %#v", obj)
	}
}

func TestDumpJSONFormatting(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"object separators and order", `{"b":1,"a":2}`, `{"b": 1, "a": 2}`},
		{"array separators", `[1,"x",true,null]`, `[1, "x", true, null]`},
		{"nested", `{"a":[1,{"z":"y"}]}`, `{"a": [1, {"z": "y"}]}`},
		{"number literal preserved", `1.50`, `1.50`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			v, err := DecodeValue([]byte(tc.in))
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			if got := DumpJSON(v); got != tc.want {
				t.Errorf("DumpJSON = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestDumpJSONScalars(t *testing.T) {
	if got := DumpJSON(nil); got != "null" {
		t.Errorf("nil = %q", got)
	}
	if got := DumpJSON(true); got != "true" {
		t.Errorf("true = %q", got)
	}
	if got := DumpJSON(false); got != "false" {
		t.Errorf("false = %q", got)
	}
	// A non-decoder value (plain int) exercises the marshal fallback.
	if got := DumpJSON(5); got != "5" {
		t.Errorf("int fallback = %q, want 5", got)
	}
}

func TestDumpJSONStringEscaping(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"quote and backslash", "a\"b\\c", `"a\"b\\c"`},
		{"short escapes", "\t\r\n\b\f", `"\t\r\n\b\f"`},
		{"control char", "\x01", `"\u0001"`},
		{"del is escaped", "\u007f", `"\u007f"`},
		{"bmp non-ascii", "\u00e9", `"\u00e9"`},
		{"astral surrogate pair", "\U0001F600", `"\ud83d\ude00"`},
		{"ascii kept literal", "Zz", `"Zz"`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := DumpJSON(tc.in); got != tc.want {
				t.Errorf("DumpJSON(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestObjMarshalJSONKeyOrder(t *testing.T) {
	obj := mustObj(t, `{"b":1,"a":"x"}`)
	raw, err := json.Marshal(obj)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if got, want := string(raw), `{"b":1,"a":"x"}`; got != want {
		t.Errorf("MarshalJSON = %q, want %q", got, want)
	}
}

func TestObjMethodsNilAndSet(t *testing.T) {
	var nilObj *Obj
	if nilObj.Get("x") != nil {
		t.Error("nil Get should be nil")
	}
	if nilObj.Has("x") {
		t.Error("nil Has should be false")
	}
	if nilObj.Keys() != nil {
		t.Error("nil Keys should be nil")
	}
	if nilObj.Len() != 0 {
		t.Error("nil Len should be 0")
	}

	o := &Obj{}
	o.Set("a", 1)
	o.Set("b", 2)
	o.Set("a", 3) // replace keeps position and count
	if keys := o.Keys(); len(keys) != 2 || keys[0] != "a" || keys[1] != "b" {
		t.Errorf("keys after replace = %v, want [a b]", o.Keys())
	}
	if o.Get("a") != 3 {
		t.Errorf("replaced value = %#v, want 3", o.Get("a"))
	}
	if o.Len() != 2 {
		t.Errorf("Len = %d, want 2", o.Len())
	}
	if !o.Has("b") {
		t.Error("Has(b) should be true")
	}
}
