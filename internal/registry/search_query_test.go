// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"reflect"
	"strings"
	"testing"
)

func TestSearchTermsEdgeTrims(t *testing.T) {
	cases := []struct {
		query string
		want  []string
	}{
		// edge punctuation trims; case folds
		{"--Weather__ API", []string{"weather api", "weather", "api"}},
		// depluralized token that lands on a stop word drops
		{"MCP Servers", nil},
		// wildcard-only input yields nil
		{"%%% !!", nil},
		{"", nil},
	}
	for _, tc := range cases {
		if got := searchTerms(tc.query); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("searchTerms(%q) = %v, want %v", tc.query, got, tc.want)
		}
	}
}

func TestSearchSQLSingleTermScoresPhraseAsToken(t *testing.T) {
	args := []any{}
	where, rank := searchSQL([]string{"clickhouse"}, "l.name", []string{"l.name", "v.description"}, &args)
	if len(args) != 1 || args[0] != "%clickhouse%" {
		t.Fatalf("args = %v", args)
	}
	if strings.Count(where, "ILIKE") != 2 {
		t.Fatalf("where = %s", where)
	}
	// phrase: name 100 + 2 field 40s; token fallback re-scores it 12 + 2 x 4
	if strings.Count(rank, "THEN 100") != 1 || strings.Count(rank, "THEN 40") != 2 ||
		strings.Count(rank, "THEN 12") != 1 || strings.Count(rank, "THEN 4 ") != 2 {
		t.Fatalf("rank = %s", rank)
	}
}

func TestBuildListQuerySearchBindsPatterns(t *testing.T) {
	p := ListParams{Search: "weather api", Limit: 50, Offset: 0, Extra: map[string]string{}}
	listSQL, countSQL, args := buildListQuery(Families["mcps"], p, nil)

	// The user text reaches the database only as bound %pattern% arguments.
	if strings.Contains(listSQL, "weather") || strings.Contains(countSQL, "weather") {
		t.Fatalf("query interpolates user text: %s", listSQL)
	}
	wantPatterns := []any{"%weather api%", "%weather%", "%api%"}
	if len(args) != 5 || !reflect.DeepEqual(args[:3], wantPatterns) {
		t.Fatalf("args = %v", args)
	}
	if args[3] != 50 || args[4] != 0 {
		t.Fatalf("limit/offset tail = %v", args[3:])
	}
	if !strings.Contains(listSQL, "ORDER BY rank DESC, l.created_at DESC") {
		t.Errorf("search must rank: %s", listSQL)
	}
	if strings.Contains(countSQL, "LIMIT") || strings.Contains(countSQL, "rank") {
		t.Errorf("count twin must not paginate or rank: %s", countSQL)
	}
}

func TestBuildListQueryWithoutTermsSkipsRank(t *testing.T) {
	p := ListParams{Search: "%%% the and", Limit: 50, Extra: map[string]string{}}
	listSQL, _, args := buildListQuery(Families["mcps"], p, nil)
	if strings.Contains(listSQL, "rank") || strings.Contains(listSQL, "ILIKE") {
		t.Errorf("no usable terms must mean no search clause: %s", listSQL)
	}
	if !strings.Contains(listSQL, "ORDER BY l.created_at DESC") {
		t.Errorf("order = %s", listSQL)
	}
	if len(args) != 2 { // limit, offset only
		t.Errorf("args = %v", args)
	}
}

func TestBuildListQueryHarnessFilterEscapesWildcards(t *testing.T) {
	p := ListParams{Harness: `k%_iro`, Limit: 50, Extra: map[string]string{}}
	listSQL, _, args := buildListQuery(Families["skills"], p, nil)
	if !strings.Contains(listSQL, "v.supported_harnesses::text ILIKE $") {
		t.Fatalf("harness filter missing: %s", listSQL)
	}
	found := false
	for _, a := range args {
		if a == `%"k\%\_iro"%` {
			found = true
		}
	}
	if !found {
		t.Errorf("harness wildcards must be escaped, args = %v", args)
	}
}
