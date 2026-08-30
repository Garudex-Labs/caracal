// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package ingest

import "testing"

func TestKeyParamsMapsSessionKey(t *testing.T) {
	key := SessionKey{SessionID: "sess-9", ProjectID: "proj", UserID: "user-2", Harness: "kiro"}
	got := (&CHStore{}).keyParams(key)

	want := map[string]string{
		"param_pid":     "proj",
		"param_uid":     "user-2",
		"param_harness": "kiro",
		"param_sid":     "sess-9",
	}
	if len(got) != len(want) {
		t.Fatalf("keyParams len = %d, want %d (%#v)", len(got), len(want), got)
	}
	for k, v := range want {
		if gv, ok := got[k]; !ok || gv != v {
			t.Errorf("keyParams[%q] = %q (present=%v), want %q", k, gv, ok, v)
		}
	}
}

func TestJSONIntFromClickHouseCells(t *testing.T) {
	tests := []struct {
		name string
		in   any
		want int
	}{
		{"float cell", float64(1500), 1500},
		{"string cell for 64-bit column", "9007199254740993", 9007199254740993},
		{"empty string", "", 0},
		{"nil cell", nil, 0},
		{"non-numeric string", "n/a", 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := jsonInt(tc.in); got != tc.want {
				t.Errorf("jsonInt(%#v) = %d, want %d", tc.in, got, tc.want)
			}
		})
	}
}

func TestRecordConflictErrorMessage(t *testing.T) {
	tests := []struct {
		name    string
		offsets []int
		want    string
	}{
		{"single offset", []int{7}, "session source content changed at line(s): 7"},
		{"multiple offsets", []int{3, 8, 15}, "session source content changed at line(s): 3, 8, 15"},
		{"no offsets", nil, "session source content changed at line(s): "},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := &RecordConflictError{Offsets: tc.offsets}
			if got := err.Error(); got != tc.want {
				t.Errorf("Error() = %q, want %q", got, tc.want)
			}
		})
	}
}
