// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package inbox

import (
	"net/url"
	"testing"
	"time"
)

func TestEnumParam(t *testing.T) {
	values := []string{"open", "resolved", "dismissed"}

	errs := []fieldError{}
	if got := enumParam(url.Values{"state": {"open"}}, "state", values, &errs); got != "open" || len(errs) != 0 {
		t.Errorf("valid value: got %q, errs %v", got, errs)
	}
	if got := enumParam(url.Values{}, "state", values, &errs); got != "" || len(errs) != 0 {
		t.Errorf("absent param must pass: got %q, errs %v", got, errs)
	}

	errs = nil
	if got := enumParam(url.Values{"state": {"OPEN"}}, "state", values, &errs); got != "" || len(errs) != 1 {
		t.Fatalf("case must not be folded: got %q, errs %v", got, errs)
	}
	if errs[0].Type != "enum" || errs[0].Msg != "Input should be 'open', 'resolved' or 'dismissed'" {
		t.Errorf("error shape: %+v", errs[0])
	}
}

func TestEnumChoicesSingleValue(t *testing.T) {
	if got := enumChoices([]string{"only"}); got != "'only'" {
		t.Errorf("enumChoices = %q", got)
	}
}

func TestBoolParam(t *testing.T) {
	truthy := []string{"true", "YES", "on", "1", "t", "Y"}
	falsy := []string{"false", "No", "off", "0", "F", "n"}
	for _, raw := range truthy {
		errs := []fieldError{}
		got := boolParam(url.Values{"read": {raw}}, "read", &errs)
		if got == nil || !*got || len(errs) != 0 {
			t.Errorf("%q: got %v, errs %v", raw, got, errs)
		}
	}
	for _, raw := range falsy {
		errs := []fieldError{}
		got := boolParam(url.Values{"read": {raw}}, "read", &errs)
		if got == nil || *got || len(errs) != 0 {
			t.Errorf("%q: got %v, errs %v", raw, got, errs)
		}
	}

	errs := []fieldError{}
	if got := boolParam(url.Values{}, "read", &errs); got != nil || len(errs) != 0 {
		t.Errorf("absent: got %v, errs %v", got, errs)
	}
	if got := boolParam(url.Values{"read": {"maybe"}}, "read", &errs); got != nil || len(errs) != 1 || errs[0].Type != "bool_parsing" {
		t.Errorf("invalid: got %v, errs %v", got, errs)
	}
}

func TestIntParam(t *testing.T) {
	q := func(v string) url.Values { return url.Values{"limit": {v}} }

	errs := []fieldError{}
	if got := intParam(url.Values{}, "limit", 20, 1, 100, &errs); got != 20 || len(errs) != 0 {
		t.Errorf("absent uses default: %d, %v", got, errs)
	}
	if got := intParam(q("50"), "limit", 20, 1, 100, &errs); got != 50 || len(errs) != 0 {
		t.Errorf("valid: %d, %v", got, errs)
	}

	cases := []struct {
		raw      string
		wantType string
	}{
		{"abc", "int_parsing"},
		{"0", "greater_than_equal"},
		{"101", "less_than_equal"},
	}
	for _, tc := range cases {
		errs := []fieldError{}
		if got := intParam(q(tc.raw), "limit", 20, 1, 100, &errs); got != 20 {
			t.Errorf("%q must fall back to default, got %d", tc.raw, got)
		}
		if len(errs) != 1 || errs[0].Type != tc.wantType {
			t.Errorf("%q: errs %v, want type %q", tc.raw, errs, tc.wantType)
		}
	}

	// max <= 0 disables the upper bound.
	errs = nil
	if got := intParam(q("100000"), "limit", 20, 1, 0, &errs); got != 100000 || len(errs) != 0 {
		t.Errorf("unbounded max: %d, %v", got, errs)
	}
}

func TestWireItemShape(t *testing.T) {
	created := time.Date(2026, 8, 30, 10, 0, 0, 0, time.UTC)
	read := created.Add(time.Minute)
	it := &Item{ID: "i1", Kind: "ownership_transfer", State: "open", ReadAt: &read, CreatedAt: created, Title: "T"}
	resp := wireItem(it)
	if !resp.Read || resp.ReadAt == nil || *resp.ReadAt != "2026-08-30T10:01:00Z" {
		t.Errorf("read projection: %+v", resp)
	}
	if resp.CreatedAt != "2026-08-30T10:00:00Z" || resp.ResolvedAt != nil {
		t.Errorf("time projection: %+v", resp)
	}

	unread := wireItem(&Item{ID: "i2", CreatedAt: created})
	if unread.Read || unread.ReadAt != nil {
		t.Errorf("unread item claims read: %+v", unread)
	}
}
