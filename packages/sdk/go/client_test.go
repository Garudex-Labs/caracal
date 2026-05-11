// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Caracal drop-in client smoke tests for env loading, header injection, and middleware binding.

package sdk_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	sdk "github.com/garudex-labs/caracal/sdk"
)

func TestFromEnvMissing(t *testing.T) {
	t.Setenv("CARACAL_COORDINATOR_URL", "")
	t.Setenv("CARACAL_ZONE_ID", "")
	t.Setenv("CARACAL_APPLICATION_ID", "")
	t.Setenv("CARACAL_SUBJECT_TOKEN", "")
	if _, err := sdk.FromEnv(); err == nil {
		t.Fatal("expected error for missing env")
	}
}

func TestFromEnvOK(t *testing.T) {
	t.Setenv("CARACAL_COORDINATOR_URL", "http://coord")
	t.Setenv("CARACAL_ZONE_ID", "z1")
	t.Setenv("CARACAL_APPLICATION_ID", "app1")
	t.Setenv("CARACAL_SUBJECT_TOKEN", "tok1")
	c, err := sdk.FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if c.ZoneID != "z1" || c.ApplicationID != "app1" || c.SubjectToken != "tok1" {
		t.Fatalf("bad config: %+v", c)
	}
}

func TestHeadersFallback(t *testing.T) {
	c := &sdk.Caracal{SubjectToken: "tok"}
	h := c.Headers(context.Background())
	if h.Get(sdk.HeaderAuthorization) != "Bearer tok" {
		t.Fatalf("missing authorization: %v", h)
	}
	if sdk.ParseTraceparent(h.Get(sdk.HeaderTraceparent)) == "" {
		t.Fatalf("missing traceparent: %v", h)
	}
}

func TestMiddlewareBindsContext(t *testing.T) {
	c := &sdk.Caracal{ZoneID: "z", ApplicationID: "a", SubjectToken: "fallback"}
	var seen string
	handler := c.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cur, ok := sdk.Current(r.Context())
		if !ok {
			t.Errorf("no context")
		}
		seen = cur.SubjectToken
		w.WriteHeader(200)
	}))
	srv := httptest.NewServer(handler)
	defer srv.Close()
	req, _ := http.NewRequest("GET", srv.URL, nil)
	req.Header.Set(sdk.HeaderAuthorization, "Bearer inbound")
	req.Header.Set(sdk.HeaderTraceparent, "00-0123456789abcdef0123456789abcdef-aabbccddeeff0011-01")
	req.Header.Set(sdk.HeaderBaggage, sdk.BaggageAgentSession+"=sess1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if seen != "inbound" {
		t.Fatalf("expected inbound token, got %q", seen)
	}
}

func TestHTTPClientInjects(t *testing.T) {
	c := &sdk.Caracal{ZoneID: "z", ApplicationID: "a", SubjectToken: "tok"}
	var got http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		w.WriteHeader(204)
	}))
	defer srv.Close()
	ctx := sdk.Bind(context.Background(), sdk.CaracalContext{
		SubjectToken:   "tok",
		ZoneID:         "z",
		ClientID:       "a",
		AgentSessionID: "sess9",
		Hop:            1,
	})
	client := c.Transport(nil)
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL, nil)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	bag := sdk.ParseBaggage(got.Get(sdk.HeaderBaggage))
	if bag[sdk.BaggageAgentSession] != "sess9" {
		t.Fatalf("envelope not injected: %v", got)
	}
	if bag[sdk.BaggageHop] != "1" {
		t.Fatalf("hop not injected: %v", got)
	}
}
