// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package harness

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
)

func newReader(data []byte) io.Reader { return bytes.NewReader(data) }

func expectDelim(dec *json.Decoder, want json.Delim) error {
	tok, err := dec.Token()
	if err != nil {
		return fmt.Errorf("read token: %w", err)
	}
	if d, ok := tok.(json.Delim); !ok || d != want {
		return fmt.Errorf("expected %q, got %v", want, tok)
	}
	return nil
}

func stringToken(dec *json.Decoder) (string, error) {
	tok, err := dec.Token()
	if err != nil {
		return "", fmt.Errorf("read token: %w", err)
	}
	s, ok := tok.(string)
	if !ok {
		return "", fmt.Errorf("expected string key, got %v", tok)
	}
	return s, nil
}

// skipValue consumes the next complete JSON value from the decoder.
func skipValue(dec *json.Decoder) error {
	tok, err := dec.Token()
	if err != nil {
		return fmt.Errorf("read token: %w", err)
	}
	d, ok := tok.(json.Delim)
	if !ok {
		return nil // scalar
	}
	if d != '{' && d != '[' {
		return fmt.Errorf("unexpected delimiter %v", d)
	}
	depth := 1
	for depth > 0 {
		tok, err := dec.Token()
		if err != nil {
			return fmt.Errorf("read token: %w", err)
		}
		if d, ok := tok.(json.Delim); ok {
			switch d {
			case '{', '[':
				depth++
			case '}', ']':
				depth--
			}
		}
	}
	return nil
}
