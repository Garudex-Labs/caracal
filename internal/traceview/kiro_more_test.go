// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package traceview

import (
	"encoding/json"
	"math"
	"testing"
)

func TestKiroAsCredits(t *testing.T) {
	tests := []struct {
		name   string
		in     any
		want   float64
		wantOK bool
	}{
		{"float", float64(5), 5, true},
		{"nan float", math.NaN(), 0, false},
		{"inf float", math.Inf(1), 0, false},
		{"json number", json.Number("12.5"), 12.5, true},
		{"bad json number", json.Number("not-a-number"), 0, false},
		{"numeric string", "3.5", 3.5, true},
		{"padded numeric string", "  7 ", 7, true},
		{"non-numeric string", "abc", 0, false},
		{"bool is unsupported", true, 0, false},
		{"nil is unsupported", nil, 0, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := kiroAsCredits(tc.in)
			if ok != tc.wantOK {
				t.Fatalf("kiroAsCredits(%#v) ok = %v, want %v", tc.in, ok, tc.wantOK)
			}
			if ok && got != tc.want {
				t.Errorf("kiroAsCredits(%#v) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

func TestKiroEpochToTimestamp(t *testing.T) {
	tests := []struct {
		name string
		in   any
		want any
	}{
		{"seconds in range", json.Number("1700000000"), "2023-11-14 22:13:20.000"},
		{"bool true is one second", true, "1970-01-01 00:00:01.000"},
		{"bool false is epoch", false, "1970-01-01 00:00:00.000"},
		{"unparsable number", json.Number("not-a-number"), nil},
		{"out of range high", json.Number("1e30"), nil},
		{"below minimum", json.Number("-62135596801"), nil},
		{"unsupported type", "2023", nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := kiroEpochToTimestamp(tc.in); got != tc.want {
				t.Errorf("kiroEpochToTimestamp(%#v) = %#v, want %#v", tc.in, got, tc.want)
			}
		})
	}
}

func TestKiroCreditsString(t *testing.T) {
	tests := []struct {
		name string
		in   any
		want string
	}{
		{"float uses float form", float64(4), "4.0"},
		{"json number uses scalar form", json.Number("5"), "5"},
		{"string passthrough", "abc", "abc"},
		{"nil renders none", nil, "None"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := kiroCreditsString(tc.in); got != tc.want {
				t.Errorf("kiroCreditsString(%#v) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}
