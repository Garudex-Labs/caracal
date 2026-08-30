// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import "testing"

func TestParseSemverAgents(t *testing.T) {
	cases := []struct {
		in    string
		major int
		minor int
		patch int
		ok    bool
	}{
		{"0.0.0", 0, 0, 0, true},
		{"1.2.3", 1, 2, 3, true},
		{"10.20.30", 10, 20, 30, true},
		{"1.2", 0, 0, 0, false},
		{"v1.2.3", 0, 0, 0, false},
		{"1.02.3", 0, 0, 0, false},
		{"1.2.3-rc1", 0, 0, 0, false},
		{"", 0, 0, 0, false},
		{"99999999999999999999.0.0", 0, 0, 0, false},
	}
	for _, tc := range cases {
		major, minor, patch, ok := parseSemver(tc.in)
		if major != tc.major || minor != tc.minor || patch != tc.patch || ok != tc.ok {
			t.Errorf("parseSemver(%q) = (%d,%d,%d,%v), want (%d,%d,%d,%v)",
				tc.in, major, minor, patch, ok, tc.major, tc.minor, tc.patch, tc.ok)
		}
	}
}

func TestSemverLessAgents(t *testing.T) {
	cases := []struct {
		a, b [3]int
		want bool
	}{
		{[3]int{1, 0, 0}, [3]int{2, 0, 0}, true},
		{[3]int{1, 2, 0}, [3]int{1, 10, 0}, true},
		{[3]int{1, 2, 3}, [3]int{1, 2, 4}, true},
		{[3]int{1, 2, 3}, [3]int{1, 2, 3}, false},
		{[3]int{2, 0, 0}, [3]int{1, 9, 9}, false},
	}
	for _, tc := range cases {
		if got := semverLess(tc.a, tc.b); got != tc.want {
			t.Errorf("semverLess(%v, %v) = %v, want %v", tc.a, tc.b, got, tc.want)
		}
	}
}

func TestBumpVersionAgents(t *testing.T) {
	cases := []struct {
		current, bump, want string
	}{
		{"1.10.7", "patch", "1.10.8"},
		{"1.10.7", "minor", "1.11.0"},
		{"1.10.7", "major", "2.0.0"},
		{"1.10.7", "anything-else", "1.10.8"},
		{"not-semver", "patch", "1.0.0"},
		{"", "major", "1.0.0"},
	}
	for _, tc := range cases {
		if got := bumpVersion(tc.current, tc.bump); got != tc.want {
			t.Errorf("bumpVersion(%q, %q) = %q, want %q", tc.current, tc.bump, got, tc.want)
		}
	}
}
