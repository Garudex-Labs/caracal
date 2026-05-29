// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tests for centralized secret-key redaction.

package logging

import (
	"strings"
	"testing"
)

func TestIsSecretKey(t *testing.T) {
	cases := map[string]bool{
		"password":      true,
		"user_password": true,
		"X-Auth-Token":  true,
		"Authorization": true,
		"refresh_token": true,
		"hmac_key":      true,
		"set-cookie":    true,
		"signature":     true,
		"zone_id":       false,
		"request_id":    false,
		"username":      false,
	}
	for k, want := range cases {
		if got := IsSecretKey(k); got != want {
			t.Errorf("IsSecretKey(%q) = %v, want %v", k, got, want)
		}
	}
}

func TestRedactMap(t *testing.T) {
	in := map[string]any{
		"zone_id":  "z1",
		"password": "hunter2",
		"nested": map[string]any{
			"api_key": "k",
			"keep":    1,
		},
	}
	out := RedactMap(in)
	if out["zone_id"] != "z1" {
		t.Fatalf("zone_id mutated: %v", out["zone_id"])
	}
	if out["password"] != RedactValue {
		t.Fatalf("password not redacted: %v", out["password"])
	}
	nested, _ := out["nested"].(map[string]any)
	if nested["api_key"] != RedactValue {
		t.Fatalf("nested api_key not redacted: %v", nested["api_key"])
	}
	if nested["keep"] != 1 {
		t.Fatalf("nested keep mutated: %v", nested["keep"])
	}
	if in["password"] == RedactValue {
		t.Fatal("input mutated")
	}
}

func TestRedactMapNilReturnsNil(t *testing.T) {
	if RedactMap(nil) != nil {
		t.Fatal("nil map must redact to nil")
	}
}

func TestRedactValueSliceAndScalar(t *testing.T) {
	in := map[string]any{
		"list":   []any{"Bearer abcdefghijklmnopqrstuvwxyz", "plain", 5},
		"number": 42,
		"flag":   true,
	}
	out := RedactMap(in)
	list, ok := out["list"].([]any)
	if !ok || len(list) != 3 {
		t.Fatalf("list not preserved: %v", out["list"])
	}
	if s, _ := list[0].(string); !strings.Contains(s, RedactValue) {
		t.Fatalf("bearer token in slice not redacted: %v", list[0])
	}
	if list[1] != "plain" || list[2] != 5 {
		t.Fatalf("non-secret slice entries mutated: %v", list)
	}
	if out["number"] != 42 || out["flag"] != true {
		t.Fatalf("scalar values must pass through unchanged: %v", out)
	}
}
