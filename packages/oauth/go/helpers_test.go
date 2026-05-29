// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for OAuth client pure helpers: retry, scope, and response logic.

package oauth

import (
	"context"
	"net/http"
	"testing"
	"time"
)

func TestInteractionRequiredErrorMessage(t *testing.T) {
	if got := (&InteractionRequiredError{}).Error(); got != "interaction required" {
		t.Fatalf("empty message must yield default, got %q", got)
	}
	if got := (&InteractionRequiredError{Message: "step up"}).Error(); got != "interaction required: step up" {
		t.Fatalf("message must be appended, got %q", got)
	}
}

func TestNormalizedScopes(t *testing.T) {
	if got := normalizedScopes(nil); got != "" {
		t.Fatalf("nil scopes must produce empty string, got %q", got)
	}
	got := normalizedScopes([]string{"read", "admin", "read", "write"})
	if got != "admin read write" {
		t.Fatalf("scopes must be deduped and sorted, got %q", got)
	}
}

func TestFirstResource(t *testing.T) {
	if got := firstResource(nil); got != "" {
		t.Fatalf("empty list must return empty string, got %q", got)
	}
	if got := firstResource([]string{"a", "b"}); got != "a" {
		t.Fatalf("must return first element, got %q", got)
	}
}

func TestResourceList(t *testing.T) {
	got := resourceList([]string{" a ", "", "  ", "b"})
	if len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Fatalf("must trim and drop empties, got %v", got)
	}
}

func TestTransientStatus(t *testing.T) {
	for _, s := range []int{http.StatusRequestTimeout, http.StatusTooEarly, http.StatusTooManyRequests, 500, 503} {
		if !transientStatus(s) {
			t.Fatalf("status %d must be transient", s)
		}
	}
	for _, s := range []int{200, 400, 401, 404} {
		if transientStatus(s) {
			t.Fatalf("status %d must not be transient", s)
		}
	}
}

func TestRetryDelayHonorsRetryAfterSeconds(t *testing.T) {
	res := &http.Response{Header: http.Header{}}
	res.Header.Set("Retry-After", "2")
	if got := retryDelay(res, 0); got != 2*time.Second {
		t.Fatalf("numeric Retry-After must be honored, got %s", got)
	}
}

func TestRetryDelayExponentialBackoffWithCap(t *testing.T) {
	if got := retryDelay(nil, 0); got != 250*time.Millisecond {
		t.Fatalf("attempt 0 must be 250ms, got %s", got)
	}
	if got := retryDelay(nil, 2); got != time.Second {
		t.Fatalf("attempt 2 must be 1s, got %s", got)
	}
	if got := retryDelay(nil, 10); got != 5*time.Second {
		t.Fatalf("backoff must cap at 5s, got %s", got)
	}
}

func TestSleepWithinDeadline(t *testing.T) {
	if err := sleepWithinDeadline(context.Background(), 5*time.Millisecond, time.Now().Add(time.Second)); err != nil {
		t.Fatalf("short sleep within deadline must succeed: %v", err)
	}

	if err := sleepWithinDeadline(context.Background(), time.Second, time.Now().Add(-time.Second)); err == nil {
		t.Fatal("a passed deadline must error")
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := sleepWithinDeadline(ctx, time.Second, time.Now().Add(time.Second)); err == nil {
		t.Fatal("a cancelled context must return its error")
	}
}

func TestJSONResponse(t *testing.T) {
	cases := map[string]bool{
		"":                                true,
		"application/json":                true,
		"application/json; charset=utf-8": true,
		"application/scim+json":           true,
		"text/html":                       false,
	}
	for ct, want := range cases {
		if got := jsonResponse(ct); got != want {
			t.Fatalf("jsonResponse(%q) = %v, want %v", ct, got, want)
		}
	}
}

func TestTimeoutFromOptions(t *testing.T) {
	if got := timeoutFromOptions(ExchangeOptions{}); got != defaultTimeout {
		t.Fatalf("zero timeout must fall back to default, got %s", got)
	}
	if got := timeoutFromOptions(ExchangeOptions{TimeoutMillis: 1500}); got != 1500*time.Millisecond {
		t.Fatalf("explicit timeout must be honored, got %s", got)
	}
}

func TestTTLString(t *testing.T) {
	if got := ttlString(0); got != "" {
		t.Fatalf("non-positive ttl must be empty, got %q", got)
	}
	if got := ttlString(300); got != "300" {
		t.Fatalf("positive ttl must stringify, got %q", got)
	}
}

func TestValidateSuccess(t *testing.T) {
	ok, err := validateSuccess(stsSuccessResponse{AccessToken: "t", ExpiresIn: 60})
	if err != nil {
		t.Fatalf("valid response must pass: %v", err)
	}
	if ok.TokenType != "Bearer" || ok.AccessToken != "t" || ok.ExpiresIn != 60 || ok.IssuedAt == 0 {
		t.Fatalf("normalized response wrong: %+v", ok)
	}

	if _, err := validateSuccess(stsSuccessResponse{ExpiresIn: 60}); err == nil {
		t.Fatal("missing access_token must error")
	}
	if _, err := validateSuccess(stsSuccessResponse{AccessToken: "t", TokenType: "MAC", ExpiresIn: 60}); err == nil {
		t.Fatal("non-Bearer token_type must error")
	}
	if _, err := validateSuccess(stsSuccessResponse{AccessToken: "t", ExpiresIn: 0}); err == nil {
		t.Fatal("non-positive expires_in must error")
	}
}
