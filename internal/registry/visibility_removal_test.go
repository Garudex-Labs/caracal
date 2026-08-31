// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"strings"
	"testing"

	"github.com/google/uuid"
)

// The removed "public" visibility must be unreachable from every read path:
// no stored row can render as public, the list filter carries no public
// disjunct, submissions reject it, and git sources are always Project-scoped.

func TestRowVisibilityNeverPublic(t *testing.T) {
	for _, scope := range []string{"", "project", "private", "team", "user"} {
		for _, priv := range []bool{true, false} {
			got := rowVisibility(map[string]any{"ownership_scope": scope, "is_private": priv})
			if got == "public" {
				t.Errorf("scope=%q is_private=%v rendered public", scope, priv)
			}
			want := "project"
			if scope == "private" {
				want = "private"
			}
			if got != want {
				t.Errorf("scope=%q is_private=%v -> %q, want %q", scope, priv, got, want)
			}
		}
	}
}

func TestVisibilitySQLHasNoPublicBranch(t *testing.T) {
	var args []any
	if got := visibilitySQL("l", nil, &args); got != "FALSE" {
		t.Errorf("anonymous = %q, want FALSE (no public scope)", got)
	}
	args = nil
	got := visibilitySQL("l", &Viewer{ID: uuid.New(), Role: "user"}, &args)
	if strings.Contains(got, "is_private = FALSE") {
		t.Errorf("signed-in visibility filter must not carry a public disjunct: %s", got)
	}
}

func TestDraftBodyRejectsPublic(t *testing.T) {
	b := draftBodyOf(map[string]any{"visibility": "public"})
	if got := b.visibility(); got != "project" || len(b.errs) == 0 {
		t.Errorf("public must be rejected and coerced to project: got=%q errs=%v", got, b.errs)
	}
}

func TestSourceWireIsAlwaysProject(t *testing.T) {
	w := sourceWireOf(map[string]any{"id": "s1", "project_id": "p1"})
	if w.Visibility != "project" {
		t.Errorf("git sources must be project-scoped, got %q", w.Visibility)
	}
}
