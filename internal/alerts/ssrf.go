// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package alerts

import (
	"context"
	"net"
	"net/url"
	"strings"
	"time"
)

// blockedHostnames are cloud metadata endpoints that must never be reached
// regardless of what they resolve to.
var blockedHostnames = map[string]bool{
	"169.254.169.254":          true,
	"metadata.google.internal": true,
	"fd00:ec2::254":            true,
}

// privateNetworks covers every private, link-local, and reserved range for
// IPv4 and IPv6.
var privateNetworks = mustParseCIDRs(
	"10.0.0.0/8",
	"172.16.0.0/12",
	"192.168.0.0/16",
	"127.0.0.0/8",    // loopback
	"169.254.0.0/16", // link-local / APIPA
	"100.64.0.0/10",  // CGNAT
	"0.0.0.0/8",      // unspecified
	"240.0.0.0/4",    // reserved
	"224.0.0.0/4",    // multicast
	"::1/128",        // IPv6 loopback
	"fc00::/7",       // IPv6 ULA
	"fe80::/10",      // IPv6 link-local
	"ff00::/8",       // IPv6 multicast
)

func mustParseCIDRs(blocks ...string) []*net.IPNet {
	nets := make([]*net.IPNet, 0, len(blocks))
	for _, block := range blocks {
		_, network, err := net.ParseCIDR(block)
		if err != nil {
			panic(err)
		}
		nets = append(nets, network)
	}
	return nets
}

func ipIsPrivate(ip net.IP) bool {
	if ip == nil {
		return true // unparseable, block it
	}
	// IPv4-mapped IPv6: check the IPv4 form.
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	for _, network := range privateNetworks {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}

// IsPrivateURL reports whether the URL resolves to a private or internal
// host. DNS failures are treated as private (fail closed).
func IsPrivateURL(ctx context.Context, rawURL string) bool {
	if rawURL == "" {
		return true
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return true
	}
	hostname := strings.ToLower(strings.Trim(parsed.Hostname(), "[]"))
	if hostname == "" {
		return true
	}
	if blockedHostnames[hostname] {
		return true
	}
	if ip := net.ParseIP(hostname); ip != nil {
		return ipIsPrivate(ip)
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, hostname)
	if err != nil || len(addrs) == 0 {
		return true // DNS failure, fail closed
	}
	for _, addr := range addrs {
		if ipIsPrivate(addr.IP) {
			return true
		}
	}
	return false
}
