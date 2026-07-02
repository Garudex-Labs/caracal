// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for safety helpers: SSRF guard, hop-by-hop, request IDs, query merge.

package internal

import (
	"errors"
	"net"
	"net/http"
	"strings"
	"testing"
)

func TestStripHopByHop(t *testing.T) {
	h := http.Header{}
	h.Set("Connection", "Keep-Alive, X-Custom-Hop")
	h.Set("Keep-Alive", "timeout=5")
	h.Set("Proxy-Authorization", "Bearer secret")
	h.Set("Upgrade", "websocket")
	h.Set("X-Custom-Hop", "drop me")
	h.Set("X-Keep-Me", "stay")

	stripHopByHop(h)

	for _, name := range []string{"Connection", "Keep-Alive", "Proxy-Authorization", "Upgrade", "X-Custom-Hop"} {
		if h.Get(name) != "" {
			t.Errorf("%s should be stripped, got %q", name, h.Get(name))
		}
	}
	if h.Get("X-Keep-Me") != "stay" {
		t.Errorf("end-to-end header was wrongly stripped")
	}
}

func TestPathTraversalDetection(t *testing.T) {
	traversals := []string{"/..", "/../etc", "/a/../b", "/./x", "/foo/../../bar", "/a/b/.."}
	for _, p := range traversals {
		if !pathContainsTraversal(p) {
			t.Errorf("missed traversal in %q", p)
		}
	}
	clean := []string{"/", "/a/b/c", "/api/v1/resource", "/.env", "/foo..bar"}
	for _, p := range clean {
		if pathContainsTraversal(p) {
			t.Errorf("false positive on %q", p)
		}
	}
}

func TestMergeQueryUpstreamWins(t *testing.T) {
	out, err := mergeQuery("a=1&b=2", "a=client&c=3")
	if err != nil {
		t.Fatal(err)
	}
	q, _ := parseQuery(out)
	if q["a"] != "1" {
		t.Errorf("upstream a should win, got %q", q["a"])
	}
	if q["b"] != "2" {
		t.Errorf("upstream b missing, got %q", q["b"])
	}
	if q["c"] != "3" {
		t.Errorf("client c should pass through, got %q", q["c"])
	}
}

func parseQuery(s string) (map[string]string, error) {
	out := map[string]string{}
	for _, kv := range strings.Split(s, "&") {
		if kv == "" {
			continue
		}
		parts := strings.SplitN(kv, "=", 2)
		if len(parts) == 2 {
			out[parts[0]] = parts[1]
		}
	}
	return out, nil
}

func TestUpstreamGuardRejectsScheme(t *testing.T) {
	g := newUpstreamGuard(nil)
	for _, raw := range []string{"file:///etc/passwd", "javascript:alert(1)", "ftp://x", "gopher://x", ""} {
		if _, err := g.Check(raw); err == nil {
			t.Errorf("guard accepted bad url %q", raw)
		}
	}
}

func TestUpstreamGuardRejectsUserinfo(t *testing.T) {
	g := newUpstreamGuard(nil)
	if _, err := g.Check("https://user:pass@example.com/x"); err == nil {
		t.Error("guard accepted userinfo")
	}
}

func TestUpstreamGuardBlocksDangerousRanges(t *testing.T) {
	g := newUpstreamGuard(nil)
	g.resolve = func(string) ([]net.IP, error) { return nil, nil }
	cases := map[string]string{
		"link-local":     "http://169.254.169.254/",
		"unspecified":    "http://0.0.0.0/",
		"multicast":      "http://224.0.0.1/",
		"nat64-metadata": "http://[64:ff9b::a9fe:a9fe]/",
	}
	for name, raw := range cases {
		if _, err := g.Check(raw); err == nil {
			t.Errorf("%s should be blocked: %s", name, raw)
		}
	}
}

func TestUpstreamGuardAllowsPrivateByDefault(t *testing.T) {
	cases := map[string]net.IP{
		"loopback":       net.ParseIP("127.0.0.1"),
		"loopback-ipv6":  net.ParseIP("::1"),
		"rfc1918-10":     net.ParseIP("10.0.0.1"),
		"rfc1918-172":    net.ParseIP("172.16.4.9"),
		"rfc1918-192":    net.ParseIP("192.168.1.1"),
		"unique-local-6": net.ParseIP("fd00::1"),
		"cgnat":          net.ParseIP("100.64.0.1"),
		"nat64-rfc1918":  net.ParseIP("64:ff9b::a00:1"),
	}
	for name, ip := range cases {
		g := newUpstreamGuard(nil)
		g.resolve = func(string) ([]net.IP, error) { return []net.IP{ip}, nil }
		if _, err := g.Check("http://provider.internal/v1"); err != nil {
			t.Errorf("%s should be permitted by default: %v", name, err)
		}
	}
}

func TestUpstreamGuardAllowsPublic(t *testing.T) {
	g := newUpstreamGuard(nil)
	g.resolve = func(string) ([]net.IP, error) { return []net.IP{net.ParseIP("8.8.8.8")}, nil }
	if _, err := g.Check("https://example.com/v1"); err != nil {
		t.Errorf("public host blocked: %v", err)
	}
}

func TestUpstreamGuardAllowsNAT64Public(t *testing.T) {
	g := newUpstreamGuard(nil)
	g.resolve = func(string) ([]net.IP, error) { return []net.IP{net.ParseIP("64:ff9b::808:808")}, nil }
	if _, err := g.Check("https://example.com/v1"); err != nil {
		t.Errorf("NAT64-embedded public address blocked: %v", err)
	}
}

func TestUpstreamGuardAllowlistEnforced(t *testing.T) {
	g := newUpstreamGuard([]string{"api.example.com"})
	g.resolve = func(string) ([]net.IP, error) { return []net.IP{net.ParseIP("8.8.8.8")}, nil }
	if _, err := g.Check("https://api.example.com/x"); err != nil {
		t.Errorf("allowlisted host blocked: %v", err)
	}
	if _, err := g.Check("https://evil.example.com/x"); err == nil {
		t.Error("non-allowlisted host accepted")
	}
}

func TestUpstreamGuardPermitsLoopback(t *testing.T) {
	// Loopback is a valid operator-provisioned upstream (local MCP / tool on the
	// same host); only client-uncontrollable dangerous ranges are blocked.
	g := newUpstreamGuard(nil)
	if _, err := g.Check("http://127.0.0.1:9000/x"); err != nil {
		t.Errorf("loopback upstream should be permitted: %v", err)
	}
}

func TestUpstreamGuardClearsFragment(t *testing.T) {
	g := newUpstreamGuard(nil)
	u, err := g.Check("https://example.com/x#frag")
	if err != nil {
		t.Fatal(err)
	}
	if u.Fragment != "" {
		t.Error("fragment not cleared")
	}
}

func TestNoRedirectPolicy(t *testing.T) {
	if err := noRedirect(nil, nil); !errors.Is(err, http.ErrUseLastResponse) {
		t.Fatalf("noRedirect must return http.ErrUseLastResponse, got %v", err)
	}
}

func TestRequestIDGeneration(t *testing.T) {
	a := newRequestID()
	b := newRequestID()
	if a == b {
		t.Error("request IDs collided")
	}
	if !validRequestID(a) {
		t.Errorf("generated id rejected: %q", a)
	}
}

func TestValidRequestID(t *testing.T) {
	if validRequestID("") {
		t.Error("empty id accepted")
	}
	if validRequestID(strings.Repeat("a", 129)) {
		t.Error("oversize id accepted")
	}
	if validRequestID("abc\ndef") {
		t.Error("control char id accepted")
	}
	if !validRequestID("550e8400-e29b-41d4-a716-446655440000") {
		t.Error("valid uuid rejected")
	}
}

func TestTokenFingerprintStable(t *testing.T) {
	a := tokenFingerprint("xyz")
	b := tokenFingerprint("xyz")
	if a != b {
		t.Error("fingerprint not stable")
	}
	if a == "xyz" {
		t.Error("fingerprint must not equal token")
	}
	if tokenFingerprint("") != "" {
		t.Error("empty token must yield empty fingerprint")
	}
}

func TestClientIPParsing(t *testing.T) {
	if got := clientIP("10.0.0.1:1234"); got != "10.0.0.1" {
		t.Errorf("ipv4 split, got %q", got)
	}
	if got := clientIP("[::1]:80"); got != "::1" {
		t.Errorf("ipv6 split, got %q", got)
	}
	if got := clientIP("unix"); got != "unix" {
		t.Errorf("unparseable returns input, got %q", got)
	}
}
