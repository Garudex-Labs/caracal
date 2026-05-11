// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// STS exchange client: HTTPS-validated RFC 8693 token exchange.

package internal

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
	"time"

	sharederr "github.com/garudex-labs/caracal/core/errors"
)

// stsErrorBodyLimit caps the bytes we read from STS error responses.
const stsErrorBodyLimit = 16 * 1024

// upstreamDirective mirrors STS UpstreamDirective so the gateway can build the
// outbound Authorization header from the credential class STS chose for the resource.
type upstreamDirective struct {
	URL           string `json:"url"`
	AuthMode      string `json:"auth_mode"`
	AuthHeader    string `json:"auth_header,omitempty"`
	AuthScheme    string `json:"auth_scheme,omitempty"`
	ProviderToken string `json:"provider_token,omitempty"`
	ExpiresAt     int64  `json:"expires_at,omitempty"`
}

// tokenResponse mirrors the STS RFC 8693 response shape.
type tokenResponse struct {
	AccessToken string                       `json:"access_token"`
	ExpiresIn   int                          `json:"expires_in"`
	Upstreams   map[string]upstreamDirective `json:"upstreams"`
}

// stsClient performs token exchanges against the configured STS.
type stsClient struct {
	url    string
	client *http.Client
}

// stsResult holds the successful token and upstream directive from a single Exchange call.
type stsResult struct {
	AccessToken string
	Upstream    upstreamDirective
	Latency     time.Duration
}

// exchangeOutcome bundles every field an Exchange call can return so callers
// never have to juggle a 4-tuple.
type exchangeOutcome struct {
	Result      *stsResult
	Status      int
	ClientErr   *sharederr.CaracalError
	InternalErr error
}

func newSTSClient(stsURL string, timeout time.Duration) *stsClient {
	transport := &http.Transport{
		MaxIdleConns:          200,
		MaxIdleConnsPerHost:   100,
		MaxConnsPerHost:       200,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   5 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		ResponseHeaderTimeout: timeout,
	}
	return &stsClient{
		url:    strings.TrimRight(stsURL, "/"),
		client: &http.Client{Timeout: timeout, Transport: transport},
	}
}

// Exchange performs an RFC 8693 token exchange. The caller's identity is sent as
// (zone_id, application_id) form fields rather than a positional client_id, so
// neither value depends on a separator-free encoding.
func (c *stsClient) Exchange(ctx context.Context, subjectToken string, bind binding, resource, requestID string) exchangeOutcome {
	form := url.Values{
		"grant_type":         {"urn:ietf:params:oauth:grant-type:token-exchange"},
		"zone_id":            {bind.ZoneID},
		"application_id":     {bind.ApplicationID},
		"subject_token":      {subjectToken},
		"subject_token_type": {"urn:ietf:params:oauth:token-type:access_token"},
		"resource":           {resource},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.url+"/oauth/2/token", strings.NewReader(form.Encode()))
	if err != nil {
		return exchangeOutcome{Status: http.StatusInternalServerError,
			ClientErr: sharederr.New(sharederr.STSUnavailable, "sts request build failed"), InternalErr: err}
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", "caracal-gateway")
	req.Header.Set("Accept", "application/json")
	if requestID != "" {
		req.Header.Set("X-Request-Id", requestID)
	}

	start := time.Now()
	resp, err := c.client.Do(req)
	latency := time.Since(start)
	if err != nil {
		status, code, msg := classifySTSTransportError(err)
		return exchangeOutcome{Status: status, ClientErr: sharederr.New(code, msg), InternalErr: err}
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var e sharederr.CaracalError
		body := io.LimitReader(resp.Body, stsErrorBodyLimit)
		if err := json.NewDecoder(body).Decode(&e); err == nil && e.Code != "" {
			return exchangeOutcome{Status: resp.StatusCode, ClientErr: &e, InternalErr: fmt.Errorf("sts %d: %s", resp.StatusCode, e.Code)}
		}
		return exchangeOutcome{Status: resp.StatusCode,
			ClientErr:   sharederr.New(sharederr.STSUnavailable, http.StatusText(resp.StatusCode)),
			InternalErr: fmt.Errorf("sts non-200 status: %d", resp.StatusCode)}
	}
	if !isJSONResponse(resp.Header.Get("Content-Type")) {
		return exchangeOutcome{Status: http.StatusBadGateway,
			ClientErr: sharederr.New(sharederr.STSUnavailable, "sts response invalid"), InternalErr: fmt.Errorf("sts response content-type invalid")}
	}
	var tr tokenResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, stsErrorBodyLimit)).Decode(&tr); err != nil {
		return exchangeOutcome{Status: http.StatusBadGateway,
			ClientErr: sharederr.New(sharederr.STSUnavailable, "sts response invalid"), InternalErr: err}
	}
	if tr.AccessToken == "" {
		return exchangeOutcome{Status: http.StatusBadGateway,
			ClientErr:   sharederr.New(sharederr.STSUnavailable, "sts response invalid"),
			InternalErr: fmt.Errorf("sts returned empty access_token")}
	}
	upstream, ok := tr.Upstreams[resource]
	if !ok || upstream.URL == "" {
		return exchangeOutcome{Status: http.StatusForbidden,
			ClientErr:   sharederr.New(sharederr.AccessDenied, "resource upstream not configured"),
			InternalErr: fmt.Errorf("resource %q not in upstreams", resource)}
	}
	return exchangeOutcome{Result: &stsResult{AccessToken: tr.AccessToken, Upstream: upstream, Latency: latency}, Status: http.StatusOK}
}

func isJSONResponse(contentType string) bool {
	if contentType == "" {
		return false
	}
	mediaType := strings.ToLower(strings.Split(contentType, ";")[0])
	return mediaType == "application/json" || strings.HasSuffix(mediaType, "+json")
}

// classifySTSTransportError maps low-level transport errors to gateway-safe responses.
func classifySTSTransportError(err error) (int, sharederr.Code, string) {
	if errors.Is(err, context.DeadlineExceeded) {
		return http.StatusGatewayTimeout, sharederr.STSUnavailable, "sts timeout"
	}
	if errors.Is(err, context.Canceled) {
		return 499, sharederr.STSUnavailable, "client cancelled"
	}
	var nerr net.Error
	if errors.As(err, &nerr) && nerr.Timeout() {
		return http.StatusGatewayTimeout, sharederr.STSUnavailable, "sts timeout"
	}
	return http.StatusBadGateway, sharederr.STSUnavailable, "sts unavailable"
}
