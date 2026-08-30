// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestWireTimeZ(t *testing.T) {
	whole := time.Date(2026, 8, 29, 8, 0, 0, 0, time.UTC)
	if got := wireTimeZ(whole); got != "2026-08-29T08:00:00Z" {
		t.Errorf("whole second = %v", got)
	}
	micros := time.Date(2026, 8, 29, 8, 0, 0, 123456000, time.UTC)
	if got := wireTimeZ(micros); got != "2026-08-29T08:00:00.123456Z" {
		t.Errorf("micros = %v", got)
	}
	if got := wireTimeZ(nil); got != nil {
		t.Errorf("nil = %v", got)
	}
}

func keysInOrder(t *testing.T, blob []byte) []string {
	t.Helper()
	dec := json.NewDecoder(strings.NewReader(string(blob)))
	keys := []string{}
	depth := 0
	for {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		switch v := tok.(type) {
		case json.Delim:
			if v == '{' || v == '[' {
				depth++
			} else {
				depth--
			}
		case string:
			if depth == 1 && dec.More() {
				keys = append(keys, v)
				// skip the value
				var skip json.RawMessage
				_ = dec.Decode(&skip)
			}
		}
	}
	return keys
}

func TestSummaryFieldOrder(t *testing.T) {
	now := time.Date(2026, 8, 29, 8, 0, 0, 0, time.UTC)
	row := map[string]any{
		"id": "abc", "name": "n", "namespace": "ns", "slug": "s", "owner": "o",
		"is_private": true, "updated_at": now,
		"version": "1.0.0", "description": "d", "status": "approved",
		"category": "general", "supported_harnesses": []any{"kiro"},
	}
	blob, err := json.Marshal(summarize(Families["mcps"], row))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"id", "name", "namespace", "slug", "qualified_name", "version", "description",
		"category", "owner", "project_id", "visibility", "is_private",
		"supported_harnesses", "status", "rejection_reason", "updated_at",
	}
	got := keysInOrder(t, blob)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("mcp order = %v", got)
	}
	var decoded map[string]any
	_ = json.Unmarshal(blob, &decoded)
	if decoded["qualified_name"] != "ns/s" || decoded["visibility"] != "project" ||
		decoded["updated_at"] != "2026-08-29T08:00:00Z" || decoded["project_id"] != nil {
		t.Fatalf("values = %s", blob)
	}
}

func TestSummaryFallbacksWithoutVersion(t *testing.T) {
	// A draft row from /my with no latest version resolves the compat defaults.
	row := map[string]any{
		"id": "abc", "name": "n", "namespace": "ns", "slug": "s", "owner": "o",
		"is_private": false,
	}
	blob, _ := json.Marshal(summarize(Families["sandboxes"], row))
	var d map[string]any
	_ = json.Unmarshal(blob, &d)
	checks := map[string]any{
		"version": "0.0.0", "description": "", "status": "draft",
		"network_policy": "none", "image": "", "visibility": "public",
	}
	for k, want := range checks {
		if d[k] != want {
			t.Errorf("%s = %v, want %v", k, d[k], want)
		}
	}
	if len(d["supported_harnesses"].([]any)) != 0 || len(d["resource_limits"].(map[string]any)) != 0 {
		t.Errorf("empty collections wrong: %s", blob)
	}
	if _, has := d["download_count"]; has {
		t.Error("sandbox summary must not carry download_count")
	}
	if d["entrypoint"] != nil || d["rejection_reason"] != nil || d["updated_at"] != nil {
		t.Errorf("nullables wrong: %s", blob)
	}
}

func TestSummaryPrivateScopeVisibility(t *testing.T) {
	row := map[string]any{
		"id": "abc", "name": "n", "namespace": "ns", "slug": "s", "owner": "o",
		"is_private": true, "ownership_scope": "private",
		"version": "1.0.0", "description": "d", "status": "approved", "event": "pre_tool", "scope": "agent",
	}
	blob, _ := json.Marshal(summarize(Families["hooks"], row))
	var d map[string]any
	_ = json.Unmarshal(blob, &d)
	if d["visibility"] != "private" {
		t.Errorf("visibility = %v", d["visibility"])
	}
}

func TestBuildListQueryShape(t *testing.T) {
	f := Families["skills"]
	p := ListParams{
		Namespace: " Tools ", Search: "clickhouse", ComposableForProjectID: "11111111-1111-1111-1111-111111111111",
		Limit: 50, Offset: 0, Extra: map[string]string{"task_type": "review"},
		Harness: "kiro", TargetAgent: "reviewer",
	}
	listSQL, countSQL, args := buildListQuery(f, p, nil)
	for _, frag := range []string{
		"v.status = 'approved'", "l.project_id =", "l.namespace =",
		"v.task_type =", "v.supported_harnesses::text ILIKE", "AS rank",
		"ORDER BY rank DESC, l.created_at DESC", "LIMIT", "OFFSET",
	} {
		if !strings.Contains(listSQL, frag) {
			t.Errorf("list SQL missing %q:\n%s", frag, listSQL)
		}
	}
	if strings.Contains(countSQL, "LIMIT") || strings.Contains(countSQL, "rank") {
		t.Errorf("count SQL carries pagination or rank: %s", countSQL)
	}
	if args[0] != "11111111-1111-1111-1111-111111111111" {
		t.Errorf("first arg = %v", args[0])
	}
	if got := args[len(args)-2]; got != 50 {
		t.Errorf("limit arg = %v", got)
	}
	// anonymous viewer sees only public rows
	if !strings.Contains(listSQL, "l.is_private = FALSE") {
		t.Error("anonymous visibility clause missing")
	}
}
