// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import (
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/registry"
)

func TestVisibilityLabels(t *testing.T) {
	cases := []struct {
		row  map[string]any
		want string
	}{
		{map[string]any{"ownership_scope": "private", "is_private": true}, "private"},
		{map[string]any{"is_private": true}, "project"},
		{map[string]any{"is_private": false}, "public"},
		{map[string]any{}, "public"},
	}
	for _, tc := range cases {
		if got := visibility(tc.row); got != tc.want {
			t.Errorf("visibility(%v) = %q, want %q", tc.row, got, tc.want)
		}
	}
}

func TestRowIntConversions(t *testing.T) {
	row := map[string]any{"a": int64(1), "b": int32(2), "c": int16(3), "d": "x"}
	if rowInt(row, "a") != 1 || rowInt(row, "b") != 2 || rowInt(row, "c") != 3 {
		t.Error("integer conversions wrong")
	}
	if rowInt(row, "d") != 0 || rowInt(row, "missing") != 0 {
		t.Error("non-integer values must read as zero")
	}
}

func TestWireTimeISO(t *testing.T) {
	whole := time.Date(2026, 8, 30, 8, 0, 5, 0, time.UTC)
	if got := wireTimeISO(whole); got != "2026-08-30T08:00:05+00:00" {
		t.Errorf("whole second: %v", got)
	}
	micros := time.Date(2026, 8, 30, 8, 0, 5, 123456000, time.UTC)
	if got := wireTimeISO(micros); got != "2026-08-30T08:00:05.123456+00:00" {
		t.Errorf("microseconds: %v", got)
	}
	if got := wireTimeISO(nil); got != nil {
		t.Errorf("non-time: %v", got)
	}
}

func TestPermissionGrants(t *testing.T) {
	owner := &registry.Viewer{ID: uuid.MustParse(viewerID), Role: "user"}
	other := &registry.Viewer{ID: uuid.MustParse(outsiderID), Role: "user"}
	operator := &registry.Viewer{ID: uuid.MustParse(outsiderID), Role: "operator"}
	row := map[string]any{"created_by": viewerID, "co_authors": []any{}}
	if permission(row, owner) != "owner" {
		t.Error("creator must own")
	}
	if permission(row, other) != "view" {
		t.Error("outsider must view")
	}
	if permission(row, operator) != "view" {
		t.Error("operator must not own other users' agents")
	}
	if permission(row, nil) != "view" {
		t.Error("anonymous must view")
	}
	coRow := map[string]any{"created_by": viewerID, "co_authors": []any{outsiderID}}
	if permission(coRow, other) != "owner" {
		t.Error("co-author must own")
	}
}

func TestMayViewUnapproved(t *testing.T) {
	reviewer := &registry.Viewer{ID: uuid.MustParse(outsiderID), Role: "reviewer"}
	if !mayViewUnapproved("view", reviewer) {
		t.Error("reviewer must pass the gate")
	}
	if !mayViewUnapproved("owner", nil) {
		t.Error("owner must pass the gate")
	}
	if mayViewUnapproved("view", &registry.Viewer{Role: "user"}) {
		t.Error("plain viewer must not pass the gate")
	}
}
