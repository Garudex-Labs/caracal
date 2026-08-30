// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestFloatRepr(t *testing.T) {
	cases := map[string]string{
		"3e-06":              "3e-06",
		"1e-05":              "1e-05",
		"1e-4":               "0.0001",
		"0.0001":             "0.0001",
		"1e15":               "1000000000000000.0",
		"1e16":               "1e+16",
		"1.5e16":             "1.5e+16",
		"1000.0":             "1000.0",
		"0.0":                "0.0",
		"-0.0":               "-0.0",
		"2.5":                "2.5",
		"8192.0":             "8192.0",
		"4.1e-07":            "4.1e-07",
		"123.456":            "123.456",
		"1e100":              "1e+100",
		"1e-100":             "1e-100",
		"9999999999999998.0": "9999999999999998.0",
		"-3e-06":             "-3e-06",
		"0.1":                "0.1",
		"1e-06":              "1e-06",
		"7e-323":             "7e-323",
	}
	for lit, want := range cases {
		var b strings.Builder
		encodeNumber(&b, json.Number(lit))
		if b.String() != want {
			t.Errorf("encodeNumber(%q) = %q, want %q", lit, b.String(), want)
		}
	}
}

func TestEncodeNumberIntPassthrough(t *testing.T) {
	for _, lit := range []string{"0", "8192", "-3", "128000"} {
		var b strings.Builder
		encodeNumber(&b, json.Number(lit))
		if b.String() != lit {
			t.Errorf("encodeNumber(%q) = %q, want passthrough", lit, b.String())
		}
	}
}
