// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"strings"
	"testing"
)

// newPromptBody builds a draftBody the way the create/update handlers do, from a
// decoded JSON object, so these tests exercise the same authoritative path the
// API uses.
func newPromptBody(raw map[string]any) *draftBody {
	return &draftBody{raw: raw}
}

// updatedCategory returns the value the update path recorded for the category
// column, or nil when the column was not set.
func updatedCategory(u *updateSpec) any {
	for i, expr := range u.sets {
		if strings.HasPrefix(expr, "category = ") {
			return u.vals[i]
		}
	}
	return nil
}

func TestDraftVersionFieldsCategoryDefault(t *testing.T) {
	f := Families["prompts"]
	b := newPromptBody(map[string]any{"template": "hi"})
	fields := draftVersionFields(f, b, nil)
	if len(b.errs) != 0 {
		t.Fatalf("unexpected validation errors: %+v", b.errs)
	}
	if fields["category"] != "general" {
		t.Fatalf("default category = %v, want general", fields["category"])
	}
}

func TestDraftVersionFieldsCategoryNormalizesCustom(t *testing.T) {
	f := Families["prompts"]
	b := newPromptBody(map[string]any{"category": "Code Review", "template": "hi"})
	fields := draftVersionFields(f, b, nil)
	if len(b.errs) != 0 {
		t.Fatalf("unexpected validation errors: %+v", b.errs)
	}
	if fields["category"] != "code-review" {
		t.Fatalf("category = %v, want code-review", fields["category"])
	}
}

func TestDraftVersionFieldsCategoryAcceptsCustomSlug(t *testing.T) {
	f := Families["prompts"]
	b := newPromptBody(map[string]any{"category": "refactoring", "template": "hi"})
	fields := draftVersionFields(f, b, nil)
	if len(b.errs) != 0 {
		t.Fatalf("unexpected validation errors: %+v", b.errs)
	}
	if fields["category"] != "refactoring" {
		t.Fatalf("category = %v, want refactoring", fields["category"])
	}
}

func TestDraftVersionFieldsCategoryRejectsInvalid(t *testing.T) {
	f := Families["prompts"]
	for _, bad := range []string{"!!!", "///", "@#$"} {
		b := newPromptBody(map[string]any{"category": bad, "template": "hi"})
		draftVersionFields(f, b, nil)
		if len(b.errs) == 0 {
			t.Fatalf("category %q should have produced a validation error", bad)
		}
		if last := b.errs[0].Loc[len(b.errs[0].Loc)-1]; last != "category" {
			t.Fatalf("error loc = %v, want ...category", b.errs[0].Loc)
		}
	}
}

func TestDraftVersionFieldsCategoryRejectsTooLong(t *testing.T) {
	f := Families["prompts"]
	long := strings.Repeat("a", 40)
	b := newPromptBody(map[string]any{"category": long, "template": "hi"})
	draftVersionFields(f, b, nil)
	if len(b.errs) == 0 {
		t.Fatal("over-length category should have produced a validation error")
	}
}

func TestUpdateVersionFieldsCategoryNormalizes(t *testing.T) {
	f := Families["prompts"]
	b := newPromptBody(map[string]any{"category": "  Code_Generation  "})
	u := &updateSpec{}
	updateVersionFields(f, b, nil, u)
	if len(b.errs) != 0 {
		t.Fatalf("unexpected validation errors: %+v", b.errs)
	}
	if got := updatedCategory(u); got != "code-generation" {
		t.Fatalf("updated category = %v, want code-generation", got)
	}
}

func TestUpdateVersionFieldsCategoryRejectsInvalid(t *testing.T) {
	f := Families["prompts"]
	b := newPromptBody(map[string]any{"category": "!!!"})
	u := &updateSpec{}
	updateVersionFields(f, b, nil, u)
	if len(b.errs) == 0 {
		t.Fatal("invalid category on update should have produced a validation error")
	}
}

func TestUpdateVersionFieldsCategoryAbsentIsNoop(t *testing.T) {
	f := Families["prompts"]
	b := newPromptBody(map[string]any{"template": "hi"})
	u := &updateSpec{}
	updateVersionFields(f, b, nil, u)
	if got := updatedCategory(u); got != nil {
		t.Fatalf("absent category should not be set, got %v", got)
	}
}

// TestValidateSubmitPromptAcceptsCustomCategory guards the direct-submit path:
// validateSubmit must not reject custom categories (the fixed-list check was
// removed), and draftVersionFields normalizes them authoritatively.
func TestValidateSubmitPromptAcceptsCustomCategory(t *testing.T) {
	b := newPromptBody(map[string]any{
		"name": "p", "version": "1.0.0", "description": "d", "owner": "o",
		"category": "My Custom Thing", "template": "hi",
	})
	validateSubmit(Families["prompts"], b)
	for _, e := range b.errs {
		if len(e.Loc) > 0 && e.Loc[len(e.Loc)-1] == "category" {
			t.Fatalf("validateSubmit must not reject custom categories: %+v", b.errs)
		}
	}
	fields := draftVersionFields(Families["prompts"], b, nil)
	if fields["category"] != "my-custom-thing" {
		t.Fatalf("category = %v, want my-custom-thing", fields["category"])
	}
}

// TestValidateSubmitPromptRejectsInvalidCategory ensures a category that cannot
// be normalized is still rejected somewhere in the direct-submit pipeline.
func TestValidateSubmitPromptRejectsInvalidCategory(t *testing.T) {
	b := newPromptBody(map[string]any{
		"name": "p", "version": "1.0.0", "description": "d", "owner": "o",
		"category": "!!!", "template": "hi",
	})
	validateSubmit(Families["prompts"], b)
	draftVersionFields(Families["prompts"], b, nil)
	rejected := false
	for _, e := range b.errs {
		if len(e.Loc) > 0 && e.Loc[len(e.Loc)-1] == "category" {
			rejected = true
		}
	}
	if !rejected {
		t.Fatalf("invalid category should be rejected: %+v", b.errs)
	}
}
