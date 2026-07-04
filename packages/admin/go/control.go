// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Control API client that mints a scoped, single-use Caracal token per call and invokes a control command through the governed /v1/control/invoke path.

package admin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	stsTokenPath      = "/oauth/2/token"
	controlInvokePath = "/v1/control/invoke"
)

// ControlClientOptions configures a ControlClient bound to one identity.
type ControlClientOptions struct {
	STSURL           string
	ControlURL       string
	Audience         string
	ApplicationID    string
	ClientSecret     string
	TTLSeconds       int
	ZoneScope        string
	AuthorizedBy     string
	CoAuthorOperator bool
	RequestID        string
	HTTPClient       *http.Client
}

// ControlClientError is a failed control invoke. Stage distinguishes a
// token-exchange failure from a control dispatch failure; Status 0 means the
// request itself failed and no response arrived. Reason is already free of
// the client secret, so it is safe to surface or log. Code and Remediation
// are the structured control-plane fields when the failure came from
// dispatch.
type ControlClientError struct {
	Stage       string
	Status      int
	Reason      string
	Code        string
	Remediation string
}

func (e *ControlClientError) Error() string {
	return fmt.Sprintf("control %s failed (%d): %s", e.Stage, e.Status, e.Reason)
}

// Definitive reports whether the failure provably applied nothing: any
// token-stage failure (no token was minted, so nothing was invoked) or an
// invoke the control plane rejected with a client error. An invoke-stage
// server error or lost response is not definitive - the command may already
// have applied - so a caller must never blindly retry it.
func (e *ControlClientError) Definitive() bool {
	return e.Stage == "token" || (e.Status >= 400 && e.Status < 500)
}

// ControlClient is a control-plane client bound to one identity. Each invoke
// mints a fresh token scoped to exactly the scopes that call requires, so an
// action carries the least authority that satisfies it and a leaked token
// grants nothing beyond that one operation. The client secret is a sealed
// credential that leaves this package only in the token-exchange request body
// to the STS and is never logged.
type ControlClient struct {
	opts       ControlClientOptions
	httpClient *http.Client
}

// NewControlClient builds a ControlClient from options, trimming trailing
// slashes from the base URLs.
func NewControlClient(opts ControlClientOptions) *ControlClient {
	opts.STSURL = strings.TrimRight(opts.STSURL, "/")
	opts.ControlURL = strings.TrimRight(opts.ControlURL, "/")
	client := opts.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	return &ControlClient{opts: opts, httpClient: client}
}

// Invoke mints a token scoped to exactly the requested scopes and dispatches
// one control command, returning the command result.
func (c *ControlClient) Invoke(ctx context.Context, command, subcommand string, flags map[string]any, scopes []string) (any, error) {
	token, err := c.mintToken(ctx, scopes)
	if err != nil {
		return nil, err
	}
	body := map[string]any{"command": command, "subcommand": subcommand, "flags": flags}
	if c.opts.AuthorizedBy != "" {
		body["authorized_by"] = c.opts.AuthorizedBy
	}
	if c.opts.CoAuthorOperator {
		body["co_author_operator"] = true
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.opts.ControlURL+controlInvokePath, strings.NewReader(string(payload)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	if c.opts.ZoneScope != "" {
		req.Header.Set("X-Caracal-Zone-Scope", c.opts.ZoneScope)
	}
	if c.opts.RequestID != "" {
		req.Header.Set("X-Request-Id", c.opts.RequestID)
	}
	res, err := c.httpClient.Do(req)
	if err != nil {
		return nil, &ControlClientError{Stage: "invoke", Status: 0, Reason: err.Error()}
	}
	defer res.Body.Close()
	parsed := readBody(res.Body)
	if res.StatusCode >= 400 {
		reason, code, remediation := describeError(parsed, "control invoke rejected")
		return nil, &ControlClientError{Stage: "invoke", Status: res.StatusCode, Reason: reason, Code: code, Remediation: remediation}
	}
	if envelope, ok := parsed.(map[string]any); ok {
		return envelope["result"], nil
	}
	return nil, nil
}

// mintToken exchanges the identity's client credentials for a control token
// scoped to exactly the requested scopes. A transient failure (a server error
// or a lost response) is retried once: a failed mint is always definitive -
// no token exists and nothing was applied - so the retry is safe for every
// caller.
func (c *ControlClient) mintToken(ctx context.Context, scopes []string) (string, error) {
	token, err := c.exchangeToken(ctx, scopes)
	if err == nil {
		return token, nil
	}
	var controlErr *ControlClientError
	if errors.As(err, &controlErr) && (controlErr.Status >= 500 || controlErr.Status == 0) {
		return c.exchangeToken(ctx, scopes)
	}
	return "", err
}

func (c *ControlClient) exchangeToken(ctx context.Context, scopes []string) (string, error) {
	form := url.Values{
		"grant_type":     {"client_credentials"},
		"application_id": {c.opts.ApplicationID},
		"client_secret":  {c.opts.ClientSecret},
		"resource":       {c.opts.Audience},
		"scope":          {strings.Join(scopes, " ")},
	}
	if c.opts.TTLSeconds > 0 {
		form.Set("ttl_seconds", strconv.Itoa(c.opts.TTLSeconds))
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.opts.STSURL+stsTokenPath, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if c.opts.RequestID != "" {
		req.Header.Set("X-Request-Id", c.opts.RequestID)
	}
	res, err := c.httpClient.Do(req)
	if err != nil {
		return "", &ControlClientError{Stage: "token", Status: 0, Reason: err.Error()}
	}
	defer res.Body.Close()
	parsed := readBody(res.Body)
	if res.StatusCode >= 400 {
		reason, code, remediation := describeError(parsed, "token exchange rejected")
		return "", &ControlClientError{Stage: "token", Status: res.StatusCode, Reason: reason, Code: code, Remediation: remediation}
	}
	envelope, _ := parsed.(map[string]any)
	token, _ := envelope["access_token"].(string)
	if token == "" {
		return "", &ControlClientError{Stage: "token", Status: res.StatusCode, Reason: "token exchange returned no access_token"}
	}
	return token, nil
}

func readBody(body io.Reader) any {
	data, err := io.ReadAll(body)
	if err != nil || len(data) == 0 {
		return nil
	}
	var parsed any
	if json.Unmarshal(data, &parsed) != nil {
		return map[string]any{"raw": string(data)}
	}
	return parsed
}

func describeError(body any, fallback string) (string, string, string) {
	envelope, ok := body.(map[string]any)
	if !ok {
		return fallback, "", ""
	}
	switch wire := envelope["error"].(type) {
	case map[string]any:
		reason, _ := wire["reason"].(string)
		if reason == "" {
			reason = fallback
		}
		code, _ := wire["code"].(string)
		remediation, _ := wire["remediation"].(string)
		return reason, code, remediation
	case string:
		return wire, "", ""
	}
	return fallback, "", ""
}
