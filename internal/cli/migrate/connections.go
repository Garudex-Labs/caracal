// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package migrate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
)

// ParseClickHouseURL parses clickhouse://user:pass@host:port/db into
// (httpURL, db, user, password). The clickhouses:// scheme maps to https
// with default port 8443; clickhouse:// maps to http with default port
// 8123, which is also the fallback for any other scheme.
func ParseClickHouseURL(raw string) (httpURL, db, user, password string, err error) {
	defaultPort := 8123
	switch {
	case strings.HasPrefix(raw, "clickhouses://"):
		raw = "https://" + raw[len("clickhouses://"):]
		defaultPort = 8443
	case strings.HasPrefix(raw, "clickhouse://"):
		raw = "http://" + raw[len("clickhouse://"):]
	}
	scheme := "http"
	if strings.HasPrefix(raw, "https") {
		scheme = "https"
	}
	rest := ""
	if idx := strings.Index(raw, "://"); idx >= 0 {
		rest = raw[idx+3:]
	}
	netloc := rest
	path := ""
	if idx := strings.IndexAny(rest, "/?#"); idx >= 0 {
		netloc = rest[:idx]
		if rest[idx] == '/' {
			path = rest[idx:]
			if q := strings.IndexAny(path, "?#"); q >= 0 {
				path = path[:q]
			}
		}
	}
	hostport := netloc
	userinfo := ""
	if at := strings.LastIndexByte(netloc, '@'); at >= 0 {
		userinfo = netloc[:at]
		hostport = netloc[at+1:]
	}
	host := hostport
	portText := ""
	if strings.HasPrefix(hostport, "[") {
		if end := strings.IndexByte(hostport, ']'); end >= 0 {
			host = hostport[1:end]
			if end+1 < len(hostport) && hostport[end+1] == ':' {
				portText = hostport[end+2:]
			}
		}
	} else if colon := strings.LastIndexByte(hostport, ':'); colon >= 0 {
		host = hostport[:colon]
		portText = hostport[colon+1:]
	}
	host = strings.ToLower(host)
	if host == "" {
		return "", "", "", "", errors.New("ClickHouse URL requires a hostname")
	}
	port := 0
	if portText != "" {
		port, err = strconv.Atoi(portText)
		if err != nil || port < 0 || port > 65535 {
			return "", "", "", "", fmt.Errorf("invalid port %q in ClickHouse URL", portText)
		}
	}
	if port == 0 {
		port = defaultPort
	}
	user = "default"
	if userinfo != "" {
		name, secret, hasSecret := strings.Cut(userinfo, ":")
		if name != "" {
			user = name
		}
		if hasSecret {
			password = secret
		}
	}
	db = strings.Trim(path, "/")
	if db == "" {
		db = "default"
	}
	return fmt.Sprintf("%s://%s:%d", scheme, host, port), db, user, password, nil
}

// chConn carries resolved ClickHouse HTTP connection parameters.
type chConn struct {
	httpURL  string
	db       string
	user     string
	password string
}

func resolveCH(rawURL string) (chConn, error) {
	httpURL, db, user, password, err := ParseClickHouseURL(rawURL)
	if err != nil {
		return chConn{}, err
	}
	return chConn{httpURL: httpURL, db: db, user: user, password: password}, nil
}

// chHTTPClient dials with a bounded connect timeout and no overall
// deadline so large result streams are never cut off mid-transfer.
func chHTTPClient() *http.Client {
	return &http.Client{Transport: &http.Transport{
		DialContext: (&net.Dialer{Timeout: 10e9}).DialContext,
	}}
}

// chResponse holds the parsed data rows of a FORMAT JSON result.
type chResponse struct {
	Data []map[string]any `json:"data"`
}

func (c chConn) queryURL(extra map[string]string) string {
	values := url.Values{}
	values.Set("database", c.db)
	for k, v := range extra {
		values.Set(k, v)
	}
	return c.httpURL + "/?" + values.Encode()
}

// chExec posts a query and returns the raw response body.
func chExec(ctx context.Context, client *http.Client, c chConn, sql string, extra map[string]string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.queryURL(extra), strings.NewReader(sql))
	if err != nil {
		return nil, migrationErrorf("%s", err)
	}
	req.SetBasicAuth(c.user, c.password)
	resp, err := client.Do(req)
	if err != nil {
		return nil, connectionErrorf("ClickHouse unreachable: %s", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, readErr := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		text := string(body)
		if len(text) > 500 {
			text = text[:500]
		}
		return nil, migrationErrorf("ClickHouse returned HTTP %d: %s", resp.StatusCode, text)
	}
	if readErr != nil {
		return nil, connectionErrorf("ClickHouse unreachable: %s", readErr)
	}
	return body, nil
}

// chQueryJSON posts a FORMAT JSON query and parses the data rows.
func chQueryJSON(ctx context.Context, client *http.Client, c chConn, sql string,
	extra map[string]string) (*chResponse, error) {
	body, err := chExec(ctx, client, c, sql, extra)
	if err != nil {
		return nil, err
	}
	parsed := &chResponse{}
	dec := json.NewDecoder(strings.NewReader(string(body)))
	dec.UseNumber()
	if err := dec.Decode(parsed); err != nil {
		return nil, migrationErrorf("ClickHouse returned an unparseable response: %s", err)
	}
	return parsed, nil
}

// chStream posts a query and streams the response body to a file,
// writing to a temporary sibling and renaming into place.
func chStream(ctx context.Context, client *http.Client, c chConn, sql string, extra map[string]string,
	dest string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.queryURL(extra), strings.NewReader(sql))
	if err != nil {
		return migrationErrorf("%s", err)
	}
	req.SetBasicAuth(c.user, c.password)
	resp, err := client.Do(req)
	if err != nil {
		return connectionErrorf("ClickHouse unreachable: %s", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 500))
		return migrationErrorf("ClickHouse returned HTTP %d: %s", resp.StatusCode, string(body))
	}
	tmp := dest + ".tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return migrationErrorf("%s", err)
	}
	if _, err := io.Copy(out, resp.Body); err != nil {
		_ = out.Close()
		os.Remove(tmp)
		return connectionErrorf("ClickHouse unreachable: %s", err)
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return migrationErrorf("%s", err)
	}
	if err := os.Rename(tmp, dest); err != nil {
		os.Remove(tmp)
		return migrationErrorf("%s", err)
	}
	return nil
}

// chHealthCheck runs SELECT 1 against the target database.
func chHealthCheck(ctx context.Context, client *http.Client, c chConn) error {
	_, err := chExec(ctx, client, c, "SELECT 1", nil)
	return err
}

// chExistingTables lists tables present in the target database.
func chExistingTables(ctx context.Context, client *http.Client, c chConn) (map[string]bool, error) {
	sql := "SELECT name FROM system.tables WHERE database = {db:String} FORMAT JSON"
	resp, err := chQueryJSON(ctx, client, c, sql, map[string]string{"param_db": c.db})
	if err != nil {
		return nil, err
	}
	existing := map[string]bool{}
	for _, row := range resp.Data {
		if name, ok := row["name"].(string); ok {
			existing[name] = true
		}
	}
	return existing, nil
}

// readCount extracts the cnt column of a count() FORMAT JSON response,
// which arrives as a quoted 64-bit integer.
func readCount(resp *chResponse) int64 {
	if len(resp.Data) == 0 {
		return 0
	}
	switch v := resp.Data[0]["cnt"].(type) {
	case string:
		n, _ := strconv.ParseInt(v, 10, 64)
		return n
	case json.Number:
		n, _ := v.Int64()
		return n
	}
	return 0
}

// stripDialect removes driver suffixes like postgresql+asyncpg:// from a DSN.
func stripDialect(dsn string) string {
	if !strings.Contains(dsn, "+asyncpg") && !strings.Contains(dsn, "+psycopg") {
		return dsn
	}
	idx := strings.Index(dsn, "://")
	if idx < 0 {
		return dsn
	}
	base, _, _ := strings.Cut(dsn, "+")
	return base + dsn[idx:]
}

// pgConnect opens a PostgreSQL connection and verifies the target carries
// a Caracal schema.
func pgConnect(ctx context.Context, dsn string) (*pgx.Conn, error) {
	conn, err := pgx.Connect(ctx, stripDialect(dsn))
	if err != nil {
		return nil, connectionErrorf("Database connection failed: %s", err)
	}
	var exists bool
	err = conn.QueryRow(ctx,
		"SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'alembic_version')").Scan(&exists)
	if err != nil {
		_ = conn.Close(ctx)
		return nil, connectionErrorf("Database connection failed: %s", err)
	}
	if !exists {
		_ = conn.Close(ctx)
		return nil, connectionErrorf("Database does not contain an Caracal schema (alembic_version table not found).")
	}
	return conn, nil
}
