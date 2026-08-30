// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"strings"
	"testing"
	"time"
)

func TestResourceOrderSQLIsAClosedSet(t *testing.T) {
	cases := map[string]string{
		"created":   "ORDER BY l.created_at DESC, l.id DESC",
		"name":      "ORDER BY LOWER(l.name) ASC, l.id ASC",
		"name_desc": "ORDER BY LOWER(l.name) DESC, l.id DESC",
		"downloads": "ORDER BY COALESCE(v.download_count, 0) DESC, l.id DESC",
		// Anything unknown falls back to recency, never raw interpolation.
		"updated":             "ORDER BY l.updated_at DESC, l.id DESC",
		"; DROP TABLE agents": "ORDER BY l.updated_at DESC, l.id DESC",
	}
	for key, want := range cases {
		if got := resourceOrderSQL(key); got != want {
			t.Errorf("resourceOrderSQL(%q) = %q, want %q", key, got, want)
		}
	}
}

func TestSerializeResourceProjection(t *testing.T) {
	spec := resourceSpec{wire: "mcp", listing: "mcp_listings", version: "mcp_versions"}
	row := map[string]any{
		"id": "id-1", "name": "Weather", "namespace": "acme", "slug": "weather",
		"owner": "acme-team", "is_private": false, "ownership_scope": "user",
		"project_id": nil,
		"created_at": testNow, "updated_at": testNow,
		"v_description": "fetches weather", "v_status": "approved",
		"v_version": "1.2.0", "v_downloads": int64(9),
	}
	item := serializeResource(spec, row)
	if item.wire["qualified_name"] != "acme/weather" || item.wire["resource_type"] != "mcp" {
		t.Errorf("wire identity: %v", item.wire)
	}
	if item.wire["visibility"] != "public" || item.downloads != 9 {
		t.Errorf("visibility/downloads: %v", item.wire)
	}
	if item.nameLower != "weather" {
		t.Errorf("merge key: %q", item.nameLower)
	}

	// Private scope wins over the private flag; project scope alone means project.
	row["ownership_scope"] = "private"
	if got := serializeResource(spec, row).wire["visibility"]; got != "private" {
		t.Errorf("private scope: %v", got)
	}
	row["ownership_scope"] = "project"
	row["is_private"] = true
	if got := serializeResource(spec, row).wire["visibility"]; got != "project" {
		t.Errorf("project visibility: %v", got)
	}

	// Absent timestamps serialize as null, not empty strings.
	delete(row, "created_at")
	if got := serializeResource(spec, row).wire["created_at"]; got != nil {
		t.Errorf("absent created_at: %v", got)
	}
}

func TestResourceCompareTupleSemantics(t *testing.T) {
	a := resourceItem{typ: "mcp", id: "a", nameLower: "alpha", downloads: 5, updatedISO: "2026-08-30T08:00:00+00:00"}
	b := resourceItem{typ: "mcp", id: "b", nameLower: "beta", downloads: 2, updatedISO: "2026-08-29T08:00:00+00:00"}

	if resourceCompare("name", a, b) >= 0 {
		t.Error("alpha must sort before beta")
	}
	if resourceCompare("downloads", a, b) <= 0 {
		t.Error("higher downloads must compare greater")
	}
	if resourceCompare("updated", a, b) <= 0 {
		t.Error("newer updated must compare greater")
	}
	// Full ties break by type then id, keeping the merge deterministic.
	c := resourceItem{typ: "skill", id: "a", nameLower: "alpha"}
	d := resourceItem{typ: "mcp", id: "a", nameLower: "alpha"}
	if resourceCompare("name", c, d) <= 0 {
		t.Error("type must break name ties")
	}
}

func TestResourceQueryValidators(t *testing.T) {
	errs := []fieldError{}
	q := map[string][]string{
		"limit": {"25"}, "flag": {"yes"}, "since": {"2026-08-30"},
	}
	if got := resourceQueryInt(q, "limit", 50, 1, 200, &errs); got != 25 {
		t.Errorf("int: %d", got)
	}
	if !resourceQueryBool(q, "flag", &errs) {
		t.Error("bool: yes must be true")
	}
	if ts := resourceQueryTime(q, "since", &errs); ts == nil || ts.Format("2006-01-02") != "2026-08-30" {
		t.Errorf("time: %v", ts)
	}
	if got := resourceQueryInt(q, "absent", 50, 1, 200, &errs); got != 50 {
		t.Errorf("absent int default: %d", got)
	}
	if len(errs) != 0 {
		t.Fatalf("valid inputs produced errors: %v", errs)
	}

	bad := map[string][]string{
		"limit": {"soon"}, "cap": {"999"}, "floor": {"0"},
		"flag": {"perhaps"}, "since": {"yesterday"},
	}
	resourceQueryInt(bad, "limit", 50, 1, 200, &errs)
	resourceQueryInt(bad, "cap", 50, 1, 200, &errs)
	resourceQueryInt(bad, "floor", 50, 1, 200, &errs)
	resourceQueryBool(bad, "flag", &errs)
	resourceQueryTime(bad, "since", &errs)
	types := make([]string, len(errs))
	for i, e := range errs {
		types[i] = e.Type
	}
	want := "int_parsing,less_than_equal,greater_than_equal,bool_parsing,datetime_parsing"
	if strings.Join(types, ",") != want {
		t.Errorf("error types = %v", types)
	}
}

func TestTimeHelpers(t *testing.T) {
	early := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	late := time.Date(2026, 8, 30, 0, 0, 0, 0, time.UTC)
	// firstTime is positional: the first non-nil candidate wins.
	if got := firstTime(nil, &late, &early); got == nil || !got.Equal(late) {
		t.Errorf("firstTime = %v, want first non-nil", got)
	}
	if got := firstTime(nil, nil); got != nil {
		t.Errorf("firstTime all nil = %v", got)
	}
	if got := timePtr(late); got == nil || !got.Equal(late) {
		t.Errorf("timePtr = %v", got)
	}
	if got := timePtr("not a time"); got != nil {
		t.Errorf("timePtr non-time = %v", got)
	}
	if nilIfEmptyStr("") != nil || nilIfEmptyStr("x") != "x" {
		t.Error("nilIfEmptyStr contract")
	}
}
