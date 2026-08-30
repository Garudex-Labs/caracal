// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import (
	"fmt"
	"reflect"
	"testing"
)

func numberedLines(n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = fmt.Sprintf("%d\n", i+1)
	}
	return out
}

func TestUnifiedDiffIdenticalInputsProduceNothing(t *testing.T) {
	a := []string{"a\n", "b\n"}
	if got := unifiedDiff(a, a, "before", "after"); len(got) != 0 {
		t.Errorf("identical inputs: %q", got)
	}
}

func TestUnifiedDiffReplaceWithContext(t *testing.T) {
	a := []string{"a\n", "b\n", "c\n"}
	b := []string{"a\n", "x\n", "c\n"}
	want := []string{
		"--- before", "+++ after",
		"@@ -1,3 +1,3 @@",
		" a", "-b", "+x", " c",
	}
	if got := unifiedDiff(a, b, "before", "after"); !reflect.DeepEqual(got, want) {
		t.Errorf("replace diff:\ngot  %q\nwant %q", got, want)
	}
}

func TestUnifiedDiffInsertIntoEmpty(t *testing.T) {
	want := []string{"--- before", "+++ after", "@@ -0,0 +1 @@", "+x"}
	if got := unifiedDiff(nil, []string{"x\n"}, "before", "after"); !reflect.DeepEqual(got, want) {
		t.Errorf("insert into empty:\ngot  %q\nwant %q", got, want)
	}
}

func TestUnifiedDiffSplitsDistantChangesIntoHunks(t *testing.T) {
	a := numberedLines(20)
	b := numberedLines(20)
	b[2] = "3x\n"
	b[16] = "17x\n"
	want := []string{
		"--- before", "+++ after",
		"@@ -1,6 +1,6 @@",
		" 1", " 2", "-3", "+3x", " 4", " 5", " 6",
		"@@ -14,7 +14,7 @@",
		" 14", " 15", " 16", "-17", "+17x", " 18", " 19", " 20",
	}
	if got := unifiedDiff(a, b, "before", "after"); !reflect.DeepEqual(got, want) {
		t.Errorf("two-hunk diff:\ngot  %q\nwant %q", got, want)
	}
}

func TestUnifiedDiffSeesMissingTrailingNewline(t *testing.T) {
	got := unifiedDiff(snapshotLines("x\n"), snapshotLines("x"), "before", "after")
	want := []string{"--- before", "+++ after", "@@ -1 +1 @@", "-x", "+x"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("trailing-newline diff:\ngot  %q\nwant %q", got, want)
	}
}

func TestFormatRangeUnified(t *testing.T) {
	cases := []struct {
		start, stop int
		want        string
	}{
		{0, 1, "1"},
		{0, 3, "1,3"},
		{13, 20, "14,7"},
		{0, 0, "0,0"},
		{5, 5, "5,0"},
	}
	for _, tc := range cases {
		if got := formatRangeUnified(tc.start, tc.stop); got != tc.want {
			t.Errorf("formatRangeUnified(%d, %d) = %q, want %q", tc.start, tc.stop, got, tc.want)
		}
	}
}

func TestSnapshotLinesKeepsLineEndings(t *testing.T) {
	if got := snapshotLines(""); got != nil {
		t.Errorf("empty text: %q", got)
	}
	if got, want := snapshotLines("a\nb\n"), []string{"a\n", "b\n"}; !reflect.DeepEqual(got, want) {
		t.Errorf("terminated text: got %q, want %q", got, want)
	}
	if got, want := snapshotLines("a\nb"), []string{"a\n", "b"}; !reflect.DeepEqual(got, want) {
		t.Errorf("unterminated text: got %q, want %q", got, want)
	}
}

func TestUnifiedDiffAutoJunkStillFindsTheChange(t *testing.T) {
	// 300 blank lines make "\n" popular (auto-junk); the changed line must
	// still surface in the diff.
	a := make([]string, 300)
	for i := range a {
		a[i] = "\n"
	}
	b := append([]string{}, a...)
	b[150] = "changed\n"
	got := unifiedDiff(a, b, "before", "after")
	found := false
	for _, line := range got {
		if line == "+changed" {
			found = true
		}
	}
	if !found {
		t.Errorf("change swallowed by auto-junk: %q", got)
	}
}
