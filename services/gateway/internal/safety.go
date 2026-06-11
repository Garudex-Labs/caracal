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
type upstreamGuard struct {
	allowList    map[string]struct{}
	allowPrivate bool
	resolve      hostResolver
}

func newUpstreamGuard(allowList []string, allowPrivate bool) *upstreamGuard {
	m := make(map[string]struct{}, len(allowList))
	for _, h := range allowList {
		m[strings.ToLower(h)] = struct{}{}
	}
	return &upstreamGuard{allowList: m, allowPrivate: allowPrivate, resolve: defaultResolver}
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
		if !g.allowPrivate && isUnsafeIP(ip) {
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
			if !g.allowPrivate && isUnsafeIP(ip) {
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

// isUnsafeIP reports whether forwarding to ip would risk SSRF into private,
// loopback, link-local, multicast, unspecified, or cloud-metadata ranges.
func isUnsafeIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() ||
		ip.IsInterfaceLocalMulticast() {
		return true
	}
	if v4 := ip.To4(); v4 != nil {
		// AWS / GCP / Azure metadata.
		if v4[0] == 169 && v4[1] == 254 {
			return true
		}
		// Carrier-grade NAT 100.64.0.0/10.
		if v4[0] == 100 && v4[1]&0xc0 == 64 {
			return true
		}
	}
	// NAT64 well-known prefix (RFC 6052) embeds an IPv4 target in the low 32 bits;
	// re-check the embedded address so 64:ff9b::<private-or-metadata-v4> cannot
	// tunnel past the guard while genuine NAT64 to public addresses still resolves.
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
