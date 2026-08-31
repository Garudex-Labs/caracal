// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package api is the authenticated JSON client for the Caracal server,
// converting transport and HTTP failures into the stable CLI error contract.
package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
	"github.com/garudex-labs/caracal/internal/cli/config"
)

// Client issues authenticated requests against the configured server.
type Client struct {
	BaseURL     string
	Token       string
	CLIVersion  string
	OrgSlug     string
	ProjectSlug string
	Timeout     time.Duration

	versionChecked bool
}

// New builds a client from the effective configuration, failing with the
// auth contract when no server or token is configured.
func New(cliVersion string) (*Client, *clierr.Error) {
	cfg, cerr := config.Load()
	if cerr != nil {
		return nil, cerr
	}
	serverURL := strings.TrimRight(config.Str(cfg, "server_url"), "/")
	token := config.Str(cfg, "access_token")
	sessionToken := config.Str(cfg, "session_token")
	if serverURL == "" || (token == "" && sessionToken == "") {
		return nil, &clierr.Error{
			Category: clierr.Auth, Message: "Caracal authentication is not configured.",
			Operation: "Load CLI configuration", Resource: config.File(),
			Remediation: "Run caracal auth login or configure an access token, then retry.",
		}
	}
	if sessionToken != "" && !accessTokenOverrideConfigured() {
		minted, cerr := mintTenantToken(serverURL, sessionToken)
		if cerr != nil {
			return nil, cerr
		}
		token = minted
		_ = config.Save(map[string]any{"access_token": token})
	}
	return &Client{
		BaseURL:     serverURL,
		Token:       token,
		CLIVersion:  cliVersion,
		OrgSlug:     config.Str(cfg, "default_org"),
		ProjectSlug: config.Str(cfg, "default_project"),
		Timeout:     time.Duration(config.Timeout(cfg)) * time.Second,
	}, nil
}

func projectScopedAPIPath(path string) bool {
	for _, prefix := range []string{
		"/api/v1/sessions", "/api/v1/resources", "/api/v1/agents",
		"/api/v1/mcps", "/api/v1/skills", "/api/v1/hooks",
		"/api/v1/prompts", "/api/v1/review",
		"/api/v1/insights", "/api/v1/inbox", "/api/v1/layer-snapshots",
		"/api/v1/registry", "/api/v1/component-sources",
		"/api/v1/recommendations", "/api/v1/bulk",
	} {
		if path == prefix || strings.HasPrefix(path, prefix+"/") {
			return true
		}
	}
	return false
}

func accessTokenOverrideConfigured() bool {
	for _, name := range []string{"CARACAL_ACCESS_TOKEN", "CARACAL_ACCESS_TOKEN_FILE", "CARACAL_TOKEN", "CARACAL_TOKEN_FILE"} {
		if strings.TrimSpace(os.Getenv(name)) != "" {
			return true
		}
	}
	return false
}

func mintTenantToken(serverURL, sessionToken string) (string, *clierr.Error) {
	req, err := http.NewRequest(http.MethodGet, serverURL+"/api/auth/tenant-token", nil)
	if err != nil {
		return "", refreshTransportError(serverURL, err)
	}
	req.Header.Set("Authorization", "Bearer "+sessionToken)
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return "", refreshTransportError(serverURL, err)
	}
	defer func() { _ = resp.Body.Close() }()
	blob, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
			return "", &clierr.Error{
				Category: clierr.Auth, Message: "The saved CLI session is invalid or expired.",
				Operation: "Refresh CLI session", Resource: "server " + serverURL,
				Remediation: "Run caracal auth login again.", HTTPStatus: resp.StatusCode,
			}
		}
		return "", refreshStatusError(serverURL, resp, blob)
	}
	var data struct {
		Token string `json:"token"`
	}
	if json.Unmarshal(blob, &data) != nil || data.Token == "" {
		return "", &clierr.Error{
			Category: clierr.Unexpected, Message: "The identity service returned an invalid token response.",
			Operation: "Refresh CLI session", Resource: "server " + serverURL,
			Remediation: "Check server health and version compatibility, then retry.",
		}
	}
	return data.Token, nil
}

func refreshTransportError(serverURL string, err error) *clierr.Error {
	return &clierr.Error{
		Category: clierr.Unavailable, Message: "Cannot reach the Caracal identity service.",
		Operation: "Refresh CLI session", Resource: "server " + serverURL,
		Remediation: "Check the server URL and service health, then retry.", Detail: err.Error(),
	}
}

func refreshStatusError(serverURL string, resp *http.Response, body []byte) *clierr.Error {
	category := clierr.Unavailable
	message := fmt.Sprintf("The identity service returned HTTP %d.", resp.StatusCode)
	remediation := "Check server health and logs, then retry."
	if resp.StatusCode == http.StatusTooManyRequests {
		category = clierr.RateLimit
		message = "The identity service rate limit was reached."
		remediation = "Retry in a few seconds."
	}
	if detail := safeDetail(resp, body); detail != "" {
		message = detail
	}
	return &clierr.Error{
		Category: category, Message: message,
		Operation: "Refresh CLI session", Resource: "server " + serverURL,
		Remediation: remediation, HTTPStatus: resp.StatusCode,
	}
}

func (c *Client) httpClient() *http.Client { return &http.Client{Timeout: c.Timeout} }

// EnforceVersion requires an exact CLI/server version match, mirroring the
// self-service exemptions so users can always fix a mismatch.
func (c *Client) EnforceVersion(subcommand string) *clierr.Error {
	if c.versionChecked || subcommand == "self" || subcommand == "server" {
		return nil
	}
	c.versionChecked = true
	if c.CLIVersion == "" || c.CLIVersion == "0.0.0" {
		return nil
	}
	resp, err := c.httpClient().Get(c.BaseURL + "/api/v1/config/version")
	if err != nil || resp.StatusCode != http.StatusOK {
		if resp != nil {
			_ = resp.Body.Close()
		}
		return nil
	}
	defer func() { _ = resp.Body.Close() }()
	var data struct {
		ServerVersion string `json:"server_version"`
	}
	if json.NewDecoder(resp.Body).Decode(&data) != nil || data.ServerVersion == "" || data.ServerVersion == "dev" {
		return nil
	}
	if data.ServerVersion == c.CLIVersion {
		return nil
	}
	return &clierr.Error{
		Category:  clierr.Version,
		Message:   fmt.Sprintf("CLI version %s does not match server version %s.", c.CLIVersion, data.ServerVersion),
		Operation: "Verify CLI compatibility", Resource: "server " + c.BaseURL,
		Remediation: fmt.Sprintf("Run caracal self upgrade --version %s.", data.ServerVersion),
	}
}

func requestID(resp *http.Response) string {
	for key, values := range resp.Header {
		lower := strings.ToLower(key)
		if (lower == "x-request-id" || lower == "request-id") && len(values) > 0 {
			return values[0]
		}
	}
	return ""
}

func safeDetail(resp *http.Response, body []byte) string {
	if !strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "application/json") {
		return ""
	}
	var data map[string]any
	if json.Unmarshal(body, &data) != nil {
		return ""
	}
	detail, _ := data["detail"].(string)
	detail = strings.TrimSpace(detail)
	if len(detail) > 500 {
		detail = detail[:500]
	}
	return detail
}

// browseRemediation suggests the list command for the addressed resource type.
func browseRemediation(path string) string {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	typePlural := ""
	if len(parts) > 3 && parts[2] == "insights" && parts[3] == "agents" {
		typePlural = "agents"
	} else if len(parts) > 2 {
		typePlural = parts[2]
	}
	typeSingular := typePlural
	if strings.HasSuffix(typePlural, "xes") {
		typeSingular = typePlural[:len(typePlural)-2]
	} else if strings.HasSuffix(typePlural, "s") {
		typeSingular = typePlural[:len(typePlural)-1]
	}
	switch typeSingular {
	case "agent":
		return "Check the identifier or run caracal agent list to browse available resources."
	case "mcp", "skill", "hook", "prompt":
		return fmt.Sprintf("Check the identifier or run caracal registry %s list to browse available resources.", typeSingular)
	}
	return "Check the identifier and retry."
}

func (c *Client) statusError(resp *http.Response, body []byte, path, operation string) *clierr.Error {
	code := resp.StatusCode
	detail := safeDetail(resp, body)
	if operation == "" {
		operation = "Request " + path
	}
	base := &clierr.Error{
		Operation: operation, Resource: path,
		RequestID: requestID(resp), HTTPStatus: code,
	}
	orDefault := func(fallback string) string {
		if detail != "" {
			return detail
		}
		return fallback
	}
	switch {
	case code == 401:
		base.Category, base.Message = clierr.Auth, "Authentication failed."
		base.Remediation = "Run caracal auth login to authenticate again."
	case code == 403:
		base.Category = clierr.Permission
		base.Message = orDefault("You do not have permission to perform this operation.")
		base.Remediation = "Ask an administrator or resource owner for the required access."
	case code == 404:
		base.Category = clierr.NotFound
		base.Message = orDefault("The requested resource was not found.")
		base.Remediation = browseRemediation(path)
	case code == 409:
		base.Category = clierr.Conflict
		base.Message = orDefault("The requested change conflicts with current state.")
		base.Remediation = "Refresh the resource state and retry the operation."
	case code == 426:
		base.Category = clierr.Version
		base.Message = orDefault("The CLI and server versions are incompatible.")
		base.Remediation = "Install the CLI version required by the server."
	case code == 429:
		retryAfter := resp.Header.Get("Retry-After")
		if retryAfter == "" {
			retryAfter = "a few seconds"
		}
		base.Category, base.Message = clierr.RateLimit, "The server rate limit was reached."
		base.Remediation = "Retry in " + retryAfter + "."
	case code >= 500:
		base.Category = clierr.Unavailable
		base.Message = fmt.Sprintf("The server returned HTTP %d.", code)
		base.Remediation = "Check server health and logs, then run caracal doctor."
	default:
		base.Category = clierr.Validation
		base.Message = orDefault(fmt.Sprintf("The server rejected the request with HTTP %d.", code))
		base.Remediation = "Correct the request input and retry."
	}
	return base
}

func (c *Client) transportError(err error, path, operation string) *clierr.Error {
	if operation == "" {
		operation = "Request " + path
	}
	if os.IsTimeout(err) || errors.Is(err, io.ErrUnexpectedEOF) || strings.Contains(err.Error(), "Client.Timeout") {
		return &clierr.Error{
			Category:  clierr.Unavailable,
			Message:   fmt.Sprintf("The request timed out after %d seconds.", int(c.Timeout.Seconds())),
			Operation: operation, Resource: path,
			Remediation: "Increase CARACAL_TIMEOUT if appropriate and check server health with caracal doctor.",
			Detail:      err.Error(),
		}
	}
	return &clierr.Error{
		Category: clierr.Unavailable, Message: "Cannot reach the Caracal server.",
		Operation: "Connect to Caracal", Resource: "server " + c.BaseURL,
		Remediation: "Check the server URL and service health, then run caracal doctor.",
		Detail:      err.Error(),
	}
}

// Request performs an authenticated JSON request and decodes the response.
func (c *Client) Request(method, path string, params map[string]string, body any) (any, *clierr.Error) {
	raw, cerr := c.RequestRaw(method, path, params, body)
	if cerr != nil {
		return nil, cerr
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, nil
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, &clierr.Error{
			Category: clierr.Unexpected, Message: "The server response is not valid JSON.",
			Operation: "Request " + path, Resource: path, Detail: err.Error(),
		}
	}
	return decoded, nil
}

// RequestRaw performs an authenticated request and returns the raw JSON
// body, preserving the server's document field order for pass-through output.
func (c *Client) RequestRaw(method, path string, params map[string]string, body any) ([]byte, *clierr.Error) {
	return c.Do(method, path, params, body, "", "")
}

// Do is RequestRaw with explicit operation and resource labels for the
// error contract.
func (c *Client) Do(method, path string, params map[string]string, body any, operation, resource string) ([]byte, *clierr.Error) {
	raw, _, cerr := c.doInternal(method, path, params, body, operation, resource)
	return raw, cerr
}

func (c *Client) doInternal(method, path string, params map[string]string, body any, operation, resource string) ([]byte, http.Header, *clierr.Error) {
	if operation == "" {
		if strings.EqualFold(method, "GET") {
			operation = "Fetch " + path
		} else {
			operation = "Call " + strings.ToUpper(method) + " " + path
		}
	}
	target := c.BaseURL + path
	if len(params) > 0 {
		values := url.Values{}
		for key, value := range params {
			values.Set(key, value)
		}
		target += "?" + values.Encode()
	}
	var reader io.Reader
	if body != nil {
		blob, err := json.Marshal(body)
		if err != nil {
			return nil, nil, &clierr.Error{
				Category: clierr.Validation, Message: "The request body cannot be encoded as JSON.",
				Operation: "Request " + path, Resource: path, Detail: err.Error(),
			}
		}
		reader = bytes.NewReader(blob)
	}
	req, err := http.NewRequest(method, target, reader)
	if err != nil {
		return nil, nil, &clierr.Error{
			Category: clierr.Usage, Message: "The request could not be constructed.",
			Operation: "Request " + path, Resource: path, Detail: err.Error(),
		}
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("X-Caracal-CLI-Version", c.CLIVersion)
	if projectScopedAPIPath(path) && c.OrgSlug != "" && c.ProjectSlug != "" {
		req.Header.Set("X-Caracal-Org", c.OrgSlug)
		req.Header.Set("X-Caracal-Project", c.ProjectSlug)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	send := func() (*http.Response, error) {
		if reader != nil {
			if seeker, ok := reader.(io.Seeker); ok {
				_, _ = seeker.Seek(0, io.SeekStart)
			}
		}
		req.Header.Set("Authorization", "Bearer "+c.Token)
		return c.httpClient().Do(req)
	}
	resp, err := send()
	if err != nil {
		return nil, nil, c.transportError(err, path, operation)
	}
	// One session-backed token refresh on the first credential rejection.
	if resp.StatusCode == http.StatusUnauthorized && c.refreshFromSession() {
		_ = resp.Body.Close()
		if resp, err = send(); err != nil {
			return nil, nil, c.transportError(err, path, operation)
		}
	}
	// Transient statuses retry idempotent reads only.
	if method == http.MethodGet {
		for attempt := 0; attempt < 2 && isTransient(resp.StatusCode); attempt++ {
			delay := retryDelay(resp, attempt)
			_ = resp.Body.Close()
			time.Sleep(delay)
			if resp, err = send(); err != nil {
				return nil, nil, c.transportError(err, path, operation)
			}
		}
	}
	defer func() { _ = resp.Body.Close() }()
	blob, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, nil, c.transportError(err, path, operation)
	}
	if resp.StatusCode >= 400 {
		cerr := c.statusError(resp, blob, path, operation)
		if resource != "" {
			cerr.Resource = resource
		}
		return nil, resp.Header, cerr
	}
	return blob, resp.Header, nil
}

// GetRaw performs an authenticated GET returning the raw JSON body.
func (c *Client) GetRaw(path string, params map[string]string) ([]byte, *clierr.Error) {
	return c.RequestRaw(http.MethodGet, path, params, nil)
}

// Get performs an authenticated GET.
func (c *Client) Get(path string, params map[string]string) (any, *clierr.Error) {
	return c.Request(http.MethodGet, path, params, nil)
}

// Health checks server reachability and returns the latency in milliseconds.
func (c *Client) Health() (bool, float64) {
	start := time.Now()
	resp, err := c.httpClient().Get(c.BaseURL + "/health")
	if err != nil {
		return false, 0
	}
	_ = resp.Body.Close()
	return resp.StatusCode < 500, float64(time.Since(start).Microseconds()) / 1000.0
}

func isTransient(status int) bool {
	return status == 429 || status == 503 || status == 504
}

func retryDelay(resp *http.Response, attempt int) time.Duration {
	if after := resp.Header.Get("Retry-After"); after != "" {
		if seconds, err := strconv.Atoi(after); err == nil && seconds >= 0 {
			return time.Duration(seconds) * time.Second
		}
	}
	return time.Duration(float64(time.Second) * 0.5 * float64(int(1)<<attempt))
}

// refreshFromSession exchanges the stored identity session for a fresh
// registry token, persisting it for later invocations.
func (c *Client) refreshFromSession() bool {
	cfg, cerr := config.Load()
	if cerr != nil {
		return false
	}
	sessionToken := config.Str(cfg, "session_token")
	if sessionToken == "" {
		return false
	}
	req, err := http.NewRequest(http.MethodGet, c.BaseURL+"/api/auth/tenant-token", nil)
	if err != nil {
		return false
	}
	req.Header.Set("Authorization", "Bearer "+sessionToken)
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return false
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	var data struct {
		Token string `json:"token"`
	}
	if json.NewDecoder(resp.Body).Decode(&data) != nil || data.Token == "" {
		return false
	}
	c.Token = data.Token
	_ = config.Save(map[string]any{"access_token": data.Token})
	return true
}

// DoWithHeaders is Do returning selected response headers alongside the body.
func (c *Client) DoWithHeaders(method, path string, params map[string]string, body any, operation, resource string) ([]byte, http.Header, *clierr.Error) {
	raw, header, cerr := c.doInternal(method, path, params, body, operation, resource)
	return raw, header, cerr
}
