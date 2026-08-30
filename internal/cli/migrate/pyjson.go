// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package migrate

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

// Doc is an insertion-ordered JSON object.
type Doc struct {
	keys []string
	vals []any
}

// NewDoc returns an empty ordered object.
func NewDoc() *Doc { return &Doc{} }

// Set appends or replaces a key, preserving first-insertion position.
func (d *Doc) Set(key string, val any) *Doc {
	for i, k := range d.keys {
		if k == key {
			d.vals[i] = val
			return d
		}
	}
	d.keys = append(d.keys, key)
	d.vals = append(d.vals, val)
	return d
}

// Get returns the value stored under key.
func (d *Doc) Get(key string) (any, bool) {
	for i, k := range d.keys {
		if k == key {
			return d.vals[i], true
		}
	}
	return nil, false
}

// Keys returns the insertion-ordered key list.
func (d *Doc) Keys() []string { return d.keys }

// GetDoc returns the nested object under key, or an empty one.
func (d *Doc) GetDoc(key string) *Doc {
	if v, ok := d.Get(key); ok {
		if sub, ok := v.(*Doc); ok {
			return sub
		}
	}
	return NewDoc()
}

// GetString returns the string under key, or "".
func (d *Doc) GetString(key string) string {
	if v, ok := d.Get(key); ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// GetInt returns the integer under key, or 0.
func (d *Doc) GetInt(key string) int64 {
	if v, ok := d.Get(key); ok {
		if n, ok := v.(json.Number); ok {
			if i, err := n.Int64(); err == nil {
				return i
			}
			if f, err := n.Float64(); err == nil {
				return int64(f)
			}
		}
	}
	return 0
}

// pyStr renders a JSON string with ASCII-only escaping: characters outside
// the printable ASCII range are emitted as \uXXXX (surrogate pairs beyond
// the BMP), matching the archive text encoding.
func pyStr(s string) string {
	var b strings.Builder
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
			case r < 0x20 || r > 0x7e:
				if r > 0xffff {
					hi, lo := utf16.EncodeRune(r)
					fmt.Fprintf(&b, `\u%04x\u%04x`, hi, lo)
				} else {
					fmt.Fprintf(&b, `\u%04x`, r)
				}
			default:
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

// pyFloat renders a float in shortest round-trip decimal form: fixed
// notation for exponents in [-4, 16), otherwise scientific with a signed
// two-digit exponent. Integral fixed values keep a trailing ".0".
func pyFloat(f float64) string {
	if math.IsNaN(f) {
		return "NaN"
	}
	if math.IsInf(f, 1) {
		return "Infinity"
	}
	if math.IsInf(f, -1) {
		return "-Infinity"
	}
	sci := strconv.FormatFloat(f, 'e', -1, 64)
	idx := strings.IndexByte(sci, 'e')
	exp, _ := strconv.Atoi(sci[idx+1:])
	if exp < -4 || exp >= 16 {
		return sci
	}
	fixed := strconv.FormatFloat(f, 'f', -1, 64)
	if !strings.Contains(fixed, ".") {
		fixed += ".0"
	}
	return fixed
}

// round2 rounds to two decimal places for duration reporting.
func round2(f float64) float64 { return math.Round(f*100) / 100 }

// FormatFloat renders a float in the decimal notation used across
// migration documents.
func FormatFloat(f float64) string { return pyFloat(f) }

// dumpValue writes one value in compact form with ", " and ": " separators.
func dumpValue(b *strings.Builder, v any) {
	switch t := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if t {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case string:
		b.WriteString(pyStr(t))
	case int:
		b.WriteString(strconv.Itoa(t))
	case int64:
		b.WriteString(strconv.FormatInt(t, 10))
	case float64:
		b.WriteString(pyFloat(t))
	case json.Number:
		b.WriteString(t.String())
	case *Doc:
		b.WriteByte('{')
		for i, k := range t.keys {
			if i > 0 {
				b.WriteString(", ")
			}
			b.WriteString(pyStr(k))
			b.WriteString(": ")
			dumpValue(b, t.vals[i])
		}
		b.WriteByte('}')
	case []any:
		b.WriteByte('[')
		for i, item := range t {
			if i > 0 {
				b.WriteString(", ")
			}
			dumpValue(b, item)
		}
		b.WriteByte(']')
	case []string:
		b.WriteByte('[')
		for i, item := range t {
			if i > 0 {
				b.WriteString(", ")
			}
			b.WriteString(pyStr(item))
		}
		b.WriteByte(']')
	default:
		b.WriteString(pyStr(fmt.Sprintf("%v", t)))
	}
}

// dumps renders a value compactly with ", " and ": " separators.
func dumps(v any) string {
	var b strings.Builder
	dumpValue(&b, v)
	return b.String()
}

// dumpIndentValue writes one value with two-space indentation.
func dumpIndentValue(b *strings.Builder, v any, depth int) {
	pad := strings.Repeat("  ", depth+1)
	closePad := strings.Repeat("  ", depth)
	switch t := v.(type) {
	case *Doc:
		if len(t.keys) == 0 {
			b.WriteString("{}")
			return
		}
		b.WriteString("{\n")
		for i, k := range t.keys {
			if i > 0 {
				b.WriteString(",\n")
			}
			b.WriteString(pad)
			b.WriteString(pyStr(k))
			b.WriteString(": ")
			dumpIndentValue(b, t.vals[i], depth+1)
		}
		b.WriteString("\n")
		b.WriteString(closePad)
		b.WriteByte('}')
	case []any:
		if len(t) == 0 {
			b.WriteString("[]")
			return
		}
		b.WriteString("[\n")
		for i, item := range t {
			if i > 0 {
				b.WriteString(",\n")
			}
			b.WriteString(pad)
			dumpIndentValue(b, item, depth+1)
		}
		b.WriteString("\n")
		b.WriteString(closePad)
		b.WriteByte(']')
	case []string:
		items := make([]any, len(t))
		for i, s := range t {
			items[i] = s
		}
		dumpIndentValue(b, items, depth)
	default:
		dumpValue(b, v)
	}
}

// dumpsIndent renders a value with two-space indentation, matching the
// manifest file layout.
func dumpsIndent(v any) string {
	var b strings.Builder
	dumpIndentValue(&b, v, 0)
	return b.String()
}

// parseOrdered decodes JSON preserving object key order. Objects become
// *Doc, arrays []any, numbers json.Number.
func parseOrdered(data []byte) (any, error) {
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.UseNumber()
	v, err := parseOrderedValue(dec)
	if err != nil {
		return nil, err
	}
	return v, nil
}

func parseOrderedValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			doc := NewDoc()
			for dec.More() {
				keyTok, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key, ok := keyTok.(string)
				if !ok {
					return nil, fmt.Errorf("invalid object key %v", keyTok)
				}
				val, err := parseOrderedValue(dec)
				if err != nil {
					return nil, err
				}
				doc.Set(key, val)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return doc, nil
		case '[':
			items := []any{}
			for dec.More() {
				val, err := parseOrderedValue(dec)
				if err != nil {
					return nil, err
				}
				items = append(items, val)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return items, nil
		}
		return nil, fmt.Errorf("unexpected delimiter %v", t)
	default:
		return tok, nil
	}
}

// sortedStrings returns a sorted copy of the input.
func sortedStrings(values []string) []string {
	out := append([]string(nil), values...)
	sort.Strings(out)
	return out
}
