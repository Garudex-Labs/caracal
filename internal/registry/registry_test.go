// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"reflect"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestSearchTermsContract(t *testing.T) {
	cases := []struct {
		query string
		want  []string
	}{
		// stop words drop, plurals trim, phrase prepends
		{"find me webhook receivers for testing", []string{"webhook receiver testing", "webhook", "receiver", "testing"}},
		// short tokens drop unless allow-listed
		{"go ui x1 db", []string{"go ui", "go", "ui"}},
		// dedupe preserves order; "ss" plurals survive
		{"class class classes", []string{"class classe", "class", "classe"}},
		// pure stop-word query yields nil
		{"the and with", nil},
		// single token: phrase == token, no duplicate
		{"clickhouse", []string{"clickhouse"}},
	}
	for _, tc := range cases {
		if got := searchTerms(tc.query); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("searchTerms(%q) = %v, want %v", tc.query, got, tc.want)
		}
	}
}

func TestSearchSQLShape(t *testing.T) {
	args := []any{}
	where, rank := searchSQL([]string{"web hook", "web", "hook"}, "l.name", []string{"l.name", "v.description"}, &args)
	if len(args) != 3 {
		t.Fatalf("args = %d", len(args))
	}
	if args[0] != "%web hook%" || args[1] != "%web%" || args[2] != "%hook%" {
		t.Fatalf("patterns = %v", args)
	}
	if strings.Count(where, "ILIKE") != 6 { // 3 terms x 2 fields
		t.Fatalf("where = %s", where)
	}
	// phrase: name 100 + 2 field 40s; tokens: 2 x (name 12 + 2 field 4s)
	if strings.Count(rank, "THEN 100") != 1 || strings.Count(rank, "THEN 40") != 2 ||
		strings.Count(rank, "THEN 12") != 2 || strings.Count(rank, "THEN 4 ") != 4 {
		t.Fatalf("rank = %s", rank)
	}
}

func TestEscapeLike(t *testing.T) {
	if got := escapeLike(`50%_a\b`); got != `50\%\_a\\b` {
		t.Fatalf("escapeLike = %s", got)
	}
}

func TestVisibilitySQL(t *testing.T) {
	// anonymous: public only
	args := []any{}
	if got := visibilitySQL("l", nil, &args); got != "l.is_private = FALSE" || len(args) != 0 {
		t.Fatalf("anonymous = %s", got)
	}
	// operator: deployment-wide bypass of row visibility
	operator := &Viewer{ID: uuid.New(), Role: "operator"}
	if got := visibilitySQL("l", operator, &args); got != "TRUE" {
		t.Fatalf("operator visibility = %s, want TRUE", got)
	}
	// plain user: all three grants, scoped listings exclude the creator arm
	user := &Viewer{ID: uuid.New(), Role: "user"}
	args = []any{}
	got := visibilitySQL("l", user, &args)
	for _, want := range []string{
		"l.is_private = FALSE",
		"(l.ownership_scope = 'private' OR l.project_id IS NULL) AND l.submitted_by = $1",
		"project_memberships pm WHERE pm.project_id = l.project_id AND pm.user_id = $1",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in %s", want, got)
		}
	}
	if len(args) != 1 || args[0] != user.ID {
		t.Fatalf("args = %v", args)
	}
	// A request-scoped viewer can only resolve rows owned by that project,
	// even when another row would otherwise be public or membership-visible.
	scoped := &Viewer{ID: user.ID, Role: "user", ProjectID: "11111111-1111-1111-1111-111111111111"}
	args = []any{}
	scopedSQL := visibilitySQL("l", scoped, &args)
	if !strings.Contains(scopedSQL, "l.project_id = $2") {
		t.Fatalf("project constraint missing: %s", scopedSQL)
	}
	if len(args) != 2 || args[0] != user.ID || args[1] != scoped.ProjectID {
		t.Fatalf("scoped args = %v", args)
	}
	// reviewer gets the same row filter as a plain user
	args = []any{}
	if got2 := visibilitySQL("l", &Viewer{ID: user.ID, Role: "reviewer"}, &args); got2 != got {
		t.Fatalf("reviewer filter diverges: %s", got2)
	}
}

func TestEffectivePermission(t *testing.T) {
	owner := uuid.New()
	co := uuid.New()
	cases := []struct {
		viewer *Viewer
		want   string
	}{
		{nil, "view"},
		{&Viewer{ID: owner, Role: "user"}, "owner"},
		{&Viewer{ID: co, Role: "user"}, "owner"},
		{&Viewer{ID: uuid.New(), Role: "reviewer"}, "view"},
		{&Viewer{ID: uuid.New(), Role: "operator"}, "view"},
		{&Viewer{ID: uuid.New(), Role: "super_admin"}, "view"},
	}
	for _, tc := range cases {
		if got := EffectivePermission(owner, []string{co.String()}, tc.viewer); got != tc.want {
			t.Errorf("viewer %+v = %s, want %s", tc.viewer, got, tc.want)
		}
	}
	if !mayViewUnapproved("view", &Viewer{Role: "reviewer"}) || !mayViewUnapproved("view", &Viewer{Role: "operator"}) || mayViewUnapproved("view", &Viewer{Role: "user"}) {
		t.Fatal("unapproved gate wrong")
	}
}

func TestFamilyDescriptors(t *testing.T) {
	if len(Families) != 5 {
		t.Fatalf("families = %d", len(Families))
	}
	for prefix, f := range Families {
		if f.Prefix != prefix || f.SearchFields[0] != "l.name" {
			t.Errorf("%s descriptor malformed: %+v", prefix, f)
		}
	}
	if Families["mcps"].ListFilters["category"] != "l.category = %s" {
		t.Error("mcp category filters the listing table")
	}
	if Families["prompts"].ListFilters["category"] != "v.category = %s" {
		t.Error("prompt category filters the version table")
	}
}
