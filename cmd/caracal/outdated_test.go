// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import "testing"

func TestParsePEP440Ordering(t *testing.T) {
	// Each pair is (older, newer) under the version-scheme rules.
	pairs := [][2]string{
		{"1.0.0", "1.0.1"},
		{"1.0.0", "1.1.0"},
		{"0.9", "0.10"},
		{"1.0.0a1", "1.0.0b1"},
		{"1.0.0b1", "1.0.0rc1"},
		{"1.0.0rc1", "1.0.0"},
		{"1.0.0", "1.0.0.post1"},
		{"1.0.0.dev1", "1.0.0a1"},
		{"1!0.5", "1!1.0"},
		{"2.0", "1!0.1"}, // epoch outranks release
		{"1.0.0", "v1.0.1"},
	}
	for _, pair := range pairs {
		older, err := parsePEP440(pair[0])
		if err != nil {
			t.Fatalf("parse %q: %v", pair[0], err)
		}
		newer, err := parsePEP440(pair[1])
		if err != nil {
			t.Fatalf("parse %q: %v", pair[1], err)
		}
		if comparePEP440(older, newer) >= 0 {
			t.Errorf("%q should order before %q", pair[0], pair[1])
		}
		if comparePEP440(newer, older) <= 0 {
			t.Errorf("%q should order after %q", pair[1], pair[0])
		}
	}
}

func TestParsePEP440Equivalence(t *testing.T) {
	pairs := [][2]string{
		{"1.0.0", "v1.0.0"},
		{"1.0.0", "1.0.0+local.build"},
		{"1.0.0rc1", "1.0.0c1"},
	}
	for _, pair := range pairs {
		a, err := parsePEP440(pair[0])
		if err != nil {
			t.Fatalf("parse %q: %v", pair[0], err)
		}
		b, err := parsePEP440(pair[1])
		if err != nil {
			t.Fatalf("parse %q: %v", pair[1], err)
		}
		if comparePEP440(a, b) != 0 {
			t.Errorf("%q and %q should compare equal", pair[0], pair[1])
		}
	}
}

func TestParsePEP440Invalid(t *testing.T) {
	for _, value := range []string{"", "abc", "1..0"} {
		if _, err := parsePEP440(value); err == nil {
			t.Errorf("%q should not parse", value)
		}
	}
}

func TestPepIntDefaultsToZero(t *testing.T) {
	if pepInt("") != 0 {
		t.Error("empty group should read 0")
	}
	if pepInt("42") != 42 {
		t.Error("digit group should parse")
	}
	// A digit run beyond int range reads 0 rather than garbage.
	if pepInt("99999999999999999999999999") != 0 {
		t.Error("overflowing group should read 0")
	}
}
