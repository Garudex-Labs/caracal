// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Internal unit tests for SDK profile parsing and gateway path helpers.

package sdk

import (
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestStripTomlComment(t *testing.T) {
	cases := map[string]string{
		`key = "value" # trailing`: `key = "value" `,
		`# whole line`:             ``,
		`key = "a # b"`:            `key = "a # b"`,
		`key = "esc \" # in"`:      `key = "esc \" # in"`,
		`no comment`:               `no comment`,
	}
	for in, want := range cases {
		if got := stripTomlComment(in); got != want {
			t.Errorf("stripTomlComment(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseTomlString(t *testing.T) {
	if v, ok := parseTomlString(`"hello"`); !ok || v != "hello" {
		t.Fatalf("quoted string must parse, got %q ok=%v", v, ok)
	}
	if v, ok := parseTomlString(`"with \"escape\""`); !ok || v != `with "escape"` {
		t.Fatalf("escaped quotes must parse, got %q ok=%v", v, ok)
	}
	if _, ok := parseTomlString(`bare`); ok {
		t.Fatal("unquoted value must be rejected")
	}
	if _, ok := parseTomlString(`"`); ok {
		t.Fatal("single quote must be rejected")
	}
	if _, ok := parseTomlString(`"unterminated`); ok {
		t.Fatal("unterminated string must be rejected")
	}
}

func TestCompactStrings(t *testing.T) {
	got := compactStrings([]string{"a", "", "b", "a", "c", ""})
	want := []string{"a", "b", "c"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("compactStrings must dedupe and drop empties, got %v", got)
	}
}

func TestCredentialCounts(t *testing.T) {
	cfg := map[string]string{
		"credentials.0.resource":          "r0",
		"credentials.1.resource":          "r1",
		"optional_credentials.0.resource": "o0",
		"zone_id":                         "z",
	}
	counts := credentialCounts(cfg)
	if counts["credentials"] != 2 {
		t.Fatalf("expected 2 credentials, got %d", counts["credentials"])
	}
	if counts["optional_credentials"] != 1 {
		t.Fatalf("expected 1 optional credential, got %d", counts["optional_credentials"])
	}
}

func TestParseProfileValid(t *testing.T) {
	path := filepath.Join(t.TempDir(), "profile.toml")
	content := `zone_id = "zone-1"
application_id = "app-1"
[[credentials]]
resource = "db" # primary
upstream_prefix = "/db"
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write profile: %v", err)
	}
	cfg, err := parseProfile(path)
	if err != nil {
		t.Fatalf("valid profile must parse: %v", err)
	}
	if cfg["zone_id"] != "zone-1" || cfg["application_id"] != "app-1" {
		t.Fatalf("top-level keys wrong: %v", cfg)
	}
	if cfg["credentials.0.resource"] != "db" || cfg["credentials.0.upstream_prefix"] != "/db" {
		t.Fatalf("credential section keys wrong: %v", cfg)
	}
}

func TestParseProfileRejectsBroadPermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "profile.toml")
	if err := os.WriteFile(path, []byte(`zone_id="z"`+"\n"+`application_id="a"`), 0o600); err != nil {
		t.Fatalf("write profile: %v", err)
	}
	if err := os.Chmod(path, 0o666); err != nil {
		t.Fatalf("chmod profile: %v", err)
	}
	if _, err := parseProfile(path); err == nil {
		t.Fatal("world/group-writable profile must be rejected")
	}
}

func TestParseProfileRejectsMissingRequired(t *testing.T) {
	path := filepath.Join(t.TempDir(), "profile.toml")
	if err := os.WriteFile(path, []byte(`zone_id = "z"`), 0o600); err != nil {
		t.Fatalf("write profile: %v", err)
	}
	if _, err := parseProfile(path); err == nil {
		t.Fatal("missing application_id must be rejected")
	}
}

func TestParseProfileRejectsMalformedLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "profile.toml")
	if err := os.WriteFile(path, []byte("garbage-without-equals"), 0o600); err != nil {
		t.Fatalf("write profile: %v", err)
	}
	if _, err := parseProfile(path); err == nil {
		t.Fatal("line without '=' must be rejected")
	}
}

func TestParseProfileMissingFile(t *testing.T) {
	if _, err := parseProfile(filepath.Join(t.TempDir(), "nope.toml")); err == nil {
		t.Fatal("missing file must error")
	}
}

func TestJoinGatewayPath(t *testing.T) {
	got, err := joinGatewayPath("https://gw.example.com/base/", "v1/tools?x=1")
	if err != nil {
		t.Fatalf("relative path must join: %v", err)
	}
	if got != "https://gw.example.com/base/v1/tools?x=1" {
		t.Fatalf("unexpected joined url: %q", got)
	}

	if _, err := joinGatewayPath("https://gw.example.com", "https://evil.com/x"); err == nil {
		t.Fatal("absolute path must be rejected")
	}

	got, err = joinGatewayPath("https://gw.example.com", "")
	if err != nil || got != "https://gw.example.com/" {
		t.Fatalf("empty path must map to root, got %q err=%v", got, err)
	}
}

func TestUrlMatchesPrefix(t *testing.T) {
	target, _ := url.Parse("https://gw.example.com/api/v1/tools")

	if !urlMatchesPrefix(target, "https://gw.example.com") {
		t.Fatal("empty-path prefix on same origin must match")
	}
	if !urlMatchesPrefix(target, "https://gw.example.com/api") {
		t.Fatal("path-prefix on same origin must match")
	}
	if !urlMatchesPrefix(target, "https://gw.example.com/api/v1/tools") {
		t.Fatal("exact path must match")
	}
	if urlMatchesPrefix(target, "https://other.example.com/api") {
		t.Fatal("different host must not match")
	}
	if urlMatchesPrefix(target, "https://gw.example.com/apix") {
		t.Fatal("non-boundary prefix must not match")
	}
	if urlMatchesPrefix(target, "://bad url") {
		t.Fatal("unparseable prefix must not match")
	}
}

func TestSameOrigin(t *testing.T) {
	a, _ := url.Parse("https://gw.example.com/x")
	b, _ := url.Parse("https://gw.example.com/y")
	c, _ := url.Parse("http://gw.example.com/x")
	if !sameOrigin(a, b) {
		t.Fatal("same scheme+host must be same origin")
	}
	if sameOrigin(a, c) {
		t.Fatal("different scheme must not be same origin")
	}
}
