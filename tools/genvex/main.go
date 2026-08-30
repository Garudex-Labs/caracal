// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Command genvex generates a timestamped OpenVEX document from static VEX
// statements, preserving the source document's key order.
package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

const source = ".github/vex/caracal.vex.json"

// object is a JSON object that remembers key insertion order.
type object struct {
	keys []string
	vals map[string]any
}

func (o *object) set(key string, val any) {
	if _, ok := o.vals[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.vals[key] = val
}

func parseValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	delim, ok := tok.(json.Delim)
	if !ok {
		return tok, nil
	}
	switch delim {
	case '{':
		obj := &object{vals: map[string]any{}}
		for dec.More() {
			keyTok, err := dec.Token()
			if err != nil {
				return nil, err
			}
			key, ok := keyTok.(string)
			if !ok {
				return nil, fmt.Errorf("expected object key, got %v", keyTok)
			}
			val, err := parseValue(dec)
			if err != nil {
				return nil, err
			}
			obj.set(key, val)
		}
		if _, err := dec.Token(); err != nil {
			return nil, err
		}
		return obj, nil
	case '[':
		arr := []any{}
		for dec.More() {
			val, err := parseValue(dec)
			if err != nil {
				return nil, err
			}
			arr = append(arr, val)
		}
		if _, err := dec.Token(); err != nil {
			return nil, err
		}
		return arr, nil
	}
	return nil, fmt.Errorf("unexpected delimiter %v", delim)
}

func encodeString(b *strings.Builder, s string) {
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
			case r < 0x20 || r >= 0x7f && r <= 0xffff:
				fmt.Fprintf(b, `\u%04x`, r)
			case r > 0xffff:
				hi, lo := utf16.EncodeRune(r)
				fmt.Fprintf(b, `\u%04x\u%04x`, hi, lo)
			default:
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
}

func encodeNumber(b *strings.Builder, n json.Number) {
	lit := string(n)
	if !strings.ContainsAny(lit, ".eE") {
		b.WriteString(lit)
		return
	}
	f, err := strconv.ParseFloat(lit, 64)
	if err != nil {
		b.WriteString(lit)
		return
	}
	b.WriteString(floatRepr(f))
}

// floatRepr renders a float using the shortest round-trip decimal form:
// fixed notation while the decimal exponent is in [-4, 16), otherwise
// scientific notation with a signed two-digit exponent.
func floatRepr(f float64) string {
	if math.IsInf(f, 1) {
		return "Infinity"
	}
	if math.IsInf(f, -1) {
		return "-Infinity"
	}
	if math.IsNaN(f) {
		return "NaN"
	}
	s := strconv.FormatFloat(f, 'e', -1, 64)
	neg := strings.HasPrefix(s, "-")
	s = strings.TrimPrefix(s, "-")
	mantExp := strings.SplitN(s, "e", 2)
	digits := strings.Replace(mantExp[0], ".", "", 1)
	exp, _ := strconv.Atoi(mantExp[1])
	var out string
	if exp >= -4 && exp < 16 {
		switch {
		case exp >= len(digits)-1:
			out = digits + strings.Repeat("0", exp-(len(digits)-1)) + ".0"
		case exp >= 0:
			out = digits[:exp+1] + "." + digits[exp+1:]
		default:
			out = "0." + strings.Repeat("0", -exp-1) + digits
		}
	} else {
		mant := digits[:1]
		if len(digits) > 1 {
			mant += "." + digits[1:]
		}
		sign := "+"
		e := exp
		if e < 0 {
			sign = "-"
			e = -e
		}
		out = fmt.Sprintf("%se%s%02d", mant, sign, e)
	}
	if neg {
		out = "-" + out
	}
	return out
}

func writeValue(b *strings.Builder, v any, indent int) {
	pad := strings.Repeat("  ", indent)
	childPad := strings.Repeat("  ", indent+1)
	switch t := v.(type) {
	case *object:
		if len(t.keys) == 0 {
			b.WriteString("{}")
			return
		}
		b.WriteString("{\n")
		for i, key := range t.keys {
			b.WriteString(childPad)
			encodeString(b, key)
			b.WriteString(": ")
			writeValue(b, t.vals[key], indent+1)
			if i < len(t.keys)-1 {
				b.WriteByte(',')
			}
			b.WriteByte('\n')
		}
		b.WriteString(pad)
		b.WriteByte('}')
	case []any:
		if len(t) == 0 {
			b.WriteString("[]")
			return
		}
		b.WriteString("[\n")
		for i, item := range t {
			b.WriteString(childPad)
			writeValue(b, item, indent+1)
			if i < len(t)-1 {
				b.WriteByte(',')
			}
			b.WriteByte('\n')
		}
		b.WriteString(pad)
		b.WriteByte(']')
	case string:
		encodeString(b, t)
	case json.Number:
		encodeNumber(b, t)
	case bool:
		if t {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case nil:
		b.WriteString("null")
	default:
		fmt.Fprintf(b, "%v", t)
	}
}

func fatal(err error) {
	fmt.Fprintf(os.Stderr, "error: %v\n", err)
	os.Exit(1)
}

func main() {
	output := "caracal.openvex.json"
	if len(os.Args) > 1 {
		output = os.Args[1]
	}

	f, err := os.Open(source)
	if err != nil {
		fatal(err)
	}
	dec := json.NewDecoder(f)
	dec.UseNumber()
	parsed, err := parseValue(dec)
	_ = f.Close()
	if err != nil {
		fatal(fmt.Errorf("parsing %s: %w", source, err))
	}
	vex, ok := parsed.(*object)
	if !ok {
		fatal(fmt.Errorf("parsing %s: top-level value is not an object", source))
	}

	vex.set("timestamp", time.Now().UTC().Format("2006-01-02T15:04:05Z"))

	var b strings.Builder
	writeValue(&b, vex, 0)
	b.WriteByte('\n')
	if err := os.WriteFile(output, []byte(b.String()), 0o644); err != nil {
		fatal(err)
	}

	statements, ok := vex.vals["statements"].([]any)
	if !ok {
		fatal(fmt.Errorf("%s has no 'statements' list", source))
	}
	fmt.Printf("Generated VEX document: %s (%d statements)\n", output, len(statements))
}
