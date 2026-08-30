// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package config

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

const identityTimeout = 5 * time.Second
const identityCacheTTL = 30 * time.Second

// IdentityClient talks to the identity service for capability discovery and
// health reporting. Capability responses are briefly cached; failures cache
// as empty so a down identity service cannot stall config reads.
type IdentityClient struct {
	BaseURL string
	HTTP    *http.Client

	mu      sync.Mutex
	cached  map[string]any
	expires time.Time
}

func (c *IdentityClient) client() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return http.DefaultClient
}

// PublicConfig returns the identity service's capability descriptor, or an
// empty map when the service is unreachable.
func (c *IdentityClient) PublicConfig(ctx context.Context) map[string]any {
	c.mu.Lock()
	if c.cached != nil && time.Now().Before(c.expires) {
		cached := c.cached
		c.mu.Unlock()
		return cached
	}
	c.mu.Unlock()

	config := map[string]any{}
	ctx, cancel := context.WithTimeout(ctx, identityTimeout)
	defer cancel()
	url := strings.TrimRight(c.BaseURL, "/") + "/api/auth/public-config"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err == nil {
		resp, err := c.client().Do(req)
		if err == nil {
			func() {
				defer func() { _ = resp.Body.Close() }()
				if resp.StatusCode == http.StatusOK {
					var parsed map[string]any
					if json.NewDecoder(resp.Body).Decode(&parsed) == nil && parsed != nil {
						config = parsed
					}
				}
			}()
		}
	}

	c.mu.Lock()
	c.cached = config
	c.expires = time.Now().Add(identityCacheTTL)
	c.mu.Unlock()
	return config
}

// Health probes the identity service and reports reachability, latency, and
// a short error description when the probe fails.
func (c *IdentityClient) Health(ctx context.Context) (ok bool, latencyMS int, errText string) {
	start := time.Now()
	ctx, cancel := context.WithTimeout(ctx, identityTimeout)
	defer cancel()
	url := strings.TrimRight(c.BaseURL, "/") + "/healthz"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		errText = "identity service unreachable: ConnectError"
	} else if resp, doErr := c.client().Do(req); doErr != nil {
		if errors.Is(doErr, context.DeadlineExceeded) || os.IsTimeout(doErr) {
			errText = "identity service unreachable: ConnectTimeout"
		} else {
			errText = "identity service unreachable: ConnectError"
		}
	} else {
		_ = resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			ok = true
		} else {
			errText = fmt.Sprintf("identity service returned HTTP %d", resp.StatusCode)
		}
	}
	latencyMS = int(math.RoundToEven(float64(time.Since(start)) / float64(time.Millisecond)))
	return ok, latencyMS, errText
}
