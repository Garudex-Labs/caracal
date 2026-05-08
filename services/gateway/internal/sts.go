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

// tokenResponse mirrors the STS RFC 8693 response shape.
type tokenResponse struct {
	AccessToken     string            `json:"access_token"`
	ExpiresIn       int               `json:"expires_in"`
	TargetUpstreams map[string]string `json:"target_upstreams"`
}

// stsClient performs token exchanges against the configured STS.
type stsClient struct {
	url    string
	client *http.Client
}

// stsResult is the outcome of a single Exchange call.
type stsResult struct {
	AccessToken string
	Upstream    string
	Latency     time.Duration
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

// Exchange performs an RFC 8693 token exchange.
// Internal error detail is returned for the gateway to log; a sanitised CaracalError is
// safe to forward to the client.
func (c *stsClient) Exchange(ctx context.Context, subjectToken, clientID, resource, requestID string) (*stsResult, int, *sharederr.CaracalError, error) {
	form := url.Values{
		"grant_type":         {"urn:ietf:params:oauth:grant-type:token-exchange"},
		"client_id":          {clientID},
		"subject_token":      {subjectToken},
		"subject_token_type": {"urn:ietf:params:oauth:token-type:access_token"},
		"resource":           {resource},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.url+"/oauth/2/token", strings.NewReader(form.Encode()))
	if err != nil {
		return nil, http.StatusInternalServerError,
			sharederr.New(sharederr.STSUnavailable, "sts request build failed"), err
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
		return nil, status, sharederr.New(code, msg), err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var e sharederr.CaracalError
		body := io.LimitReader(resp.Body, stsErrorBodyLimit)
		if err := json.NewDecoder(body).Decode(&e); err == nil && e.Code != "" {
			return nil, resp.StatusCode, &e, fmt.Errorf("sts %d: %s", resp.StatusCode, e.Code)
		}
		return nil, resp.StatusCode,
			sharederr.New(sharederr.STSUnavailable, http.StatusText(resp.StatusCode)),
			fmt.Errorf("sts non-200 status: %d", resp.StatusCode)
	}
	var tr tokenResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, stsErrorBodyLimit)).Decode(&tr); err != nil {
		return nil, http.StatusBadGateway,
			sharederr.New(sharederr.STSUnavailable, "sts response invalid"), err
	}
	if tr.AccessToken == "" {
		return nil, http.StatusBadGateway,
			sharederr.New(sharederr.STSUnavailable, "sts response invalid"),
			fmt.Errorf("sts returned empty access_token")
	}
	upstream := tr.TargetUpstreams[resource]
	if upstream == "" {
		return nil, http.StatusForbidden,
			sharederr.New(sharederr.AccessDenied, "resource upstream not configured"),
			fmt.Errorf("resource %q not in target_upstreams", resource)
	}
	return &stsResult{AccessToken: tr.AccessToken, Upstream: upstream, Latency: latency}, http.StatusOK, nil, nil
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
