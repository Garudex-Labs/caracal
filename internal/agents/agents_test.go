// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/garudex-labs/caracal/internal/registry"
)

func TestSummaryFieldOrderAndValues(t *testing.T) {
	now := time.Date(2026, 8, 29, 8, 0, 0, 0, time.UTC)
	row := map[string]any{
		"id": "abc", "name": "n", "namespace": "ns", "slug": "s", "owner": "o",
		"is_private": true, "created_at": now, "updated_at": now,
		"version": "1.0.0", "description": "d", "status": "approved",
		"model_name": "m1", "supported_harnesses": []any{"kiro"},
		"download_count": int32(7), "component_count": int64(3),
		"created_by":       "u1",
		"created_by_email": "e@x", "created_by_username": "u",
	}
	blob, err := json.Marshal(summarize(row))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"id", "name", "namespace", "slug", "qualified_name", "version", "description",
		"owner", "project_id", "visibility", "is_private", "model_name",
		"supported_harnesses", "required_capabilities", "inferred_supported_harnesses",
		"status", "rejection_reason", "download_count",
		"component_count", "created_by", "created_by_email", "created_by_username",
		"created_at", "deleted_at", "scheduled_purge_at", "updated_at", "components_ready", "blocking_components",
	}
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
				var skip json.RawMessage
				_ = dec.Decode(&skip)
			}
		}
	}
	if strings.Join(keys, ",") != strings.Join(want, ",") {
		t.Fatalf("field order = %v", keys)
	}
	var d map[string]any
	_ = json.Unmarshal(blob, &d)
	if d["visibility"] != "project" || d["qualified_name"] != "ns/s" ||
		d["components_ready"] != true || d["deleted_at"] != nil || d["scheduled_purge_at"] != nil {
		t.Fatalf("values wrong: %s", blob)
	}
}

func TestVersionlessFallbacks(t *testing.T) {
	row := map[string]any{
		"id": "abc", "name": "n", "namespace": "ns", "slug": "s", "owner": "o",
		"is_private": false,
	}
	blob, _ := json.Marshal(summarize(row))
	var d map[string]any
	_ = json.Unmarshal(blob, &d)
	for k, want := range map[string]any{
		"version": "0.0.0", "description": "", "status": "draft", "model_name": "",
		"download_count": float64(0), "created_by_email": "",
	} {
		if d[k] != want {
			t.Errorf("%s = %v, want %v", k, d[k], want)
		}
	}
	if len(d["supported_harnesses"].([]any)) != 0 || len(d["blocking_components"].([]any)) != 0 {
		t.Errorf("collections wrong: %s", blob)
	}
}

func TestBuildListShape(t *testing.T) {
	p := ListParams{
		Search: "clickhouse", Namespace: " ACME ", Category: "devops",
		ProjectID: "11111111-1111-1111-1111-111111111111", Limit: 50, Offset: 10,
	}
	listSQL, countSQL, args := buildList(p, nil)
	for _, frag := range []string{
		"v.status = 'approved'", "a.deleted_at IS NULL", "a.project_id =",
		"a.namespace =", "a.category =", "AS rank",
		"ORDER BY rank DESC, a.created_at DESC", "LIMIT", "OFFSET",
		"count(*) FROM agent_components",
	} {
		if !strings.Contains(listSQL, frag) {
			t.Errorf("list SQL missing %q", frag)
		}
	}
	if strings.Contains(countSQL, "LIMIT") || strings.Contains(countSQL, "users u") {
		t.Errorf("count SQL wrong: %s", countSQL)
	}
	if args[len(args)-2] != 50 || args[len(args)-1] != 10 {
		t.Errorf("pagination args wrong: %v", args)
	}
}

func TestScopeUsesCreatedBy(t *testing.T) {
	viewer := &registry.Viewer{Role: "user"}
	args := []any{}
	scope := registry.ScopeSQL("a", "a.created_by", viewer, &args)
	if !strings.Contains(scope, "a.created_by = $1") {
		t.Fatalf("scope = %s", scope)
	}
}
