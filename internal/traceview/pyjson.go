// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package traceview

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf16"
)

// Obj is a JSON object that remembers key order, so re-serialized fragments
// (tool inputs shown in the trace viewer) keep the transcript's own ordering.
type Obj struct {
	keys []string
	vals map[string]any
}

// Get returns the value for key, or nil when absent.
func (o *Obj) Get(key string) any {
	if o == nil {
		return nil
	}
	return o.vals[key]
}

// Has reports whether key is present (even with a null value).
func (o *Obj) Has(key string) bool {
	if o == nil {
		return false
	}
	_, ok := o.vals[key]
	return ok
}

// Keys returns the object's keys in document order.
func (o *Obj) Keys() []string {
	if o == nil {
		return nil
	}
	return o.keys
}

// Len returns the number of entries.
func (o *Obj) Len() int {
	if o == nil {
		return 0
	}
	return len(o.keys)
}

// Set appends or replaces an entry, keeping first-insertion order.
func (o *Obj) Set(key string, value any) {
	if _, ok := o.vals[key]; !ok {
		o.keys = append(o.keys, key)
	}
	if o.vals == nil {
		o.vals = map[string]any{}
	}
	o.vals[key] = value
}

// DecodeValue parses a JSON document into nil, bool, json.Number, string,
// []any, or *Obj, preserving object key order and number literals.
func DecodeValue(data []byte) (any, error) {
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.UseNumber()
	value, err := decodeNext(dec)
	if err != nil {
		return nil, err
	}
	if dec.More() {
		return nil, fmt.Errorf("trailing data after JSON value")
	}
	return value, nil
}

func decodeNext(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			obj := &Obj{vals: map[string]any{}}
			for dec.More() {
				keyTok, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key, ok := keyTok.(string)
				if !ok {
					return nil, fmt.Errorf("non-string object key")
				}
				value, err := decodeNext(dec)
				if err != nil {
					return nil, err
				}
				obj.Set(key, value)
			}
			if _, err := dec.Token(); err != nil { // consume '}'
				return nil, err
			}
			return obj, nil
		case '[':
			var arr []any
			for dec.More() {
				value, err := decodeNext(dec)
				if err != nil {
					return nil, err
				}
				arr = append(arr, value)
			}
			if _, err := dec.Token(); err != nil { // consume ']'
				return nil, err
			}
			if arr == nil {
				arr = []any{}
			}
			return arr, nil
		}
		return nil, fmt.Errorf("unexpected delimiter %v", t)
	default:
		return tok, nil
	}
}

// DumpJSON serializes a decoded value back to JSON text with the exact
// conventions of the stored contract: ", " and ": " separators, ASCII-only
// escaping, document key order, and literal number preservation.
func DumpJSON(value any) string {
	var b strings.Builder
	dumpJSON(&b, value)
	return b.String()
}

func dumpJSON(b *strings.Builder, value any) {
	switch v := value.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if v {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case json.Number:
		b.WriteString(v.String())
	case string:
		writeJSONString(b, v)
	case []any:
		b.WriteByte('[')
		for i, item := range v {
			if i > 0 {
				b.WriteString(", ")
			}
			dumpJSON(b, item)
		}
		b.WriteByte(']')
	case *Obj:
		b.WriteByte('{')
		for i, key := range v.Keys() {
			if i > 0 {
				b.WriteString(", ")
			}
			writeJSONString(b, key)
			b.WriteString(": ")
			dumpJSON(b, v.Get(key))
		}
		b.WriteByte('}')
	default:
		// Values injected by parser code (plain ints, floats) - rare.
		raw, _ := json.Marshal(v)
		b.Write(raw)
	}
}

// writeJSONString writes s with ASCII-only escaping.
func writeJSONString(b *strings.Builder, s string) {
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		default:
			switch {
			case r < 0x20:
				fmt.Fprintf(b, `\u%04x`, r)
			case r < 0x7f:
				b.WriteByte(byte(r))
			case r > 0xffff:
				r1, r2 := utf16.EncodeRune(r)
				fmt.Fprintf(b, `\u%04x\u%04x`, r1, r2)
			default:
				fmt.Fprintf(b, `\u%04x`, r)
			}
		}
	}
	b.WriteByte('"')
}

// MarshalJSON serializes the object with its document key order.
func (o *Obj) MarshalJSON() ([]byte, error) {
	var b strings.Builder
	b.WriteByte('{')
	for i, key := range o.Keys() {
		if i > 0 {
			b.WriteByte(',')
		}
		keyJSON, err := json.Marshal(key)
		if err != nil {
			return nil, err
		}
		b.Write(keyJSON)
		b.WriteByte(':')
		valJSON, err := json.Marshal(o.Get(key))
		if err != nil {
			return nil, err
		}
		b.Write(valJSON)
	}
	b.WriteByte('}')
	return []byte(b.String()), nil
}
