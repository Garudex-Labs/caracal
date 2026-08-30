// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insights

import (
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/registry"
)

func TestWireTime(t *testing.T) {
	whole := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	if got := wireTime(whole); got != "2026-01-02T03:04:05Z" {
		t.Errorf("whole seconds = %s", got)
	}
	micros := time.Date(2026, 1, 2, 3, 4, 5, 123450000, time.UTC)
	if got := wireTime(micros); got != "2026-01-02T03:04:05.123450Z" {
		t.Errorf("micros = %s", got)
	}
}

func TestVersionFilter(t *testing.T) {
	got := versionFilter("agent_version", false)
	want := "({agent_version:String} = '' OR agent_version = {agent_version:String} " +
		"OR ({agent_version:String} = '1.0.0' AND agent_version = ''))"
	if got != want {
		t.Errorf("filter = %s", got)
	}
	nullable := versionFilter("agent_version", true)
	if nullable == got {
		t.Error("nullable filter should coalesce")
	}
}

func TestRowPermission(t *testing.T) {
	creator := uuid.New()
	coAuthor := uuid.New()
	stranger := uuid.New()
	row := map[string]any{
		"created_by": creator.String(),
		"co_authors": []any{coAuthor.String()},
	}
	cases := []struct {
		name   string
		viewer *registry.Viewer
		want   string
	}{
		{"anonymous", nil, "view"},
		{"creator", &registry.Viewer{ID: creator, Role: "user"}, "owner"},
		{"co-author", &registry.Viewer{ID: coAuthor, Role: "user"}, "owner"},
		{"operator", &registry.Viewer{ID: stranger, Role: "operator"}, "view"},
		{"legacy admin", &registry.Viewer{ID: stranger, Role: "super_admin"}, "view"},
		{"stranger", &registry.Viewer{ID: stranger, Role: "user"}, "view"},
		{"reviewer", &registry.Viewer{ID: stranger, Role: "reviewer"}, "view"},
	}
	for _, tc := range cases {
		if got := rowPermission(row, tc.viewer); got != tc.want {
			t.Errorf("%s = %s, want %s", tc.name, got, tc.want)
		}
	}
}

func TestListItemNulls(t *testing.T) {
	rep := &Report{
		ID: "r1", AgentID: "a1", Status: "pending",
		PeriodStart: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		PeriodEnd:   time.Date(2026, 1, 15, 0, 0, 0, 0, time.UTC),
		CreatedAt:   time.Date(2026, 1, 15, 0, 0, 0, 0, time.UTC),
	}
	item := rep.ListItem()
	if item["completed_at"] != nil || item["agent_version"] != nil {
		t.Errorf("optional fields should be null: %v", item)
	}
	if item["progress_percent"] != 0 {
		t.Errorf("progress_percent = %v", item["progress_percent"])
	}
	detail := rep.Detail()
	if detail["applied_at"] != nil || detail["metrics"] != nil {
		t.Errorf("detail optional fields should be null: %v", detail)
	}
}
