// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestScopeSQLReexportsVisibilityFilter(t *testing.T) {
	// Operator bypasses the row filter entirely.
	var args []any
	if got := ScopeSQL("a", "a.created_by", &Viewer{Role: "operator"}, &args); got != "TRUE" {
		t.Errorf("operator ScopeSQL = %q, want TRUE", got)
	}
	if len(args) != 0 {
		t.Errorf("operator must not bind args: %v", args)
	}

	// Anonymous sees only public rows, no bound viewer id.
	args = nil
	got := ScopeSQL("a", "a.created_by", nil, &args)
	if got != "a.is_private = FALSE" {
		t.Errorf("anonymous ScopeSQL = %q", got)
	}
	if len(args) != 0 {
		t.Errorf("anonymous must not bind args: %v", args)
	}

	// A signed-in non-operator binds the viewer id exactly once and uses the
	// caller-supplied creator column.
	args = nil
	viewer := &Viewer{ID: uuid.MustParse("22222222-2222-2222-2222-222222222222"), Role: "user"}
	got = ScopeSQL("a", "a.created_by", viewer, &args)
	if !strings.Contains(got, "a.created_by = $1") {
		t.Errorf("creator column not honored: %q", got)
	}
	if strings.Count(got, "$1") == 0 || len(args) != 1 {
		t.Errorf("viewer id must bind once, args=%v sql=%q", args, got)
	}
}

func TestKeywordTermsTokenizes(t *testing.T) {
	terms := KeywordTerms("Weather Forecasting Skills")
	// Phrase is first, stop-word "skills" dropped, "skills" depluralized anyway.
	if len(terms) == 0 || !strings.Contains(terms[0], "weather") {
		t.Fatalf("terms = %v", terms)
	}
	if KeywordTerms("the and for") != nil {
		t.Errorf("all-stopword query should yield nil terms")
	}
}

func TestKeywordSQLRendersConditionsAndRank(t *testing.T) {
	var args []any
	where, rank := KeywordSQL([]string{"weather forecast", "weather", "forecast"},
		"l.name", []string{"v.description"}, &args)
	if !strings.Contains(where, "ILIKE") || !strings.HasPrefix(where, "(") {
		t.Errorf("where = %q", where)
	}
	if !strings.Contains(rank, "100") || !strings.Contains(rank, "40") {
		t.Errorf("rank should score name/field weights: %q", rank)
	}
	if len(args) == 0 {
		t.Errorf("patterns should bind args")
	}
}

func TestWireTimeReexport(t *testing.T) {
	ts := time.Date(2026, 8, 30, 8, 0, 0, 0, time.UTC)
	if got := WireTime(ts); got != "2026-08-30T08:00:00Z" {
		t.Errorf("WireTime = %v", got)
	}
	if got := WireTime("not-a-time"); got != nil {
		t.Errorf("non-time WireTime = %v, want nil", got)
	}
}

func TestCollectRowsReexport(t *testing.T) {
	rows := &fakeRows{cols: []string{"id", "name"}, rows: [][]any{
		{"a", "one"},
		{"b", "two"},
	}}
	out := CollectRows(rows)
	if len(out) != 2 || out[0]["id"] != "a" || out[1]["name"] != "two" {
		t.Fatalf("CollectRows = %v", out)
	}
}

func TestAPIErrorOfUnwraps(t *testing.T) {
	status, detail, ok := APIErrorOf(&apiError{Status: 409, Detail: "conflict"})
	if !ok || status != 409 || detail != "conflict" {
		t.Errorf("APIErrorOf(apiError) = %d %q %v", status, detail, ok)
	}
	if _, _, ok := APIErrorOf(errBoom); ok {
		t.Errorf("plain error must not unwrap as apiError")
	}
}

func TestParseQueryHelpers(t *testing.T) {
	q := url.Values{}
	q.Set("limit", "25")
	q.Set("flag", "yes")
	q.Set("pid", "11111111-1111-1111-1111-111111111111")
	var errs []FieldError

	if got := ParseIntQuery(q, "limit", 10, 1, 100, &errs); got != 25 {
		t.Errorf("ParseIntQuery = %d", got)
	}
	if got := ParseIntQuery(q, "missing", 7, 1, 100, &errs); got != 7 {
		t.Errorf("ParseIntQuery default = %d", got)
	}
	if !ParseBoolQuery(q, "flag", &errs) {
		t.Errorf("ParseBoolQuery = false, want true")
	}
	if got := ParseUUIDQuery(q, "pid", &errs); got != "11111111-1111-1111-1111-111111111111" {
		t.Errorf("ParseUUIDQuery = %q", got)
	}
	if len(errs) != 0 {
		t.Fatalf("valid inputs produced errors: %v", errs)
	}

	// Invalid inputs append field errors.
	bad := url.Values{}
	bad.Set("limit", "9999")
	bad.Set("flag", "maybe")
	bad.Set("pid", "not-a-uuid")
	errs = nil
	ParseIntQuery(bad, "limit", 10, 1, 100, &errs)
	ParseBoolQuery(bad, "flag", &errs)
	ParseUUIDQuery(bad, "pid", &errs)
	if len(errs) != 3 {
		t.Errorf("expected 3 field errors, got %d: %v", len(errs), errs)
	}
}
