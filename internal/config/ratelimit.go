// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package config

import (
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// rateLimiter enforces fixed-window per-client limits expressed as
// "<count>/<unit>" (for example "10/minute").
type rateLimiter struct {
	mu      sync.Mutex
	windows map[string]rateWindow
	now     func() time.Time
}

type rateWindow struct {
	start time.Time
	count int
}

func rateSpan(unit string) time.Duration {
	switch strings.TrimSuffix(unit, "s") {
	case "second":
		return time.Second
	case "hour":
		return time.Hour
	case "day":
		return 24 * time.Hour
	default:
		return time.Minute
	}
}

func rateDetail(count int, span time.Duration) string {
	unit := "minute"
	switch span {
	case time.Second:
		unit = "second"
	case time.Hour:
		unit = "hour"
	case 24 * time.Hour:
		unit = "day"
	}
	return fmt.Sprintf("%d per 1 %s", count, unit)
}

// allow reports whether the caller is within the limit, plus a human-readable
// description of the limit for rejection messages.
func (l *rateLimiter) allow(key, limit string) (bool, string) {
	countRaw, unit, _ := strings.Cut(limit, "/")
	count, err := strconv.Atoi(strings.TrimSpace(countRaw))
	if err != nil || count <= 0 {
		count = 10
		unit = "minute"
	}
	span := rateSpan(strings.TrimSpace(unit))
	detail := rateDetail(count, span)

	l.mu.Lock()
	defer l.mu.Unlock()
	if l.now == nil {
		l.now = time.Now
	}
	if l.windows == nil {
		l.windows = map[string]rateWindow{}
	}
	now := l.now()
	if len(l.windows) > 4096 {
		for k, w := range l.windows {
			if now.Sub(w.start) >= span {
				delete(l.windows, k)
			}
		}
	}
	window := l.windows[key]
	if now.Sub(window.start) >= span {
		window = rateWindow{start: now}
	}
	if window.count >= count {
		return false, detail
	}
	window.count++
	l.windows[key] = window
	return true, detail
}

// clientKey identifies the caller for rate limiting: the first forwarded
// address when behind the load balancer, else the peer address.
func clientKey(r *http.Request) string {
	if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
		first, _, _ := strings.Cut(forwarded, ",")
		return strings.TrimSpace(first)
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}
