// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package clickhouse is a minimal HTTP client for ClickHouse queries and
// JSONEachRow inserts, with parameterized statements and bounded retries on
// connection failures.
package clickhouse

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// maxResponseBytes caps any single response body.
const maxResponseBytes = 64 << 20

// Client executes statements against one ClickHouse server over HTTP.
type Client struct {
	endpoint string
	database string
	username string
	password string
	http     *http.Client

	// overrides are administrator-applied resource settings injected into
	// every statement (guarded by overridesMu).
	overridesMu sync.RWMutex
	overrides   map[string]string

	// retryWait returns the backoff before attempt n (1-based); test seam.
	retryWait func(attempt int) time.Duration
}

// New parses a clickhouse:// or http:// URL of the form
// scheme://user:pass@host:port/database. A nil httpClient uses a
// 10-second-timeout default.
func New(rawURL string, httpClient *http.Client) (*Client, error) {
	parsed, err := url.Parse(strings.Replace(rawURL, "clickhouse://", "http://", 1))
	if err != nil {
		return nil, fmt.Errorf("parse clickhouse url: %w", err)
	}
	if parsed.Hostname() == "" {
		return nil, fmt.Errorf("clickhouse url %q has no host", rawURL)
	}
	port := parsed.Port()
	if port == "" {
		port = "8123"
	}
	database := strings.Trim(parsed.Path, "/")
	if database == "" {
		database = "default"
	}
	username := parsed.User.Username()
	if username == "" {
		username = "default"
	}
	password, _ := parsed.User.Password()
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 10 * time.Second}
	}
	return &Client{
		endpoint: fmt.Sprintf("http://%s:%s", parsed.Hostname(), port),
		database: database,
		username: username,
		password: password,
		http:     httpClient,
		retryWait: func(attempt int) time.Duration {
			return min(500*time.Millisecond<<(attempt-1), 5*time.Second)
		},
	}, nil
}

// Settings are per-request ClickHouse settings and {name:Type} parameter
// bindings; parameter keys must carry the "param_" prefix.
type Settings map[string]string

// Database returns the database the client is bound to.
func (c *Client) Database() string {
	return c.database
}

// SetQueryOverrides replaces the resource settings applied to every
// subsequent statement (memory ceilings, spill thresholds, and the like).
func (c *Client) SetQueryOverrides(overrides map[string]string) {
	copied := make(map[string]string, len(overrides))
	for k, v := range overrides {
		copied[k] = v
	}
	c.overridesMu.Lock()
	c.overrides = copied
	c.overridesMu.Unlock()
}

// safety floor applied to every query
const maxExecutionTime = "300"

// Exec runs a statement and discards the result.
func (c *Client) Exec(ctx context.Context, sql string, settings Settings) error {
	_, err := c.do(ctx, sql, settings, "")
	return err
}

// InsertJSONEachRow appends the rows as JSONEachRow input to an INSERT
// statement, waiting for the insert to be durable.
func (c *Client) InsertJSONEachRow(ctx context.Context, sql string, rows []any) error {
	if len(rows) == 0 {
		return nil
	}
	var body strings.Builder
	for i, row := range rows {
		data, err := json.Marshal(row)
		if err != nil {
			return fmt.Errorf("marshal row %d: %w", i, err)
		}
		body.Write(data)
		body.WriteByte('\n')
	}
	_, err := c.do(ctx, sql, Settings{"wait_for_async_insert": "1"}, body.String())
	return err
}

// QueryJSON runs a "... FORMAT JSON" statement and returns the data rows.
func (c *Client) QueryJSON(ctx context.Context, sql string, settings Settings) ([]map[string]any, error) {
	resp, err := c.do(ctx, sql, settings, "")
	if err != nil {
		return nil, err
	}
	var doc struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(resp, &doc); err != nil {
		return nil, fmt.Errorf("parse clickhouse response: %w", err)
	}
	return doc.Data, nil
}

// do posts the statement, retrying connection failures up to three attempts.
func (c *Client) do(ctx context.Context, sql string, settings Settings, data string) ([]byte, error) {
	params := url.Values{}
	params.Set("database", c.database)
	params.Set("max_execution_time", maxExecutionTime)
	c.overridesMu.RLock()
	for k, v := range c.overrides {
		params.Set(k, v)
	}
	c.overridesMu.RUnlock()
	for k, v := range settings {
		params.Set(k, v)
	}
	body := sql
	if data != "" {
		body = sql + "\n" + data
	}

	var lastErr error
	for attempt := 1; attempt <= 3; attempt++ {
		if attempt > 1 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(c.retryWait(attempt - 1)):
			}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost,
			c.endpoint+"?"+params.Encode(), strings.NewReader(body))
		if err != nil {
			return nil, err
		}
		// Credentials travel as headers so they never land in proxy/access logs.
		req.Header.Set("X-ClickHouse-User", c.username)
		req.Header.Set("X-ClickHouse-Key", c.password)
		resp, err := c.http.Do(req)
		if err != nil {
			if isConnectionError(err) {
				lastErr = err
				continue
			}
			return nil, fmt.Errorf("clickhouse request: %w", err)
		}
		out, readErr := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
		_ = resp.Body.Close()
		if readErr != nil {
			return nil, fmt.Errorf("read clickhouse response: %w", readErr)
		}
		if resp.StatusCode >= 400 {
			return nil, fmt.Errorf("clickhouse returned %s: %s", resp.Status, truncate(string(out), 200))
		}
		return out, nil
	}
	return nil, fmt.Errorf("clickhouse unreachable after 3 attempts: %w", lastErr)
}

func isConnectionError(err error) bool {
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true
	}
	var opErr *net.OpError
	return errors.As(err, &opErr)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
