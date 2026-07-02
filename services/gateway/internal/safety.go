// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Cross-cutting safety helpers: SSRF guard, hop-by-hop sanitisation, request IDs, token fingerprints.

package internal

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// hopByHopHeaders are stripped from both inbound and outbound requests per RFC 7230 §6.1.
var hopByHopHeaders = []string{
	"Connection",
	"Proxy-Connection",
	"Keep-Alive",
	"Proxy-Authenticate",
	"Proxy-Authorization",
	"Te",
	"Trailer",
	"Transfer-Encoding",
	"Upgrade",
}

// stripHopByHop removes hop-by-hop headers and any header named in Connection.
func stripHopByHop(h http.Header) {
	for _, name := range strings.Split(h.Get("Connection"), ",") {
		if n := strings.TrimSpace(name); n != "" {
			h.Del(n)
		}
	}
	for _, n := range hopByHopHeaders {
		h.Del(n)
	}
}

// pathContainsTraversal reports whether p contains a "." or ".." segment, recursively
// undoing percent-encoding so multi-decoded sequences like %252e are also caught.
func pathContainsTraversal(p string) bool {
	prev := ""
	for p != prev {
		prev = p
		decoded, err := url.PathUnescape(p)
		if err != nil {
			return true
		}
		p = decoded
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == ".." || seg == "." {
			return true
		}
	}
	return false
}

// mergeQuery parses upstream and request query strings and merges them.
// Upstream-defined values win on conflict; remaining client values are appended.
func mergeQuery(upstreamQuery, requestQuery string) (string, error) {
	upstreamVals, err := url.ParseQuery(upstreamQuery)
	if err != nil {
		return "", err
	}
	requestVals, err := url.ParseQuery(requestQuery)
	if err != nil {
		return "", err
	}
	for k, vs := range requestVals {
		if _, taken := upstreamVals[k]; taken {
			continue
		}
		upstreamVals[k] = vs
	}
	return upstreamVals.Encode(), nil
}

// hostResolver resolves hostnames to IPs; replaceable in tests.
type hostResolver func(host string) ([]net.IP, error)

func defaultResolver(host string) ([]net.IP, error) { return net.LookupIP(host) }

// upstreamGuard validates URLs returned by STS before the gateway forwards to them.
// Upstream hosts are operator-provisioned through the Control API, never client-supplied,
// so loopback, private, and unique-local addresses are permitted: internal tools, local
// MCPs, and on-prem providers are first-class upstreams. Ranges that are never a legitimate
// upstream and dangerous regardless of intent (cloud metadata / link-local, multicast,
// unspecified) are always blocked. An optional allowList pins egress to an explicit set.
type upstreamGuard struct {
	allowList map[string]struct{}
	resolve   hostResolver
}

func newUpstreamGuard(allowList []string) *upstreamGuard {
	m := make(map[string]struct{}, len(allowList))
	for _, h := range allowList {
		m[strings.ToLower(h)] = struct{}{}
	}
	return &upstreamGuard{allowList: m, resolve: defaultResolver}
}

// Check parses the upstream URL and enforces scheme/host/network safety.
// It returns the parsed URL with fragment cleared and userinfo rejected.
func (g *upstreamGuard) Check(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return nil, fmt.Errorf("invalid upstream url")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("unsupported upstream scheme")
	}
	if u.User != nil {
		return nil, fmt.Errorf("upstream url must not include userinfo")
	}
	host := u.Hostname()
	if host == "" {
		return nil, fmt.Errorf("upstream url has empty host")
	}
	if len(g.allowList) > 0 {
		if _, ok := g.allowList[strings.ToLower(host)]; !ok {
			return nil, fmt.Errorf("upstream host not in allowlist")
		}
	}
	ips, err := g.resolveHost(host)
	if err != nil {
		return nil, fmt.Errorf("upstream host resolution failed")
	}
	for _, ip := range ips {
		if isUnsafeIP(ip) {
			return nil, fmt.Errorf("upstream host resolves to a restricted address")
		}
	}
	u.Fragment = ""
	return u, nil
}

// SafeDialContext returns a net.Dialer DialContext that re-resolves the host
// at connection time and refuses to dial unsafe IPs. This closes the TOCTOU
// window between Check's lookup and the transport's own lookup.
func (g *upstreamGuard) SafeDialContext(timeout, keepAlive time.Duration) func(ctx context.Context, network, addr string) (net.Conn, error) {
	dialer := &net.Dialer{Timeout: timeout, KeepAlive: keepAlive}
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		ips, err := g.resolveHost(host)
		if err != nil {
			return nil, fmt.Errorf("dial: resolve %s: %w", host, err)
		}
		var lastErr error
		for _, ip := range ips {
			if isUnsafeIP(ip) {
				lastErr = fmt.Errorf("dial: %s resolves to restricted address", host)
				continue
			}
			conn, derr := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
			if derr == nil {
				return conn, nil
			}
			lastErr = derr
		}
		if lastErr == nil {
			lastErr = fmt.Errorf("dial: no addresses for %s", host)
		}
		return nil, lastErr
	}
}

func (g *upstreamGuard) resolveHost(host string) ([]net.IP, error) {
	if ip := net.ParseIP(host); ip != nil {
		return []net.IP{ip}, nil
	}
	return g.resolve(host)
}

// isUnsafeIP reports whether forwarding to ip would reach infrastructure that is
// never a legitimate operator-provisioned upstream and is dangerous regardless of
// operator intent: cloud metadata and link-local (169.254.0.0/16, fe80::/10),
// multicast, and unspecified addresses. These stay blocked even under DNS rebinding.
// Loopback, private (RFC1918), unique-local (fc00::/7), and carrier-grade NAT
// addresses are permitted, because internal tools, local MCPs, and on-prem providers
// live there; upstream hosts are operator-provisioned, never client-supplied.
func isUnsafeIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsMulticast() || ip.IsUnspecified() || ip.IsInterfaceLocalMulticast() {
		return true
	}
	// NAT64 well-known prefix (RFC 6052) embeds an IPv4 target in the low 32 bits;
	// re-check the embedded address so 64:ff9b::<metadata-v4> cannot tunnel past the
	// guard while genuine NAT64 to permitted addresses still resolves.
	if embedded := nat64Embedded(ip); embedded != nil {
		return isUnsafeIP(embedded)
	}
	return false
}

// nat64WellKnownPrefix is the RFC 6052 well-known prefix 64:ff9b::/96.
var nat64WellKnownPrefix = [12]byte{0x00, 0x64, 0xff, 0x9b}

// nat64Embedded returns the IPv4 address carried in a 64:ff9b::/96 address, or
// nil when ip is not a NAT64 well-known-prefix address.
func nat64Embedded(ip net.IP) net.IP {
	if ip.To4() != nil {
		return nil
	}
	ip16 := ip.To16()
	if ip16 == nil {
		return nil
	}
	for i := 0; i < 12; i++ {
		if ip16[i] != nat64WellKnownPrefix[i] {
			return nil
		}
	}
	return net.IPv4(ip16[12], ip16[13], ip16[14], ip16[15])
}

// newRequestID returns a UUIDv4 string used to correlate access logs and STS audits.
func newRequestID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// rand.Read failures are unrecoverable; fall back to deterministic marker.
		return "00000000-0000-4000-8000-000000000000"
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// newTraceparent returns a standards-compliant W3C traceparent header value.
// It is generated independently from X-Request-Id because request IDs are
// allowed to be human-friendly opaque strings rather than lowercase hex.
func newTraceparent() string {
	var ids [24]byte
	if _, err := rand.Read(ids[:]); err != nil {
		// Fall back to hash-derived bytes so trace propagation stays valid even if
		// randomness is temporarily unavailable.
		sum := sha256.Sum256([]byte(newRequestID()))
		copy(ids[:], sum[:24])
	}
	if zeroBytes(ids[:16]) {
		ids[0] = 1
	}
	if zeroBytes(ids[16:24]) {
		ids[16] = 1
	}
	return "00-" + hex.EncodeToString(ids[:16]) + "-" + hex.EncodeToString(ids[16:24]) + "-01"
}

// validRequestID accepts UUID-shaped or short opaque identifiers (≤128 chars, printable ASCII).
func validRequestID(s string) bool {
	if s == "" || len(s) > 128 {
		return false
	}
	for _, r := range s {
		if r < 0x21 || r > 0x7e {
			return false
		}
	}
	return true
}

func zeroBytes(b []byte) bool {
	for _, v := range b {
		if v != 0 {
			return false
		}
	}
	return true
}

// validTraceparent reports whether s is a parseable W3C traceparent. A version-00
// value must carry exactly the four canonical fields; higher versions may append
// fields, so their leading fields are parsed and the rest preserved rather than
// discarded. trace-id and parent-id must be non-zero lowercase hex of fixed width.
func validTraceparent(s string) bool {
	parts := strings.Split(s, "-")
	if len(parts) < 4 {
		return false
	}
	version, traceID, parentID, flags := parts[0], parts[1], parts[2], parts[3]
	if len(version) != 2 || !isHex(version) || version == "ff" {
		return false
	}
	if version == "00" && len(parts) != 4 {
		return false
	}
	if len(traceID) != 32 || !isHex(traceID) || allZeroHex(traceID) {
		return false
	}
	if len(parentID) != 16 || !isHex(parentID) || allZeroHex(parentID) {
		return false
	}
	return len(flags) == 2 && isHex(flags)
}

// traceIDFromTraceparent returns the trace-id field that correlates every hop of a
// request, used to tie gateway access logs and audit events to the distributed trace.
func traceIDFromTraceparent(s string) string {
	parts := strings.Split(s, "-")
	if len(parts) < 2 {
		return ""
	}
	return parts[1]
}

func isHex(s string) bool {
	for _, c := range s {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return s != ""
}

func allZeroHex(s string) bool {
	for _, c := range s {
		if c != '0' {
			return false
		}
	}
	return true
}

// tokenFingerprint returns a short SHA-256 hex prefix for a bearer token.
// The full token is never logged or returned anywhere.
func tokenFingerprint(token string) string {
	if token == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:8])
}

// clientIP extracts the network IP from an http.Request.RemoteAddr ("ip:port").
func clientIP(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return remoteAddr
	}
	return host
}
