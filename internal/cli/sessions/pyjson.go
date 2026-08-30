// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// pyObject is an insertion-ordered JSON object.
type pyObject struct {
	keys   []string
	values map[string]any
}

func newPyObject() *pyObject {
	return &pyObject{values: map[string]any{}}
}

func (o *pyObject) set(key string, value any) {
	if _, exists := o.values[key]; !exists {
		o.keys = append(o.keys, key)
	}
	o.values[key] = value
}

// pyList is a JSON array preserving element order.
type pyList []any

// parsePyValue parses JSON preserving object key order; unparseable or empty
// input yields the fallback.
func parsePyValue(raw string, fallback any) any {
	if raw == "" {
		return fallback
	}
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.UseNumber()
	value, err := decodeOrdered(dec)
	if err != nil {
		return fallback
	}
	return value
}

func decodeOrdered(dec *json.Decoder) (any, error) {
	token, err := dec.Token()
	if err != nil {
		return nil, err
	}
	return decodeFromToken(dec, token)
}

func decodeFromToken(dec *json.Decoder, token json.Token) (any, error) {
	switch v := token.(type) {
	case json.Delim:
		switch v {
		case '{':
			object := newPyObject()
			for dec.More() {
				keyToken, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key, ok := keyToken.(string)
				if !ok {
					return nil, fmt.Errorf("object key is not a string")
				}
				value, err := decodeOrdered(dec)
				if err != nil {
					return nil, err
				}
				object.set(key, value)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return object, nil
		case '[':
			list := pyList{}
			for dec.More() {
				value, err := decodeOrdered(dec)
				if err != nil {
					return nil, err
				}
				list = append(list, value)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return list, nil
		}
		return nil, fmt.Errorf("unexpected delimiter %v", v)
	default:
		return v, nil
	}
}

// pyDumps renders a value the way the stored mirror format expects:
// ", " and ": " separators, insertion-ordered keys, and raw non-ASCII.
func pyDumps(value any) string {
	var sb strings.Builder
	writePyValue(&sb, value)
	return sb.String()
}

func writePyValue(sb *strings.Builder, value any) {
	switch v := value.(type) {
	case nil:
		sb.WriteString("null")
	case bool:
		if v {
			sb.WriteString("true")
		} else {
			sb.WriteString("false")
		}
	case string:
		writePyString(sb, v)
	case json.Number:
		writePyNumber(sb, v)
	case int:
		sb.WriteString(strconv.Itoa(v))
	case int64:
		sb.WriteString(strconv.FormatInt(v, 10))
	case float64:
		writePyFloat(sb, v)
	case *pyObject:
		sb.WriteByte('{')
		for i, key := range v.keys {
			if i > 0 {
				sb.WriteString(", ")
			}
			writePyString(sb, key)
			sb.WriteString(": ")
			writePyValue(sb, v.values[key])
		}
		sb.WriteByte('}')
	case pyList:
		sb.WriteByte('[')
		for i, item := range v {
			if i > 0 {
				sb.WriteString(", ")
			}
			writePyValue(sb, item)
		}
		sb.WriteByte(']')
	case []any:
		writePyValue(sb, pyList(v))
	case map[string]any:
		// Unordered maps only ever carry values built locally in fixed order.
		object := newPyObject()
		for key := range v {
			object.set(key, v[key])
		}
		writePyValue(sb, object)
	default:
		fmt.Fprint(sb, v)
	}
}

// writePyNumber keeps integer literals exact (arbitrary precision) and
// renders anything fractional or exponential through the float formatter.
func writePyNumber(sb *strings.Builder, number json.Number) {
	text := number.String()
	if !strings.ContainsAny(text, ".eE") {
		sb.WriteString(text)
		return
	}
	parsed, err := number.Float64()
	if err != nil {
		sb.WriteString(text)
		return
	}
	writePyFloat(sb, parsed)
}

// writePyFloat renders the shortest round-trip decimal, fixed notation for
// exponents in [-4, 16) and two-digit scientific notation outside it.
func writePyFloat(sb *strings.Builder, v float64) {
	if math.IsInf(v, 1) {
		sb.WriteString("Infinity")
		return
	}
	if math.IsInf(v, -1) {
		sb.WriteString("-Infinity")
		return
	}
	if math.IsNaN(v) {
		sb.WriteString("NaN")
		return
	}
	shortest := strconv.FormatFloat(v, 'e', -1, 64)
	mantissa, expText, _ := strings.Cut(shortest, "e")
	exp, _ := strconv.Atoi(expText)
	negative := strings.HasPrefix(mantissa, "-")
	mantissa = strings.TrimPrefix(mantissa, "-")
	digits := strings.Replace(mantissa, ".", "", 1)
	var out string
	switch {
	case exp < -4 || exp >= 16:
		out = digits[:1]
		if len(digits) > 1 {
			out += "." + digits[1:]
		}
		sign := "+"
		if exp < 0 {
			sign = "-"
			exp = -exp
		}
		out += fmt.Sprintf("e%s%02d", sign, exp)
	case exp >= 0:
		if exp+1 >= len(digits) {
			out = digits + strings.Repeat("0", exp+1-len(digits)) + ".0"
		} else {
			out = digits[:exp+1] + "." + digits[exp+1:]
		}
	default:
		out = "0." + strings.Repeat("0", -exp-1) + digits
	}
	if negative {
		out = "-" + out
	}
	sb.WriteString(out)
}

// writePyString escapes like the stored format: short escapes for common
// control characters, \u for the rest, non-ASCII left raw.
func writePyString(sb *strings.Builder, s string) {
	sb.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			sb.WriteString(`\"`)
		case '\\':
			sb.WriteString(`\\`)
		case '\n':
			sb.WriteString(`\n`)
		case '\r':
			sb.WriteString(`\r`)
		case '\t':
			sb.WriteString(`\t`)
		case '\b':
			sb.WriteString(`\b`)
		case '\f':
			sb.WriteString(`\f`)
		default:
			if r < 0x20 {
				fmt.Fprintf(sb, `\u%04x`, r)
			} else {
				sb.WriteRune(r)
			}
		}
	}
	sb.WriteByte('"')
}
