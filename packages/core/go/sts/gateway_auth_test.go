// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for gateway exchange request authentication.

package sts

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestSignGatewayExchangeMatchesCanonicalEnvelope(t *testing.T) {
	key := []byte("gateway-signing-key-with-entropy")
	timestamp := time.Unix(1_700_000_000, 123)
	body := []byte(`{"grant_id":"grant_123","scope":"read write"}`)

	got := SignGatewayExchange(key, timestamp, "req-123", "post", "/oauth/token", body)
	want := "4d299b9ededc03aae1467f1d85502ee7c9399d05c9a46123a31d4a768d2e0925"

	if got != want {
		t.Fatalf("signature = %q, want %q", got, want)
	}
}

func TestSignGatewayExchangeReturnsEmptyWithoutKey(t *testing.T) {
	if got := SignGatewayExchange(nil, time.Unix(1, 0), "req", "POST", "/token", []byte("body")); got != "" {
		t.Fatalf("signature without key = %q, want empty string", got)
	}
}

func TestVerifyGatewayExchangeAcceptsValidSignature(t *testing.T) {
	key := []byte("gateway-signing-key-with-entropy")
	now := time.Unix(1_700_000_000, 0)
	body := []byte(`{"audience":"gateway"}`)
	signature := SignGatewayExchange(key, now, "req-123", "POST", "/oauth/token", body)

	if err := VerifyGatewayExchange(key, now, 30*time.Second, fmt.Sprint(now.Unix()), "req-123", signature, "POST", "/oauth/token", body); err != nil {
		t.Fatalf("valid gateway exchange rejected: %v", err)
	}
}

func TestVerifyGatewayExchangeAcceptsCaseInsensitiveMethodInput(t *testing.T) {
	key := []byte("gateway-signing-key-with-entropy")
	now := time.Unix(1_700_000_000, 0)
	body := []byte("body")
	signature := SignGatewayExchange(key, now, "req-123", "post", "/oauth/token", body)

	if err := VerifyGatewayExchange(key, now, time.Minute, fmt.Sprint(now.Unix()), "req-123", signature, "POST", "/oauth/token", body); err != nil {
		t.Fatalf("method canonicalization should accept equivalent signatures: %v", err)
	}
}

func TestVerifyGatewayExchangeRejectsInvalidInputs(t *testing.T) {
	key := []byte("gateway-signing-key-with-entropy")
	now := time.Unix(1_700_000_000, 0)
	body := []byte("body")
	signature := SignGatewayExchange(key, now, "req-123", "POST", "/oauth/token", body)

	for _, tc := range []struct {
		name      string
		key       []byte
		timestamp string
		requestID string
		signature string
		method    string
		path      string
		body      []byte
		want      string
	}{
		{name: "missing key", key: nil, timestamp: fmt.Sprint(now.Unix()), requestID: "req-123", signature: signature, method: "POST", path: "/oauth/token", body: body, want: "key not configured"},
		{name: "missing timestamp", key: key, timestamp: "", requestID: "req-123", signature: signature, method: "POST", path: "/oauth/token", body: body, want: "headers missing"},
		{name: "missing request id", key: key, timestamp: fmt.Sprint(now.Unix()), requestID: "", signature: signature, method: "POST", path: "/oauth/token", body: body, want: "headers missing"},
		{name: "missing signature", key: key, timestamp: fmt.Sprint(now.Unix()), requestID: "req-123", signature: "", method: "POST", path: "/oauth/token", body: body, want: "headers missing"},
		{name: "invalid timestamp", key: key, timestamp: "not-unix", requestID: "req-123", signature: signature, method: "POST", path: "/oauth/token", body: body, want: "timestamp invalid"},
		{name: "past skew", key: key, timestamp: fmt.Sprint(now.Add(-31 * time.Second).Unix()), requestID: "req-123", signature: signature, method: "POST", path: "/oauth/token", body: body, want: "outside skew"},
		{name: "future skew", key: key, timestamp: fmt.Sprint(now.Add(31 * time.Second).Unix()), requestID: "req-123", signature: signature, method: "POST", path: "/oauth/token", body: body, want: "outside skew"},
		{name: "invalid hex", key: key, timestamp: fmt.Sprint(now.Unix()), requestID: "req-123", signature: "not-hex", method: "POST", path: "/oauth/token", body: body, want: "signature invalid"},
		{name: "wrong body", key: key, timestamp: fmt.Sprint(now.Unix()), requestID: "req-123", signature: signature, method: "POST", path: "/oauth/token", body: []byte("tampered"), want: "signature mismatch"},
		{name: "wrong path", key: key, timestamp: fmt.Sprint(now.Unix()), requestID: "req-123", signature: signature, method: "POST", path: "/oauth/other", body: body, want: "signature mismatch"},
		{name: "wrong request id", key: key, timestamp: fmt.Sprint(now.Unix()), requestID: "req-456", signature: signature, method: "POST", path: "/oauth/token", body: body, want: "signature mismatch"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := VerifyGatewayExchange(tc.key, now, 30*time.Second, tc.timestamp, tc.requestID, tc.signature, tc.method, tc.path, tc.body)
			if err == nil {
				t.Fatal("expected verification error")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %q, want substring %q", err, tc.want)
			}
		})
	}
}

func TestGatewayExchangePayloadUsesUppercaseMethodAndBodyDigest(t *testing.T) {
	body := []byte("payload")
	got := string(gatewayExchangePayload(42, "req-1", "patch", "/resource", body))
	digest := sha256.Sum256(body)
	want := "42\nreq-1\nPATCH\n/resource\n" + hex.EncodeToString(digest[:])

	if got != want {
		t.Fatalf("canonical payload = %q, want %q", got, want)
	}
}

func TestGatewayExchangeHeaderConstants(t *testing.T) {
	if GatewayTimestampHeader != "X-Caracal-Gateway-Timestamp" {
		t.Fatalf("timestamp header = %q", GatewayTimestampHeader)
	}
	if GatewayRequestHeader != "X-Caracal-Gateway-Request" {
		t.Fatalf("request header = %q", GatewayRequestHeader)
	}
	if GatewaySignatureHeader != "X-Caracal-Gateway-Signature" {
		t.Fatalf("signature header = %q", GatewaySignatureHeader)
	}
}

func TestTokenResponseAndUpstreamDirectiveJSONShape(t *testing.T) {
	resp := TokenResponse{
		AccessToken:     "access-token",
		TokenType:       "Bearer",
		ExpiresIn:       300,
		Scope:           "read write",
		IssuedTokenType: "urn:ietf:params:oauth:token-type:access_token",
		TargetResources: []string{"resource-a"},
		Upstreams: map[string]UpstreamDirective{
			"resource-a": {
				URL:                    "https://api.example.test",
				AuthMode:               "bearer",
				AuthLocation:           "header",
				AuthHeader:             "Authorization",
				QueryParamName:         "access_token",
				AuthScheme:             "Bearer",
				AllowedTokenHosts:      []string{"auth.example.test"},
				ProviderToken:          "provider-token",
				ProviderID:             "provider-a",
				ConnectionID:           "grant-a",
				ForwardCaracalIdentity: true,
				ExpiresAt:              1_700_000_300,
			},
		},
	}

	data, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("marshal token response: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal token response: %v", err)
	}
	if got["access_token"] != "access-token" || got["token_type"] != "Bearer" || got["scope"] != "read write" {
		t.Fatalf("unexpected top-level JSON fields: %s", data)
	}
	upstreams := got["upstreams"].(map[string]any)
	directive := upstreams["resource-a"].(map[string]any)
	if directive["forward_caracal_identity"] != true || directive["provider_token"] != "provider-token" {
		t.Fatalf("unexpected upstream JSON fields: %s", data)
	}
}

func TestUpstreamDirectiveOmitsEmptyOptionalFields(t *testing.T) {
	data, err := json.Marshal(TokenResponse{
		AccessToken:     "access-token",
		TokenType:       "Bearer",
		ExpiresIn:       300,
		IssuedTokenType: "urn:ietf:params:oauth:token-type:access_token",
		Upstreams: map[string]UpstreamDirective{
			"resource-a": {
				URL:      "https://api.example.test",
				AuthMode: "caracal_jwt",
			},
		},
	})
	if err != nil {
		t.Fatalf("marshal token response: %v", err)
	}

	for _, omitted := range []string{
		"scope",
		"target_resources",
		"provider_token",
		"forward_caracal_identity",
		"expires_at",
	} {
		if strings.Contains(string(data), omitted) {
			t.Fatalf("empty optional field %q should be omitted from %s", omitted, data)
		}
	}
}
