// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// omap is a JSON object that remembers key insertion order.
type omap struct {
	keys []string
	vals map[string]any
}

func newOmap() *omap { return &omap{vals: map[string]any{}} }

// MarshalJSON emits keys in insertion order.
func (o *omap) MarshalJSON() ([]byte, error) { return marshalOrdered(o) }

func (o *omap) get(key string) any { return o.vals[key] }

func (o *omap) has(key string) bool {
	_, ok := o.vals[key]
	return ok
}

func (o *omap) set(key string, value any) {
	if _, ok := o.vals[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.vals[key] = value
}

func (o *omap) remove(key string) {
	if _, ok := o.vals[key]; !ok {
		return
	}
	delete(o.vals, key)
	for i, existing := range o.keys {
		if existing == key {
			o.keys = append(o.keys[:i], o.keys[i+1:]...)
			break
		}
	}
}

func (o *omap) len() int { return len(o.keys) }

func (o *omap) str(key string) string {
	text, _ := o.vals[key].(string)
	return text
}

func (o *omap) object(key string) *omap {
	inner, _ := o.vals[key].(*omap)
	return inner
}

func (o *omap) array(key string) []any {
	items, _ := o.vals[key].([]any)
	return items
}

// decodeOrderedJSON parses JSON preserving object key order.
func decodeOrderedJSON(blob []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(blob))
	dec.UseNumber()
	value, err := decodeOrderedValue(dec)
	if err != nil {
		return nil, err
	}
	if dec.More() {
		return nil, fmt.Errorf("trailing data after JSON value")
	}
	return value, nil
}

func decodeOrderedValue(dec *json.Decoder) (any, error) {
	token, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch tok := token.(type) {
	case json.Delim:
		switch tok {
		case '{':
			object := newOmap()
			for dec.More() {
				keyToken, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key, _ := keyToken.(string)
				value, err := decodeOrderedValue(dec)
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
			items := []any{}
			for dec.More() {
				value, err := decodeOrderedValue(dec)
				if err != nil {
					return nil, err
				}
				items = append(items, value)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return items, nil
		}
		return nil, fmt.Errorf("unexpected delimiter %v", tok)
	default:
		return token, nil
	}
}

// plain converts ordered values back to standard Go JSON shapes.
func plain(value any) any {
	switch v := value.(type) {
	case *omap:
		out := map[string]any{}
		for _, key := range v.keys {
			out[key] = plain(v.vals[key])
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = plain(item)
		}
		return out
	case json.Number:
		return v
	default:
		return v
	}
}

// marshalOrdered renders a value with omap key order preserved.
func marshalOrdered(value any) ([]byte, error) {
	var buf bytes.Buffer
	if err := writeOrderedSep(&buf, value, ", ", ": "); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// marshalOrderedCompact renders without separator whitespace.
func marshalOrderedCompact(value any) ([]byte, error) {
	var buf bytes.Buffer
	if err := writeOrderedSep(&buf, value, ",", ":"); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func writeOrderedSep(buf *bytes.Buffer, value any, itemSep, kvSep string) error {
	switch v := value.(type) {
	case *omap:
		if v == nil {
			buf.WriteString("null")
			return nil
		}
		buf.WriteByte('{')
		for i, key := range v.keys {
			if i > 0 {
				buf.WriteString(itemSep)
			}
			buf.WriteString(jsonString(key))
			buf.WriteString(kvSep)
			if err := writeOrderedSep(buf, v.vals[key], itemSep, kvSep); err != nil {
				return err
			}
		}
		buf.WriteByte('}')
		return nil
	case []any:
		buf.WriteByte('[')
		for i, item := range v {
			if i > 0 {
				buf.WriteString(itemSep)
			}
			if err := writeOrderedSep(buf, item, itemSep, kvSep); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
		return nil
	case json.Number:
		buf.WriteString(v.String())
		return nil
	default:
		blob, err := json.Marshal(v)
		if err != nil {
			return err
		}
		buf.Write(blob)
		return nil
	}
}
