// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import "testing"

func TestParseSemver(t *testing.T) {
	tests := []struct {
		version string
		want    [3]int
		ok      bool
	}{
		{"1.2.3", [3]int{1, 2, 3}, true},
		{"0.0.0", [3]int{0, 0, 0}, true},
		{"10.20.30", [3]int{10, 20, 30}, true},
		{"1.2", [3]int{}, false},
		{"1.2.3-beta", [3]int{}, false},
		{"01.2.3", [3]int{}, false},
		{"", [3]int{}, false},
		// Digit runs beyond int range must be rejected, not read as zero.
		{"99999999999999999999999999.0.0", [3]int{}, false},
	}
	for _, tc := range tests {
		major, minor, patch, ok := parseSemver(tc.version)
		if ok != tc.ok {
			t.Errorf("%q: ok = %v, want %v", tc.version, ok, tc.ok)
			continue
		}
		if ok && [3]int{major, minor, patch} != tc.want {
			t.Errorf("%q: parsed %v, want %v", tc.version, [3]int{major, minor, patch}, tc.want)
		}
	}
}

func TestSemverLess(t *testing.T) {
	pairs := [][2]string{
		{"1.0.0", "1.0.1"},
		{"1.0.9", "1.1.0"},
		{"1.9.9", "2.0.0"},
		{"9.0.0", "10.0.0"},
	}
	for _, pair := range pairs {
		if !semverLess(pair[0], pair[1]) {
			t.Errorf("%q should be less than %q", pair[0], pair[1])
		}
		if semverLess(pair[1], pair[0]) {
			t.Errorf("%q should not be less than %q", pair[1], pair[0])
		}
	}
	// Unparseable versions order before parseable ones and tie together.
	if !semverLess("garbage", "0.0.1") {
		t.Error("unparseable should order before parseable")
	}
	if semverLess("garbage", "junk") {
		t.Error("two unparseable versions should tie")
	}
}

func TestBumpVersion(t *testing.T) {
	tests := []struct {
		current, kind, want string
	}{
		{"1.2.3", "major", "2.0.0"},
		{"1.2.3", "minor", "1.3.0"},
		{"1.2.3", "patch", "1.2.4"},
		{"not-semver", "patch", "1.0.0"},
	}
	for _, tc := range tests {
		if got := bumpVersion(tc.current, tc.kind); got != tc.want {
			t.Errorf("bumpVersion(%q, %q) = %q, want %q", tc.current, tc.kind, got, tc.want)
		}
	}
}
